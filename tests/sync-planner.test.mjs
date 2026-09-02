import test from "node:test";
import assert from "node:assert/strict";
import { SyncPlanner } from "../src/sync/sync-planner.js";

function plannerWith(guardAllow = true) {
  return new SyncPlanner({
    readLocal: async () => ({ bytes: new TextEncoder().encode("local") }),
    readRemoteBlobBySha: async (sha) => ({ bytes: new TextEncoder().encode("remote:" + sha) }),
    guardLocalDelete: async () => ({ allow: guardAllow, reasons: guardAllow ? [] : ["本地清单中不存在该文件"] }),
  });
}

const entry = (sha) => ({ sha, type: "blob", size: 3 });

test("双方均无新增/无变化 → 不动作", async () => {
  const p = plannerWith();
  const plan = await p.build({
    baseEntries: new Map([["a.md", entry("S0")]]),
    remoteEntries: new Map([["a.md", entry("S0")]]),
    localFiles: [{ path: "a.md", name: "a.md", updated: 1 }],
    localShas: new Map([["a.md", "S0"]]),
  });
  assert.equal(plan.unchanged, 1);
  assert.equal(plan.uploads.length + plan.downloads.length + plan.conflicts.length, 0);
});

test("本地新增、远端无 → upload create", async () => {
  const p = plannerWith();
  const plan = await p.build({
    remoteEntries: new Map(),
    localFiles: [{ path: "new.md" }],
    localShas: new Map([["new.md", "SL"]]),
  });
  assert.deepEqual(plan.uploads, [{ path: "new.md", op: "create" }]);
});

test("远端新增、本地无 → download create", async () => {
  const p = plannerWith();
  const plan = await p.build({
    remoteEntries: new Map([["r.md", entry("SR")]]),
    localFiles: [],
    localShas: new Map(),
  });
  assert.deepEqual(plan.downloads, [{ path: "r.md", op: "create" }]);
});

test("双方同时新增且不同 → 冲突", async () => {
  const p = plannerWith();
  const plan = await p.build({
    remoteEntries: new Map([["both.md", entry("SR")]]),
    localFiles: [{ path: "both.md" }],
    localShas: new Map([["both.md", "SL"]]),
  });
  assert.equal(plan.conflicts.length, 1);
  assert.match(plan.conflicts[0].reason, /同时新增/);
});

test("双方同时新增且内容一致 → 无动作", async () => {
  const p = plannerWith();
  const plan = await p.build({
    remoteEntries: new Map([["both.md", entry("SAME")]]),
    localFiles: [{ path: "both.md" }],
    localShas: new Map([["both.md", "SAME"]]),
  });
  assert.equal(plan.unchanged, 1);
  assert.equal(plan.conflicts.length, 0);
});

test("本地未变、远端变更 → download update", async () => {
  const p = plannerWith();
  const plan = await p.build({
    baseEntries: new Map([["f.md", entry("S0")]]),
    remoteEntries: new Map([["f.md", entry("S1")]]),
    localFiles: [{ path: "f.md" }],
    localShas: new Map([["f.md", "S0"]]),
  });
  assert.deepEqual(plan.downloads, [{ path: "f.md", op: "update" }]);
});

test("本地变更、远端未变 → upload update", async () => {
  const p = plannerWith();
  const plan = await p.build({
    baseEntries: new Map([["f.md", entry("S0")]]),
    remoteEntries: new Map([["f.md", entry("S0")]]),
    localFiles: [{ path: "f.md" }],
    localShas: new Map([["f.md", "S2"]]),
  });
  assert.deepEqual(plan.uploads, [{ path: "f.md", op: "update" }]);
});

test("双方变更但结果一致 → upload update(幂等同步)", async () => {
  const p = plannerWith();
  const plan = await p.build({
    baseEntries: new Map([["f.md", entry("S0")]]),
    remoteEntries: new Map([["f.md", entry("S1")]]),
    localFiles: [{ path: "f.md" }],
    localShas: new Map([["f.md", "S1"]]),
  });
  assert.deepEqual(plan.uploads, [{ path: "f.md", op: "update" }]);
  assert.equal(plan.conflicts.length, 0);
});

test("双方变更且不同(文本) → 三方合并", async () => {
  const p = plannerWith();
  const plan = await p.build({
    baseEntries: new Map([["f.md", entry("S0")]]),
    remoteEntries: new Map([["f.md", entry("S1")]]),
    localFiles: [{ path: "f.md" }],
    localShas: new Map([["f.md", "S2"]]),
  });
  assert.deepEqual(plan.merges, [{ path: "f.md", baseSha: "S0", remoteSha: "S1" }]);
});

test("双方变更且不同(二进制) → 冲突不合并", async () => {
  const p = plannerWith();
  const plan = await p.build({
    baseEntries: new Map([["img.png", entry("S0")]]),
    remoteEntries: new Map([["img.png", entry("S1")]]),
    localFiles: [{ path: "img.png" }],
    localShas: new Map([["img.png", "S2"]]),
  });
  assert.equal(plan.merges.length, 0);
  assert.equal(plan.conflicts.length, 1);
  assert.match(plan.conflicts[0].reason, /二进制/);
});

test("本地删除、远端未变且守卫通过 → delete_remote", async () => {
  const p = plannerWith(true);
  const plan = await p.build({
    baseEntries: new Map([["gone.md", entry("S0")]]),
    remoteEntries: new Map([["gone.md", entry("S0")]]),
    localFiles: [],
    localShas: new Map(),
  });
  assert.deepEqual(plan.deletionsRemote, [{ path: "gone.md", remoteSha: "S0" }]);
});

