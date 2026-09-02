import test from "node:test";
import assert from "node:assert/strict";
import { CommitBuilder } from "../src/sync/commit-builder.js";

test("单批次: 消息含操作ID与统计", async () => {
  const b = new CommitBuilder({});
  const result = await b.build({
    operationId: "op-1",
    uploads: [{ path: "a.md", op: "create", bytes: new Uint8Array(10) }],
    deletionsRemote: [{ path: "b.md" }],
    provider: "github",
  });
  assert.equal(result.batches.length, 1);
  assert.equal(result.batches[0].part, 1);
  assert.equal(result.batches[0].total, 1);
  assert.match(result.batches[0].message, /sync: create 1, update 0, delete 1 \[op-1 part 1\/1\]/);
  assert.equal(result.skipped.length, 0);
});

test("超过单请求上限的大文件被跳过并记录", async () => {
  const b = new CommitBuilder({ requestLimit: 10 });
  const result = await b.build({
    operationId: "op-2",
    uploads: [{ path: "big.bin", bytes: new Uint8Array(100) }],
  });
  assert.equal(result.batches.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].path, "big.bin");
  assert.equal(result.skipped[0].reason, "LARGE_FILE");
});

test("多批次: 按体积分批并标注 part i/N", async () => {
  const b = new CommitBuilder({ requestLimit: 4096, batchByteLimit: 100 });
  const uploads = [];
  for (let i = 0; i < 30; i++) uploads.push({ path: "f" + i + ".md", bytes: new Uint8Array(40) });
  const result = await b.build({ operationId: "op-3", uploads, deletionsRemote: [] });
  assert.ok(result.batches.length >= 3);
  for (const batch of result.batches) {
    assert.equal(batch.total, result.batches.length);
    assert.match(batch.message, new RegExp("part " + batch.part + "/" + result.batches.length));
  }
  const paths = result.batches.flatMap((b2) => b2.uploads.map((u) => u.path));
  assert.equal(paths.length, 30);
});

test("GitHub 载荷: entries 带路径与模式, 删除为 sha:null", async () => {
  const b = new CommitBuilder({});
  const result = await b.build({
    operationId: "op-4",
    provider: "github",
    uploads: [{ path: "a.md", bytes: new TextEncoder().encode("hi") }],
    deletionsRemote: [{ path: "b.md", remoteSha: "sha-b" }],
  });
  const gh = result.batches[0].github;
  assert.equal(gh.entries.length, 1);
  assert.equal(gh.entries[0].path, "a.md");
  assert.equal(gh.entries[0].mode, "100644");
  assert.deepEqual(gh.deletePaths, [{ path: "b.md", sha: "sha-b" }]);
});

test("Gitee 载荷: create/update/delete 操作序列", async () => {
  const b = new CommitBuilder({});
  const result = await b.build({
    operationId: "op-5",
    provider: "gitee",
    uploads: [
      { path: "new.md", op: "create", bytes: new TextEncoder().encode("n") },
      { path: "upd.md", op: "update", bytes: new TextEncoder().encode("u") },
    ],
    deletionsRemote: [{ path: "del.md", remoteSha: "sha-d" }],
  });
  const ops = result.batches[0].gitee.operations;
  assert.deepEqual(ops.map((o) => o.type || o.op), ["create", "update", "delete"]);
  assert.equal(ops[2].remoteSha, "sha-d");
});
