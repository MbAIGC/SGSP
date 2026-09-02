import test from "node:test";
import assert from "node:assert/strict";
import { RetryPolicy, DEFAULT_RETRYABLE_CATEGORIES } from "../src/sync/retry-policy.js";
import { SyncError, SyncErrorCategory } from "../src/sync/sync-error.js";

const err = (category) => new SyncError({ category, message: "x", retryable: true });

test("默认关闭重试", () => {
  const p = new RetryPolicy({});
  assert.equal(p.decide(err(SyncErrorCategory.NETWORK), 0).retry, false);
});

test("开启后: 网络类最多 3 次(attempt 0..2)", () => {
  const p = new RetryPolicy({ enabled: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    const d = p.decide(err(SyncErrorCategory.NETWORK), attempt);
    assert.equal(d.retry, true, "attempt " + attempt);
    assert.ok(d.delayMs >= 1000);
  }
  assert.equal(p.decide(err(SyncErrorCategory.NETWORK), 3).retry, false);
});

test("开启后: REMOTE_CHANGED/PUSH_REJECTED 最多 2 次并要求重新规划", () => {
  const p = new RetryPolicy({ enabled: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    const d = p.decide(err(SyncErrorCategory.REMOTE_CHANGED), attempt);
    assert.equal(d.retry, true);
    assert.equal(d.replan, true);
    assert.equal(d.delayMs, 0);
  }
  assert.equal(p.decide(err(SyncErrorCategory.PUSH_REJECTED), 2).retry, false);
});

test("冲突/鉴权/仓库类错误永不自动重试", () => {
  const p = new RetryPolicy({ enabled: true });
  for (const category of [SyncErrorCategory.CONFLICT, SyncErrorCategory.AUTH, SyncErrorCategory.REPOSITORY, SyncErrorCategory.LARGE_FILE]) {
    assert.equal(p.decide(err(category), 0).retry, false, category);
  }
});

test("错误标记 retryable=false 时不重试", () => {
  const p = new RetryPolicy({ enabled: true });
  const e = new SyncError({ category: SyncErrorCategory.NETWORK, message: "x", retryable: false });
  assert.equal(p.decide(e, 0).retry, false);
});

test("可重试分类集合", () => {
  assert.ok(DEFAULT_RETRYABLE_CATEGORIES.includes(SyncErrorCategory.NETWORK));
  assert.ok(DEFAULT_RETRYABLE_CATEGORIES.includes(SyncErrorCategory.TIMEOUT));
  assert.ok(DEFAULT_RETRYABLE_CATEGORIES.includes(SyncErrorCategory.REMOTE_CHANGED));
  assert.ok(DEFAULT_RETRYABLE_CATEGORIES.includes(SyncErrorCategory.PUSH_REJECTED));
});
