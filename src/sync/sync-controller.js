/**
 * SyncController: 入口编排(2.0 方案 §3)。
 * - 唯一对外入口: 手动/自动/启动/重试/冲突解决 都经过这里;
 * - 持有 SyncQueue(同仓库分支串行)、RetryPolicy(有限重试)、通知策略;
 * - 冲突暂停状态持久化,重启后仍保持,直到用户处理;
 * - 不直接接触 Git API 细节与文件合并细节。
 */

import { SyncQueue } from "./sync-queue.js";
import { RetryPolicy } from "./retry-policy.js";
import { SyncEngine } from "./sync-engine.js";
import { createSyncContext, SyncState, SyncTrigger, SyncMode, transition } from "./sync-context.js";
import { SyncError, SyncErrorCategory, toSyncError, classifyError } from "./sync-error.js";

export const ENGINE_STATE_FILE = "engine-state.json";

export class SyncController {
  /**
   * @param {object} deps {
   *   plugin, settings, events, notify, i18n,
   *   makeEngineDeps: (ctx) => {provider, workspace, contentAdapter, metadataStore,
   *     manifestStore, conflictService, planner, merger, commitBuilder, events, config},
   *   repoInfo: () => {provider, owner, repo, branch, token},
   *   autoSync: {pause(), resume(), markAutoTick()}
   * }
   */
  constructor(deps) {
    this.plugin = deps.plugin;
    this.settings = deps.settings;
    this.events = deps.events;
    this.notify = deps.notify;
    this.i18n = deps.i18n || ((k, fb) => fb);
    this.makeEngineDeps = deps.makeEngineDeps;
    this.repoInfo = deps.repoInfo;
    this.autoSync = deps.autoSync;
    this.queue = new SyncQueue();
    this.retryPolicy = new RetryPolicy({ enabled: false });
    this.state = SyncState.IDLE;
    this.lastContext = null;
    this.conflictPaused = null; // {kind, repoKey, operationId, reason, conflictCount}
    this.autoTick = false;
    this._autoSkipNotified = false;
    this.retryTimer = null;
  }

  /** 恢复持久化的冲突暂停状态(onload) */
  async restore() {
    try {
      const saved = await this.plugin.loadData(ENGINE_STATE_FILE);
      if (saved && saved.conflictPaused) {
        this.conflictPaused = saved.conflictPaused;
        this.state = SyncState.CONFLICT_PAUSED;
        this.events.emit("state:changed", { state: this.state, conflictPaused: this.conflictPaused });
      }
    } catch (err) {
      console.warn("[SY-GSP] 恢复暂停状态失败:", err && err.message);
    }
  }

  _persistState() {
    const payload = this.conflictPaused
      ? { conflictPaused: this.conflictPaused }
      : {};
    this.plugin.saveData(ENGINE_STATE_FILE, payload).catch((err) => {
      this.notify(this.i18n("sygspPersistFailed", "⚠️ 状态保存失败,重启后可能丢失暂停状态"), "error");
      console.warn("[SY-GSP] 状态持久化失败:", err && err.message);
    });
  }

  /** 自动同步定时器回调前打标: 区分定时触发与手动触发 */
  markAutoTick() {
    this.autoTick = true;
  }

  isConflictPaused() {
    return !!this.conflictPaused;
  }

  /**
   * 发起一次同步。
   * @param {object} opts {trigger, mode, overrides(Map), resolutionOf?}
   */
  async syncNow({ trigger = SyncTrigger.MANUAL, mode = SyncMode.AUTO, overrides = null } = {}) {
    const info = this.repoInfo();
    const key = SyncQueue.keyOf(info);

    if (this.conflictPaused) {
      const isResolution = overrides !== null || mode !== SyncMode.AUTO;
      if (!isResolution) {
        const wasAuto = this.autoTick;
        this.autoTick = false;
        if (wasAuto) {
          if (!this._autoSkipNotified) {
            this._autoSkipNotified = true;
            this.notify(this.i18n("sygspPausedMsg", "⚠️ 同步冲突未处理,自动同步已暂停,请先处理冲突"), "error");
          }
          return { skipped: true };
        }
        // 手动触发: 重新打开冲突处理入口
        this.events.emit("conflict:reopen", { conflictPaused: this.conflictPaused });
        return { skipped: true, conflict: true };
      }
    }
    this.autoTick = false;

    const ctx = createSyncContext({
      trigger,
      mode: this.conflictPaused && overrides ? SyncMode.AUTO : mode,
      provider: info.provider,
      owner: info.owner,
      repo: info.repo,
      branch: info.branch,
    });
    if (overrides) ctx.overrides = overrides;

    return this.queue.enqueue(
      key,
      () => this._runWithRetry(ctx),
      { mergeable: trigger === SyncTrigger.AUTOMATIC, label: ctx.id }
    );
  }

