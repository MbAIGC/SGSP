import test from "node:test";
import assert from "node:assert/strict";
import { SyncEngine } from "../src/sync/sync-engine.js";
import { SyncPlanner } from "../src/sync/sync-planner.js";
import { ThreeWayMerger } from "../src/sync/three-way-merger.js";
import { CommitBuilder } from "../src/sync/commit-builder.js";
import { SyncMetadataStore } from "../src/storage/sync-metadata-store.js";
import { LocalManifestStore } from "../src/storage/local-manifest-store.js";
import { ConflictService } from "../src/sync/conflict-service.js";
import { createSyncContext, SyncState } from "../src/sync/sync-context.js";
import { SyncError, SyncErrorCategory } from "../src/sync/sync-error.js";
import { createEventBus } from "../src/util/event-bus.js";
import { GitProvider } from "../src/git/git-provider.js";
import { makeFakeKernel, makeFakePlugin } from "./helpers.mjs";

const enc = (s) => GitProvider.textToBytes(s);
const dec = (b) => GitProvider.bytesToText(b);
const sha = (s) => GitProvider.gitBlobSha(enc(s));

/** 内存 Git 仓库(实现引擎所需 provider 契约) */
async function makeFakeRepo(files = {}) {
  const blobs = new Map(); // sha -> bytes
  let head = null;
  const commits = new Map();
  const trees = new Map();
  let seq = 0;

  async function ensureBlobs() {
    for (const content of Object.values(files)) {
      const s = await sha(content);
      if (!blobs.has(s)) blobs.set(s, enc(content));
    }
  }

  const notFound = (op, msg) =>
    new SyncError({ category: SyncErrorCategory.GIT, code: "HTTP_404", httpStatus: 404, operation: op, message: msg });

  const provider = {
    platform: "github",
    token: "tk",
    gitBlobSha: (bytes) => GitProvider.gitBlobSha(bytes),
    bytesToBase64: (bytes) => GitProvider.bytesToBase64(bytes),
    base64ToBytes: (b64) => GitProvider.base64ToBytes(b64),
    async getBranchHead() {
      if (head === null) throw notFound("getBranchHead", "分支不存在(空仓库)");
      return { sha: head };
    },
    async getCommit(shaArg) {
      const c = commits.get(shaArg);
      if (!c) throw notFound("getCommit", "commit 不存在: " + shaArg);
      return c;
    },
    async getTree(treeSha) {
      const t = trees.get(treeSha);
      if (!t) throw notFound("getTree", "tree 不存在: " + treeSha);
      return t.map((e) => ({ ...e }));
    },
    async getBlob(blobSha) {
      const b = blobs.get(blobSha);
      if (!b) throw notFound("getBlob", "blob 不存在: " + blobSha);
      return { bytes: b };
    },
    async getFileContent(path, ref) {
      const c = commits.get(ref || head);
      const entry = trees.get(c.treeSha).find((e) => e.path === path);
      if (!entry) throw notFound("getFileContent", "文件不存在: " + path);
      return { bytes: blobs.get(entry.sha) };
    },
    async getMergeBase() {
      return null;
    },
    async getInitialCommit() {
      if (commits.size === 0) throw notFound("getInitialCommit", "空仓库");
      return [...commits.values()][0];
    },
    async createBlob(bytes) {
      const s = await GitProvider.gitBlobSha(bytes);
      blobs.set(s, bytes);
      return s;
    },
    async createTree(baseTreeSha, entries) {
      const base = baseTreeSha ? new Map(trees.get(baseTreeSha).map((e) => [e.path, e])) : new Map();
      for (const e of entries) {
        if (e.sha === null) base.delete(e.path);
        else base.set(e.path, { path: e.path, sha: e.sha, type: "blob", size: 0 });
      }
      const treeSha = "tree-" + ++seq;
      trees.set(treeSha, [...base.values()]);
      return { sha: treeSha };
    },
    async createCommit({ message, treeSha, parents }) {
      const c = { sha: "commit-" + (commits.size + 1), treeSha, parents, message };
      commits.set(c.sha, c);
      return c;
    },
    async updateBranchRef(newSha, { expectedHead }) {
      if (head === null) throw notFound("updateBranchRef", "分支不存在");
      if (head !== expectedHead) {
        throw new SyncError({
          category: SyncErrorCategory.REMOTE_CHANGED,
          code: "REMOTE_HEAD_MOVED",
          operation: "updateBranchRef",
          message: "远端分支已变化",
        });
      }
      head = newSha;
      return { confirmedSha: head };
    },
    async _createRefRaw(newSha) {
      if (head !== null) {
        // 模拟真实 422: 引用已存在(他人已建分支)
        throw new SyncError({
          category: SyncErrorCategory.GIT,
          code: "HTTP_422",
          httpStatus: 422,
          operation: "createRef",
          message: "reference already exists",
        });
      }
      head = newSha;
    },
    mapUpdateRefFailure: (err) => err,
  };
  // 复用真实基类契约: ensureBranchRef/updateBranchRef/mapUpdateRefFailure
  Object.setPrototypeOf(provider, GitProvider.prototype);

  /** 以当前 files 内容建 tree/commit 并前移 HEAD(测试准备用) */
  async function snapshot(message) {
    await ensureBlobs();
    const entries = [];
    for (const [path, content] of Object.entries(files)) {
      entries.push({ path, sha: await sha(content), type: "blob", size: enc(content).length });
    }
    const treeSha = "tree-" + ++seq;
    trees.set(treeSha, entries);
    const c = { sha: "commit-" + (commits.size + 1), treeSha, parents: head ? [head] : [], message: message || "init" };
    commits.set(c.sha, c);
    head = c.sha;
    return c;
  }
  if (Object.keys(files).length) await snapshot("init");

  return {
    provider,
    files,
    blobs,
    snapshot,
    get head() {
      return head;
    },
  };
}

