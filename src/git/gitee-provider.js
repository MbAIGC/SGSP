/**
 * GiteeProvider: 与 GitProvider 相同的查询契约;写入走逐文件 contents API。
 *
 * 原子性说明(2.0 方案 §6.3): Gitee v5 不提供与 GitHub Git Data API 等价的
 * 服务端原子树提交 + CAS 更新,因此写入路径实现为:
 *  - 写入前再次确认远端 HEAD(记录到操作日志);
 *  - 每个文件操作记录前映像与后映像;
 *  - 任意中途失败抛 PARTIAL_REMOTE_WRITE,禁止自动标记成功;
 *  - 恢复动作由 ConflictService/诊断面板的恢复向导提供,不做自动回放。
 */

import { GitProvider } from "./git-provider.js";
import { SyncError, SyncErrorCategory } from "../sync/sync-error.js";
import { encodePath } from "./github-provider.js";

export class GiteeProvider extends GitProvider {
  constructor(opts) {
    super(Object.assign({ platform: "gitee" }, opts));
  }

  baseUrl() {
    return "https://gitee.com/api/v5";
  }

  displayName() {
    return "Gitee";
  }

  _repoPath() {
    return "/repos/" + this.owner + "/" + this.repo;
  }

  _wrap(err, operation, message) {
    if (err instanceof SyncError) return err;
    const status = (err && err.httpStatus) || 0;
    return new SyncError({
      category: status === 404 ? SyncErrorCategory.REPOSITORY : SyncErrorCategory.GIT,
      operation,
      httpStatus: status,
      message: message || (err && err.message) || String(err),
      detail: String((err && err.detail) || (err && err.message) || err),
      retryable: status >= 500,
      recoverable: false,
      cause: err,
    });
  }

  static _mapCommit(data) {
    return {
      sha: data.sha,
      treeSha: data.commit && data.commit.tree && data.commit.tree.sha,
      message: (data.commit && data.commit.message) || "",
      author: (data.commit && data.commit.author && data.commit.author.name) || "",
      email: (data.commit && data.commit.author && data.commit.author.email) || "",
      date: (data.commit && data.commit.author && data.commit.author.date) || "",
      parents: (data.parents || []).map((p) => p.sha),
    };
  }

  async getBranchHead() {
    try {
      const res = await this.http.request({
        path: this._repoPath() + "/branches/" + encodeURIComponent(this.branch),
      });
      const sha = res.data && res.data.commit && res.data.commit.sha;
      if (!sha) throw new Error("分支响应缺少 commit.sha");
      return { sha };
    } catch (err) {
      throw this._wrap(err, "getBranchHead", "读取分支 HEAD 失败");
    }
  }

  async getCommit(shaOrRef) {
    try {
      const res = await this.http.request({
        path: this._repoPath() + "/commits/" + encodeURIComponent(shaOrRef),
      });
      return GiteeProvider._mapCommit(res.data);
    } catch (err) {
      throw this._wrap(err, "getCommit", "读取提交失败(" + shaOrRef + ")");
    }
  }

  async getTree(treeSha) {
    try {
      const res = await this.http.request({
        path: this._repoPath() + "/git/trees/" + treeSha,
        query: { recursive: 1 },
      });
      return (res.data.tree || res.data || []).map((t) => ({
        path: t.path,
        mode: t.mode,
        type: t.type,
        sha: t.sha,
        size: t.size || 0,
      }));
    } catch (err) {
      throw this._wrap(err, "getTree", "读取远端目录树失败");
    }
  }

  async getBlob(blobSha) {
    try {
      const res = await this.http.request({
        path: this._repoPath() + "/git/blobs/" + blobSha,
      });
      const b64 = res.data.content || "";
      return {
        sha: res.data.sha,
        size: res.data.size,
        contentBase64: b64,
        bytes: GitProvider.base64ToBytes(b64),
      };
    } catch (err) {
      throw this._wrap(err, "getBlob", "读取远端文件内容失败");
    }
  }