test("本地删除但删除守卫拒绝 → 跳过并记录原因(绝不误删远端)", async () => {
  const p = plannerWith(false);
  const plan = await p.build({
    baseEntries: new Map([["gone.md", entry("S0")]]),
    remoteEntries: new Map([["gone.md", entry("S0")]]),
    localFiles: [],
    localShas: new Map(),
  });
  assert.equal(plan.deletionsRemote.length, 0);
  assert.equal(plan.skippedDeletes.length, 1);
  assert.ok(plan.skippedDeletes[0].reasons.length > 0);
});

test("本地删除、远端有修改 → 冲突", async () => {
  const p = plannerWith(true);
  const plan = await p.build({
    baseEntries: new Map([["gone.md", entry("S0")]]),
    remoteEntries: new Map([["gone.md", entry("S1")]]),
    localFiles: [],
    localShas: new Map(),
  });
  assert.equal(plan.conflicts.length, 1);
  assert.match(plan.conflicts[0].reason, /本地删除但远端有修改/);
});

test("远端删除、本地未变 → delete_local", async () => {
  const p = plannerWith();
  const plan = await p.build({
    baseEntries: new Map([["gone.md", entry("S0")]]),
    remoteEntries: new Map(),
    localFiles: [{ path: "gone.md" }],
    localShas: new Map([["gone.md", "S0"]]),
  });
  assert.deepEqual(plan.deletionsLocal, [{ path: "gone.md" }]);
});

test("远端删除、本地有修改 → 冲突(不静默覆盖本地)", async () => {
  const p = plannerWith();
  const plan = await p.build({
    baseEntries: new Map([["gone.md", entry("S0")]]),
    remoteEntries: new Map(),
    localFiles: [{ path: "gone.md" }],
    localShas: new Map([["gone.md", "S9"]]),
  });
  assert.equal(plan.conflicts.length, 1);
  assert.match(plan.conflicts[0].reason, /本地有修改但远端已删除/);
});

test("枚举异常时阻止一切远端删除", async () => {
  const p = plannerWith(true);
  const plan = await p.build({
    baseEntries: new Map([["gone.md", entry("S0")]]),
    remoteEntries: new Map([["gone.md", entry("S0")]]),
    localFiles: [],
    localShas: new Map(),
    enumErrorOccurred: true,
  });
  assert.equal(plan.deletionsRemote.length, 0);
  assert.equal(plan.skippedDeletes.length, 1);
});

test("覆盖决策: keep_local → 本地存在则上传/本地删除则删远端", async () => {
  const p = plannerWith(true);
  const plan1 = await p.build({
    baseEntries: new Map([["a.md", entry("S0")]]),
    remoteEntries: new Map([["a.md", entry("S1")]]),
    localFiles: [{ path: "a.md" }],
    localShas: new Map([["a.md", "S2"]]),
    overrides: new Map([["a.md", "keep_local"]]),
  });
  assert.equal(plan1.uploads.length, 1);
  const plan2 = await p.build({
    baseEntries: new Map([["a.md", entry("S0")]]),
    remoteEntries: new Map([["a.md", entry("S1")]]),
    localFiles: [],
    localShas: new Map(),
    overrides: new Map([["a.md", "keep_local"]]),
  });
  assert.equal(plan2.deletionsRemote.length, 1);
});

test("覆盖决策: keep_remote → 本地存在则下载/远端删除则删本地", async () => {
  const p = plannerWith(true);
  const plan1 = await p.build({
    baseEntries: new Map([["a.md", entry("S0")]]),
    remoteEntries: new Map([["a.md", entry("S1")]]),
    localFiles: [{ path: "a.md" }],
    localShas: new Map([["a.md", "S2"]]),
    overrides: new Map([["a.md", "keep_remote"]]),
  });
  assert.equal(plan1.downloads.length, 1);
  const plan2 = await p.build({
    baseEntries: new Map([["a.md", entry("S0")]]),
    remoteEntries: new Map(),
    localFiles: [{ path: "a.md" }],
    localShas: new Map([["a.md", "S2"]]),
    overrides: new Map([["a.md", "keep_remote"]]),
  });
  assert.equal(plan2.deletionsLocal.length, 1);
});

test("强制方向: remote_over_local 全部 keep_remote", async () => {
  const p = plannerWith(true);
  const plan = await p.build({
    baseEntries: new Map([["a.md", entry("S0")]]),
    remoteEntries: new Map([["a.md", entry("S1")], ["b.md", entry("SR")]]),
    localFiles: [{ path: "a.md" }, { path: "c.md" }],
    localShas: new Map([["a.md", "S2"], ["c.md", "SC"]]),
    mode: "remote_over_local",
  });
  assert.ok(plan.downloads.some((d) => d.path === "a.md" && d.op === "update"));
  assert.ok(plan.downloads.some((d) => d.path === "b.md" && d.op === "create"));
  assert.ok(plan.deletionsLocal.some((d) => d.path === "c.md"));
  assert.equal(plan.uploads.length, 0);
});

test("强制方向: local_over_remote 全部 keep_local", async () => {
  const p = plannerWith(true);
  const plan = await p.build({
    baseEntries: new Map([["a.md", entry("S0")]]),
    remoteEntries: new Map([["a.md", entry("S1")], ["b.md", entry("SR")]]),
    localFiles: [{ path: "a.md" }, { path: "c.md" }],
    localShas: new Map([["a.md", "S2"], ["c.md", "SC"]]),
    mode: "local_over_remote",
  });
  assert.ok(plan.uploads.some((u) => u.path === "a.md"));
  assert.ok(plan.uploads.some((u) => u.path === "c.md" && u.op === "create"));
  assert.ok(plan.deletionsRemote.some((d) => d.path === "b.md"));
  assert.equal(plan.downloads.length, 0);
});
