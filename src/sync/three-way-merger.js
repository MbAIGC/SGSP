/**
 * ThreeWayMerger: 文本内容三方合并(独立于思源 UI)。
 * - 文本文件使用 node-diff3 做确定性三方合并(与旧版同一合并库,行为对齐);
 * - 二进制、超大文件不做文本合并,直接进入人工冲突处理;
 * - 输出契约见 2.0 方案 §7.5。
 */

import { diff3Merge } from "node-diff3";
import { isBinaryPath } from "../local/content-adapter.js";
import { GitProvider } from "../git/git-provider.js";

/** 超过该大小的文本不做自动合并(字节) */
export const MAX_TEXT_MERGE_BYTES = 10 * 1024 * 1024;

/** 按保留行尾方式切分(与旧版一致,CRLF/LF/CR 均可) */
export function splitLines(text) {
  const s = String(text == null ? "" : text);
  const lines = [];
  let start = 0;
  const re = /(\r\n|\n|\r)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    lines.push(s.slice(start, m.index) + m[0]);
    start = m.index + m[0].length;
  }
  if (start < s.length) lines.push(s.slice(start));
  return lines;
}

function looksBinary(bytes) {
  const probe = bytes.subarray ? bytes.subarray(0, 8000) : bytes;
  for (let i = 0; i < probe.length; i++) {
    if (probe[i] === 0) return true;
  }
  return false;
}

export class ThreeWayMerger {
  /**
   * @param {object} input {path, base:{bytes}|null, local:{bytes}, remote:{bytes}}
   * @returns {Promise<{merged:boolean, content:Uint8Array|null,
   *   conflicts:Array<{path,reason}>, strategy:string}>}
   */
  async merge({ path, base, local, remote }) {
    const localBytes = local && local.bytes;
    const remoteBytes = remote && remote.bytes;
    const baseBytes = base && base.bytes;

    if (!localBytes || !remoteBytes) {
      return { merged: false, content: null, conflicts: [{ path, reason: "缺少本地或远端内容" }], strategy: "manual-required" };
    }
    if (isBinaryPath(path) || looksBinary(localBytes) || looksBinary(remoteBytes)) {
      return { merged: false, content: null, conflicts: [{ path, reason: "二进制文件不做文本合并" }], strategy: "manual-required" };
    }
    if (localBytes.length > MAX_TEXT_MERGE_BYTES || remoteBytes.length > MAX_TEXT_MERGE_BYTES) {
      return { merged: false, content: null, conflicts: [{ path, reason: "文件过大,不做自动合并" }], strategy: "manual-required" };
    }

    const baseText = baseBytes ? GitProvider.bytesToText(baseBytes) : "";
    const localText = GitProvider.bytesToText(localBytes);
    const remoteText = GitProvider.bytesToText(remoteBytes);

    // 无共同祖先时以空串为基,双方任意修改都会成块冲突,交由人工决策
    // node-diff3 v3: 直接返回块数组 [{ok:[行]}|{conflict:{a,o,b}}]
    const chunks = diff3Merge(splitLines(localText), splitLines(baseText), splitLines(remoteText), {
      stringSeparator: false,
      excludeFalseConflicts: true,
    });

    const merged = [];
    for (const chunk of chunks) {
      if (chunk.conflict) {
        return {
          merged: false,
          content: null,
          conflicts: [{ path, reason: "双方修改了同一文本文件且无法自动合并" }],
          strategy: "manual-required",
        };
      }
      if (chunk.ok) merged.push(...chunk.ok);
    }
    return {
      merged: true,
      content: GitProvider.textToBytes(merged.join("")),
      conflicts: [],
      strategy: "text-three-way",
    };
  }
}