  async getFileContent(path, ref) {
    try {
      const res = await this.http.request({
        path: this._repoPath() + "/contents/" + encodePath(path),
        query: { ref },
      });
      const data = res.data;
      const b64 = (data && data.content) || "";
      const bytes = GitProvider.base64ToBytes(b64);
      return {
        sha: data.sha,
        size: data.size,
        contentBase64: b64,
        bytes,
        text: GitProvider.bytesToText(bytes),
      };
    } catch (err) {
      if (err instanceof SyncError && err.httpStatus === 404) {
        throw new SyncError({
          category: SyncErrorCategory.GIT,
          code: "FILE_NOT_FOUND",
          operation: "getFileContent",
          httpStatus: 404,
          path,
          message: "远端文件不存在: " + path,
          retryable: false,
          recoverable: true,
          cause: err,
        });
      }
      throw this._wrap(err, "getFileContent", "读取远端文件失败(" + path + ")");
    }
  }

  async compareCommits(baseRef, headRef) {
    try {
      const res = await this.http.request({
        path: this._repoPath() + "/compare",
        query: { base: baseRef, head: headRef },
      });
      return (res.data.files || []).map((f) => ({ filename: f.filename, status: f.status, sha: f.sha }));
    } catch (err) {
      // Gitee 对无共同祖先的对比会失败: 视为不可对比,由调用方兜底
      if (err instanceof SyncError && err.httpStatus === 404) return [];
      throw this._wrap(err, "compareCommits", "提交对比失败");
    }
  }

  async listCommits(query = {}) {
    try {
      const res = await this.http.request({
        path: this._repoPath() + "/commits",
        query: {
          sha: query.sha,
          path: query.path,
          since: query.since,
          until: query.until,
          per_page: query.perPage,
          page: query.page,
        },
      });
      return (res.data || []).map((c) => GiteeProvider._mapCommit(c));
    } catch (err) {
      throw this._wrap(err, "listCommits", "读取提交列表失败");
    }
  }

  /** Gitee: listCommits 响应头含 total_page/total_count,首提交取最后一页 */
  async getInitialCommit() {
    try {
      const first = await this.http.request({
        path: this._repoPath() + "/commits",
        query: { sha: this.branch, per_page: 1, page: 1 },
      });
      if (!Array.isArray(first.data) || first.data.length === 0) return null;
      let lastPage = 1;
      if (first.headers && typeof first.headers.get === "function") {
        const tp = Number(first.headers.get("total_page"));
        const tc = Number(first.headers.get("total_count"));
        lastPage = !isNaN(tp) && tp > 0 ? tp : !isNaN(tc) && tc > 0 ? tc : 1;
      }
      if (lastPage <= 1) return GiteeProvider._mapCommit(first.data[0]);
      const last = await this.http.request({
        path: this._repoPath() + "/commits",
        query: { sha: this.branch, per_page: 1, page: lastPage },
      });
      return GiteeProvider._mapCommit(last.data[0]);
    } catch (err) {
      throw this._wrap(err, "getInitialCommit", "读取分支首个提交失败");
    }
  }

  // ---------- 写入: 逐文件 contents API ----------

  /** 单文件创建/更新。existingSha 为空表示创建,否则更新 */
  async putFileContent(path, bytes, { message, branch, existingSha }) {
    const body = {
      content: GitProvider.bytesToBase64(bytes),
      branch: branch || this.branch,
      message: message || "sync: update " + path,
    };
    if (existingSha) body.sha = existingSha;
    try {
      const res = await this.http.request({
        path: this._repoPath() + "/contents/" + encodePath(path),
        method: existingSha ? "PUT" : "POST",
        body,
      });
      const commit = res.data && res.data.commit;
      return { path, sha: res.data && res.data.content && res.data.content.sha, commitSha: commit && commit.sha };
    } catch (err) {
      if (err instanceof SyncError && err.httpStatus === 404 && existingSha) {
        // 远端文件已被他人删除: 报告为远端变化,由上层重新规划
        throw new SyncError({
          category: SyncErrorCategory.REMOTE_CHANGED,
          code: "TARGET_GONE",
          operation: "putFileContent",
          httpStatus: 404,
          path,
          message: "远端文件在写入前已不存在: " + path,
          retryable: true,
          recoverable: false,
          cause: err,
        });
      }
      if (err instanceof SyncError && (err.httpStatus === 409 || err.httpStatus === 422)) {
        throw new SyncError({
          category: SyncErrorCategory.REMOTE_CHANGED,
          code: "NON_FAST_FORWARD",
          operation: "putFileContent",
          httpStatus: err.httpStatus,
          path,
          message: "远端已更新,写入被拒绝: " + path,
          retryable: true,
          recoverable: false,
          cause: err,
        });
      }
      throw this._wrap(err, "putFileContent", "远端文件写入失败(" + path + ")");
    }
  }

