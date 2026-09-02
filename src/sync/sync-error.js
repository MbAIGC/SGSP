/**
 * SyncError: 同步错误的统一形态。
 * - category 决定重试、弹窗与状态颜色,UI 不允许从字符串猜测错误类型;
 * - message 必须可直接展示给用户;detail 用于诊断且必须脱敏;
 * - 原始 Error 仅保存在 cause(内存/日志),不写入可能被同步的目录。
 */

export const SyncErrorCategory = Object.freeze({
  NETWORK: "NETWORK",
  TIMEOUT: "TIMEOUT",
  AUTH: "AUTH",
  PERMISSION: "PERMISSION",
  REPOSITORY: "REPOSITORY",
  BRANCH: "BRANCH",
  REMOTE_CHANGED: "REMOTE_CHANGED",
  PUSH_REJECTED: "PUSH_REJECTED",
  CONFLICT: "CONFLICT",
  LARGE_FILE: "LARGE_FILE",
  LOCAL_FILE: "LOCAL_FILE",
  GIT: "GIT",
  CANCELLED: "CANCELLED",
  UNKNOWN: "UNKNOWN",
});

export class SyncError extends Error {
  constructor(fields) {
    const message = String((fields && fields.message) || "同步错误");
    super(message);
    this.name = "SyncError";
    this.category = (fields && fields.category) || SyncErrorCategory.UNKNOWN;
    this.code = (fields && fields.code) || "";
    this.operation = (fields && fields.operation) || "";
    this.phase = (fields && fields.phase) || "";
    this.httpStatus = (fields && fields.httpStatus) || 0;
    this.path = (fields && fields.path) || "";
    this.detail = (fields && fields.detail) || "";
    this.retryable = !!(fields && fields.retryable);
    this.recoverable = !!(fields && fields.recoverable);
    this.cause = (fields && fields.cause) || null;
  }

  /** 面向用户的单行摘要(HTTP 状态 + 文件路径 + 消息) */
  toDisplayText() {
    let text = this.message;
    if (this.httpStatus) text = "HTTP " + this.httpStatus + ": " + text;
    if (this.path) text += " (" + this.path + ")";
    return String(text).slice(0, 500);
  }

  toSerializable() {
    return {
      category: this.category,
      code: this.code,
      operation: this.operation,
      phase: this.phase,
      httpStatus: this.httpStatus,
      path: this.path,
      message: this.message,
      detail: redact(this.detail),
      retryable: this.retryable,
      recoverable: this.recoverable,
    };
  }
}

