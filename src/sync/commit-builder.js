/**
 * CommitBuilder: 把计划中的远端变更组织为确定性批次与可追踪提交信息(2.0 方案 §7.7)。
 * - 单次逻辑同步优先一个提交;超出阈值按确定性阈值拆分;
 * - 每个批次携带同一 operationId;
 * - 上传前请求大小预检,超限报 LARGE_FILE 而不是静默截断。
 */

import { SyncError, SyncErrorCategory } from "./sync-error.js";

/** 单批字节数阈值(确定性,与内容无关) */
export const BATCH_BYTE_LIMIT = 80 * 1024 * 1024;
/** 单文件请求大小默认上限(base64 后约 +1/3) */
export const DEFAULT_REQUEST_LIMIT = 32 * 1024 * 1024;

export class CommitBuilder {
  constructor({ requestLimit = DEFAULT_REQUEST_LIMIT, batchByteLimit = BATCH_BYTE_LIMIT } = {}) {
    this.requestLimit = requestLimit;
    this.batchByteLimit = batchByteLimit;
  }

  /**
   * 构建提交批次。
   * @param {object} opts {operationId, uploads:[{path, bytes}], deletionsRemote:[{path, remoteSha}]}
   * @returns {{batches:Array, skipped:Array}}
   *   github 批次: {entries:[{path,sha,mode}], deletePaths:[...], size, message, part, total}
   *   gitee 批次:  {operations:[{op,path,bytes,remoteSha}], message, part, total}
   */
  build({ operationId, uploads = [], deletionsRemote = [], provider }) {
    const skipped = [];
    const oversize = uploads.filter((u) => this._encodedSize(u.bytes) > this.requestLimit);
    for (const item of oversize) {
      skipped.push({
        path: item.path,
        reason: "LARGE_FILE",
        size: item.bytes ? item.bytes.length : 0,
      });
    }
    const eligible = uploads.filter((u) => !oversize.includes(u));
    const deletions = deletionsRemote.map((d) => ({ op: "delete", path: d.path, remoteSha: d.remoteSha }));

    const total = Math.max(1, Math.ceil((eligible.length + deletions.length) / 1) === 0 ? 1 : 1);
    // 拆分以字节预算为主;GitHub 与 Gitee 都按统一预算切分
    const chunks = this._chunk(eligible, deletions);
    const batches = chunks.map((chunk, idx) => ({
      part: idx + 1,
      total: chunks.length,
      size: chunk.size,
      uploads: chunk.uploads,
      deletions: chunk.deletions,
      message: this._message(operationId, chunk, idx + 1, chunks.length),
      github: provider === "github" ? chunk.github : null,
      gitee: provider === "gitee" ? chunk.gitee : null,
    }));
    return { batches, skipped };
  }

  _chunk(uploads, deletions) {
    const chunks = [];
    let current = { uploads: [], deletions: [], size: 0, github: { entries: [], deletePaths: [] }, gitee: { operations: [] } };
    const flush = () => {
      if (current.uploads.length === 0 && current.deletions.length === 0) return;
      chunks.push(current);
      current = { uploads: [], deletions: [], size: 0, github: { entries: [], deletePaths: [] }, gitee: { operations: [] } };
    };
    for (const item of uploads) {
      const size = item.bytes ? item.bytes.length : 0;
      if (current.size + size > this.batchByteLimit && current.uploads.length > 0) flush();
      current.uploads.push(item);
      current.size += size;
      current.github.entries.push({ path: item.path, sha: null, mode: "100644" }); // sha 由 createBlob 填充
      current.gitee.operations.push({ op: item.op === "create" ? "create" : "update", path: item.path, bytes: item.bytes, remoteSha: item.remoteSha || null });
    }
    for (const d of deletions) {
      current.deletions.push(d);
      current.github.deletePaths.push({ path: d.path, sha: d.remoteSha });
      current.gitee.operations.push(d);
    }
    flush();
    return chunks;
  }

  _message(operationId, chunk, part, total) {
    // 固定三段计数,便于脚本与人工比对
    const creates = chunk.uploads.filter((u) => u.op === "create").length;
    const updates = chunk.uploads.filter((u) => u.op !== "create").length;
    const deletes = chunk.deletions.length;
    const summary = "create " + creates + ", update " + updates + ", delete " + deletes;
    const partTag = " part " + part + "/" + total;
    return "sync: " + summary + " [" + operationId + partTag + "]";
  }

  _encodedSize(bytes) {
    if (!bytes) return 0;
    return Math.ceil(bytes.length / 3) * 4 + 2048;
  }
}
