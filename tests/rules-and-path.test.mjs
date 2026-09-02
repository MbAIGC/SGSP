import test from "node:test";
import assert from "node:assert/strict";
import { isIgnored, normalizeUserIgnores, buildIgnoreList, DEFAULT_IGNORES } from "../src/local/ignore-rules.js";
import { isBinaryPath } from "../src/local/content-adapter.js";
import { parseRepoAddress } from "../src/plugin/repo-address.js";

test("忽略规则: 精确匹配不区分大小写", () => {
  assert.ok(isIgnored(".LOCK", [".lock"]));
  assert.ok(!isIgnored(".lockx", [".lock"]));
});

test("忽略规则: 通配符整串匹配(与旧版一致)", () => {
  assert.ok(isIgnored("data/plugins/foo/bar.js", ["data/plugins/*"]));
  assert.ok(isIgnored("temp/git_sync.log", ["temp/*"]));
  // 旧版语义: * 只转 .*,不做前缀省略
  assert.ok(!isIgnored("xdata/plugins/a", ["data/plugins/*"]));
});

test("用户忽略配置规范化", () => {
  assert.deepEqual(normalizeUserIgnores(" a.txt ; /b/*.tmp/ ;; "), ["a.txt", "b/*.tmp"]);
});

test("buildIgnoreList 合并默认+固定+用户", () => {
  const list = buildIgnoreList("my.txt", ["extra/*"]);
  for (const d of DEFAULT_IGNORES) assert.ok(list.includes(d));
  assert.ok(list.includes("data/storage/petal/SY-GSP/*"));
  assert.ok(list.includes("my.txt"));
  assert.ok(list.includes("extra/*"));
});

test("二进制扩展名判定与旧版扩展名集合一致", () => {
  for (const ext of [".png", ".jpg", ".pdf", ".zip", ".sqlite"]) assert.ok(isBinaryPath("x" + ext));
  assert.ok(!isBinaryPath("note.md"));
  assert.ok(!isBinaryPath("doc.sy"));
});

test("仓库地址解析(https/git/ssh/带 .git)", () => {
  assert.deepEqual(parseRepoAddress("https://github.com/o/r.git"), { host: "github.com", owner: "o", repo: "r" });
  assert.deepEqual(parseRepoAddress("git@github.com:o/r.git"), { host: "github.com", owner: "o", repo: "r" });
  assert.deepEqual(parseRepoAddress("https://gitee.com/o/r"), { host: "gitee.com", owner: "o", repo: "r" });
  assert.deepEqual(parseRepoAddress("不是地址"), { host: "", owner: "", repo: "" });
});
