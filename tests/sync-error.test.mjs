import test from "node:test";
import assert from "node:assert/strict";
import { SyncError, SyncErrorCategory, classifyError, toSyncError, redact, extractConflicts } from "../src/sync/sync-error.js";

test("classifyError: HTTP 401 → AUTH", () => {
  const c = classifyError(Object.assign(new Error("x"), { status: 401 }));
  assert.equal(c.category, SyncErrorCategory.AUTH);
  assert.equal(c.retryable, false);
});

test("classifyError: 404 按内容区分仓库/分支", () => {
  const repo = classifyError(Object.assign(new Error("Not Found"), { status: 404, response: { data: { message: "Git Repository not found" } } }));
  assert.equal(repo.category, SyncErrorCategory.REPOSITORY);
  const branch = classifyError(Object.assign(new Error("branch not found"), { status: 404, response: { data: { message: "Branch not found" } } }));
  assert.equal(branch.category, SyncErrorCategory.BRANCH);
});

test("classifyError: 409/422 → PUSH_REJECTED 可重试", () => {
  const c = classifyError(Object.assign(new Error("Update is not a fast forward"), { status: 422 }));
  assert.equal(c.category, SyncErrorCategory.PUSH_REJECTED);
  assert.equal(c.retryable, true);
});

test("classifyError: 超时与网络文案", () => {
  assert.equal(classifyError(new Error("Request timeout")).category, SyncErrorCategory.TIMEOUT);
  assert.equal(classifyError(new Error("fetch failed: getaddrinfo ENOTFOUND api.github.com")).category, SyncErrorCategory.NETWORK);
});

test("classifyError: 沿 cause 链归类并保留 SyncError 分类", () => {
  const inner = new SyncError({ category: SyncErrorCategory.AUTH, message: "Token 无效" });
  const outer = new Error("请求失败");
  outer.cause = inner;
  const c = classifyError(outer);
  assert.equal(c.category, SyncErrorCategory.AUTH);
  assert.equal(c.message, "Token 无效");
});

test("redact: 隐藏 token/authorization/bearer", () => {
  const text = 'Authorization: token abc123 "password": hunter2 Bearer xyz789';
  const out = redact(text);
  assert.ok(!out.includes("abc123"));
  assert.ok(!out.includes("hunter2"));
  assert.ok(!out.includes("xyz789"));
});

test("extractConflicts: 收集 cause 链上的全部冲突", () => {
  const a = new SyncError({ category: SyncErrorCategory.CONFLICT, path: "a.md", code: 300 });
  const b = new SyncError({ category: SyncErrorCategory.CONFLICT, path: "b.md", code: 300, cause: a });
  const list = extractConflicts(b);
  assert.deepEqual(list.map((c) => c.path).sort(), ["a.md", "b.md"]);
});

test("toSyncError: 任意错误 → SyncError 并保留 cause", () => {
  const err = toSyncError(new Error("boom"), { operation: "op", phase: "PLANNING" });
  assert.ok(err instanceof SyncError);
  assert.equal(err.operation, "op");
  assert.ok(err.cause instanceof Error);
  assert.equal(err.category, SyncErrorCategory.UNKNOWN);
});
