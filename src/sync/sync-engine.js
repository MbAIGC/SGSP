/**
 * SyncEngine: 一次同步的执行体(2.0 方案 §7)。
 * 不变量:
 * - 未确认远端状态,不写入;
 * - 未确认同步成功,不更新 BASE;
 * - 无法自动合并,不自动覆盖(进入 CONFLICT_PAUSED);
 * - 写入失败,不伪造成功;
 * - 基准无法证明时,进入恢复向导,不自动选边。
 *
 * 引擎只编排与执行,不直接操作 UI;进度通过事件总线发布。
 */

import { SyncError, SyncErrorCategory } from "./sync-error.js";
import { SyncState, transition, finish } from "./sync-context.js";
import { PlanAction } from "./sync-planner.js";

export class SyncEngine {
  /**
   * @param {object} deps {
   *   provider, workspace, contentAdapter, metadataStore, manifestStore, conflictService,
   *   planner, merger, commitBuilder, events, config:{syncRange, syncFileType, repoKey}
   * }
   */
  constructor(deps) {
    this.provider = deps.provider;
    this.workspace = deps.workspace;
    this.contentAdapter = deps.contentAdapter;
    this.metadataStore = deps.metadataStore;
    this.manifestStore = deps.manifestStore;
    this.conflictService = deps.conflictService;
    this.planner = deps.planner;
    this.merger = deps.merger;
    this.commitBuilder = deps.commitBuilder;
    this.events = deps.events;
    this.config = deps.config;
  }

  _emit(name, payload) {
    if (this.events) this.events.emit(name, payload);
  }

