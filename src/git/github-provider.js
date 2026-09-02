/**
 * GitHubProvider: 基于 Git Data API 的原子树提交实现。
 * 写入路径: createBlob → createTree(base_tree) → createCommit(parent=期望HEAD) → updateRef(force=false) → 回读确认。
 * 查询路径同时服务同步引擎与同步历史面板。
 */

import { GitProvider } from "./git-provider.js";
import { SyncError, SyncErrorCategory } from "../sync/sync-error.js";

export class GitHubProvider extends GitProvider {
  constructor(opts) {
    super(Object.assign({ platform: "github" }, opts));
  }

  baseUrl() {
    return "https://api.github.com";
  }

  displayName() {
    return "GitHub";
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
      const res = await this.http.request({ path: this._repoPath() + "/git/ref/heads/" + this.branch });
      return { sha: res.data.object.sha };
    } catch (err) {
      throw this._wrap(err, "getBranchHead", "读取分支 HEAD 失败");
    }
  }

  async getCommit(shaOrRef) {
    try {
      const res = await this.http.request({ path: this._repoPath() + "/commits/" + encodeURIComponent(shaOrRef) });
      return GitHubProvider._mapCommit(res.data);
    } catch (err) {
      throw this._wrap(err, "getCommit", "读取提交失败(" + shaOrRef + ")");
    }
  }

  async getTree(treeSha) {
    try {
      const res = await this.http.request({
        path: this._repoPath() + "/git/trees/" + treeSha,
        query: { recursive: "1" },
      });
      return (res.data.tree || []).map((t) => ({
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
        responseType: "json",
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
        headers: { Accept: "application/vnd.github.raw+json, application/json" },
        responseType: "json",
      });
      const data = res.data;
      // 请求 raw 优先: 纯文本直接返回;JSON 兜底(base64)
      if (typeof data === "string") {
        const bytes = GitProvider.textToBytes(data);
        return { sha: "", size: bytes.length, contentBase64: GitProvider.bytesToBase64(bytes), bytes, text: data };
      }
      const b64 = data.content || "";
      const bytes = GitProvider.base64ToBytes(b64);
      return { sha: data.sha, size: data.size, contentBase64: b64, bytes, text: GitProvider.bytesToText(bytes) };
    } catch (err) {
      if (err instanceof SyncError && err.httpStatus === 404) {
        const notFound = new SyncError({
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
        throw notFound;
      }
      throw this._wrap(err, "getFileContent", "读取远端文件失败(" + path + ")");
    }
  }

  async compareCommits(baseRef, headRef) {
    try {
      const res = await this.http.request({
        path: this._repoPath() + "/compare/" + encodeURIComponent(baseRef) + "..." + encodeURIComponent(headRef),
      });
      return (res.data.files || []).map((f) => ({
        filename: f.filename,
        status: f.status,
        sha: f.sha,
      }));
    } catch (err) {
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
      return (res.data || []).map((c) => Object.assign(GitHubProvider._mapCommit(c), {}));
    } catch (err) {
      throw this._wrap(err, "listCommits", "读取提交列表失败");
    }
  }

  /**
   * 分支首提交: listCommits per_page=1 后按 Link 头跳到最后一页。
   * 无提交(空仓库)返回 null。
   */
  async getInitialCommit() {
    try {
      const first = await this.http.request({
        path: this._repoPath() + "/commits",
        query: { sha: this.branch, per_page: 1, page: 1 },
      });
      if (!Array.isArray(first.data) || first.data.length === 0) return null;
      const lastPage = parseLinkLastPage(first.link) || 1;
      if (lastPage <= 1) return GitHubProvider._mapCommit(first.data[0]);
      const last = await this.http.request({
        path: this._repoPath() + "/commits",
        query: { sha: this.branch, per_page: 1, page: lastPage },
      });
      return GitHubProvider._mapCommit(last.data[0]);
    } catch (err) {
      throw this._wrap(err, "getInitialCommit", "读取分支首个提交失败");
    }
  }

  async getMergeBase(leftSha, rightSha) {
    try {
      const res = await this.http.request({
        path: this._repoPath() + "/compare/" + encodeURIComponent(leftSha) + "..." + encodeURIComponent(rightSha),
      });
      const mb = res.data.merge_base_commit;
      return mb && mb.sha ? mb.sha : null;
    } catch (err) {
      return null; // 对比失败按无合并基处理,由调用方进入恢复流程
    }
  }

  async createBlob(bytes) {
    try {
      const res = await this.http.request({
        path: this._repoPath() + "/git/blobs",
        method: "POST",
        body: { content: GitProvider.bytesToBase64(bytes), encoding: "base64" },
      });
      return res.data.sha;
    } catch (err) {
      throw this._wrap(err, "createBlob", "上传文件内容(Blob)失败");
    }
  }

  async createTree(baseTreeSha, entries) {
    try {
      const body = { tree: entries.map((e) => ({ path: e.path, mode: e.mode || "100644", type: "blob", sha: e.sha })) };
      if (baseTreeSha) body.base_tree = baseTreeSha;
      const res = await this.http.request({
        path: this._repoPath() + "/git/trees",
        method: "POST",
        body,
      });
      return { sha: res.data.sha };
    } catch (err) {
      throw this._wrap(err, "createTree", "创建远端目录树失败");
    }
  }

  async createCommit({ message, treeSha, parents }) {
    try {
      const res = await this.http.request({
        path: this._repoPath() + "/git/commits",
        method: "POST",
        body: { message, tree: treeSha, parents },
      });
      return { sha: res.data.sha };
    } catch (err) {
      throw this._wrap(err, "createCommit", "创建远端提交失败");
    }
  }

  async _updateRefRaw(newSha) {
    try {
      await this.http.request({
        path: this._repoPath() + "/git/refs/heads/" + this.branch,
        method: "PATCH",
        body: { sha: newSha, force: false },
      });
    } catch (err) {
      throw this.mapUpdateRefFailure(err);
    }
  }

  /** 空仓库首推: 创建分支引用 */
  async _createRefRaw(commitSha) {
    await this.http.request({
      path: this._repoPath() + "/git/refs",
      method: "POST",
      body: { ref: "refs/heads/" + this.branch, sha: commitSha },
    });
  }
}

/** 解析 Link 头中 rel="last" 的页码 */
export function parseLinkLastPage(linkHeader) {
  if (!linkHeader) return 0;
  const m = /[?&]page=(\d+)>;\s*rel="last"/.exec(linkHeader);
  return m ? Number(m[1]) : 0;
}

/** contents API 路径编码: 保留斜杠 */
export function encodePath(path) {
  return String(path)
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}