async function makeHarness({ remoteFiles = {}, localFiles = {} } = {}) {
  const repo = await makeFakeRepo({ ...remoteFiles });
  const kernel = makeFakeKernel();
  for (const [path, content] of Object.entries(localFiles)) {
    await kernel.putFile(path, new Blob([enc(content)]), false);
  }
  const metadataStore = new SyncMetadataStore(makeFakePlugin());
  await metadataStore.load();
  const manifestStore = new LocalManifestStore(makeFakePlugin());
  await manifestStore.load();
  const conflictService = new ConflictService(makeFakePlugin());
  await conflictService.load();
  const workspace = {
    async scan() {
      const out = [];
      for (const name of kernel.__files.keys()) {
        if (/^(data\/|assets\/|\.siyuan\/)/.test(name)) {
          out.push({ path: name, name: name.split("/").pop(), updated: 1 });
        }
      }
      return { files: out, enumErrorOccurred: false };
    },
  };
  const contentAdapter = {
    kernel,
    async readFileBlob(path) {
      return kernel.getFile(path);
    },
    async writeFileBlob(path, blob) {
      await kernel.putFile(path, blob, false);
    },
    async removeFileWithBackup(path) {
      await kernel.removeFile(path);
    },
  };
  const planner = new SyncPlanner({
    readLocal: async (path) => {
      const blob = await kernel.getFile(path);
      return blob ? { bytes: new Uint8Array(await blob.arrayBuffer()) } : null;
    },
    readRemoteBlobBySha: (s) => repo.provider.getBlob(s),
    guardLocalDelete: async () => ({ allow: true, reasons: [] }),
  });
  const engine = new SyncEngine({
    provider: repo.provider,
    workspace,
    contentAdapter,
    metadataStore,
    manifestStore,
    conflictService,
    planner,
    merger: new ThreeWayMerger(),
    commitBuilder: new CommitBuilder({}),
    events: createEventBus(),
    config: { repoKey: "github:o/r:main", syncRange: 1, syncFileType: "raw" },
  });
  const makeCtx = (extra = {}) => {
    const { overrides, ...rest } = extra;
    const ctx = createSyncContext(
      Object.assign({ trigger: "manual", mode: "auto", provider: "github", owner: "o", repo: "r", branch: "main" }, rest)
    );
    if (overrides) ctx.overrides = overrides;
    return ctx;
  };
  return { repo, kernel, engine, metadataStore, manifestStore, conflictService, makeCtx };
}

test("引擎: 远端领先 → 下载覆盖本地,不产生远端写入,基准推进", async () => {
  const remote = "data/20240101120000-abc/note.md";
  const h = await makeHarness({ remoteFiles: { [remote]: "remote v1" } });
  const baseCommit = await h.repo.snapshot("base");
  await h.metadataStore.setConfirmedCommit("github:o/r:main", baseCommit.sha, "prep");
  await h.kernel.putFile(remote, new Blob([enc("remote v1")]), false); // 本地=基准版本
  h.repo.files[remote] = "remote v2";
  await h.repo.snapshot("v2"); // 远端前进,本地不知情

  const ctx = h.makeCtx();
  const result = await h.engine.run(ctx);
  assert.equal(result.success, true);
  assert.equal(result.downloads, 1);
  assert.equal(result.uploads, 0);
  const local = await h.kernel.getFile(remote);
  assert.equal(await local.text(), "remote v2");
  assert.equal(h.metadataStore.getBaseCommit("github:o/r:main"), h.repo.head);
});

