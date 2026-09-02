/**
 * GitProvider 契约与共享实现(2.0 方案 §6.1)。
 * 子类实现具体平台 API;本基类提供:
 * - UTF-8/Base64 编解码与 git blob SHA-1 计算(用于本地与远端内容等价判断);
 * - 错误包装(统一 SyncError,不泄露凭据);
 * - updateBranchRef 的安全流程骨架(force 固定 false + 更新前二次读 HEAD + 成功后回读确认)。
 */

import { HttpClient } from "./http-client.js";
import { SyncError, SyncErrorCategory } from "../sync/sync-error.js";

export class GitProvider {
  /**
   * @param {object} opts {platform, owner, repo, branch, token, timeoutMs}
   */
  constructor(opts) {
    this.platform = opts.platform;
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.branch = opts.branch;
    this.token = opts.token || "";
    this.http = new HttpClient({
      baseUrl: this.baseUrl(),
      token: this.token,
      timeoutMs: opts.timeoutMs,
      platform: this.platform,
    });
  }

  /** @returns {string} 平台 API 根地址,由子类实现 */
  baseUrl() {
    throw new Error("子类必须实现 baseUrl()");
  }

  /** 平台展示名 */
  displayName() {
    return this.platform;
  }

  // ---------- 编码与内容等价 ----------

  static encoder = new TextEncoder();
  static decoder = new TextDecoder("utf-8", { fatal: false });

  static textToBytes(text) {
    return GitProvider.encoder.encode(String(text == null ? "" : text));
  }

  static bytesToText(bytes) {
    return GitProvider.decoder.decode(bytes);
  }

