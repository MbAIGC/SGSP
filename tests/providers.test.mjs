import test from "node:test";
import assert from "node:assert/strict";
import { GitHubProvider } from "../src/git/github-provider.js";
import { GiteeProvider } from "../src/git/gitee-provider.js";
import { GitProvider } from "../src/git/git-provider.js";
import { SyncErrorCategory } from "../src/sync/sync-error.js";

/** fetch 记录器: 按注册的响应序列应答 */
function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const r of routes) {
      if (r.match(url, init)) {
        if (r.throw) throw r.throw;
        return r.respond(url, init);
      }
    }
    return { ok: false, status: 404, statusText: "Not Found", headers: new Map(), json: async () => ({ message: "Not Found" }), text: async () => "Not Found" };
  };
  return calls;
}

const jsonResponse = (body, status = 200) => ({
  ok: status < 400,
  status,
  statusText: String(status),
  headers: new Map(),
  json: async () => body,
  text: async () => JSON.stringify(body),
  arrayBuffer: async () => new ArrayBuffer(0),
});

const gh = () => new GitHubProvider({ owner: "o", repo: "r", branch: "main", token: "tk" });
const gt = () => new GiteeProvider({ owner: "o", repo: "r", branch: "main", token: "tk" });

test("GitHub getBranchHead 返回 HEAD 指针", async () => {
  const calls = mockFetch([{ match: (u) => /\/git\/ref\/heads\/main$/.test(u), respond: () => jsonResponse({ object: { sha: "abc" } }) }]);
  const head = await gh().getBranchHead();
  assert.equal(head.sha, "abc");
  assert.ok(calls[0].url.startsWith("https://api.github.com/repos/o/r/"));
});

test("GitHub updateBranchRef: CAS 校验 + force:false + 回读确认", async () => {
  let headReads = 0;
  const calls = mockFetch([
    // 第一次读 HEAD(前置校验)
    { match: (u) => /\/git\/ref\/heads\/main$/.test(u) && headReads++ === 0, respond: () => jsonResponse({ object: { sha: "old" } }) },
    // PATCH ref
    { match: (u, i) => u.endsWith("/git/refs/heads/main") && i.method === "PATCH", respond: () => jsonResponse({ object: { sha: "new" } }) },
    // 回读确认
    { match: (u) => /\/git\/ref\/heads\/main$/.test(u), respond: () => jsonResponse({ object: { sha: "new" } }) },
  ]);
  const confirmed = await gh().updateBranchRef("new", { expectedHead: "old" });
  assert.equal(confirmed.confirmedSha, "new");
  const patch = calls.find((c) => c.init.method === "PATCH");
  assert.equal(JSON.parse(patch.init.body).force, false);
});

test("GitHub updateBranchRef: 推送期间远端前移 → REMOTE_CHANGED,绝不覆盖", async () => {
  let n = 0;
  mockFetch([
    { match: (u) => /\/git\/ref\/heads\/main$/.test(u) && n++ === 0, respond: () => jsonResponse({ object: { sha: "moved-on" } }) },
  ]);
  await assert.rejects(
    () => gh().updateBranchRef("new", { expectedHead: "expected" }),
    (err) => err.category === SyncErrorCategory.REMOTE_CHANGED
  );
});

test("GitHub updateBranchRef: PATCH 409 → PUSH_REJECTED NON_FAST_FORWARD", async () => {
  let n = 0;
  mockFetch([
    { match: (u) => /\/git\/ref\/heads\/main$/.test(u) && n++ === 0, respond: () => jsonResponse({ object: { sha: "old" } }) },
    { match: (u, i) => u.endsWith("/git/refs/heads/main") && i.method === "PATCH", respond: () => jsonResponse({ message: "not fast forward" }, 409) },
  ]);
  await assert.rejects(
    () => gh().updateBranchRef("new", { expectedHead: "old" }),
    (err) => err.category === SyncErrorCategory.PUSH_REJECTED
  );
});

test("GitHub getMergeBase / getInitialCommit", async () => {
  mockFetch([
    { match: (u) => /\/compare\/base\.\.\.head$/.test(u), respond: () => jsonResponse({ merge_base_commit: { sha: "mb" } }) },
    { match: (u) => /\/commits\?sha=main&per_page=1&page=1$/.test(u), respond: () => jsonResponse([{ sha: "first" }]) },
  ]);
  const p = gh();
  assert.equal(await p.getMergeBase("base", "head"), "mb");
  assert.equal((await p.getInitialCommit()).sha, "first");
});