test("引擎: 本地领先 → 上传,推送后基准=远端头", async () => {
  const path = "data/20240101120000-abc/a.md";
  const h = await makeHarness({ localFiles: { [path]: "local new file" } });
  await h.metadataStore.setConfirmedCommit("github:o/r:main", h.repo.head, "prep");

  const ctx = h.makeCtx();
  const result = await h.engine.run(ctx);
  assert.equal(result.success, true);
  assert.equal(result.uploads, 1);
  const tree = await h.repo.provider.getTree((await h.repo.provider.getCommit(h.repo.head)).treeSha);
  assert.ok(tree.some((e) => e.path === path));
  assert.equal(h.metadataStore.getBaseCommit("github:o/r:main"), h.repo.head);
});

test("引擎: 双方修改同一文件非相邻区域 → 自动合并上传", async () => {
  const path = "data/20240101120000-abc/m.md";
  const h = await makeHarness({ remoteFiles: { [path]: "1\n2\n3\n4\n5\n" } });
  const baseCommit = await h.repo.snapshot("base");
  await h.metadataStore.setConfirmedCommit("github:o/r:main", baseCommit.sha, "prep");
  await h.kernel.putFile(path, new Blob([enc("1\n2X\n3\n4\n5\n")]), false);
  h.repo.files[path] = "1\n2\n3\n4Y\n5\n";
  await h.repo.snapshot("remote-edit");

  const ctx = h.makeCtx();
  const result = await h.engine.run(ctx);
  assert.equal(result.success, true);
  const local = await h.kernel.getFile(path);
  const text = await local.text();
  assert.ok(text.includes("2X") && text.includes("4Y"), "合并结果包含双方修改: " + text);
  assert.equal(result.uploads, 1);
});

test("引擎: 双方修改同一行 → 冲突暂停,本地不被覆盖,BASE 不推进", async () => {
  const path = "data/20240101120000-abc/c.md";
  const h = await makeHarness({ remoteFiles: { [path]: "a\nb\nc\n" } });
  const baseCommit = await h.repo.snapshot("base");
  await h.metadataStore.setConfirmedCommit("github:o/r:main", baseCommit.sha, "prep");
  await h.kernel.putFile(path, new Blob([enc("a\nB1\nc\n")]), false);
  h.repo.files[path] = "a\nB2\nc\n";
  await h.repo.snapshot("remote-edit");

  const ctx = h.makeCtx();
  const result = await h.engine.run(ctx);
  assert.equal(result.paused, true);
  assert.equal(result.kind, "FILE_CONFLICTS");
  assert.equal(ctx.state, SyncState.CONFLICT_PAUSED);
  const local = await h.kernel.getFile(path);
  assert.equal(await local.text(), "a\nB1\nc\n");
  const set = h.conflictService.openSet("github:o/r:main");
  assert.equal(set.conflicts[0].path, path);
  assert.ok(set.conflicts[0].snapshots.localB64);
  assert.equal(h.metadataStore.getBaseCommit("github:o/r:main"), baseCommit.sha);
});

test("引擎: 冲突决策后重新规划 → keep_remote 下载远端版本并推进 BASE", async () => {
  const path = "data/20240101120000-abc/r.md";
  const h = await makeHarness({ remoteFiles: { [path]: "a\nb\nc\n" } });
  const baseCommit = await h.repo.snapshot("base");
  await h.metadataStore.setConfirmedCommit("github:o/r:main", baseCommit.sha, "prep");
  await h.kernel.putFile(path, new Blob([enc("a\nB1\nc\n")]), false);
  h.repo.files[path] = "a\nB2\nc\n";
  await h.repo.snapshot("remote-edit");

  // 第一轮: 冲突暂停
  const ctx1 = h.makeCtx();
  const result1 = await h.engine.run(ctx1);
  assert.equal(result1.paused, true);

  // 第二轮: 用户选择保留远端(带 overrides 的新上下文)
  const ctx2 = h.makeCtx({ overrides: new Map([[path, "keep_remote"]]) });
  const result2 = await h.engine.run(ctx2);
  assert.equal(result2.success, true);
  assert.equal(result2.downloads, 1);
  const local = await h.kernel.getFile(path);
  assert.equal(await local.text(), "a\nB2\nc\n");
  assert.equal(h.metadataStore.getBaseCommit("github:o/r:main"), h.repo.head);
});