  static bytesToBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  static base64ToBytes(b64) {
    const clean = String(b64 || "").replace(/\s+/g, "");
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /**
   * 计算 git blob SHA-1(即 "blob <len>\0<content>" 的 sha1),
   * 可直接与 tree/compare 返回的 blob sha 对比,无需下载远端内容。
   * 环境不支持 crypto.subtle 时返回 null,调用方须回退为内容比对。
   */
  static async gitBlobSha(content) {
    const bytes = typeof content === "string" ? GitProvider.textToBytes(content) : content;
    if (!(globalThis.crypto && globalThis.crypto.subtle)) return null;
    const header = GitProvider.textToBytes("blob " + bytes.length + "\0");
    const merged = new Uint8Array(header.length + bytes.length);
    merged.set(header, 0);
    merged.set(bytes, header.length);
    const digest = await globalThis.crypto.subtle.digest("SHA-1", merged);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  // ---------- 查询契约 ----------

  /** 分支 HEAD: 返回 {sha} */
  async getBranchHead() {
    throw new Error("子类必须实现 getBranchHead()");
  }

  /** 提交详情(sha 或分支名): 返回 {sha, treeSha, message, author, date, parents} */
  async getCommit(shaOrRef) {
    throw new Error("子类必须实现 getCommit()");
  }

  /** 递归 tree: 返回 [{path, mode, type, sha, size}] */
  async getTree(treeSha) {
    throw new Error("子类必须实现 getTree()");
  }

  /** blob 内容: 返回 {sha, size, contentBase64, bytes} */
  async getBlob(blobSha) {
    throw new Error("子类必须实现 getBlob()");
  }

  /** 按 路径+ref 读取内容(contents API): 返回 {sha, size, contentBase64, bytes} */
  async getFileContent(path, ref) {
    throw new Error("子类必须实现 getFileContent()");
  }

  /** 提交对比: 返回 [{filename, status, sha}] */
  async compareCommits(baseRef, headRef) {
    throw new Error("子类必须实现 compareCommits()");
  }

  /** 列提交(同步历史用): query={sha, path, since, until, perPage, page} */
  async listCommits(query) {
    throw new Error("子类必须实现 listCommits()");
  }

  /** 分支首提交(首次同步的候选基准): 返回 {sha, treeSha, date} 或 null */
  async getInitialCommit() {
    throw new Error("子类必须实现 getInitialCommit()");
  }

  /** 合并基(可用于基准重建);平台不支持时返回 null */
  async getMergeBase(leftSha, rightSha) {
    return null;
  }

  // ---------- 写入契约 ----------

  async createBlob(bytes, encoding = "base64") {
    throw new Error("子类必须实现 createBlob()");
  }

  /** entries: [{path, mode, type:"blob", sha}] ;sha 为 null 表示删除 */
  async createTree(baseTreeSha, entries) {
    throw new Error("子类必须实现 createTree()");
  }

  async createCommit({ message, treeSha, parents }) {
    throw new Error("子类必须实现 createCommit()");
  }

  /**
   * 更新分支引用(安全流程):
   * 1. force 固定 false;
   * 2. 更新前二次读取远端 HEAD,与 expectedHead 不一致 → REMOTE_CHANGED(不写入);
   * 3. 更新被拒(非快进) → PUSH_REJECTED;
   * 4. 成功后回读 HEAD,不等于新提交 → REMOTE_CHANGED(不更新任何本地基准)。
   * @returns {Promise<{confirmedSha:string}>}
   */
  async updateBranchRef(newSha, { expectedHead } = {}) {
    if (!expectedHead) {
      throw new SyncError({
        category: SyncErrorCategory.GIT,
        code: "MISSING_EXPECTED_HEAD",
        operation: "updateBranchRef",
        message: "缺少 expectedHead,拒绝更新远端引用",
        retryable: false,
        recoverable: false,
      });
    }
    const observed = await this.getBranchHead();
    if (observed.sha !== expectedHead) {
      throw new SyncError({
        category: SyncErrorCategory.REMOTE_CHANGED,
        code: "REMOTE_HEAD_MOVED",
        operation: "updateBranchRef",
        message: "远端分支已变化(期望 " + expectedHead.slice(0, 8) + ",实际 " + observed.sha.slice(0, 8) + "),本次不写入",
        retryable: true,
        recoverable: false,
      });
    }
    await this._updateRefRaw(newSha);
    const confirmed = await this.getBranchHead();
    if (confirmed.sha !== newSha) {
      throw new SyncError({
        category: SyncErrorCategory.REMOTE_CHANGED,
        code: "CONFIRM_FAILED",
        operation: "updateBranchRef",
        message: "远端引用回读不一致,提交未确认",
        retryable: false,
        recoverable: false,
      });
    }
    return { confirmedSha: confirmed.sha };
  }

  /** 平台原生引用更新(子类实现;失败抛 HTTP 层 SyncError) */
  async _updateRefRaw(newSha) {
    throw new Error("子类必须实现 _updateRefRaw()");
  }

  /**
   * 空仓库首推: 创建分支引用并回读确认。
   * 与 updateBranchRef 同级的安全契约,仅当远端确认分支不存在时使用。
   */
  async ensureBranchRef(commitSha) {
    try {
      await this._createRefRaw(commitSha);
    } catch (err) {
      if (err instanceof SyncError && (err.httpStatus === 409 || err.httpStatus === 422)) {
        // 规划时分支不存在、创建时已存在 → 竞争,本轮不写入
        throw new SyncError({
          category: SyncErrorCategory.REMOTE_CHANGED,
          code: "REMOTE_HEAD_MOVED",
          operation: "ensureBranchRef",
          message: "创建分支引用时远端分支已存在(疑似竞争),本轮不写入",
          retryable: true,
          recoverable: false,
          cause: err,
        });
      }
      throw err;
    }
    const confirmed = await this.getBranchHead();
    if (confirmed.sha !== commitSha) {
      throw new SyncError({
        category: SyncErrorCategory.REMOTE_CHANGED,
        code: "CONFIRM_FAILED",
        operation: "ensureBranchRef",
        message: "分支引用创建后回读不一致,提交未确认",
        retryable: false,
        recoverable: false,
      });
    }
    return { confirmedSha: confirmed.sha };
  }

  /** 平台原生引用创建(子类实现) */
  async _createRefRaw(commitSha) {
    throw new Error("子类必须实现 _createRefRaw()");
  }

  // ---------- 写入失败语义 ----------

  mapUpdateRefFailure(err) {
    const status = (err && err.httpStatus) || 0;
    if (status === 409 || status === 422) {
      return new SyncError({
        category: SyncErrorCategory.PUSH_REJECTED,
        code: "NON_FAST_FORWARD",
        operation: "updateBranchRef",
        httpStatus: status,
        message: "远端分支已前移,本次提交未写入(force=false,不覆盖远端)",
        detail: (err && err.detail) || "",
        retryable: true,
        recoverable: false,
        cause: err,
      });
    }
    return err;
  }

  /** 统一错误包装: 保留底层 SyncError,其余按 operation 归类 */
  wrapError(err, operation, message) {
    if (err instanceof SyncError) return err;
    return new SyncError({
      category: SyncErrorCategory.GIT,
      operation,
      message: message || (err && err.message) || String(err),
      detail: String((err && err.message) || err),
      cause: err,
    });
  }
}
