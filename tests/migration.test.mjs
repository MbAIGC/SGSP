import test from "node:test";
import assert from "node:assert/strict";
import { Migration, LEGACY_STORAGE_DIR } from "../src/storage/migration.js";
import { SyncMetadataStore } from "../src/storage/sync-metadata-store.js";
import { makeFakeKernel, makeFakePlugin } from "./helpers.mjs";

const enc = (s) => new TextEncoder().encode(s);

async function prepareLegacy(kernel, gitCfg) {
  await kernel.putFile(
    LEGACY_STORAGE_DIR + "/plugin_config_platform.json",
    new Blob([enc(JSON.stringify({ sync_range: 2, sync_mode: 1, latest_commit_time: "" }))]),
    false
  );
  await kernel.putFile(
    LEGACY_STORAGE_DIR + "/plugin_config_git_sync_github.json",
    new Blob([enc(JSON.stringify(gitCfg))]),
    false
  );
}

test("迁移: 设置逐键迁入,旧基准只作线索", async () => {
  const kernel = makeFakeKernel();
  await prepareLegacy(kernel, {
    repository_address: "https://github.com/o/r.git",
    repository_branch: "main",
    submit_token: "tok",
    latest_commit_sha: "abc123",
    latest_commit_time: "2024-01-01T00:00:00Z",
  });
  const saved = {};
  const settings = {
    async setAndSave(key, value) {
      saved[key] = value;
    },
  };
  const metadataStore = new SyncMetadataStore(makeFakePlugin());
  await metadataStore.load();
  const report = await new Migration(kernel, settings, metadataStore).migrate({
    provider: "github",
    owner: "o",
    repo: "r",
    branch: "main",
  });
  assert.equal(saved.repository_address, "https://github.com/o/r.git");
  assert.equal(saved.sync_range, 2);
  assert.equal(saved.upload_sub_platform, 0);
  // 旧基准绝不成为确认基准
  assert.equal(metadataStore.getBaseCommit("github:o/r:main"), null);
  assert.equal(metadataStore.getLegacyHint("github:o/r:main").sha, "abc123");
  assert.ok(report.migratedKeys.length >= 5);
  assert.equal(report.errors.length, 0);
});

test("迁移: 旧版文件缺失不报错", async () => {
  const kernel = makeFakeKernel();
  const metadataStore = new SyncMetadataStore(makeFakePlugin());
  await metadataStore.load();
  const report = await new Migration(kernel, { async setAndSave() {} }, metadataStore).migrate({
    provider: "github",
    owner: "o",
    repo: "r",
    branch: "main",
  });
  assert.equal(report.migratedKeys.length, 0);
  assert.equal(report.errors.length, 0);
  assert.equal(report.legacyHint, null);
});

test("迁移: 损坏的旧版 JSON 进入错误报告,不中断", async () => {
  const kernel = makeFakeKernel();
  await kernel.putFile(LEGACY_STORAGE_DIR + "/plugin_config_platform.json", new Blob([enc("{oops")]), false);
  const metadataStore = new SyncMetadataStore(makeFakePlugin());
  await metadataStore.load();
  const report = await new Migration(kernel, { async setAndSave() {} }, metadataStore).migrate({
    provider: "gitee",
    owner: "o",
    repo: "r",
    branch: "main",
  });
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /解析失败/);
});
