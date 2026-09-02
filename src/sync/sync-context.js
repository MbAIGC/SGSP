/**
 * SyncContext 与 SyncState。
 * 每次同步创建唯一上下文,不得复用;状态机约束合法转换(见 2.0 方案 §5.1/§5.2)。
 */

export const SyncState = Object.freeze({
  IDLE: "IDLE",
  QUEUED: "QUEUED",
  CHECKING: "CHECKING",
  SNAPSHOTTING_LOCAL: "SNAPSHOTTING_LOCAL",
  FETCHING_REMOTE: "FETCHING_REMOTE",
  RESOLVING_BASE: "RESOLVING_BASE",
  PLANNING: "PLANNING",
  MERGING: "MERGING",
  CONFLICT_PAUSED: "CONFLICT_PAUSED",
  COMMITTING: "COMMITTING",
  VERIFYING_REMOTE_HEAD: "VERIFYING_REMOTE_HEAD",
  PUSHING: "PUSHING",
  RETRYING: "RETRYING",
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
});

/** 合法状态转换表(不在表内的转换一律非法) */
const TRANSITIONS = Object.freeze({
  [SyncState.IDLE]: [SyncState.QUEUED, SyncState.FAILED],
  [SyncState.QUEUED]: [SyncState.CHECKING, SyncState.CANCELLED],
  [SyncState.CHECKING]: [
    SyncState.SNAPSHOTTING_LOCAL,
    SyncState.FAILED,
    SyncState.CANCELLED,
  ],
  [SyncState.SNAPSHOTTING_LOCAL]: [
    SyncState.FETCHING_REMOTE,
    SyncState.FAILED,
    SyncState.CANCELLED,
  ],
  [SyncState.FETCHING_REMOTE]: [
    SyncState.RESOLVING_BASE,
    SyncState.FAILED,
    SyncState.CANCELLED,
  ],
  [SyncState.RESOLVING_BASE]: [
    SyncState.PLANNING,
    SyncState.CONFLICT_PAUSED, // 基准无法恢复 → 阻止写入,等待恢复向导
    SyncState.FAILED,
    SyncState.CANCELLED,
  ],
  [SyncState.PLANNING]: [
    SyncState.MERGING,
    SyncState.SUCCESS, // 本地与远端均无变化
    SyncState.FAILED,
    SyncState.CANCELLED,
  ],
  [SyncState.MERGING]: [
    SyncState.CONFLICT_PAUSED, // 无法自动合并
    SyncState.COMMITTING,
    SyncState.SUCCESS,
    SyncState.FAILED,
    SyncState.CANCELLED,
  ],
  [SyncState.CONFLICT_PAUSED]: [
    SyncState.CHECKING, // 用户决策后重新规划
    SyncState.FAILED,
  ],
  [SyncState.COMMITTING]: [
    SyncState.VERIFYING_REMOTE_HEAD,
    SyncState.PUSHING,
    SyncState.RETRYING,
    SyncState.FAILED,
    SyncState.CANCELLED,
  ],
  [SyncState.VERIFYING_REMOTE_HEAD]: [
    SyncState.PUSHING,
    SyncState.RETRYING,
    SyncState.FAILED,
    SyncState.CANCELLED,
  ],
  [SyncState.PUSHING]: [
    SyncState.SUCCESS,
    SyncState.RETRYING,
    SyncState.COMMITTING, // 多批次提交: 下一批回到提交阶段
    SyncState.VERIFYING_REMOTE_HEAD, // 多批次提交: 下一批重新校验远端 HEAD
    SyncState.FAILED,
    SyncState.CANCELLED,
  ],
  [SyncState.RETRYING]: [
    SyncState.FETCHING_REMOTE,
    SyncState.FAILED,
    SyncState.CANCELLED,
  ],
  [SyncState.SUCCESS]: [SyncState.IDLE],
  [SyncState.FAILED]: [SyncState.IDLE],
  [SyncState.CANCELLED]: [SyncState.IDLE],
});

export function canTransition(from, to) {
  const allowed = TRANSITIONS[from];
  return !!allowed && allowed.indexOf(to) >= 0;
}

/** 触发来源 */
export const SyncTrigger = Object.freeze({
  MANUAL: "manual",
  AUTOMATIC: "automatic",
  STARTUP: "startup",
  RETRY: "retry",
  CONFLICT_RESOLUTION: "conflict_resolution",
  DIAGNOSIS: "diagnosis",
});

/** 同步模式 */
export const SyncMode = Object.freeze({
  AUTO: "auto",
  REMOTE_OVER_LOCAL: "remote_over_local",
  LOCAL_OVER_REMOTE: "local_over_remote",
});

let contextSeq = 0;

/**
 * 创建一次同步的上下文。
 * baseCommit 是双方已确认的共同提交,不是"最后看到的远端提交"。
 */
export function createSyncContext({ trigger, mode, provider, owner, repo, branch }) {
  contextSeq += 1;
  const now = new Date().toISOString();
  return {
    id: "sync-" + Date.now() + "-" + contextSeq,
    trigger: trigger || SyncTrigger.MANUAL,
    mode: mode || SyncMode.AUTO,
    provider: provider || "",
    owner: owner || "",
    repo: repo || "",
    branch: branch || "",
    startedAt: now,
    finishedAt: null,
    phase: SyncState.QUEUED,
    state: SyncState.QUEUED,
    attempt: 0,
    baseCommit: null,
    expectedRemoteHead: null,
    observedRemoteHead: null,
    localSnapshotId: null,
    plan: null,
    result: null,
    error: null,
    conflicts: [],
    /** @type {Array<{state:string, at:string, note:string}>} 状态流转轨迹(内存,不持久化) */
    trail: [],
  };
}

/** 推进状态;非法转换抛出错误(由引擎兜底为 FAILED) */
export function transition(ctx, to, note = "") {
  if (!canTransition(ctx.state, to)) {
    const err = new Error(
      "非法状态转换: " + ctx.state + " -> " + to + (note ? " (" + note + ")" : "")
    );
    err.illegalTransition = true;
    err.fromState = ctx.state;
    err.toState = to;
    throw err;
  }
  ctx.trail.push({ state: to, at: new Date().toISOString(), note });
  ctx.state = to;
  if (to !== SyncState.SUCCESS && to !== SyncState.FAILED && to !== SyncState.CANCELLED) {
    ctx.phase = to;
  }
  return ctx;
}

/** 结束上下文(成功/失败/取消),记录 finishedAt 与结果 */
export function finish(ctx, { state, result, error }) {
  ctx.finishedAt = new Date().toISOString();
  ctx.state = state;
  ctx.result = result || null;
  ctx.error = error || null;
  return ctx;
}