  async _runWithRetry(ctx) {
    // 状态机由引擎推进;控制器只镜像展示状态
    this.state = ctx.state;
    this.lastContext = ctx;
    this.events.emit("state:changed", { state: this.state, ctx });

    let attempt = 0;
    for (;;) {
      try {
        const engine = new SyncEngine(this.makeEngineDeps(ctx));
        const result = await engine.run(ctx);
        if (result && result.paused) {
          // 冲突/基准暂停: 引擎已结束上下文,不作为成功处理
          await this._onFailed(ctx, new SyncError({
            category: SyncErrorCategory.CONFLICT,
            code: result.kind,
            phase: ctx.state,
            message: (ctx.conflicts && ctx.conflicts[0] && (ctx.conflicts[0].reason || ctx.conflicts[0].detail)) || "同步已暂停",
          }));
          return result;
        }
        await this._onFinished(ctx, result);
        return result;
      } catch (err) {
        const syncErr = err instanceof SyncError ? err : toSyncError(err, { phase: ctx.state });
        const decision = this.retryPolicy.decide(syncErr, attempt);
        if (!decision.retry || ctx.state === SyncState.CONFLICT_PAUSED) {
          await this._onFailed(ctx, syncErr);
          throw syncErr;
        }
        attempt += 1;
        ctx.attempt = attempt;
        try {
          transition(ctx, SyncState.RETRYING);
        } catch (e) {
          ctx.state = SyncState.RETRYING;
        }
        this.events.emit("state:changed", { state: SyncState.RETRYING, ctx });
        this.notify(
          this.i18n("sygspRetrying", "⚠️ 同步失败,准备重试") +
            " (" + attempt + "/" + (decision.replan ? 2 : 3) + "): " + syncErr.message,
          "error"
        );
        if (decision.delayMs > 0) {
          await new Promise((resolve) => {
            this.retryTimer = setTimeout(resolve, decision.delayMs);
          });
        }
        // 重新规划: 以全新上下文重跑,不复用旧 tree/commit
        ctx = createSyncContext({
          trigger: SyncTrigger.RETRY,
          mode: ctx.mode,
          provider: ctx.provider,
          owner: ctx.owner,
          repo: ctx.repo,
          branch: ctx.branch,
        });
        ctx.attempt = attempt;
        this.lastContext = ctx;
      }
    }
  }

  async _onFinished(ctx, result) {
    this.state = SyncState.SUCCESS;
    if (this.conflictPaused) {
      this.conflictPaused = null;
      this._autoSkipNotified = false;
      this._persistState();
      this.autoSync.resume();
      this.notify(this.i18n("sygspResolvedMsg", "✅ 冲突已处理,自动同步已恢复"), "info");
    }
    this.events.emit("state:changed", { state: this.state, ctx });
    this.events.emit("sync:success", { ctx, result });
  }

  async _onFailed(ctx, syncErr) {
    if (ctx.state === SyncState.CONFLICT_PAUSED) {
      const kind = ctx.baseUnresolved ? "BASE_UNRESOLVED" : "FILE_CONFLICTS";
      this.conflictPaused = {
        kind,
        repoKey: this.repoKey(),
        operationId: ctx.id,
        reason: kind === "BASE_UNRESOLVED" ? (ctx.conflicts[0] && ctx.conflicts[0].detail) || "基准无法解析" : "存在未处理冲突",
        conflictCount: kind === "FILE_CONFLICTS" ? (ctx.conflicts || []).length : 0,
      };
      this._persistState();
      this.autoSync.pause();
      this.state = SyncState.CONFLICT_PAUSED;
      this.events.emit("state:changed", { state: this.state, ctx, conflictPaused: this.conflictPaused });
      this.events.emit("sync:conflict", { ctx, conflictPaused: this.conflictPaused });
      return;
    }
    this.state = SyncState.FAILED;
    this.events.emit("state:changed", { state: this.state, ctx, error: syncErr });
    this.events.emit("sync:error", { ctx, error: syncErr });
  }

  repoKey() {
    const info = this.repoInfo();
    return SyncQueue.keyOf(info);
  }

  /** 用户冲突决策: 逐文件 keep_local/keep_remote → 重新规划执行 */
  async resolveConflicts(decisions) {
    const overrides = new Map(Object.entries(decisions || {}));
    if (this.conflictPaused && this.conflictPaused.kind === "BASE_UNRESOLVED") {
      // 基准恢复: decisions = {__base__: "keep_local"|"keep_remote"}
      return this._resolveBaseUnresolved(overrides);
    }
    return this.syncNow({ trigger: SyncTrigger.CONFLICT_RESOLUTION, overrides });
  }

  /** 基准失效恢复: 明确选择一方为新基准后执行一次强制方向同步 */
  async _resolveBaseUnresolved(overrides) {
    const choice = overrides.get("__base__");
    if (choice !== "keep_local" && choice !== "keep_remote") {
      throw new SyncError({
        category: SyncErrorCategory.UNKNOWN,
        message: "基准恢复需要明确选择 keep_local 或 keep_remote",
        recoverable: true,
      });
    }
    const mode = choice === "keep_local" ? SyncMode.LOCAL_OVER_REMOTE : SyncMode.REMOTE_OVER_LOCAL;
    const result = await this.syncNow({ trigger: SyncTrigger.CONFLICT_RESOLUTION, mode });
    if (result && result.result && result.result.success) {
      await this.plugin.saveData(ENGINE_STATE_FILE, {});
      this.conflictPaused = null;
      this._persistState();
    }
    return result;
  }

  dismissConflictPause() {
    this.conflictPaused = null;
    this._persistState();
    this.events.emit("state:changed", { state: this.state });
  }

  destroy() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }
}