/** 脱敏: 隐藏 token / 密码 / Authorization / Cookie 等 */
export function redact(text) {
  return String(text == null ? "" : text)
    .replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]")
    .replace(/(token|access_token|client_secret|secret|password|passwd)["']?\s*[:=]\s*["']?[^\s"',;&]+/gi, "$1=[已隐藏]")
    .replace(/(authorization|cookie)["']?\s*[:=][^"',;&]+/gi, "$1=[已隐藏]")
    .replace(/token\s+[A-Za-z0-9_.\-]{8,}/g, "token [已隐藏]");
}

const NETWORK_PATTERN = /(timeout|timed?\s?out|econn|enotfound|eai_again|aborted|aborterror|socket|network|fetch failed|连接|网络|超时|dns|getaddrinfo)/i;
const LARGE_FILE_PATTERN = /(too large|too big|exceed|文件过大|过大|超过.*限|file size)/i;

function statusOf(node) {
  if (node && typeof node.status === "number" && node.status) return node.status;
  if (node && node.response && typeof node.response.status === "number") return node.response.status;
  return 0;
}

function messageOf(node) {
  const data = (node && node.response && node.response.data) || {};
  const m = data.message || (node && node.message) || "";
  return m ? String(m) : "";
}

/**
 * 沿 cause 链归类错误。只读特征、不吞错:
 * 返回 {category, httpStatus, path, message, retryable, recoverable}。
 * 识别 SyncError 约定的冲突标记(category===CONFLICT 或 code===CONFLICT_CODE)。
 */
export const CONFLICT_CODE = 300;

export function classifyError(err) {
  let node = err;
  let status = 0;
  let path = "";
  let message = "";
  let conflict = false;
  let aborted = false;

  for (let i = 0; node && i < 8; i++) {
    if (node.category === SyncErrorCategory.CONFLICT || node.code === CONFLICT_CODE) conflict = true;
    if (node instanceof SyncError && node.category) {
      // 已是 SyncError: 直接采用其分类与消息(链条上最具体的错误优先)
      if (!status) status = statusOf(node);
      if (!path && node.path) path = node.path;
      return {
        category: node.category,
        httpStatus: status,
        path,
        message: node.message || message || String((err && err.message) || err || "未知错误"),
        retryable: node.retryable,
        recoverable: node.recoverable,
      };
    }
    if (!status) status = statusOf(node);
    if (!path && node.path) path = node.path;
    const m = messageOf(node);
    if (m) message = m;
    if (node && (node.name === "AbortError" || /abort/i.test(String(node.message || "")))) aborted = true;
    node = node.cause || (node instanceof Error && node.cause) || null;
  }

  const text = (message || String((err && err.message) || err || "")).toLowerCase();
  const base = { httpStatus: status, path, message: message || String((err && err.message) || err || "未知错误") };

  if (conflict) return { ...base, category: SyncErrorCategory.CONFLICT, retryable: false, recoverable: true };
  if (aborted) return { ...base, category: SyncErrorCategory.CANCELLED, retryable: false, recoverable: true };
  if (status === 401) return { ...base, category: SyncErrorCategory.AUTH, retryable: false, recoverable: true };
  if (status === 403) return { ...base, category: SyncErrorCategory.PERMISSION, retryable: false, recoverable: true };
  if (status === 404) {
    const cat = /branch|分支|ref|refname/i.test(text) ? SyncErrorCategory.BRANCH : SyncErrorCategory.REPOSITORY;
    return { ...base, category: cat, retryable: false, recoverable: true };
  }
  if (status === 409 || status === 422) {
    return { ...base, category: SyncErrorCategory.PUSH_REJECTED, retryable: true, recoverable: false };
  }
  if (status === 413) return { ...base, category: SyncErrorCategory.LARGE_FILE, retryable: false, recoverable: true };
  if (status >= 400) return { ...base, category: SyncErrorCategory.GIT, retryable: false, recoverable: false };
  if (/(timeout|timed?\s?out|超时)/i.test(text)) return { ...base, category: SyncErrorCategory.TIMEOUT, retryable: true, recoverable: false };
  if (NETWORK_PATTERN.test(text)) return { ...base, category: SyncErrorCategory.NETWORK, retryable: true, recoverable: false };
  if (LARGE_FILE_PATTERN.test(text)) return { ...base, category: SyncErrorCategory.LARGE_FILE, retryable: false, recoverable: true };
  return { ...base, category: SyncErrorCategory.UNKNOWN, retryable: false, recoverable: false };
}

/** 把任意错误转换为 SyncError(保留 cause 与分类),用于跨层统一抛出 */
export function toSyncError(err, defaults = {}) {
  if (err instanceof SyncError) return err;
  const c = classifyError(err);
  return new SyncError({
    category: defaults.category || c.category,
    operation: defaults.operation || "",
    phase: defaults.phase || "",
    httpStatus: c.httpStatus,
    path: defaults.path || c.path,
    message: defaults.message || c.message,
    detail: redact(String((err && err.message) || err || "")),
    retryable: defaults.retryable !== undefined ? defaults.retryable : c.retryable,
    recoverable: defaults.recoverable !== undefined ? defaults.recoverable : c.recoverable,
    cause: err,
  });
}

/** 遍历 cause 链收集所有冲突节点(多文件冲突) */
export function extractConflicts(err) {
  const conflicts = [];
  let node = err;
  for (let i = 0; node && i < 16; i++) {
    if (node && node.conflictInfo) {
      conflicts.push(node.conflictInfo);
    } else if (node && (node.code === CONFLICT_CODE || node.category === SyncErrorCategory.CONFLICT)) {
      conflicts.push({
        path: node.path || "",
        reason: node.message || "文件冲突",
        baseRef: node.baseRef || null,
        localRef: node.localRef || null,
        remoteRef: node.remoteRef || null,
      });
    }
    node = node.cause || null;
  }
  return conflicts;
}