  async run(ctx) {
    try {
      // 1. 前置检查
      transition(ctx, SyncState.CHECKING);
      this._emit("engine:phase", { ctx, state: SyncState.CHECKING });
      this._checkConfig(ctx);

      // 2. 本地快照
      transition(ctx, SyncState.SNAPSHOTTING_LOCAL);
      this._emit("engine:phase", { ctx, state: SyncState.SNAPSHOTTING_LOCAL });
      const scan = await this.workspace.scan({ range: this.config.syncRange });
      const localShas = new Map();
      for (const file of scan.files) {
        const bytes = await this._readLocalBytes(file.path);
        localShas.set(file.path, bytes ? await this.provider.gitBlobSha(bytes) : null);
      }
      ctx.localSnapshotId = ctx.id;

      // 3. 读取远端(空仓库 404 → 无头模式,由首推创建分支)
      transition(ctx, SyncState.FETCHING_REMOTE);
      this._emit("engine:phase", { ctx, state: SyncState.FETCHING_REMOTE });
      let remoteHead = null;
      try {
        remoteHead = await this.provider.getBranchHead();
        ctx.observedRemoteHead = remoteHead.sha;
        const remoteCommit = await this.provider.getCommit(remoteHead.sha);
        var remoteEntries = await this._treeMap(await this.provider.getTree(remoteCommit.treeSha));
      } catch (err) {
        if (err instanceof SyncError && err.httpStatus === 404) {
          ctx.remoteHeadless = true;
          remoteHead = null;
          var remoteEntries = new Map();
        } else {
          throw err;
        }
      }

      // 4. BASE 解析
      transition(ctx, SyncState.RESOLVING_BASE);
      this._emit("engine:phase", { ctx, state: SyncState.RESOLVING_BASE });
      const baseResolution = await this._resolveBase(ctx, remoteHead ? remoteHead.sha : null);
      if (baseResolution.unresolved) {
        ctx.baseUnresolved = true;
        ctx.conflicts = [{ path: "__base__", reason: "BASE_UNRESOLVED", detail: baseResolution.reason }];
        transition(ctx, SyncState.CONFLICT_PAUSED, "BASE_UNRESOLVED");
        finish(ctx, { state: SyncState.CONFLICT_PAUSED, result: { paused: true, kind: "BASE_UNRESOLVED" } });
        return ctx.result;
      }
      const baseEntries = baseResolution.baseEntries;
      if (baseResolution.bootstrapDownload) {
        // 引导下载: 本地为空的新设备首同步,本地缺失不视作删除
        ctx.bootstrapDownload = true;
      }

      // 5. 规划
      transition(ctx, SyncState.PLANNING);
      this._emit("engine:phase", { ctx, state: SyncState.PLANNING });
      ctx.expectedRemoteHead = remoteHead ? remoteHead.sha : null;
      const overrides = ctx.overrides || new Map();
      const plan = await this.planner.build({
        baseEntries,
        remoteEntries,
        localFiles: scan.files,
        localShas,
        mode: ctx.mode,
        overrides,
        enumErrorOccurred: scan.enumErrorOccurred,
        bootstrap: ctx.bootstrapDownload === true,
      });
      ctx.plan = plan;

      // 6. 合并
      transition(ctx, SyncState.MERGING);
      this._emit("engine:phase", { ctx, state: SyncState.MERGING });
      await this._runMerges(ctx, plan, baseEntries, remoteEntries);

      // 7. 冲突 → 暂停
      if (plan.conflicts.length > 0) {
        await this._saveConflicts(ctx, plan, baseEntries, remoteEntries);
        transition(ctx, SyncState.CONFLICT_PAUSED, "conflicts=" + plan.conflicts.length);
        finish(ctx, {
          state: SyncState.CONFLICT_PAUSED,
          result: {
            paused: true,
            kind: "FILE_CONFLICTS",
            conflictCount: plan.conflicts.length,
            conflicts: plan.conflicts.map((c) => ({ path: c.path, reason: c.reason })),
          },
        });
        return ctx.result;
      }

      // 8. 无远端变更 → 本地应用(可能存在远端领先下载),不创建提交
      const remoteWrites = plan.uploads.length + plan.deletionsRemote.length;
      if (remoteWrites === 0) {
        await this._applyLocalChanges(ctx, plan);
        await this._rebuildManifest(ctx, plan);
        if (remoteHead) {
          await this.metadataStore.setConfirmedCommit(this.config.repoKey, remoteHead.sha, ctx.id);
        }
        transition(ctx, SyncState.SUCCESS, "无远端变更");
        finish(ctx, { state: SyncState.SUCCESS, result: this._result(ctx, remoteHead ? remoteHead.sha : null, plan) });
        return ctx.result;
      }

      // 9. 提交与推送(按平台原子能力分派);全部大文件被跳过时无批次,远端无变化
      transition(ctx, SyncState.COMMITTING);
      this._emit("engine:phase", { ctx, state: SyncState.COMMITTING });
      const { batches, skipped } = this.commitBuilder.build({
        operationId: ctx.id,
        uploads: await this._materializeUploads(ctx, plan),
        deletionsRemote: plan.deletionsRemote,
        provider: this.provider.platform,
      });
      ctx.skippedLarge = skipped;

      let finalSha;
      if (batches.length === 0) {
        finalSha = remoteHead ? remoteHead.sha : null; // 无实际远端写入
      } else if (this.provider.platform === "github") {
        finalSha = await this._pushAtomic(ctx, batches, remoteEntries);
      } else {
        finalSha = await this._pushPerFile(ctx, batches);
      }

      // 10. 远端确认成功 → 应用本地侧变更 → 更新基准与清单
      if (batches.length > 0 && !finalSha) {
        throw new SyncError({
          category: SyncErrorCategory.REMOTE_CHANGED,
          code: "PUSH_UNCONFIRMED",
          operation: "push",
          message: "推送后无法确认远端引用状态,本轮不标记成功",
          retryable: true,
          recoverable: false,
        });
      }
      await this._applyLocalChanges(ctx, plan);
      await this._rebuildManifest(ctx, plan);
      const confirmedSha = finalSha || (remoteHead ? remoteHead.sha : null);
      if (confirmedSha) {
        await this.metadataStore.setConfirmedCommit(this.config.repoKey, confirmedSha, ctx.id);
      }
      transition(ctx, SyncState.SUCCESS);
      finish(ctx, { state: SyncState.SUCCESS, result: this._result(ctx, confirmedSha, plan) });
      return ctx.result;
    } catch (err) {
      const syncErr = err instanceof SyncError ? err : new SyncError({
        category: SyncErrorCategory.UNKNOWN,
        phase: ctx.state,
        message: (err && err.message) || String(err),
        detail: (err && err.stack) || "",
        cause: err,
      });
      syncErr.phase = syncErr.phase || ctx.state;
      ctx.error = syncErr;
      if (ctx.state !== SyncState.CONFLICT_PAUSED) {
        try {
          transition(ctx, SyncState.FAILED);
        } catch (e) {
          ctx.state = SyncState.FAILED;
        }
      }
      finish(ctx, { state: ctx.state, error: syncErr, result: { paused: ctx.state === SyncState.CONFLICT_PAUSED } });
      throw syncErr;
    }
  }

