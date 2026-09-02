import test from "node:test";
import assert from "node:assert/strict";
import { ThreeWayMerger, splitLines, MAX_TEXT_MERGE_BYTES } from "../src/sync/three-way-merger.js";
import { GitProvider } from "../src/git/git-provider.js";

const merger = new ThreeWayMerger();
const enc = (s) => GitProvider.textToBytes(s);

test("splitLines 保留行尾(CRLF/LF/CR/无尾行)", () => {
  assert.deepEqual(splitLines("a\r\nb\nc\rd"), ["a\r\n", "b\n", "c\r", "d"]);
  assert.deepEqual(splitLines("x\n"), ["x\n"]);
  assert.deepEqual(splitLines(""), []);
});

test("三方合并: 非相邻区域双方修改 → 自动合并", async () => {
  const r = await merger.merge({
    path: "a.md",
    base: { bytes: enc("1\n2\n3\n4\n5\n") },
    local: { bytes: enc("1\n2X\n3\n4\n5\n") },
    remote: { bytes: enc("1\n2\n3\n4Y\n5\n") },
  });
  assert.equal(r.merged, true);
  assert.equal(GitProvider.bytesToText(r.content), "1\n2X\n3\n4Y\n5\n");
});

test("三方合并: 相邻行双方修改 → 保守冲突(与旧版同库行为一致)", async () => {
  const r = await merger.merge({
    path: "a.md",
    base: { bytes: enc("1\n2\n3\n") },
    local: { bytes: enc("1\n2X\n3\n") },
    remote: { bytes: enc("1\n2\n3Y\n") },
  });
  assert.equal(r.merged, false);
  assert.ok(r.conflicts[0].reason.length > 0);
  assert.equal(r.content, null);
});

test("三方合并: 双方修改同一行 → 冲突,不产出内容", async () => {
  const r = await merger.merge({
    path: "a.md",
    base: { bytes: enc("a\nb\nc\n") },
    local: { bytes: enc("a\nB1\nc\n") },
    remote: { bytes: enc("a\nB2\nc\n") },
  });
  assert.equal(r.merged, false);
  assert.ok(r.conflicts[0].reason.length > 0);
  assert.equal(r.content, null);
});

test("三方合并: 双方相同修改 → 合并结果确定", async () => {
  const r = await merger.merge({
    path: "a.md",
    base: { bytes: enc("x\n") },
    local: { bytes: enc("x\nsame\n") },
    remote: { bytes: enc("x\nsame\n") },
  });
  assert.equal(r.merged, true);
});

test("三方合并: 二进制内容拒绝合并", async () => {
  const bin = new Uint8Array([0x89, 0x50, 0x00, 0x4e]);
  const r = await merger.merge({ path: "img.png", base: null, local: { bytes: bin }, remote: { bytes: bin.slice() } });
  assert.equal(r.merged, false);
  assert.match(r.conflicts[0].reason, /二进制/);
});

test("三方合并: NUL 字节内容按二进制处理", async () => {
  const bin = new Uint8Array([0x61, 0x00, 0x62]);
  const r = await merger.merge({ path: "odd.bin", base: null, local: { bytes: bin }, remote: { bytes: bin.slice() } });
  assert.equal(r.merged, false);
});

test("三方合并: 超大文本拒绝自动合并", async () => {
  const big = enc("x".repeat(MAX_TEXT_MERGE_BYTES + 1));
  const r = await merger.merge({ path: "big.txt", base: { bytes: enc("") }, local: { bytes: big }, remote: { bytes: enc("y") } });
  assert.equal(r.merged, false);
  assert.match(r.conflicts[0].reason, /过大/);
});

test("git blob sha 与已知值一致(SHA-1 可用环境)", async () => {
  const sha = await GitProvider.gitBlobSha(GitProvider.textToBytes("hello\n"));
  if (sha === null) return; // 环境不支持时跳过
  assert.equal(sha, "ce013625030ba8dba906f756967f9e9ca394464a");
});

test("base64 编解码往返", () => {
  const bytes = GitProvider.textToBytes("你好, world 🎉");
  const b64 = GitProvider.bytesToBase64(bytes);
  const back = GitProvider.base64ToBytes(b64);
  assert.equal(GitProvider.bytesToText(back), "你好, world 🎉");
});
