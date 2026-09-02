import test from "node:test";
import assert from "node:assert/strict";
import { SyncMetadataStore } from "../src/storage/sync-metadata-store.js";
import { SyncHistoryStore } from "../src/storage/sync-history-store.js";
import { LocalManifestStore } from "../src/storage/local-manifest-store.js";
import { ConflictService } from "../src/sync/conflict-service.js";
import { makeFakePlugin } from "./helpers.mjs";

test("元数据: 只有确认后的提交才能写入 BASE", async () => {
  const store = new SyncMetadataStore(makeFakePlugin());
  await store.load();
  assert.equal(store.getBaseCommit("github:o/r:main"), null);
  await store.setConfirmedCommit("github:o/r:main", "abc123", "op-1");
  assert.equal(store.getBaseCommit("github:o/r:main"), "abc123");
  const raw = store.data.repositories["github:o/r:main"];
  assert.equal(raw.lastOperationId, "op-1");
  assert.ok(raw.lastSuccessfulAt);
  assert.equal(store.data.schemaVersion, 1);
});

test("元数据: 旧版 sha 只作线索,不作为确认基准", async () => {
  const store = new SyncMetadataStore(makeFakePlugin());
  await store.load();
  await store.setLegacyHint("github:o/r:main", { sha: "legacy1", time: "2020-01-01" });
  assert.equal(store.getBaseCommit("github:o/r:main"), null);
  assert.equal(store.getLegacyHint("github:o/r:main").sha, "legacy1");
});

test("元数据: clear 支持按仓库清空或全量清空", async () => {
  const store = new SyncMetadataStore(makeFakePlugin());
  await store.load();
  await store.setConfirmedCommit("github:o/r:main", "abc", "op");
  await store.setConfirmedCommit("gitee:o/r:main", "def", "op");
  await store.clear("github:o/r:main");
  assert.equal(store.getBaseCommit("github:o/r:main"), null);
  assert.equal(store.getBaseCommit("gitee:o/r:main"), "def");
  await store.clear();
  assert.deepEqual(store.data.repositories, {});
});

test("历史: 按 id 去重且只保留最近 100 条", async () => {
  const store = new SyncHistoryStore(makeFakePlugin());
  await store.load();
  for (let i = 0; i < 120; i++) {
    await store.append("k", { operationId: "op-" + i, state: "SUCCESS" });
  }
  await store.append("k", { operationId: "op-119", state: "SUCCESS" }); // 重复去重
  const list = store.list("k");
  assert.equal(list.length, 100);
  assert.equal(list[99].id, "op-119"); // 新条目追加在尾部
  assert.equal(list[0].id, "op-20");
});

test("历史: 失败条目带错误摘要", async () => {
  const store = new SyncHistoryStore(makeFakePlugin());
  await store.load();
  await store.append("k", { operationId: "op-err", state: "FAILED", error: { category: "NETWORK", message: "断网" } });
  const entry = store.list("k")[0];
  assert.equal(entry.error.category, "NETWORK");
  assert.ok(entry.id);
});

test("本地清单: 全量替换用于重建,损坏文件按空清单处理(删除守卫安全侧)", async () => {
  const plugin = makeFakePlugin();
  const store = new LocalManifestStore(plugin);
  await store.load();
  await store.replaceAll(["a.md", "b.md"]);
  assert.ok(store.has("a.md"));
  await store.replaceAll(["c.md"]);
  assert.ok(!store.has("a.md") && store.has("c.md"));
  // 损坏数据 → 空 Set(宁可跳过删除也不误删)
  plugin.__store["local-manifest.json"] = { paths: 42 };
  const broken = new LocalManifestStore(plugin);
  await broken.load();
  assert.equal(broken.paths.size, 0);
});

test("冲突服务: 保存冲突集/逐文件决策/收集覆盖决策", async () => {
  const store = new ConflictService(makeFakePlugin());
  await store.load();
  const set = await store.saveSet({
    repoKey: "github:o/r:main",
    operationId: "op-c1",
    conflicts: [{ path: "a.md", reason: "双方修改" }, { path: "b.md", reason: "双方修改" }],
  });
  assert.equal(set.operationId, "op-c1");
  assert.equal(store.openSet("github:o/r:main").operationId, "op-c1");
  await store.decide("op-c1", "a.md", "keep_local");
  const overrides = store.collectOverrides("op-c1");
  assert.equal(overrides.get("a.md"), "keep_local");
  assert.equal(overrides.size, 1);
  assert.equal(store.openSet("github:o/r:main").status, "open");
  await store.decide("op-c1", "b.md", "keep_remote");
  assert.equal(store.openSet("github:o/r:main"), null); // 全部决策后不再处于 open
  await store.closeSet("op-c1");
  assert.equal(store.sets["op-c1"].status, "closed");
});

test("冲突服务: 稍后处理保持 open", async () => {
  const store = new ConflictService(makeFakePlugin());
  await store.load();
  await store.saveSet({ repoKey: "k", operationId: "op-l", conflicts: [{ path: "a.md", reason: "r" }] });
  await store.decide("op-l", "a.md", "later");
  assert.equal(store.openSet("k").status, "open");
  assert.equal(store.collectOverrides("op-l").size, 0);
});

test("冲突服务: 同仓库新冲突集替换旧集", async () => {
  const store = new ConflictService(makeFakePlugin());
  await store.load();
  await store.saveSet({ repoKey: "k", operationId: "op-1", conflicts: [{ path: "a.md", reason: "r" }] });
  const second = await store.saveSet({ repoKey: "k", operationId: "op-2", conflicts: [{ path: "b.md", reason: "r" }] });
  const open = store.openSet("k");
  assert.equal(open.operationId, "op-2");
  assert.equal(store.sets["op-1"].status, "superseded");
  const all = store.allOpenSets();
  assert.equal(all.length, 1);
});

test("冲突服务: 快照超过上限被截断(不写完整大文件)", async () => {
  const store = new ConflictService(makeFakePlugin());
  await store.load();
  const big = "A".repeat(6 * 1024 * 1024);
  const set = await store.saveSet({
    repoKey: "k",
    operationId: "op-big",
    conflicts: [{ path: "big.bin", reason: "r", snapshots: { baseB64: big, localB64: big, remoteB64: big } }],
  });
  const saved = store.openSet("k");
  assert.ok(saved.conflicts[0].snapshots.truncated);
  const raw = JSON.stringify(store.sets);
  assert.ok(raw.length < 1024 * 1024 * 20);
});