  // ---------- 阶段实现 ----------

  _checkConfig(ctx) {
    if (!ctx.owner || !ctx.repo) {
      throw new SyncError({ category: SyncErrorCategory.REPOSITORY, phase: SyncState.CHECKING, message: "仓库地址未配置或无法解析", recoverable: true });
    }
    if (!ctx.branch) {
      throw new SyncError({ category: SyncErrorCategory.BRANCH, phase: SyncState.CHECKING, message: "分支未配置", recoverable: true });
    }
    if (!this.provider.token) {
      throw new SyncError({ category: SyncErrorCategory.AUTH, phase: SyncState.CHECKING, message: "Token 未配置", recoverable: true });
    }
  }

  async _treeMap(entries) {
    const map = new Map();
    for (const e of entries || []) {
      if (String(e.type).toLowerCase() !== "blob") continue;
      map.set(e.path, { sha: e.sha, type: e.type, size: e.size || 0 });
    }
    return map;
  }

  /**
   * BASE 解析(2.0 方案 §7.3):
   * - 确认基准存在且远端可达 → 使用;
   * - 提交丢失 → 尝试合并基重建;
   * - 无法证明共同祖先 → BASE_UNRESOLVED(不自动选边);
   * - 首次同步: 空仓库(BASE=null)直接进入;远端已有内容则交由首同步向导。
   */
  async _resolveBase(ctx, remoteHeadSha) {
    const repoKey = this.config.repoKey;
    const baseSha = this.metadataStore.getBaseCommit(repoKey);
    if (baseSha) {
      try {
        const baseCommit = await this.provider.getCommit(baseSha);
        return { baseEntries: await this._treeMap(await this.provider.getTree(baseCommit.treeSha)), baseSha };
      } catch (err) {
        const mergeBase = await this.provider.getMergeBase(baseSha, remoteHeadSha);
        if (mergeBase) {
          const mbCommit = await this.provider.getCommit(mergeBase);
          ctx.baseRebuiltFrom = mergeBase;
          return { baseEntries: await this._treeMap(await this.provider.getTree(mbCommit.treeSha)), baseSha: mergeBase };
        }
        return { unresolved: true, reason: "确认基准 " + baseSha.slice(0, 8) + " 在远端不可访问,且找不到共同祖先" };
      }
    }

    // 无确认基准: 首次同步
    let initial = null;
    try {
      initial = await this.provider.getInitialCommit();
    } catch (err) {
      if (err instanceof SyncError && err.httpStatus === 404) initial = null; // 空仓库
      else throw err;
    }
    if (!initial) {
      return { baseEntries: new Map(), baseSha: null }; // 空仓库: 允许首次上传
    }
    // 本地完全为空 → 以下载远端为首次同步的安全路径
    const scan = await this.workspace.scan({ range: this.config.syncRange });
    if (scan.files.length === 0) {
      return { baseEntries: await this._treeMap(await this.provider.getTree(initial.treeSha)), baseSha: initial.sha, bootstrapDownload: true };
    }
    return {
      unresolved: true,
      reason: "首次同步: 本地与远端都有内容,无法证明共同基准,需要通过首同步向导明确选择",
    };
  }

  async _runMerges(ctx, plan, baseEntries, remoteEntries) {
    for (const mergeItem of plan.merges) {
      const path = mergeItem.path;
      const baseBytes = mergeItem.baseSha ? (await this.provider.getBlob(mergeItem.baseSha)).bytes : null;
      const remoteBytes = (await this.provider.getBlob(mergeItem.remoteSha)).bytes;
      const localBytes = await this._readLocalBytes(path);
      const result = await this.merger.merge({
        path,
        base: baseBytes ? { bytes: baseBytes } : null,
        local: { bytes: localBytes },
        remote: { bytes: remoteBytes },
      });
      if (result.merged) {
        // 合并结果先落本地;提交失败时下一轮会把本地合并内容视为本地变更重新上传
        await this.contentAdapter.writeFileBlob(path, new Blob([result.content]), "raw", "update");
        plan.uploads.push({ path, bytes: result.content, op: "update", merged: true });
        plan.unchanged += 0;
      } else {
        plan.conflicts.push({
          path,
          reason: (result.conflicts[0] && result.conflicts[0].reason) || "无法自动合并",
          baseSha: mergeItem.baseSha,
          localSha: await this.provider.gitBlobSha(localBytes),
          remoteSha: mergeItem.remoteSha,
        });
      }
    }
    plan.merges.length = 0;
  }