  /** 单文件删除 */
  async deleteFileContent(path, { message, branch, sha }) {
    try {
      await this.http.request({
        path: this._repoPath() + "/contents/" + encodePath(path),
        method: "DELETE",
        query: { sha, branch: branch || this.branch, message: message || "sync: delete " + path },
        body: { sha, branch: branch || this.branch, message: message || "sync: delete " + path },
      });
      return { path };
    } catch (err) {
      if (err instanceof SyncError && err.httpStatus === 404) {
        throw new SyncError({
          category: SyncErrorCategory.REMOTE_CHANGED,
          code: "TARGET_GONE",
          operation: "deleteFileContent",
          httpStatus: 404,
          path,
          message: "远端文件已不存在,无需删除: " + path,
          retryable: true,
          recoverable: false,
          cause: err,
        });
      }
      throw this._wrap(err, "deleteFileContent", "远端文件删除失败(" + path + ")");
    }
  }

  /**
   * 原子能力声明: Gitee 无服务端 CAS,拒绝走 updateRef 契约,
   * 引擎据此选择逐文件写入 + 操作日志路径。
   */
  async _updateRefRaw() {
    throw new SyncError({
      category: SyncErrorCategory.GIT,
      code: "ATOMIC_WRITE_UNSUPPORTED",
      operation: "updateBranchRef",
      message: "Gitee 不支持原子引用更新,请使用逐文件写入路径",
      retryable: false,
      recoverable: false,
    });
  }

  /**
   * 执行逐文件操作序列(确定性顺序,不并行)。
   * @param {Array<{op:"create"|"update"|"delete", path, bytes?, remoteSha?}>} operations
   * @param {object} opts {message, branch}
   * @returns {Promise<{operations:Array, partialFailure:SyncError|null}>}
   *   任一失败时: 已完成的操作保留在日志中,错误抛出 PARTIAL_REMOTE_WRITE。
   */
  async applyFileOperations(operations, { message, branch } = {}) {
    const log = [];
    // 空仓库: 分支不存在时首个文件写入即建分支(Gitee contents API 语义),前置读取失败按无头处理
    let headBefore = { sha: "" };
    try {
      headBefore = await this.getBranchHead();
    } catch (err) {
      if (!(err instanceof SyncError && err.httpStatus === 404)) throw err;
    }
    for (const op of operations) {
      const entry = {
        op: op.op,
        path: op.path,
        beforeSha: op.remoteSha || null,
        afterSha: null,
        headBefore: headBefore.sha,
        headAfter: null,
        at: new Date().toISOString(),
      };
      try {
        if (op.op === "delete") {
          await this.deleteFileContent(op.path, { message, branch, sha: op.remoteSha });
        } else {
          const result = await this.putFileContent(op.path, op.bytes, {
            message,
            branch,
            existingSha: op.op === "update" ? op.remoteSha : undefined,
          });
          entry.afterSha = result.sha;
          entry.commitSha = result.commitSha;
        }
      } catch (err) {
        entry.error = (err && err.message) || String(err);
        log.push(entry);
        const headAfter = await this.getBranchHead().catch(() => ({ sha: "" }));
        for (const e of log) e.headAfter = headAfter.sha;
        throw new SyncError({
          category: SyncErrorCategory.GIT,
          code: "PARTIAL_REMOTE_WRITE",
          operation: "applyFileOperations",
          path: op.path,
          message:
            "远端写入中途失败(" + log.length + "/" + operations.length + " 已完成),本轮不标记成功: " + op.path,
          detail: JSON.stringify(log).slice(0, 2000),
          retryable: false,
          recoverable: true,
          cause: err,
        });
      }
      log.push(entry);
    }
    const headAfter = await this.getBranchHead().catch(() => ({ sha: "" }));
    for (const e of log) e.headAfter = headAfter.sha;
    return { operations: log, partialFailure: null, remoteHead: headAfter.sha };
  }
}
