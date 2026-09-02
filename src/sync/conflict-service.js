/**
 * ConflictService: 冲突快照持久化与用户决策(2.0 方案 §7.6)。
 * - 冲突出现后保存 base/local/remote 快照(内容或可恢复引用),状态持久化;
 * - 支持: 接受本地/接受远端/标记已解决/导出三方副本/稍后处理;
 * - 「接受」不是无条件覆盖: 引擎基于重新读取的远端 HEAD 重新规划后执行。
 */

import { SyncError, SyncErrorCategory } from "./sync-error.js";

export const CONFLICT_FILE = "sync-conflicts.json";
/** 单文件快照内容上限(超过则只保存引用与提示) */
const SNAPSHOT_BYTE_LIMIT = 5 * 1024 * 1024;

export class ConflictService {
  constructor(plugin) {
    this.plugin = plugin;
    /** @type {Object<string, {repoKey, operationId, createdAt, status, conflicts:Array}>} */
    this.sets = {};
  }

  async load() {
    try {
      const data = await this.plugin.loadData(CONFLICT_FILE);
      if (data && typeof data.sets === "object") this.sets = data.sets;
    } catch (err) {
      // 损坏/缺失时视为无冲突集,但保持可见
      console.warn("[SY-GSP] 冲突集读取失败:", err && err.message);
    }
    return this.sets;
  }

  openSet(repoKey) {
    return Object.values(this.sets).find((s) => s.repoKey === repoKey && s.status === "open") || null;
  }

  allOpenSets() {
    return Object.values(this.sets).filter((s) => s.status === "open");
  }

  /**
   * 保存冲突集(覆盖同仓库已有 open 集)。
   * @param {object} opts {repoKey, operationId, conflicts:[{path, reason, baseSha, localSha, remoteSha,
   *   snapshots:{baseB64,localB64,remoteB64}}]}
   */
  async saveSet(opts) {
    const conflicts = (opts.conflicts || []).map((c) => ({
      path: c.path,
      reason: c.reason || "",
      baseSha: c.baseSha || null,
      localSha: c.localSha || null,
      remoteSha: c.remoteSha || null,
      snapshots: this._capSnapshots(c.snapshots),
      status: "open",
      decision: null,
    }));
    const set = {
      repoKey: opts.repoKey,
      operationId: opts.operationId,
      createdAt: new Date().toISOString(),
      status: "open",
      conflicts,
    };
    // 同仓库仅保留一个 open 集
    for (const [key, s] of Object.entries(this.sets)) {
      if (s.repoKey === opts.repoKey && s.status === "open") s.status = "superseded";
    }
    this.sets[opts.operationId] = set;
    await this._persist();
    return set;
  }

  /** 单文件决策: keep_local | keep_remote | resolved(用户已编辑) */
  async decide(operationId, path, decision) {
    const set = this.sets[operationId];
    if (!set) throw new SyncError({ category: SyncErrorCategory.UNKNOWN, message: "冲突集不存在: " + operationId });
    const item = set.conflicts.find((c) => c.path === path);
    if (!item) throw new SyncError({ category: SyncErrorCategory.UNKNOWN, message: "冲突集不含该文件: " + path });
    item.decision = decision;
    item.status = decision === "later" ? "open" : "decided";
    if (set.conflicts.every((c) => c.status !== "open")) set.status = "decided";
    await this._persist();
  }

  /** 收集一个冲突集的覆盖决策(供引擎重新规划) */
  collectOverrides(operationId) {
    const set = this.sets[operationId];
    if (!set) return new Map();
    const overrides = new Map();
    for (const c of set.conflicts) {
      if (c.decision === "keep_local" || c.decision === "keep_remote") overrides.set(c.path, c.decision);
    }
    return overrides;
  }

  /** 关闭冲突集(本轮已处理完毕) */
  async closeSet(operationId) {
    const set = this.sets[operationId];
    if (set) {
      set.status = "closed";
      await this._persist();
    }
  }

  _capSnapshots(snapshots) {
    if (!snapshots) return null;
    const capped = {};
    for (const key of ["baseB64", "localB64", "remoteB64"]) {
      const v = snapshots[key];
      capped[key] = v && v.length <= SNAPSHOT_BYTE_LIMIT ? v : null;
    }
    capped.truncated = Object.keys(snapshots).some((k) => snapshots[k] && !capped[k]);
    return capped;
  }

  async _persist() {
    try {
      await this.plugin.saveData(CONFLICT_FILE, { sets: this.sets });
    } catch (err) {
      throw new SyncError({
        category: SyncErrorCategory.LOCAL_FILE,
        code: "CONFLICT_SAVE_FAILED",
        operation: "saveConflicts",
        message: "冲突快照保存失败: " + String((err && err.message) || err),
        recoverable: true,
        cause: err,
      });
    }
  }
}