  async _saveConflicts(ctx, plan, baseEntries, remoteEntries) {
    const conflicts = [];
    for (const c of plan.conflicts) {
      let snapshots = null;
      try {
        const localBytes = await this._readLocalBytes(c.path);
        const remoteBytes = c.remoteSha ? (await this.provider.getBlob(c.remoteSha)).bytes : null;
        const baseBytes = c.baseSha ? (await this.provider.getBlob(c.baseSha)).bytes : null;
        snapshots = {
          localB64: localBytes ? this.provider.bytesToBase64(localBytes) : null,
          remoteB64: remoteBytes ? this.provider.bytesToBase64(remoteBytes) : null,
          baseB64: baseBytes ? this.provider.bytesToBase64(baseBytes) : null,
        };
      } catch (err) {
        snapshots = { localB64: null, remoteB64: null, baseB64: null };
      }
      conflicts.push({ path: c.path, reason: c.reason, baseSha: c.baseSha, localSha: c.localSha, remoteSha: c.remoteSha, snapshots });
    }
    await this.conflictService.saveSet({
      repoKey: this.config.repoKey,
      operationId: ctx.id,
      conflicts,
    });
    ctx.conflicts = conflicts.map((c) => ({ path: c.path, reason: c.reason }));
  }

  /** 读取待上传内容(读取版本 = 提交版本;超限在 CommitBuilder 预检) */
  async _materializeUploads(ctx, plan) {
    const uploads = [];
    for (const item of plan.uploads) {
      if (item.bytes) {
        uploads.push(item);
        continue;
      }
      const format = this._uploadFormat(item.path);
      const blob = await this.contentAdapter.readFileBlob(item.path, format);
      if (!blob) {
        throw new SyncError({
          category: SyncErrorCategory.LOCAL_FILE,
          code: "READ_EMPTY",
          operation: "materializeUploads",
          path: item.path,
          message: "本地文件读取为空,已停止上传: " + item.path,
          retryable: false,
          recoverable: true,
        });
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.length === 0 && /\.sy$/i.test(item.path)) {
        throw new SyncError({
          category: SyncErrorCategory.LOCAL_FILE,
          code: "EMPTY_DOC",
          operation: "materializeUploads",
          path: item.path,
          message: "笔记文件内容为空,拒绝上传: " + item.path,
          retryable: false,
          recoverable: true,
        });
      }
      uploads.push(Object.assign({}, item, { bytes, format }));
    }
    return uploads;
  }

  _uploadFormat(path) {
    // markdown 模式仅影响思源笔记文档,其余文件恒为 raw
    if (this.config.syncFileType === "markdown" && /\.sy$/i.test(path)) return "markdown";
    return "raw";
  }