test("Gitee 读接口: 分支/树/blob", async () => {
  mockFetch([
    { match: (u) => u.includes("/branches/main"), respond: () => jsonResponse({ commit: { sha: "g1" } }) },
    { match: (u) => /\/commits\/g1$/.test(u), respond: () => jsonResponse({ sha: "g1", commit: { tree: { sha: "tree1" } } }) },
    { match: (u) => /\/git\/trees\/tree1\?recursive=1/.test(u), respond: () => jsonResponse({ tree: [{ path: "a.md", type: "blob", sha: "b1", size: 3 }] }) },
    { match: (u) => /\/git\/blobs\/b1/.test(u), respond: () => jsonResponse({ content: "aGk=", encoding: "base64" }) },
  ]);
  const p = gt();
  assert.equal((await p.getBranchHead()).sha, "g1");
  assert.equal((await p.getCommit("g1")).treeSha, "tree1");
  const tree = await p.getTree("tree1");
  assert.equal(tree[0].path, "a.md");
  const blob = await p.getBlob("b1");
  assert.equal(GitProvider.bytesToText(blob.bytes), "hi");
});

test("Gitee 不支持原子 updateRef → 明确报错,而不是静默降级", async () => {
  await assert.rejects(
    () => gt()._updateRefRaw(),
    (err) => err.code === "ATOMIC_WRITE_UNSUPPORTED" && /原子/.test(err.message)
  );
});

test("Gitee applyFileOperations: 成功记录操作日志并跟踪 HEAD", async () => {
  const calls = mockFetch([
    { match: (u) => /\/branches\/main(\?|$)/.test(u), respond: () => jsonResponse({ commit: { sha: "h1" } }) },
    { match: (u, i) => /\/contents\/a\.md(\?|$)/.test(u) && i.method === "PUT", respond: () => jsonResponse({ commit: { sha: "h2" }, content: { sha: "blob1" } }) },
  ]);
  const result = await gt().applyFileOperations([
    { op: "update", path: "a.md", bytes: new TextEncoder().encode("v"), remoteSha: "old" },
  ], { message: "m", branch: "main" });
  assert.equal(result.operations.length, 1);
  assert.equal(result.operations[0].op, "update");
  assert.equal(result.operations[0].afterSha, "blob1");
  assert.equal(result.operations[0].commitSha, "h2");
  assert.equal(result.remoteHead, "h1"); // remoteHead 取回读确认的分支头,而非单文件提交
  const put = calls.find((c) => c.init.method === "PUT");
  assert.ok(put.url.startsWith("https://gitee.com/api/v5/repos/o/r/contents/"));
  const body = JSON.parse(put.init.body);
  assert.equal(body.sha, "old");
  assert.equal(body.branch, "main");
});

test("Gitee applyFileOperations: 中途失败 → PARTIAL_REMOTE_WRITE 可恢复错误", async () => {
  mockFetch([
    { match: (u) => /\/branches\/main(\?|$)/.test(u), respond: () => jsonResponse({ commit: { sha: "h1" } }) },
    { match: (u) => /\/contents\/ok\.md\?/.test(u), respond: () => jsonResponse({ commit: { sha: "h" }, content: { sha: "b" } }) },
    { match: (u) => /\/contents\/bad\.md\?/.test(u), respond: () => jsonResponse({ message: "conflict" }, 409) },
  ]);
  await assert.rejects(
    () => gt().applyFileOperations([
      { op: "update", path: "ok.md", bytes: new TextEncoder().encode("1"), remoteSha: "s1" },
      { op: "update", path: "bad.md", bytes: new TextEncoder().encode("2"), remoteSha: "s2" },
    ], { message: "m", branch: "main" }),
    (err) => {
      assert.equal(err.code, "PARTIAL_REMOTE_WRITE");
      assert.equal(err.recoverable, true);
      assert.ok(err.detail.includes("ok.md"));
      return true;
    }
  );
});

test("Gitee 删除: DELETE 同时携带 query 与 body 参数", async () => {
  const calls = mockFetch([
    { match: (u) => /\/branches\/main(\?|$)/.test(u), respond: () => jsonResponse({ commit: { sha: "h1" } }) },
    { match: (u, i) => /\/contents\/del\.md\?/.test(u) && i.method === "DELETE", respond: () => jsonResponse({ commit: { sha: "h" } }) },
  ]);
  await gt().applyFileOperations([{ op: "delete", path: "del.md", remoteSha: "ds" }], { message: "m", branch: "main" });
  const del = calls.find((c) => c.init.method === "DELETE");
  assert.ok(del.url.includes("sha=ds"));
  assert.equal(JSON.parse(del.init.body).sha, "ds");
});
