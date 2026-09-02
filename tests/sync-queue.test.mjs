import test from "node:test";
import assert from "node:assert/strict";
import { SyncQueue } from "../src/sync/sync-queue.js";

test("同键任务严格串行", async () => {
  const queue = new SyncQueue();
  const order = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const p1 = queue.enqueue("k", async () => {
    order.push("1-start");
    await sleep(20);
    order.push("1-end");
    return "r1";
  });
  const p2 = queue.enqueue("k", async () => {
    order.push("2-start");
    return "r2";
  });
  const [a, b] = await Promise.all([p1, p2]);
  assert.deepEqual(order, ["1-start", "1-end", "2-start"]);
  assert.equal(a.result, "r1");
  assert.equal(b.result, "r2");
});

test("运行中可合并触发(自动同步)不会排队", async () => {
  const queue = new SyncQueue();
  let release;
  const gate = new Promise((r) => (release = r));
  const running = queue.enqueue("k", async () => gate, {});
  const merged = await queue.enqueue("k", async () => "should-not-run", { mergeable: true });
  assert.equal(merged.merged, true);
  release("done");
  assert.equal((await running).result, "done");
});

test("前序失败不阻塞后续任务", async () => {
  const queue = new SyncQueue();
  const first = queue.enqueue("k", async () => {
    throw new Error("boom");
  });
  await assert.rejects(first, /boom/);
  const second = await queue.enqueue("k", async () => "ok");
  assert.equal(second.result, "ok");
});

test("不同键并行", async () => {
  const queue = new SyncQueue();
  let releaseA;
  const gate = new Promise((r) => (releaseA = r));
  const a = queue.enqueue("A", async () => gate);
  const b = await queue.enqueue("B", async () => "b-done");
  assert.equal(b.result, "b-done");
  releaseA("a-done");
  assert.equal((await a).result, "a-done");
});

test("keyOf 格式", () => {
  assert.equal(SyncQueue.keyOf({ provider: "github", owner: "o", repo: "r", branch: "b" }), "github:o/r:b");
});