  /** GitHub: 原子树提交 + 引用 CAS + 回读确认(空仓库时首推创建引用) */
  async _pushAtomic(ctx, batches, remoteEntries) {
    let finalSha = null;
    for (const batch of batches) {
      if (batch.uploads.length === 0 && batch.github.deletePaths.length === 0) continue;
      // 提交前二次读取远端 HEAD(不替代 CAS,仅尽早发现竞争);空仓库允许无头
      let headNow = null;
      try {
        headNow = await this.provider.getBranchHead();
      } catch (err) {
        if (!(err instanceof SyncError && err.httpStatus === 404)) throw err;
      }
      if (headNow) {
        // 规划时无分支、推送时已存在,或规划后前移 → 竞争,本轮不写入
        if (!ctx.expectedRemoteHead || headNow.sha !== ctx.expectedRemoteHead) {
          throw new SyncError({
            category: SyncErrorCategory.REMOTE_CHANGED,
            code: "REMOTE_HEAD_MOVED",
            operation: "prePushCheck",
            message: "远端分支在规划后已变化(" + headNow.sha.slice(0, 8) + "),本轮重新规划",
            retryable: true,
            recoverable: false,
          });
        }
        transition(ctx, SyncState.VERIFYING_REMOTE_HEAD);
        ctx.expectedRemoteHead = headNow.sha;
      }
      const treeBaseSha = headNow ? (await this.provider.getCommit(headNow.sha)).treeSha : null;

      const entries = [];
      for (const upload of batch.uploads) {
        const blobSha = await this.provider.createBlob(upload.bytes);
        entries.push({ path: upload.path, sha: blobSha, mode: "100644" });
      }
      for (const dp of batch.github.deletePaths) {
        entries.push({ path: dp.path, sha: null, mode: "100644" });
      }
      const tree = await this.provider.createTree(treeBaseSha, entries);
      const parentSha = finalSha || (headNow ? headNow.sha : null);
      const commit = await this.provider.createCommit({
        message: batch.message,
        treeSha: tree.sha,
        parents: parentSha ? [parentSha] : [],
      });
      transition(ctx, SyncState.PUSHING);
      if (!headNow) {
        // 空仓库: 创建分支引用并回读确认
        const confirmed = await this.provider.ensureBranchRef(commit.sha);
        finalSha = confirmed.confirmedSha;
        ctx.expectedRemoteHead = finalSha;
      } else {
        try {
          const confirmed = await this.provider.updateBranchRef(commit.sha, { expectedHead: headNow.sha });
          finalSha = confirmed.confirmedSha;
        } catch (err) {
          throw this.provider.mapUpdateRefFailure(err);
        }
      }
    }
    return finalSha;
  }

  /** Gitee: 逐文件写入 + 操作日志 + 部分失败显式化(空仓库由 Gitee 分支参数自动建分支) */
  async _pushPerFile(ctx, batches) {
    let lastHead = "";
    let lastCommitSha = "";
    for (const batch of batches) {
      if (batch.gitee.operations.length === 0) continue;
      if (ctx.state === SyncState.COMMITTING) {
        transition(ctx, SyncState.PUSHING);
      }
      // 部分失败: 不标记成功,交由恢复向导;错误含完整操作日志
      const result = await this.provider.applyFileOperations(batch.gitee.operations, { message: batch.message });
      lastHead = result.remoteHead || lastHead;
      const commits = (result.operations || []).map((o) => o.commitSha).filter(Boolean);
      if (commits.length > 0) lastCommitSha = commits[commits.length - 1];
    }
    if (!lastHead) {
      // 空仓库首推后分支头可能尚未可读 → 回退到本批最后提交(逐文件提交串行,最后提交即分支头)
      lastHead = lastCommitSha;
    }
    if (!lastHead) {
      const head = await this.provider.getBranchHead();
      lastHead = head.sha;
    }
    return lastHead;
  }

  /** 远端确认后应用本地侧变更(下载/本地删除),破坏性动作先备份 */
  async _applyLocalChanges(ctx, plan) {
    const formatOf = (path) => (this.config.syncFileType === "markdown" && /\.sy$/i.test(path) ? "markdown" : "raw");
    for (const item of plan.downloads) {
      const src = await this.provider.getFileContent(item.path, ctx.observedRemoteHead);
      const blob = new Blob([src.bytes]);
      await this.contentAdapter.writeFileBlob(item.path, blob, formatOf(item.path), item.op === "create" ? "create" : "update");
    }
    for (const item of plan.deletionsLocal) {
      await this.contentAdapter.removeFileWithBackup(item.path);
    }
    if (plan.downloads.length > 0 || plan.deletionsLocal.length > 0) {
      await this.contentAdapter.kernel.refreshFiletree().catch(() => {});
    }
  }

  async _rebuildManifest(ctx, plan) {
    const scan = await this.workspace.scan({ range: this.config.syncRange });
    await this.manifestStore.replaceAll(scan.files.map((f) => f.path));
  }

  _result(ctx, sha, plan) {
    return {
      success: true,
      operationId: ctx.id,
      commitSha: sha,
      remoteHead: sha,
      uploads: plan.uploads.length,
      downloads: plan.downloads.length,
      deletionsRemote: plan.deletionsRemote.length,
      deletionsLocal: plan.deletionsLocal.length,
      skippedDeletes: plan.skippedDeletes,
      skippedLarge: ctx.skippedLarge || [],
      unchanged: plan.unchanged,
      conflicts: 0,
    };
  }

  async _readLocalBytes(path) {
    const blob = await this.contentAdapter.kernel.getFile(path);
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  }
}
