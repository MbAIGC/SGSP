import test from "node:test";
import assert from "node:assert/strict";
import { SyncState, canTransition, createSyncContext, transition, finish } from "../src/sync/sync-context.js";

test("合法主链路: QUEUED → CHECKING → … → SUCCESS → IDLE", () => {
  const ctx = createSyncContext({ trigger: "manual", provider: "github", owner: "o", repo: "r", branch: "b" });
  assert.equal(ctx.state, SyncState.QUEUED);
  transition(ctx, SyncState.CHECKING);
  transition(ctx, SyncState.SNAPSHOTTING_LOCAL);
  transition(ctx, SyncState.FETCHING_REMOTE);
  transition(ctx, SyncState.RESOLVING_BASE);
  transition(ctx, SyncState.PLANNING);
  transition(ctx, SyncState.MERGING);
  transition(ctx, SyncState.COMMITTING);
  transition(ctx, SyncState.VERIFYING_REMOTE_HEAD);
  transition(ctx, SyncState.PUSHING);
  transition(ctx, SyncState.SUCCESS);
  assert.equal(ctx.state, SyncState.SUCCESS);
  transition(ctx, SyncState.IDLE);
  assert.ok(ctx.trail.length >= 10);
});

test("非法转换抛错: IDLE → COMMITTING 不允许", () => {
  const ctx = createSyncContext({ trigger: "manual" });
  assert.throws(() => transition(ctx, SyncState.COMMITTING), /非法状态转换/);
});

test("MERGING → CONFLICT_PAUSED 合法;CONFLICT_PAUSED → CHECKING 用于重新规划", () => {
  assert.ok(canTransition(SyncState.MERGING, SyncState.CONFLICT_PAUSED));
  assert.ok(canTransition(SyncState.CONFLICT_PAUSED, SyncState.CHECKING));
  assert.ok(!canTransition(SyncState.CONFLICT_PAUSED, SyncState.PUSHING));
});

test("RESOLVING_BASE → CONFLICT_PAUSED 用于基准失效阻断", () => {
  assert.ok(canTransition(SyncState.RESOLVING_BASE, SyncState.CONFLICT_PAUSED));
});

test("多批次: PUSHING → VERIFYING_REMOTE_HEAD 与 PUSHING → COMMITTING 合法", () => {
  assert.ok(canTransition(SyncState.PUSHING, SyncState.VERIFYING_REMOTE_HEAD));
  assert.ok(canTransition(SyncState.PUSHING, SyncState.COMMITTING));
});

test("finish 记录结果与时间", () => {
  const ctx = createSyncContext({ trigger: "manual" });
  finish(ctx, { state: SyncState.FAILED, error: new Error("x"), result: null });
  assert.equal(ctx.state, SyncState.FAILED);
  assert.ok(ctx.finishedAt);
});