test("引擎: 首次同步(本地+远端都有内容,无基准) → BASE_UNRESOLVED 暂停", async () => {
  const h = await makeHarness({
    remoteFiles: { "data/20240101120000-abc/r.md": "remote" },
    localFiles: { "data/20240101120000-abc/l.md": "local" },
  });
  const result = await h.engine.run(h.makeCtx());
  assert.equal(result.paused, true);
  assert.equal(result.kind, "BASE_UNRESOLVED");
  assert.equal(h.metadataStore.getBaseCommit("github:o/r:main"), null);
});

test("引擎: 首次同步(本地为空,远端有内容) → 引导下载且不误删远端", async () => {
  const h = await makeHarness({ remoteFiles: { "data/20240101120000-abc/r.md": "remote content" } });
  const headBefore = h.repo.head;
  const result = await h.engine.run(h.makeCtx());
  assert.equal(result.success, true);
  assert.equal(result.downloads, 1);
  assert.equal(result.deletionsRemote, 0);
  assert.equal(h.repo.head, headBefore, "远端无写入");
  const local = await h.kernel.getFile("data/20240101120000-abc/r.md");
  assert.equal(await local.text(), "remote content");
});

test("引擎: 首次同步(空仓库,本地有内容) → 首推创建分支", async () => {
  const h = await makeHarness({ localFiles: { "data/20240101120000-abc/l.md": "local content" } });
  const result = await h.engine.run(h.makeCtx());
  assert.equal(result.success, true);
  assert.equal(result.uploads, 1);
  assert.ok(h.repo.head, "分支已创建");
  const tree = await h.repo.provider.getTree((await h.repo.provider.getCommit(h.repo.head)).treeSha);
  assert.ok(tree.some((e) => e.path === "data/20240101120000-abc/l.md"));
});

test("引擎: 推送竞争(规划后远端前移) → REMOTE_CHANGED,不覆盖他人提交", async () => {
  const path = "data/20240101120000-abc/race.md";
  const h = await makeHarness({ localFiles: { [path]: "local" } });
  const baseSha = h.repo.head;
  await h.metadataStore.setConfirmedCommit("github:o/r:main", baseSha, "prep");

  // 劫持 createBlob: 首个上传动作前模拟他人推送
  const origCreateBlob = h.repo.provider.createBlob;
  let hijacked = false;
  h.repo.provider.createBlob = async (bytes) => {
    if (!hijacked) {
      hijacked = true;
      h.repo.files[path] = "foreign push content";
      await h.repo.snapshot("foreign push");
    }
    return origCreateBlob(bytes);
  };

  const ctx = h.makeCtx();
  await assert.rejects(
    () => h.engine.run(ctx),
    (err) => {
      assert.equal(err.category, SyncErrorCategory.REMOTE_CHANGED);
      return true;
    }
  );
  // 远端仍是他人提交;BASE 不变
  assert.notEqual(h.repo.head, baseSha);
  const remoteText = dec((await h.repo.provider.getBlob(
    (await h.repo.provider.getTree((await h.repo.provider.getCommit(h.repo.head)).treeSha)).find((e) => e.path === path).sha
  )).bytes);
  assert.equal(remoteText, "foreign push content");
  assert.equal(h.metadataStore.getBaseCommit("github:o/r:main"), baseSha);
});

test("引擎: 配置缺失 → 可恢复错误,不触碰远端", async () => {
  const h = await makeHarness({ localFiles: { "data/20240101120000-abc/x.md": "x" } });
  await assert.rejects(
    () => h.engine.run(h.makeCtx({ owner: "", repo: "" })),
    (err) => {
      assert.equal(err.category, SyncErrorCategory.REPOSITORY);
      assert.equal(err.recoverable, true);
      return true;
    }
  );
});

test("引擎: 空文档拒绝上传(EMPTY_DOC)", async () => {
  const h = await makeHarness({});
  await h.kernel.putFile("data/20240101120000-abc/empty.sy", new Blob([enc("")]), false);
  const ctx = h.makeCtx();
  await assert.rejects(
    () => h.engine.run(ctx),
    (err) => {
      assert.equal(err.code, "EMPTY_DOC");
      return true;
    }
  );
});

export { makeFakeRepo, makeHarness };
