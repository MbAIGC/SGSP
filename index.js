var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/plugin/index.js
var index_exports = {};
__export(index_exports, {
  default: () => SyGspPlugin
});
module.exports = __toCommonJS(index_exports);
var q = __toESM(require("siyuan"));

// src/local/kernel.js
function createKernel(q2) {
  async function post(path, data) {
    if (q2 && typeof q2.fetchSyncPost === "function") {
      const res = await q2.fetchSyncPost(path, data);
      if (res && typeof res.code === "number" && res.code !== 0) {
        throw new Error("内核请求失败 " + path + ": " + (res.msg || res.code));
      }
      return res && res.data !== void 0 ? res.data : res;
    }
    const resp = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data || {})
    });
    if (!resp.ok) throw new Error("内核请求失败 " + path + ": HTTP " + resp.status);
    const text = await resp.text();
    try {
      const json = JSON.parse(text);
      if (json && json.code && json.code !== 0) throw new Error("内核请求失败 " + path + ": " + (json.msg || json.code));
      return json && json.data !== void 0 ? json.data : json;
    } catch (e) {
      if (e instanceof SyntaxError) return text;
      throw e;
    }
  }
  async function getFile(path) {
    const resp = await fetch("/api/file/getFile", {
      method: "POST",
      body: JSON.stringify({ path })
    });
    return resp.ok ? resp.blob() : null;
  }
  async function putFile(path, blob, isDir = false) {
    const form = new FormData();
    form.append("path", path);
    form.append("isDir", String(isDir));
    form.append("modTime", String(Date.now()));
    form.append("file", blob);
    const resp = await fetch("/api/file/putFile", { method: "POST", body: form });
    if (!resp.ok) throw new Error("写入本地文件失败 " + path + ": HTTP " + resp.status);
    return resp.json();
  }
  async function removeFile(path) {
    return post("/api/file/removeFile", { path });
  }
  async function readDir(path) {
    const data = await post("/api/file/readDir", { path });
    if (Array.isArray(data)) return data;
    const dirs = Array.isArray(data && data.dir) ? data.dir : [];
    const files = Array.isArray(data && data.file) ? data.file : [];
    return dirs.concat(files);
  }
  return {
    post,
    getFile,
    putFile,
    removeFile,
    readDir,
    exportMdContent: (id) => post("/api/export/exportMdContent", { id }),
    createDocWithMd: (notebook, path, markdown) => post("/api/filetree/createDocWithMd", { notebook, path, markdown }),
    createDoc: (notebook, path, title, md) => post("/api/filetree/createDoc", { notebook, path, title, md, listDocTree: false }),
    updateBlock: (dataType, data, id) => post("/api/block/updateBlock", { dataType, data, id }),
    getBlockKramdown: (id) => post("/api/block/getBlockKramdown", { id }),
    sql: (stmt) => post("/api/query/sql", { stmt }),
    lsNotebooks: () => post("/api/notebook/lsNotebooks", {}),
    createNotebook: (name) => post("/api/notebook/createNotebook", { name }),
    getNotebookConf: (notebook) => post("/api/notebook/getNotebookConf", { notebook }),
    refreshFiletree: () => post("/api/filetree/refreshFiletree", {})
  };
}

// src/local/ignore-rules.js
var DEFAULT_IGNORES = Object.freeze([
  "data/plugins/*",
  "data/widgets/*",
  ".lock",
  "temp/*"
]);
var ALWAYS_IGNORES = Object.freeze(["data/storage/petal/SY-GSP/*"]);
function normalizeUserIgnores(raw) {
  return String(raw == null ? "" : raw).split(";").map((s) => s.trim().replace(/^\/+|\/+$/g, "").trim()).filter((s) => s.length > 0);
}
function isIgnored(path, patterns) {
  const p = String(path == null ? "" : path).toLowerCase();
  return patterns.some((pattern) => {
    const s = String(pattern).toLowerCase();
    if (s.indexOf("*") === -1) return p === s;
    return new RegExp("^" + s.replace(/\*/g, ".*") + "$").test(p);
  });
}
function buildIgnoreList(userRaw, extra = []) {
  return [
    ...DEFAULT_IGNORES,
    ...ALWAYS_IGNORES,
    ...normalizeUserIgnores(userRaw),
    ...normalizeUserIgnores(Array.isArray(extra) ? extra.join(";") : String(extra || ""))
  ];
}

// src/util/path.js
function basename(p) {
  const s = String(p == null ? "" : p);
  const idx = s.lastIndexOf("/");
  return idx >= 0 ? s.slice(idx + 1) : s;
}
function extname(p) {
  const name = basename(p);
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return "";
  return name.slice(idx);
}
function isSiyuanDocPath(p) {
  return /^data\/(\d{14}-[a-zA-Z0-9]+)(\/\d{14}-[a-zA-Z0-9]+)*(\.sy)?$/.test(String(p == null ? "" : p));
}

// src/local/workspace-adapter.js
var WorkspaceAdapter = class {
  /**
   * @param {object} kernel createKernel 产物
   * @param {object} opts {getUserIgnore: () => string, getSyncRange: () => number, getNotebooks: async () => [{id,name}]}
   */
  constructor(kernel, opts = {}) {
    this.kernel = kernel;
    this.getUserIgnore = opts.getUserIgnore || (() => "");
    this.getSyncRange = opts.getSyncRange || (() => 0);
    this.getNotebooks = opts.getNotebooks || (async () => []);
    this.enumErrorOccurred = false;
  }
  resetEnumError() {
    this.enumErrorOccurred = false;
  }
  /** 当前同步范围对应的扫描根(空串表示整个工作空间) */
  async rootsFor(range) {
    if (range === void 0 || range === null) range = this.getSyncRange();
    const notebooks = range === 2 ? await this.getNotebooks() : [];
    const roots = [];
    if (range === 0) roots.push("");
    else if (range === 1) roots.push("data");
    else {
      roots.push("data/assets", "data/.siyuan");
      for (const n of notebooks) roots.push("data/" + n.id);
    }
    return roots;
  }
  /**
   * 扫描工作区文件清单。
   * @param {object} opts {range, onlyChangedSince: Date|0, extraIgnores: string[]}
   * @returns {Promise<{files:Array<{path,name,updated:number}>, enumErrorOccurred:boolean}>}
   */
  async scan({ range, onlyChangedSince = 0, extraIgnores = [] } = {}) {
    this.resetEnumError();
    const ignores = buildIgnoreList(this.getUserIgnore(), extraIgnores);
    const roots = await this.rootsFor(range !== void 0 ? range : this.getSyncRange());
    const files = [];
    const sinceMs = onlyChangedSince ? new Date(onlyChangedSince).getTime() : 0;
    for (let root of roots) {
      const queue = [root];
      while (queue.length > 0) {
        const dir = queue.pop();
        if (dir !== "" && isIgnored(dir, ignores)) continue;
        let entries;
        try {
          entries = await this.kernel.readDir(dir);
        } catch (err) {
          this.enumErrorOccurred = true;
          continue;
        }
        for (const entry of entries || []) {
          const path = dir === "" ? entry.name : dir + "/" + entry.name;
          if (isIgnored(path, ignores)) continue;
          if (entry.isDir) {
            queue.push(path);
            continue;
          }
          let updatedMs = new Date(entry.updated).getTime() * 1e3;
          if (!(updatedMs < Date.now())) updatedMs = 0;
          if (sinceMs && updatedMs <= sinceMs) continue;
          files.push({ path, name: entry.name, updated: updatedMs });
        }
      }
    }
    return { files, enumErrorOccurred: this.enumErrorOccurred };
  }
  /** 路径是否属于当前同步范围(删除守卫用,与扫描范围语义一致) */
  async inSyncScope(path, range) {
    const p = String(path == null ? "" : path).replace(/\\/g, "/");
    const r = range !== void 0 ? range : this.getSyncRange();
    if (r === 0) return true;
    if (p.indexOf("data/") !== 0) return false;
    if (r === 1) return true;
    if (p.indexOf("data/assets/") === 0) return true;
    if (p.indexOf("data/.siyuan/") === 0) return true;
    return /^data\/(\d{14}-[a-zA-Z0-9]+)(\/|$)/.test(p);
  }
  /**
   * 删除安全判定。
   * @returns {Promise<{allow:boolean, reasons:string[]}>}
   */
  async guardLocalDelete(path, manifest, { remoteEntryExists } = {}) {
    const reasons = [];
    if (this.enumErrorOccurred) reasons.push("本地目录枚举异常");
    if (!await this.inSyncScope(path)) reasons.push("不在当前同步范围");
    if (!manifest || !manifest.has(path)) {
      reasons.push("本地清单中不存在该文件(新设备/首次同步/从未下载)");
    }
    if (remoteEntryExists === false) reasons.push("远端已无此文件,无需删除");
    return { allow: reasons.length === 0, reasons };
  }
};

// src/local/content-adapter.js
var BINARY_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".bmp",
  ".webp",
  ".mp4",
  ".avi",
  ".mov",
  ".mkv",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ttf",
  ".woff2",
  ".woff",
  ".otf",
  ".eot",
  ".zip",
  ".tar",
  ".gz",
  ".rar",
  ".exe",
  ".dll",
  ".bin",
  ".tmp",
  ".swp",
  ".bak",
  ".log",
  ".so",
  ".dylib",
  ".dat",
  ".img",
  ".iso",
  ".bz2",
  ".mp3",
  ".wav",
  ".flac",
  ".aac",
  ".wmv",
  ".swf",
  ".apk",
  ".ipa",
  ".jar",
  ".class",
  ".pyc",
  ".o",
  ".obj",
  ".a",
  ".lib",
  ".pdb",
  ".db",
  ".sqlite",
  ".mdb",
  ".accdb",
  ".cur",
  ".ico",
  ".icns",
  ".cab",
  ".msi",
  ".msp",
  ".msu",
  ".nupkg",
  ".deb",
  ".rpm",
  ".pkg",
  ".dmg",
  ".torrent",
  ".crdownload",
  ".part"
];
function isBinaryPath(path) {
  return BINARY_EXTENSIONS.indexOf(String(extname(path)).toLowerCase()) >= 0;
}
var ContentAdapter = class {
  /**
   * @param {object} kernel createKernel 产物
   * @param {object} opts {backupDir: 删除备份根路径, i18n}
   */
  constructor(kernel, opts = {}) {
    this.kernel = kernel;
    this.backupDir = opts.backupDir || "temp/SY-GSP/backup/";
    this.i18n = opts.i18n || {};
  }
  /**
   * 读取文件内容为 Blob。
   * @param {string} path 本地路径
   * @param {"raw"|"markdown"} format markdown 模式走内核导出并剥离 front-matter
   */
  async readFileBlob(path, format = "raw") {
    if (format === "markdown") {
      const docId = basename(path, extname(path));
      const exported = await this.kernel.exportMdContent(docId);
      if (!exported || !exported.content || String(exported.content).length === 0) {
        throw new Error("数据完整性异常: 导出 Markdown 内容为空,已停止 -> " + path);
      }
      const stripped = String(exported.content).replace(/^---\s*\n([\s\S]*?)\n---\s*/, "");
      return new Blob([stripped]);
    }
    const blob = await this.kernel.getFile(path);
    return blob;
  }
  /**
   * 写入远端内容到本地。
   * raw: 直接 putFile;markdown: 按思源文档导入语义(create/update)。
   * @param {string} originalPath 原始本地路径(.sy)
   * @param {Blob} blob 内容
   * @param {"raw"|"markdown"} format
   * @param {"create"|"update"} op
   */
  async writeFileBlob(originalPath, blob, format = "raw", op = "create") {
    if (format === "markdown") {
      return this._writeMarkdownDoc(originalPath, blob, op);
    }
    return this.kernel.putFile(originalPath, blob, false);
  }
  /**
   * Markdown 导入语义(与旧版对齐):
   * - create: 从路径解析笔记本;笔记本不存在则按目录名创建;createDoc(路径去掉 data/<notebookId> 前缀,剥离首个一级标题);
   * - update: updateBlock(docId, "markdown", 内容去掉首个一级标题)。
   */
  async _writeMarkdownDoc(localPath, blob, op) {
    const segments = String(localPath).replace(/\\/g, "/").split("/");
    const notebookDir = segments[1];
    const mdText = await blob.text();
    if (op === "update") {
      const docId = basename(localPath, extname(localPath));
      return this.kernel.updateBlock("markdown", stripFirstHeading(mdText), docId);
    }
    let notebookId = notebookDir;
    const notebooks = await this.kernel.lsNotebooks();
    const exists = (notebooks && notebooks.notebooks || []).some((n) => n.id === notebookId);
    if (!exists) {
      const created = await this.kernel.createNotebook(notebookDir);
      notebookId = created && created.notebook && created.notebook.id || notebookId;
    }
    const hpath = "/" + segments.slice(2).join("/");
    const title = extractFirstHeading(mdText) || basename(hpath);
    return this.kernel.createDoc(notebookId, hpath, title, stripFirstHeading(mdText));
  }
  /** 删除本地文件(先备份到隔离目录),返回备份路径 */
  async removeFileWithBackup(path) {
    const blob = await this.kernel.getFile(path);
    let backupPath = "";
    if (blob) {
      backupPath = this.backupDir + String(path).replace(/^\/+/, "");
      await this.kernel.putFile(backupPath, blob, false);
    }
    await this.kernel.removeFile(path);
    return backupPath;
  }
  /**
   * 生成冲突文档(与旧版语义一致,不在原文件上静默覆盖):
   * - 思源文档(.sy): 把远端内容写入原路径,把本地内容以 createDocWithMd 生成
   *   "原路径名_conflict_<平台>_<时间戳>" 副本文档;
   * - 普通文件: 在原文件旁生成 "<名>_conflict_<平台>_<时间戳>.<扩展名>" 副本,
   *   并把远端内容写入原路径。
   * @returns {Promise<{conflictPath:string}>}
   */
  async createConflictDoc({ path, localBlob, remoteBlob, platform, format }) {
    const stamp = "_conflict_" + (platform || "") + "_" + Date.now();
    if (isSiyuanDocPath(path) && format !== "markdown") {
      const docId = basename(path, extname(path));
      const block = await this.kernel.getBlockKramdown(docId);
      const kramdown = block && block.kramdown || "";
      await this.kernel.putFile(path, remoteBlob, false);
      const conf = await this.kernel.sql("select * from blocks where id ='" + docId + "'");
      const info = conf && conf[0] || {};
      const conflictDocPath = (info.hpath || docId) + stamp;
      const res = await this.kernel.createDocWithMd(info.box || notebookIdOf(path), conflictDocPath, kramdown);
      return { conflictPath: "data/" + (info.box || notebookIdOf(path)) + conflictDocPath + ".sy", docId: res };
    }
    const ext = extname(path);
    const conflictPath = path.replace(basename(path), basename(path, ext) + stamp + ext);
    await this.kernel.putFile(conflictPath, localBlob, false);
    await this.kernel.putFile(path, remoteBlob, false);
    return { conflictPath };
  }
  /** 导出三方副本到隔离目录,供用户手工比对 */
  async exportConflictCopies({ path, baseBytes, localBytes, remoteBytes, operationId }) {
    const dir = "temp/SY-GSP/conflicts/" + operationId + "/";
    const stem = path.replace(/\//g, "_");
    const writes = [];
    if (baseBytes) writes.push([dir + stem + ".base", baseBytes]);
    if (localBytes) writes.push([dir + stem + ".local", localBytes]);
    if (remoteBytes) writes.push([dir + stem + ".remote", remoteBytes]);
    for (const [p, bytes] of writes) {
      await this.kernel.putFile(p, new Blob([bytes]), false);
    }
    return { dir, files: writes.map((w) => w[0]) };
  }
  /**
   * 资源路径前缀替换(与旧版 $s 对齐):
   * - path 为空: 全工作空间 spans;否则限定 box+root_id;
   * - 将 markdown 中 "(..)assets/" 形式链接替换为配置前缀;无匹配时回退 "[text](link)" 整体替换。
   */
  async replaceAssetPrefix({ path, assetsPrefix }) {
    let stmt = "select * from spans where type in ('img','textmark a')";
    if (path) {
      const notebookID = notebookIdOf(path);
      const docID = basename(path, extname(path));
      stmt = "select * from spans where box = '" + notebookID + "' and root_id = '" + docID + "' and type in ('img','textmark a')";
    }
    const spans = await this.kernel.sql(stmt);
    if (!spans || spans.length === 0) return { updated: 0 };
    let prefix = assetsPrefix || "assets/";
    if (!prefix.endsWith("/")) prefix += "/";
    const pattern = /(?<=\()\/*(?:[^/]+\/)?assets\//g;
    let updated = 0;
    for (const span of spans) {
      let markdown = span.markdown || "";
      if (pattern.test(markdown)) {
        markdown = markdown.replace(pattern, prefix);
      } else {
        const m = /(!?\[[^\]]+\])(\(([^)]+)\))/.exec(markdown);
        if (m) {
          const link = m[3].replace(/^[/\\]+/, "").replace(/\\/g, "/");
          markdown = m[1] + "(" + encodeURI(prefix + link).replace(/%2F/g, "/") + ")";
        }
      }
      if (markdown !== span.markdown) {
        await this.kernel.updateBlock("markdown", markdown, span.block_id || span.id);
        updated += 1;
      }
    }
    return { updated };
  }
};
function notebookIdOf(path) {
  const seg = String(path).replace(/\\/g, "/").split("/");
  return /^data$/.test(seg[0]) ? seg[1] : seg[0];
}
function extractFirstHeading(md) {
  const m = /^\s*#\s+(.+)/m.exec(String(md || ""));
  return m ? m[1] : "";
}
function stripFirstHeading(md) {
  return String(md || "").replace(/^\s*#\s+(.+)/m, "");
}

// src/sync/sync-error.js
var SyncErrorCategory = Object.freeze({
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
  UNKNOWN: "UNKNOWN"
});
var SyncError = class extends Error {
  constructor(fields) {
    const message = String(fields && fields.message || "同步错误");
    super(message);
    this.name = "SyncError";
    this.category = fields && fields.category || SyncErrorCategory.UNKNOWN;
    this.code = fields && fields.code || "";
    this.operation = fields && fields.operation || "";
    this.phase = fields && fields.phase || "";
    this.httpStatus = fields && fields.httpStatus || 0;
    this.path = fields && fields.path || "";
    this.detail = fields && fields.detail || "";
    this.retryable = !!(fields && fields.retryable);
    this.recoverable = !!(fields && fields.recoverable);
    this.cause = fields && fields.cause || null;
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
      recoverable: this.recoverable
    };
  }
};
function redact(text) {
  return String(text == null ? "" : text).replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]").replace(/(token|access_token|client_secret|secret|password|passwd)["']?\s*[:=]\s*["']?[^\s"',;&]+/gi, "$1=[已隐藏]").replace(/(authorization|cookie)["']?\s*[:=][^"',;&]+/gi, "$1=[已隐藏]").replace(/token\s+[A-Za-z0-9_.\-]{8,}/g, "token [已隐藏]");
}
var NETWORK_PATTERN = /(timeout|timed?\s?out|econn|enotfound|eai_again|aborted|aborterror|socket|network|fetch failed|连接|网络|超时|dns|getaddrinfo)/i;
var LARGE_FILE_PATTERN = /(too large|too big|exceed|文件过大|过大|超过.*限|file size)/i;
function statusOf(node) {
  if (node && typeof node.status === "number" && node.status) return node.status;
  if (node && node.response && typeof node.response.status === "number") return node.response.status;
  return 0;
}
function messageOf(node) {
  const data = node && node.response && node.response.data || {};
  const m = data.message || node && node.message || "";
  return m ? String(m) : "";
}
var CONFLICT_CODE = 300;
function classifyError(err) {
  let node = err;
  let status = 0;
  let path = "";
  let message = "";
  let conflict = false;
  let aborted = false;
  for (let i = 0; node && i < 8; i++) {
    if (node.category === SyncErrorCategory.CONFLICT || node.code === CONFLICT_CODE) conflict = true;
    if (node instanceof SyncError && node.category) {
      if (!status) status = statusOf(node);
      if (!path && node.path) path = node.path;
      return {
        category: node.category,
        httpStatus: status,
        path,
        message: node.message || message || String(err && err.message || err || "未知错误"),
        retryable: node.retryable,
        recoverable: node.recoverable
      };
    }
    if (!status) status = statusOf(node);
    if (!path && node.path) path = node.path;
    const m = messageOf(node);
    if (m) message = m;
    if (node && (node.name === "AbortError" || /abort/i.test(String(node.message || "")))) aborted = true;
    node = node.cause || node instanceof Error && node.cause || null;
  }
  const text = (message || String(err && err.message || err || "")).toLowerCase();
  const base = { httpStatus: status, path, message: message || String(err && err.message || err || "未知错误") };
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
function toSyncError(err, defaults = {}) {
  if (err instanceof SyncError) return err;
  const c = classifyError(err);
  return new SyncError({
    category: defaults.category || c.category,
    operation: defaults.operation || "",
    phase: defaults.phase || "",
    httpStatus: c.httpStatus,
    path: defaults.path || c.path,
    message: defaults.message || c.message,
    detail: redact(String(err && err.message || err || "")),
    retryable: defaults.retryable !== void 0 ? defaults.retryable : c.retryable,
    recoverable: defaults.recoverable !== void 0 ? defaults.recoverable : c.recoverable,
    cause: err
  });
}

// src/git/http-client.js
var HttpClient = class {
  constructor({ baseUrl, token, timeoutMs = 3e4, platform = "" } = {}) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.token = token || "";
    this.timeoutMs = timeoutMs;
    this.platform = platform;
  }
  /**
   * 发起 JSON 请求。
   * @param {object} opts {method, path(以/开头,或完整url), query, body, headers, responseType:"json"|"text"|"arraybuffer"|"raw", timeoutMs}
   * @returns {Promise<{status:number, headers:Headers, data:any, link:string}>}
   */
  async request(opts) {
    const method = (opts.method || "GET").toUpperCase();
    const url = this._buildUrl(opts);
    const headers = Object.assign({ Accept: "application/json" }, opts.headers || {});
    if (this.token) headers.Authorization = "token " + this.token;
    let body;
    if (opts.body !== void 0 && opts.body !== null) {
      if (opts.body instanceof ArrayBuffer || opts.body instanceof Uint8Array || typeof opts.body === "string") {
        body = opts.body;
        if (!headers["Content-Type"]) headers["Content-Type"] = "application/octet-stream";
      } else {
        headers["Content-Type"] = headers["Content-Type"] || "application/json";
        body = JSON.stringify(opts.body);
      }
    }
    const timeoutMs = opts.timeoutMs || this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(url, { method, headers, body, signal: controller.signal });
    } catch (err) {
      const aborted = err && (err.name === "AbortError" || /abort/i.test(String(err.message || "")));
      throw new SyncError({
        category: aborted ? SyncErrorCategory.TIMEOUT : SyncErrorCategory.NETWORK,
        code: aborted ? "HTTP_TIMEOUT" : "NETWORK_ERROR",
        operation: method + " " + this._safeUrl(opts),
        message: aborted ? "请求超时(" + Math.round(timeoutMs / 1e3) + "s)" : "网络连接失败",
        detail: redact(String(err && err.message || err)),
        retryable: true,
        recoverable: false,
        cause: err
      });
    } finally {
      clearTimeout(timer);
    }
    const data = await this._parse(response, opts.responseType || "json");
    if (!response.ok) {
      const apiMessage = data && typeof data === "object" ? data.message || data.errors || "" : "";
      throw new SyncError({
        category: SyncErrorCategory.GIT,
        code: "HTTP_" + response.status,
        operation: method + " " + this._safeUrl(opts),
        httpStatus: response.status,
        message: this._friendlyStatus(response.status, apiMessage),
        detail: redact(typeof apiMessage === "string" ? apiMessage : JSON.stringify(apiMessage)),
        retryable: response.status >= 500 || response.status === 429,
        recoverable: false
      });
    }
    return { status: response.status, headers: response.headers, data, link: response.headers.get("link") || "" };
  }
  _buildUrl(opts) {
    let url = opts.url || this.baseUrl + (opts.path || "");
    if (opts.query) {
      const qs = Object.keys(opts.query).filter((k) => opts.query[k] !== void 0 && opts.query[k] !== null && opts.query[k] !== "").map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(String(opts.query[k]))).join("&");
      if (qs) url += (url.indexOf("?") >= 0 ? "&" : "?") + qs;
    }
    return url;
  }
  /** 日志用 URL: 不带 query,避免泄露 token 等参数 */
  _safeUrl(opts) {
    return (opts.url || this.baseUrl + (opts.path || "")).replace(/\?.*$/, "");
  }
  async _parse(response, type) {
    if (type === "raw") return response;
    if (type === "json") {
      const text = await response.text();
      try {
        return text ? JSON.parse(text) : null;
      } catch (e) {
        return text;
      }
    }
    if (type === "arraybuffer") return response.arrayBuffer();
    return response.text();
  }
  _friendlyStatus(status, apiMessage) {
    const suffix = apiMessage ? "(" + redact(String(apiMessage)).slice(0, 200) + ")" : "";
    switch (status) {
      case 401:
        return "Token 无效或已过期" + suffix;
      case 403:
        return "权限不足或触发 API 限流" + suffix;
      case 404:
        return "仓库、分支或文件不存在,请检查设置" + suffix;
      case 409:
      case 422:
        return "远端引用更新被拒绝(远端已变化或校验失败)" + suffix;
      case 413:
        return "请求体超过平台限制" + suffix;
      default:
        return "Git API 请求失败(HTTP " + status + ")" + suffix;
    }
  }
};

// src/git/git-provider.js
var _GitProvider = class _GitProvider {
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
      platform: this.platform
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
  static textToBytes(text) {
    return _GitProvider.encoder.encode(String(text == null ? "" : text));
  }
  static bytesToText(bytes) {
    return _GitProvider.decoder.decode(bytes);
  }
  static bytesToBase64(bytes) {
    let binary = "";
    const chunk = 32768;
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
    const bytes = typeof content === "string" ? _GitProvider.textToBytes(content) : content;
    if (!(globalThis.crypto && globalThis.crypto.subtle)) return null;
    const header = _GitProvider.textToBytes("blob " + bytes.length + "\0");
    const merged = new Uint8Array(header.length + bytes.length);
    merged.set(header, 0);
    merged.set(bytes, header.length);
    const digest = await globalThis.crypto.subtle.digest("SHA-1", merged);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
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
        recoverable: false
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
        recoverable: false
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
        recoverable: false
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
        throw new SyncError({
          category: SyncErrorCategory.REMOTE_CHANGED,
          code: "REMOTE_HEAD_MOVED",
          operation: "ensureBranchRef",
          message: "创建分支引用时远端分支已存在(疑似竞争),本轮不写入",
          retryable: true,
          recoverable: false,
          cause: err
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
        recoverable: false
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
    const status = err && err.httpStatus || 0;
    if (status === 409 || status === 422) {
      return new SyncError({
        category: SyncErrorCategory.PUSH_REJECTED,
        code: "NON_FAST_FORWARD",
        operation: "updateBranchRef",
        httpStatus: status,
        message: "远端分支已前移,本次提交未写入(force=false,不覆盖远端)",
        detail: err && err.detail || "",
        retryable: true,
        recoverable: false,
        cause: err
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
      message: message || err && err.message || String(err),
      detail: String(err && err.message || err),
      cause: err
    });
  }
};
// ---------- 编码与内容等价 ----------
__publicField(_GitProvider, "encoder", new TextEncoder());
__publicField(_GitProvider, "decoder", new TextDecoder("utf-8", { fatal: false }));
var GitProvider = _GitProvider;

// src/git/github-provider.js
var GitHubProvider = class _GitHubProvider extends GitProvider {
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
    const status = err && err.httpStatus || 0;
    return new SyncError({
      category: status === 404 ? SyncErrorCategory.REPOSITORY : SyncErrorCategory.GIT,
      operation,
      httpStatus: status,
      message: message || err && err.message || String(err),
      detail: String(err && err.detail || err && err.message || err),
      retryable: status >= 500,
      recoverable: false,
      cause: err
    });
  }
  static _mapCommit(data) {
    return {
      sha: data.sha,
      treeSha: data.commit && data.commit.tree && data.commit.tree.sha,
      message: data.commit && data.commit.message || "",
      author: data.commit && data.commit.author && data.commit.author.name || "",
      email: data.commit && data.commit.author && data.commit.author.email || "",
      date: data.commit && data.commit.author && data.commit.author.date || "",
      parents: (data.parents || []).map((p) => p.sha)
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
      return _GitHubProvider._mapCommit(res.data);
    } catch (err) {
      throw this._wrap(err, "getCommit", "读取提交失败(" + shaOrRef + ")");
    }
  }
  async getTree(treeSha) {
    try {
      const res = await this.http.request({
        path: this._repoPath() + "/git/trees/" + treeSha,
        query: { recursive: "1" }
      });
      return (res.data.tree || []).map((t) => ({
        path: t.path,
        mode: t.mode,
        type: t.type,
        sha: t.sha,
        size: t.size || 0
      }));
    } catch (err) {
      throw this._wrap(err, "getTree", "读取远端目录树失败");
    }
  }
  async getBlob(blobSha) {
    try {
      const res = await this.http.request({
        path: this._repoPath() + "/git/blobs/" + blobSha,
        responseType: "json"
      });
      const b64 = res.data.content || "";
      return {
        sha: res.data.sha,
        size: res.data.size,
        contentBase64: b64,
        bytes: GitProvider.base64ToBytes(b64)
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
        responseType: "json"
      });
      const data = res.data;
      if (typeof data === "string") {
        const bytes2 = GitProvider.textToBytes(data);
        return { sha: "", size: bytes2.length, contentBase64: GitProvider.bytesToBase64(bytes2), bytes: bytes2, text: data };
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
          cause: err
        });
        throw notFound;
      }
      throw this._wrap(err, "getFileContent", "读取远端文件失败(" + path + ")");
    }
  }
  async compareCommits(baseRef, headRef) {
    try {
      const res = await this.http.request({
        path: this._repoPath() + "/compare/" + encodeURIComponent(baseRef) + "..." + encodeURIComponent(headRef)
      });
      return (res.data.files || []).map((f) => ({
        filename: f.filename,
        status: f.status,
        sha: f.sha
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
          page: query.page
        }
      });
      return (res.data || []).map((c) => Object.assign(_GitHubProvider._mapCommit(c), {}));
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
        query: { sha: this.branch, per_page: 1, page: 1 }
      });
      if (!Array.isArray(first.data) || first.data.length === 0) return null;
      const lastPage = parseLinkLastPage(first.link) || 1;
      if (lastPage <= 1) return _GitHubProvider._mapCommit(first.data[0]);
      const last = await this.http.request({
        path: this._repoPath() + "/commits",
        query: { sha: this.branch, per_page: 1, page: lastPage }
      });
      return _GitHubProvider._mapCommit(last.data[0]);
    } catch (err) {
      throw this._wrap(err, "getInitialCommit", "读取分支首个提交失败");
    }
  }
  async getMergeBase(leftSha, rightSha) {
    try {
      const res = await this.http.request({
        path: this._repoPath() + "/compare/" + encodeURIComponent(leftSha) + "..." + encodeURIComponent(rightSha)
      });
      const mb = res.data.merge_base_commit;
      return mb && mb.sha ? mb.sha : null;
    } catch (err) {
      return null;
    }
  }
  async createBlob(bytes) {
    try {
      const res = await this.http.request({
        path: this._repoPath() + "/git/blobs",
        method: "POST",
        body: { content: GitProvider.bytesToBase64(bytes), encoding: "base64" }
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
        body
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
        body: { message, tree: treeSha, parents }
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
        body: { sha: newSha, force: false }
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
      body: { ref: "refs/heads/" + this.branch, sha: commitSha }
    });
  }
};
function parseLinkLastPage(linkHeader) {
  if (!linkHeader) return 0;
  const m = /[?&]page=(\d+)>;\s*rel="last"/.exec(linkHeader);
  return m ? Number(m[1]) : 0;
}
function encodePath(path) {
  return String(path).split("/").map((seg) => encodeURIComponent(seg)).join("/");
}

// src/git/gitee-provider.js
var GiteeProvider = class _GiteeProvider extends GitProvider {
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
    const status = err && err.httpStatus || 0;
    return new SyncError({
      category: status === 404 ? SyncErrorCategory.REPOSITORY : SyncErrorCategory.GIT,
      operation,
      httpStatus: status,
      message: message || err && err.message || String(err),
      detail: String(err && err.detail || err && err.message || err),
      retryable: status >= 500,
      recoverable: false,
      cause: err
    });
  }
  static _mapCommit(data) {
    return {
      sha: data.sha,
      treeSha: data.commit && data.commit.tree && data.commit.tree.sha,
      message: data.commit && data.commit.message || "",
      author: data.commit && data.commit.author && data.commit.author.name || "",
      email: data.commit && data.commit.author && data.commit.author.email || "",
      date: data.commit && data.commit.author && data.commit.author.date || "",
      parents: (data.parents || []).map((p) => p.sha)
    };
  }
  async getBranchHead() {
    try {
      const res = await this.http.request({
        path: this._repoPath() + "/branches/" + encodeURIComponent(this.branch)
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
        path: this._repoPath() + "/commits/" + encodeURIComponent(shaOrRef)
      });
      return _GiteeProvider._mapCommit(res.data);
    } catch (err) {
      throw this._wrap(err, "getCommit", "读取提交失败(" + shaOrRef + ")");
    }
  }
  async getTree(treeSha) {
    try {
      const res = await this.http.request({
        path: this._repoPath() + "/git/trees/" + treeSha,
        query: { recursive: 1 }
      });
      return (res.data.tree || res.data || []).map((t) => ({
        path: t.path,
        mode: t.mode,
        type: t.type,
        sha: t.sha,
        size: t.size || 0
      }));
    } catch (err) {
      throw this._wrap(err, "getTree", "读取远端目录树失败");
    }
  }
  async getBlob(blobSha) {
    try {
      const res = await this.http.request({
        path: this._repoPath() + "/git/blobs/" + blobSha
      });
      const b64 = res.data.content || "";
      return {
        sha: res.data.sha,
        size: res.data.size,
        contentBase64: b64,
        bytes: GitProvider.base64ToBytes(b64)
      };
    } catch (err) {
      throw this._wrap(err, "getBlob", "读取远端文件内容失败");
    }
  }
  async getFileContent(path, ref) {
    try {
      const res = await this.http.request({
        path: this._repoPath() + "/contents/" + encodePath(path),
        query: { ref }
      });
      const data = res.data;
      const b64 = data && data.content || "";
      const bytes = GitProvider.base64ToBytes(b64);
      return {
        sha: data.sha,
        size: data.size,
        contentBase64: b64,
        bytes,
        text: GitProvider.bytesToText(bytes)
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
          cause: err
        });
      }
      throw this._wrap(err, "getFileContent", "读取远端文件失败(" + path + ")");
    }
  }
  async compareCommits(baseRef, headRef) {
    try {
      const res = await this.http.request({
        path: this._repoPath() + "/compare",
        query: { base: baseRef, head: headRef }
      });
      return (res.data.files || []).map((f) => ({ filename: f.filename, status: f.status, sha: f.sha }));
    } catch (err) {
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
          page: query.page
        }
      });
      return (res.data || []).map((c) => _GiteeProvider._mapCommit(c));
    } catch (err) {
      throw this._wrap(err, "listCommits", "读取提交列表失败");
    }
  }
  /** Gitee: listCommits 响应头含 total_page/total_count,首提交取最后一页 */
  async getInitialCommit() {
    try {
      const first = await this.http.request({
        path: this._repoPath() + "/commits",
        query: { sha: this.branch, per_page: 1, page: 1 }
      });
      if (!Array.isArray(first.data) || first.data.length === 0) return null;
      let lastPage = 1;
      if (first.headers && typeof first.headers.get === "function") {
        const tp = Number(first.headers.get("total_page"));
        const tc = Number(first.headers.get("total_count"));
        lastPage = !isNaN(tp) && tp > 0 ? tp : !isNaN(tc) && tc > 0 ? tc : 1;
      }
      if (lastPage <= 1) return _GiteeProvider._mapCommit(first.data[0]);
      const last = await this.http.request({
        path: this._repoPath() + "/commits",
        query: { sha: this.branch, per_page: 1, page: lastPage }
      });
      return _GiteeProvider._mapCommit(last.data[0]);
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
      message: message || "sync: update " + path
    };
    if (existingSha) body.sha = existingSha;
    try {
      const res = await this.http.request({
        path: this._repoPath() + "/contents/" + encodePath(path),
        method: existingSha ? "PUT" : "POST",
        body
      });
      const commit = res.data && res.data.commit;
      return { path, sha: res.data && res.data.content && res.data.content.sha, commitSha: commit && commit.sha };
    } catch (err) {
      if (err instanceof SyncError && err.httpStatus === 404 && existingSha) {
        throw new SyncError({
          category: SyncErrorCategory.REMOTE_CHANGED,
          code: "TARGET_GONE",
          operation: "putFileContent",
          httpStatus: 404,
          path,
          message: "远端文件在写入前已不存在: " + path,
          retryable: true,
          recoverable: false,
          cause: err
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
          cause: err
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
        body: { sha, branch: branch || this.branch, message: message || "sync: delete " + path }
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
          cause: err
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
      recoverable: false
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
        at: (/* @__PURE__ */ new Date()).toISOString()
      };
      try {
        if (op.op === "delete") {
          await this.deleteFileContent(op.path, { message, branch, sha: op.remoteSha });
        } else {
          const result = await this.putFileContent(op.path, op.bytes, {
            message,
            branch,
            existingSha: op.op === "update" ? op.remoteSha : void 0
          });
          entry.afterSha = result.sha;
          entry.commitSha = result.commitSha;
        }
      } catch (err) {
        entry.error = err && err.message || String(err);
        log.push(entry);
        const headAfter2 = await this.getBranchHead().catch(() => ({ sha: "" }));
        for (const e of log) e.headAfter = headAfter2.sha;
        throw new SyncError({
          category: SyncErrorCategory.GIT,
          code: "PARTIAL_REMOTE_WRITE",
          operation: "applyFileOperations",
          path: op.path,
          message: "远端写入中途失败(" + log.length + "/" + operations.length + " 已完成),本轮不标记成功: " + op.path,
          detail: JSON.stringify(log).slice(0, 2e3),
          retryable: false,
          recoverable: true,
          cause: err
        });
      }
      log.push(entry);
    }
    const headAfter = await this.getBranchHead().catch(() => ({ sha: "" }));
    for (const e of log) e.headAfter = headAfter.sha;
    return { operations: log, partialFailure: null, remoteHead: headAfter.sha };
  }
};

// src/sync/sync-planner.js
var PlanAction = Object.freeze({
  UPLOAD_CREATE: "upload_create",
  UPLOAD_UPDATE: "upload_update",
  DOWNLOAD_CREATE: "download_create",
  DOWNLOAD_UPDATE: "download_update",
  DELETE_REMOTE: "delete_remote",
  DELETE_LOCAL: "delete_local",
  MERGE: "merge",
  CONFLICT: "conflict",
  SKIP: "skip"
});
var SyncPlanner = class {
  constructor(deps) {
    this.readLocal = deps.readLocal;
    this.readRemoteBlobBySha = deps.readRemoteBlobBySha;
    this.guardLocalDelete = deps.guardLocalDelete || null;
  }
  /**
   * @param {object} opts {baseEntries, remoteEntries, localFiles, localShas,
   *   mode:"auto"|"remote_over_local"|"local_over_remote",
   *   overrides:Map<path,"keep_local"|"keep_remote">, enumErrorOccurred}
   * @returns {Promise<object>} plan
   */
  async build(opts) {
    const {
      baseEntries = /* @__PURE__ */ new Map(),
      remoteEntries = /* @__PURE__ */ new Map(),
      localFiles = [],
      localShas = /* @__PURE__ */ new Map(),
      mode = "auto",
      overrides = /* @__PURE__ */ new Map(),
      enumErrorOccurred = false
    } = opts;
    const localSet = new Set(localFiles.map((f) => f.path));
    const allPaths = /* @__PURE__ */ new Set([...baseEntries.keys(), ...remoteEntries.keys(), ...localSet]);
    const plan = {
      uploads: [],
      // {path, bytes, op:"create"|"update"}
      downloads: [],
      // {path, op:"create"|"update"}
      deletionsRemote: [],
      // {path, remoteSha}
      deletionsLocal: [],
      // {path}
      merges: [],
      // {path, baseSha, remoteSha}
      conflicts: [],
      // {path, reason, baseSha, localSha, remoteSha}
      skippedDeletes: [],
      // {path, reasons}
      unchanged: 0
    };
    for (const path of allPaths) {
      const override = overrides.get(path);
      if (override) {
        this._applyOverride(plan, path, override, {
          baseEntry: baseEntries.get(path),
          remoteEntry: remoteEntries.get(path),
          localExists: localSet.has(path),
          localShas
        });
        continue;
      }
      if (mode === "remote_over_local") {
        this._applyOverride(plan, path, "keep_remote", {
          baseEntry: baseEntries.get(path),
          remoteEntry: remoteEntries.get(path),
          localExists: localSet.has(path),
          localShas
        });
        continue;
      }
      if (mode === "local_over_remote") {
        this._applyOverride(plan, path, "keep_local", {
          baseEntry: baseEntries.get(path),
          remoteEntry: remoteEntries.get(path),
          localExists: localSet.has(path),
          localShas
        });
        continue;
      }
      await this._decideAuto(plan, path, {
        baseEntry: baseEntries.get(path),
        remoteEntry: remoteEntries.get(path),
        localExists: localSet.has(path),
        localShas,
        enumErrorOccurred,
        bootstrap: opts.bootstrap === true
      });
    }
    return plan;
  }
  /** 状态三值: absent | unchanged | changed | deleted(local/remote 语义化) */
  _stateOf({ exists, sha, refSha }) {
    if (!exists) return "deleted";
    if (!refSha) return "new";
    if (sha && refSha && sha === refSha) return "unchanged";
    return "changed";
  }
  async _localState(path, { baseEntry, remoteEntry, localExists, localShas }) {
    if (!localExists) return "deleted";
    if (!baseEntry) return "new";
    const sha = localShas.get(path);
    const ref = baseEntry ? baseEntry.sha : remoteEntry ? remoteEntry.sha : null;
    if (sha === null || sha === void 0) {
      const bytes = await this.readLocal(path) || { bytes: null };
      if (!bytes) return "deleted";
      const refBytes = baseEntry ? await this.readRemoteBlobBySha(baseEntry.sha) : remoteEntry ? await this.readRemoteBlobBySha(remoteEntry.sha) : null;
      return refBytes && bytesEqual(refBytes.bytes, bytes.bytes) ? "unchanged" : "changed";
    }
    return this._stateOf({ exists: true, sha, refSha: ref });
  }
  async _decideAuto(plan, path, ctx) {
    const { baseEntry, remoteEntry, localExists, localShas, enumErrorOccurred, bootstrap } = ctx;
    const localState = await this._localState(path, ctx);
    const remoteState = !remoteEntry ? "deleted" : !baseEntry ? "new" : remoteEntry.sha === baseEntry.sha ? "unchanged" : "changed";
    if (localState === "deleted" && remoteState === "deleted") {
      plan.unchanged += 1;
      return;
    }
    if (localState === "unchanged" && remoteState === "unchanged") {
      plan.unchanged += 1;
      return;
    }
    if (localState === "unchanged" && remoteState === "new") {
      plan.unchanged += 1;
      return;
    }
    if (localState === "new" && remoteState === "deleted") {
      plan.uploads.push({ path, op: "create" });
      return;
    }
    if (localState === "deleted" && remoteState === "new") {
      plan.downloads.push({ path, op: "create" });
      return;
    }
    if (localState === "new" && remoteState === "new") {
      const localSha = localShas.get(path);
      if (localSha && localSha === remoteEntry.sha) {
        plan.unchanged += 1;
        return;
      }
      plan.conflicts.push({ path, reason: "双方同时新增了不同内容", baseSha: null, localSha, remoteSha: remoteEntry.sha });
      return;
    }
    if (localState === "unchanged" && remoteState === "changed") {
      plan.downloads.push({ path, op: "update" });
      return;
    }
    if (localState === "changed" && remoteState === "unchanged") {
      plan.uploads.push({ path, op: "update" });
      return;
    }
    if (localState === "changed" && remoteState === "changed") {
      const localSha = localShas.get(path);
      if (localSha && localSha === remoteEntry.sha) {
        plan.uploads.push({ path, op: "update" });
        return;
      }
      if (isMergeable(path)) {
        plan.merges.push({ path, baseSha: baseEntry.sha, remoteSha: remoteEntry.sha });
      } else {
        plan.conflicts.push({ path, reason: "二进制/超大文件无法自动合并", baseSha: baseEntry.sha, localSha, remoteSha: remoteEntry.sha });
      }
      return;
    }
    if (localState === "deleted" && remoteState === "unchanged") {
      if (bootstrap) {
        plan.downloads.push({ path, op: "create" });
        return;
      }
      const guard = this.guardLocalDelete ? await this.guardLocalDelete(path) : { allow: true, reasons: [] };
      if (!guard.allow || enumErrorOccurred) {
        plan.skippedDeletes.push({ path, reasons: enumErrorOccurred ? guard.reasons.concat(["枚举异常"]) : guard.reasons });
        return;
      }
      plan.deletionsRemote.push({ path, remoteSha: remoteEntry.sha });
      return;
    }
    if (localState === "deleted" && remoteState === "changed") {
      plan.conflicts.push({ path, reason: "本地删除但远端有修改", baseSha: baseEntry.sha, localSha: null, remoteSha: remoteEntry.sha });
      return;
    }
    if (localState === "unchanged" && remoteState === "deleted") {
      plan.deletionsLocal.push({ path });
      return;
    }
    if (localState === "changed" && remoteState === "deleted") {
      plan.conflicts.push({ path, reason: "本地有修改但远端已删除", baseSha: baseEntry.sha, localSha: localShas.get(path), remoteSha: null });
      return;
    }
    plan.conflicts.push({ path, reason: "未知状态组合: local=" + localState + " remote=" + remoteState, baseSha: baseEntry ? baseEntry.sha : null, localSha: localShas.get(path) || null, remoteSha: remoteEntry ? remoteEntry.sha : null });
  }
  /**
   * 用户显式决策/强制方向: 覆盖三方矩阵。
   * 「接受本地/远端」不是无条件覆盖: 仍受删除守卫与枚举异常约束。
   */
  _applyOverride(plan, path, decision, { baseEntry, remoteEntry, localExists, localShas }) {
    if (decision === "keep_local") {
      if (localExists) {
        const sha = localShas.get(path);
        const sameAsRemote = sha && remoteEntry && sha === remoteEntry.sha;
        if (sameAsRemote) {
          plan.unchanged += 1;
          return;
        }
        plan.uploads.push({ path, op: baseEntry ? "update" : "create" });
      } else if (remoteEntry) {
        plan.deletionsRemote.push({ path, remoteSha: remoteEntry.sha });
      } else {
        plan.unchanged += 1;
      }
      return;
    }
    if (decision === "keep_remote") {
      if (remoteEntry) {
        const sha = localShas.get(path);
        const sameAsRemote = localExists && sha && sha === remoteEntry.sha;
        if (sameAsRemote) {
          plan.unchanged += 1;
          return;
        }
        plan.downloads.push({ path, op: localExists ? "update" : "create" });
      } else if (localExists) {
        plan.deletionsLocal.push({ path });
      } else {
        plan.unchanged += 1;
      }
      return;
    }
    throw new SyncError({
      category: SyncErrorCategory.UNKNOWN,
      code: "BAD_OVERRIDE",
      operation: "plan",
      path,
      message: "未知的覆盖决策: " + decision,
      retryable: false,
      recoverable: false
    });
  }
};
function isMergeable(path) {
  return !/\.(zip|tar|gz|rar|7z|exe|dll|so|dylib|png|jpe?g|gif|webp|mp4|mov|avi|mkv|mp3|wav|flac|pdf|docx?|xlsx?|pptx?|sqlite|db)$/i.test(path);
}
function bytesEqual(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// node_modules/node-diff3/dist/diff3.mjs
function LCS(buffer1, buffer2) {
  let equivalenceClasses = /* @__PURE__ */ Object.create(null);
  for (let j = 0; j < buffer2.length; j++) {
    const item = buffer2[j];
    if (equivalenceClasses[item]) {
      equivalenceClasses[item].push(j);
    } else {
      equivalenceClasses[item] = [j];
    }
  }
  const NULLRESULT = { buffer1index: -1, buffer2index: -1, chain: null };
  let candidates = [NULLRESULT];
  for (let i = 0; i < buffer1.length; i++) {
    const item = buffer1[i];
    const buffer2indices = equivalenceClasses[item] || [];
    let r = 0;
    let c = candidates[0];
    for (const j of buffer2indices) {
      let s;
      for (s = r; s < candidates.length; s++) {
        if (candidates[s].buffer2index < j && (s === candidates.length - 1 || candidates[s + 1].buffer2index > j)) {
          break;
        }
      }
      if (s < candidates.length) {
        const newCandidate = { buffer1index: i, buffer2index: j, chain: candidates[s] };
        if (r === candidates.length) {
          candidates.push(c);
        } else {
          candidates[r] = c;
        }
        r = s + 1;
        c = newCandidate;
        if (r === candidates.length) {
          break;
        }
      }
    }
    candidates[r] = c;
  }
  return candidates[candidates.length - 1];
}
function diffIndices(buffer1, buffer2) {
  const lcs = LCS(buffer1, buffer2);
  let result = [];
  let tail1 = buffer1.length;
  let tail2 = buffer2.length;
  for (let candidate = lcs; candidate !== null; candidate = candidate.chain) {
    const mismatchLength1 = tail1 - candidate.buffer1index - 1;
    const mismatchLength2 = tail2 - candidate.buffer2index - 1;
    tail1 = candidate.buffer1index;
    tail2 = candidate.buffer2index;
    if (mismatchLength1 || mismatchLength2) {
      result.push({
        buffer1: [tail1 + 1, mismatchLength1],
        buffer1Content: buffer1.slice(tail1 + 1, tail1 + 1 + mismatchLength1),
        buffer2: [tail2 + 1, mismatchLength2],
        buffer2Content: buffer2.slice(tail2 + 1, tail2 + 1 + mismatchLength2)
      });
    }
  }
  result.reverse();
  return result;
}
function diff3MergeRegions(a, o, b) {
  let hunks = [];
  function addHunk(h, ab) {
    hunks.push({
      ab,
      oStart: h.buffer1[0],
      oLength: h.buffer1[1],
      abStart: h.buffer2[0],
      abLength: h.buffer2[1]
    });
  }
  diffIndices(o, a).forEach((item) => addHunk(item, "a"));
  diffIndices(o, b).forEach((item) => addHunk(item, "b"));
  hunks.sort((x, y) => x.oStart - y.oStart);
  let results = [];
  let currOffset = 0;
  function advanceTo(endOffset) {
    if (endOffset > currOffset) {
      results.push({
        stable: true,
        buffer: "o",
        bufferStart: currOffset,
        bufferLength: endOffset - currOffset,
        bufferContent: o.slice(currOffset, endOffset)
      });
      currOffset = endOffset;
    }
  }
  while (hunks.length) {
    let hunk = hunks.shift();
    let regionStart = hunk.oStart;
    let regionEnd = hunk.oStart + hunk.oLength;
    let regionHunks = [hunk];
    advanceTo(regionStart);
    while (hunks.length) {
      const nextHunk = hunks[0];
      const nextHunkStart = nextHunk.oStart;
      if (nextHunkStart > regionEnd)
        break;
      regionEnd = Math.max(regionEnd, nextHunkStart + nextHunk.oLength);
      regionHunks.push(hunks.shift());
    }
    if (regionHunks.length === 1) {
      if (hunk.abLength > 0) {
        const buffer = hunk.ab === "a" ? a : b;
        results.push({
          stable: true,
          buffer: hunk.ab,
          bufferStart: hunk.abStart,
          bufferLength: hunk.abLength,
          bufferContent: buffer.slice(hunk.abStart, hunk.abStart + hunk.abLength)
        });
      }
    } else {
      let bounds = {
        a: [a.length, -1, o.length, -1],
        b: [b.length, -1, o.length, -1]
      };
      while (regionHunks.length) {
        hunk = regionHunks.shift();
        const oStart = hunk.oStart;
        const oEnd = oStart + hunk.oLength;
        const abStart = hunk.abStart;
        const abEnd = abStart + hunk.abLength;
        let b2 = bounds[hunk.ab];
        b2[0] = Math.min(abStart, b2[0]);
        b2[1] = Math.max(abEnd, b2[1]);
        b2[2] = Math.min(oStart, b2[2]);
        b2[3] = Math.max(oEnd, b2[3]);
      }
      const aStart = bounds.a[0] + (regionStart - bounds.a[2]);
      const aEnd = bounds.a[1] + (regionEnd - bounds.a[3]);
      const bStart = bounds.b[0] + (regionStart - bounds.b[2]);
      const bEnd = bounds.b[1] + (regionEnd - bounds.b[3]);
      let result = {
        stable: false,
        aStart,
        aLength: aEnd - aStart,
        aContent: a.slice(aStart, aEnd),
        oStart: regionStart,
        oLength: regionEnd - regionStart,
        oContent: o.slice(regionStart, regionEnd),
        bStart,
        bLength: bEnd - bStart,
        bContent: b.slice(bStart, bEnd)
      };
      results.push(result);
    }
    currOffset = regionEnd;
  }
  advanceTo(o.length);
  return results;
}
function diff3Merge(a, o, b, options) {
  let defaults = {
    excludeFalseConflicts: true,
    stringSeparator: /\s+/
  };
  options = Object.assign(defaults, options);
  if (typeof a === "string")
    a = a.split(options.stringSeparator);
  if (typeof o === "string")
    o = o.split(options.stringSeparator);
  if (typeof b === "string")
    b = b.split(options.stringSeparator);
  let results = [];
  const regions = diff3MergeRegions(a, o, b);
  let okBuffer = [];
  function flushOk() {
    if (okBuffer.length) {
      results.push({ ok: okBuffer });
    }
    okBuffer = [];
  }
  function isFalseConflict(a2, b2) {
    if (a2.length !== b2.length)
      return false;
    for (let i = 0; i < a2.length; i++) {
      if (a2[i] !== b2[i])
        return false;
    }
    return true;
  }
  regions.forEach((region) => {
    if (region.stable) {
      okBuffer.push(...region.bufferContent);
    } else {
      if (options.excludeFalseConflicts && isFalseConflict(region.aContent, region.bContent)) {
        okBuffer.push(...region.aContent);
      } else {
        flushOk();
        results.push({
          conflict: {
            a: region.aContent,
            aIndex: region.aStart,
            o: region.oContent,
            oIndex: region.oStart,
            b: region.bContent,
            bIndex: region.bStart
          }
        });
      }
    }
  });
  flushOk();
  return results;
}

// src/sync/three-way-merger.js
var MAX_TEXT_MERGE_BYTES = 10 * 1024 * 1024;
function splitLines(text) {
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
  const probe = bytes.subarray ? bytes.subarray(0, 8e3) : bytes;
  for (let i = 0; i < probe.length; i++) {
    if (probe[i] === 0) return true;
  }
  return false;
}
var ThreeWayMerger = class {
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
    const chunks = diff3Merge(splitLines(localText), splitLines(baseText), splitLines(remoteText), {
      stringSeparator: false,
      excludeFalseConflicts: true
    });
    const merged = [];
    for (const chunk of chunks) {
      if (chunk.conflict) {
        return {
          merged: false,
          content: null,
          conflicts: [{ path, reason: "双方修改了同一文本文件且无法自动合并" }],
          strategy: "manual-required"
        };
      }
      if (chunk.ok) merged.push(...chunk.ok);
    }
    return {
      merged: true,
      content: GitProvider.textToBytes(merged.join("")),
      conflicts: [],
      strategy: "text-three-way"
    };
  }
};

// src/sync/commit-builder.js
var BATCH_BYTE_LIMIT = 80 * 1024 * 1024;
var DEFAULT_REQUEST_LIMIT = 32 * 1024 * 1024;
var CommitBuilder = class {
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
        size: item.bytes ? item.bytes.length : 0
      });
    }
    const eligible = uploads.filter((u) => !oversize.includes(u));
    const deletions = deletionsRemote.map((d) => ({ op: "delete", path: d.path, remoteSha: d.remoteSha }));
    const total = Math.max(1, Math.ceil((eligible.length + deletions.length) / 1) === 0 ? 1 : 1);
    const chunks = this._chunk(eligible, deletions);
    const batches = chunks.map((chunk, idx) => ({
      part: idx + 1,
      total: chunks.length,
      size: chunk.size,
      uploads: chunk.uploads,
      deletions: chunk.deletions,
      message: this._message(operationId, chunk, idx + 1, chunks.length),
      github: provider === "github" ? chunk.github : null,
      gitee: provider === "gitee" ? chunk.gitee : null
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
      current.github.entries.push({ path: item.path, sha: null, mode: "100644" });
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
};

// src/sync/conflict-service.js
var CONFLICT_FILE = "sync-conflicts.json";
var SNAPSHOT_BYTE_LIMIT = 5 * 1024 * 1024;
var ConflictService = class {
  constructor(plugin) {
    this.plugin = plugin;
    this.sets = {};
  }
  async load() {
    try {
      const data = await this.plugin.loadData(CONFLICT_FILE);
      if (data && typeof data.sets === "object") this.sets = data.sets;
    } catch (err) {
      console.warn("[SY-GSP] 冲突集读取失败:", err && err.message);
    }
    return this.sets;
  }
  openSet(repoKey) {
    return Object.values(this.sets).find((s) => s.repoKey === repoKey && s.status === "open") || null;
  }
  allOpenSets() {
    return Object.values(this.sets).filter((s) => s.status === "open");
  }
  /**
   * 保存冲突集(覆盖同仓库已有 open 集)。
   * @param {object} opts {repoKey, operationId, conflicts:[{path, reason, baseSha, localSha, remoteSha,
   *   snapshots:{baseB64,localB64,remoteB64}}]}
   */
  async saveSet(opts) {
    const conflicts = (opts.conflicts || []).map((c) => ({
      path: c.path,
      reason: c.reason || "",
      baseSha: c.baseSha || null,
      localSha: c.localSha || null,
      remoteSha: c.remoteSha || null,
      snapshots: this._capSnapshots(c.snapshots),
      status: "open",
      decision: null
    }));
    const set = {
      repoKey: opts.repoKey,
      operationId: opts.operationId,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      status: "open",
      conflicts
    };
    for (const [key, s] of Object.entries(this.sets)) {
      if (s.repoKey === opts.repoKey && s.status === "open") s.status = "superseded";
    }
    this.sets[opts.operationId] = set;
    await this._persist();
    return set;
  }
  /** 单文件决策: keep_local | keep_remote | resolved(用户已编辑) */
  async decide(operationId, path, decision) {
    const set = this.sets[operationId];
    if (!set) throw new SyncError({ category: SyncErrorCategory.UNKNOWN, message: "冲突集不存在: " + operationId });
    const item = set.conflicts.find((c) => c.path === path);
    if (!item) throw new SyncError({ category: SyncErrorCategory.UNKNOWN, message: "冲突集不含该文件: " + path });
    item.decision = decision;
    item.status = decision === "later" ? "open" : "decided";
    if (set.conflicts.every((c) => c.status !== "open")) set.status = "decided";
    await this._persist();
  }
  /** 收集一个冲突集的覆盖决策(供引擎重新规划) */
  collectOverrides(operationId) {
    const set = this.sets[operationId];
    if (!set) return /* @__PURE__ */ new Map();
    const overrides = /* @__PURE__ */ new Map();
    for (const c of set.conflicts) {
      if (c.decision === "keep_local" || c.decision === "keep_remote") overrides.set(c.path, c.decision);
    }
    return overrides;
  }
  /** 关闭冲突集(本轮已处理完毕) */
  async closeSet(operationId) {
    const set = this.sets[operationId];
    if (set) {
      set.status = "closed";
      await this._persist();
    }
  }
  _capSnapshots(snapshots) {
    if (!snapshots) return null;
    const capped = {};
    for (const key of ["baseB64", "localB64", "remoteB64"]) {
      const v = snapshots[key];
      capped[key] = v && v.length <= SNAPSHOT_BYTE_LIMIT ? v : null;
    }
    capped.truncated = Object.keys(snapshots).some((k) => snapshots[k] && !capped[k]);
    return capped;
  }
  async _persist() {
    try {
      await this.plugin.saveData(CONFLICT_FILE, { sets: this.sets });
    } catch (err) {
      throw new SyncError({
        category: SyncErrorCategory.LOCAL_FILE,
        code: "CONFLICT_SAVE_FAILED",
        operation: "saveConflicts",
        message: "冲突快照保存失败: " + String(err && err.message || err),
        recoverable: true,
        cause: err
      });
    }
  }
};

// src/sync/sync-queue.js
var SyncQueue = class {
  constructor() {
    this.lanes = /* @__PURE__ */ new Map();
    this.events = null;
  }
  static keyOf({ provider, owner, repo, branch }) {
    return provider + ":" + owner + "/" + repo + ":" + branch;
  }
  /**
   * 入队一个任务。
   * @returns {Promise<{merged:boolean, queued:boolean, result:any}>}
   *   merged=true 表示该触发被合并进运行中/已排队的任务,未创建新任务。
   */
  enqueue(key, task, { mergeable = false, label = "" } = {}) {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { running: false, pending: 0, chain: Promise.resolve() };
      this.lanes.set(key, lane);
    }
    if (mergeable && (lane.running || lane.pending > 0)) {
      if (this.events) this.events.emit("queue:merged", { key, label });
      return Promise.resolve({ merged: true, queued: false, result: null });
    }
    lane.pending += 1;
    const execution = lane.chain.then(
      () => this._run(key, lane, task, label),
      () => this._run(key, lane, task, label)
      // 前任失败不阻塞后续任务
    );
    lane.chain = execution.catch(() => {
    });
    return execution.then((r) => ({ merged: false, queued: true, result: r }));
  }
  async _run(key, lane, task, label) {
    lane.pending -= 1;
    lane.running = true;
    if (this.events) this.events.emit("queue:start", { key, label });
    try {
      return await task();
    } finally {
      lane.running = false;
      if (this.events) this.events.emit("queue:finish", { key, label });
      if (lane.pending <= 0) {
        const timer = setTimeout(() => {
          if (!lane.running && lane.pending <= 0) this.lanes.delete(key);
        }, 0);
        if (typeof timer.unref === "function") timer.unref();
      }
    }
  }
  isRunning(key) {
    const lane = this.lanes.get(key);
    return !!(lane && lane.running);
  }
  /** 包装任务: 任何异常统一转 SyncError 上抛,保持错误可分类 */
  static wrapError(phase) {
    return (task) => async () => {
      try {
        return await task();
      } catch (err) {
        if (err instanceof SyncError) throw err;
        throw new SyncError({
          category: SyncErrorCategory.UNKNOWN,
          phase,
          message: err && err.message || String(err),
          detail: err && err.stack || "",
          cause: err
        });
      }
    };
  }
};

// src/sync/retry-policy.js
var NETWORK_MAX = 3;
var REMOTE_CHANGED_MAX = 2;
var BASE_DELAYS_MS = [1e3, 3e3, 9e3];
var DEFAULT_RETRYABLE_CATEGORIES = Object.freeze([
  SyncErrorCategory.NETWORK,
  SyncErrorCategory.TIMEOUT,
  SyncErrorCategory.REMOTE_CHANGED,
  SyncErrorCategory.PUSH_REJECTED
]);
var NO_RETRY_CATEGORIES = [
  SyncErrorCategory.AUTH,
  SyncErrorCategory.PERMISSION,
  SyncErrorCategory.REPOSITORY,
  SyncErrorCategory.BRANCH,
  SyncErrorCategory.LARGE_FILE,
  SyncErrorCategory.CONFLICT,
  SyncErrorCategory.LOCAL_FILE,
  SyncErrorCategory.CANCELLED
];
var RetryPolicy = class {
  constructor({ enabled = false } = {}) {
    this.enabled = !!enabled;
  }
  /**
   * 判定某错误是否可重试。
   * @param {SyncError|Error} err
   * @param {number} attempt 已尝试次数(从 0 开始)
   * @returns {{retry:boolean, delayMs:number, replan:boolean, reason:string}}
   */
  decide(err, attempt) {
    const category = err && err.category || "";
    const notEligible = (reason) => ({ retry: false, delayMs: 0, replan: false, reason });
    if (!this.enabled) return notEligible("自动重试未开启");
    if (!(err instanceof SyncError)) return notEligible("非 SyncError");
    if (NO_RETRY_CATEGORIES.indexOf(category) >= 0) return notEligible("该错误类型不自动重试");
    if (err.retryable === false) return notEligible("错误标记为不可重试");
    if (category === SyncErrorCategory.NETWORK || category === SyncErrorCategory.TIMEOUT) {
      if (attempt >= NETWORK_MAX) return notEligible("已达网络类重试上限");
      return { retry: true, delayMs: this._delay(attempt), replan: false, reason: "网络类暂态错误" };
    }
    if (category === SyncErrorCategory.REMOTE_CHANGED || category === SyncErrorCategory.PUSH_REJECTED) {
      if (attempt >= REMOTE_CHANGED_MAX) return notEligible("已达远端变化重试上限");
      return { retry: true, delayMs: 0, replan: true, reason: "远端已变化,重新规划" };
    }
    return notEligible("未知重试资格");
  }
  _delay(attempt) {
    const base = BASE_DELAYS_MS[Math.min(attempt, BASE_DELAYS_MS.length - 1)];
    const jitter = Math.round(base * 0.2 * Math.random());
    return base + jitter;
  }
};

// src/sync/sync-context.js
var SyncState = Object.freeze({
  IDLE: "IDLE",
  QUEUED: "QUEUED",
  CHECKING: "CHECKING",
  SNAPSHOTTING_LOCAL: "SNAPSHOTTING_LOCAL",
  FETCHING_REMOTE: "FETCHING_REMOTE",
  RESOLVING_BASE: "RESOLVING_BASE",
  PLANNING: "PLANNING",
  MERGING: "MERGING",
  CONFLICT_PAUSED: "CONFLICT_PAUSED",
  COMMITTING: "COMMITTING",
  VERIFYING_REMOTE_HEAD: "VERIFYING_REMOTE_HEAD",
  PUSHING: "PUSHING",
  RETRYING: "RETRYING",
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED"
});
var TRANSITIONS = Object.freeze({
  [SyncState.IDLE]: [SyncState.QUEUED, SyncState.FAILED],
  [SyncState.QUEUED]: [SyncState.CHECKING, SyncState.CANCELLED],
  [SyncState.CHECKING]: [
    SyncState.SNAPSHOTTING_LOCAL,
    SyncState.FAILED,
    SyncState.CANCELLED
  ],
  [SyncState.SNAPSHOTTING_LOCAL]: [
    SyncState.FETCHING_REMOTE,
    SyncState.FAILED,
    SyncState.CANCELLED
  ],
  [SyncState.FETCHING_REMOTE]: [
    SyncState.RESOLVING_BASE,
    SyncState.FAILED,
    SyncState.CANCELLED
  ],
  [SyncState.RESOLVING_BASE]: [
    SyncState.PLANNING,
    SyncState.CONFLICT_PAUSED,
    // 基准无法恢复 → 阻止写入,等待恢复向导
    SyncState.FAILED,
    SyncState.CANCELLED
  ],
  [SyncState.PLANNING]: [
    SyncState.MERGING,
    SyncState.SUCCESS,
    // 本地与远端均无变化
    SyncState.FAILED,
    SyncState.CANCELLED
  ],
  [SyncState.MERGING]: [
    SyncState.CONFLICT_PAUSED,
    // 无法自动合并
    SyncState.COMMITTING,
    SyncState.SUCCESS,
    SyncState.FAILED,
    SyncState.CANCELLED
  ],
  [SyncState.CONFLICT_PAUSED]: [
    SyncState.CHECKING,
    // 用户决策后重新规划
    SyncState.FAILED
  ],
  [SyncState.COMMITTING]: [
    SyncState.VERIFYING_REMOTE_HEAD,
    SyncState.PUSHING,
    SyncState.RETRYING,
    SyncState.FAILED,
    SyncState.CANCELLED
  ],
  [SyncState.VERIFYING_REMOTE_HEAD]: [
    SyncState.PUSHING,
    SyncState.RETRYING,
    SyncState.FAILED,
    SyncState.CANCELLED
  ],
  [SyncState.PUSHING]: [
    SyncState.SUCCESS,
    SyncState.RETRYING,
    SyncState.COMMITTING,
    // 多批次提交: 下一批回到提交阶段
    SyncState.VERIFYING_REMOTE_HEAD,
    // 多批次提交: 下一批重新校验远端 HEAD
    SyncState.FAILED,
    SyncState.CANCELLED
  ],
  [SyncState.RETRYING]: [
    SyncState.FETCHING_REMOTE,
    SyncState.FAILED,
    SyncState.CANCELLED
  ],
  [SyncState.SUCCESS]: [SyncState.IDLE],
  [SyncState.FAILED]: [SyncState.IDLE],
  [SyncState.CANCELLED]: [SyncState.IDLE]
});
function canTransition(from, to) {
  const allowed = TRANSITIONS[from];
  return !!allowed && allowed.indexOf(to) >= 0;
}
var SyncTrigger = Object.freeze({
  MANUAL: "manual",
  AUTOMATIC: "automatic",
  STARTUP: "startup",
  RETRY: "retry",
  CONFLICT_RESOLUTION: "conflict_resolution",
  DIAGNOSIS: "diagnosis"
});
var SyncMode = Object.freeze({
  AUTO: "auto",
  REMOTE_OVER_LOCAL: "remote_over_local",
  LOCAL_OVER_REMOTE: "local_over_remote"
});
var contextSeq = 0;
function createSyncContext({ trigger, mode, provider, owner, repo, branch }) {
  contextSeq += 1;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  return {
    id: "sync-" + Date.now() + "-" + contextSeq,
    trigger: trigger || SyncTrigger.MANUAL,
    mode: mode || SyncMode.AUTO,
    provider: provider || "",
    owner: owner || "",
    repo: repo || "",
    branch: branch || "",
    startedAt: now,
    finishedAt: null,
    phase: SyncState.QUEUED,
    state: SyncState.QUEUED,
    attempt: 0,
    baseCommit: null,
    expectedRemoteHead: null,
    observedRemoteHead: null,
    localSnapshotId: null,
    plan: null,
    result: null,
    error: null,
    conflicts: [],
    /** @type {Array<{state:string, at:string, note:string}>} 状态流转轨迹(内存,不持久化) */
    trail: []
  };
}
function transition(ctx, to, note = "") {
  if (!canTransition(ctx.state, to)) {
    const err = new Error(
      "非法状态转换: " + ctx.state + " -> " + to + (note ? " (" + note + ")" : "")
    );
    err.illegalTransition = true;
    err.fromState = ctx.state;
    err.toState = to;
    throw err;
  }
  ctx.trail.push({ state: to, at: (/* @__PURE__ */ new Date()).toISOString(), note });
  ctx.state = to;
  if (to !== SyncState.SUCCESS && to !== SyncState.FAILED && to !== SyncState.CANCELLED) {
    ctx.phase = to;
  }
  return ctx;
}
function finish(ctx, { state, result, error }) {
  ctx.finishedAt = (/* @__PURE__ */ new Date()).toISOString();
  ctx.state = state;
  ctx.result = result || null;
  ctx.error = error || null;
  return ctx;
}

// src/sync/sync-engine.js
var SyncEngine = class {
  /**
   * @param {object} deps {
   *   provider, workspace, contentAdapter, metadataStore, manifestStore, conflictService,
   *   planner, merger, commitBuilder, events, config:{syncRange, syncFileType, repoKey}
   * }
   */
  constructor(deps) {
    this.provider = deps.provider;
    this.workspace = deps.workspace;
    this.contentAdapter = deps.contentAdapter;
    this.metadataStore = deps.metadataStore;
    this.manifestStore = deps.manifestStore;
    this.conflictService = deps.conflictService;
    this.planner = deps.planner;
    this.merger = deps.merger;
    this.commitBuilder = deps.commitBuilder;
    this.events = deps.events;
    this.config = deps.config;
  }
  _emit(name, payload) {
    if (this.events) this.events.emit(name, payload);
  }
  async run(ctx) {
    try {
      transition(ctx, SyncState.CHECKING);
      this._emit("engine:phase", { ctx, state: SyncState.CHECKING });
      this._checkConfig(ctx);
      transition(ctx, SyncState.SNAPSHOTTING_LOCAL);
      this._emit("engine:phase", { ctx, state: SyncState.SNAPSHOTTING_LOCAL });
      const scan = await this.workspace.scan({ range: this.config.syncRange });
      const localShas = /* @__PURE__ */ new Map();
      for (const file of scan.files) {
        const bytes = await this._readLocalBytes(file.path);
        localShas.set(file.path, bytes ? await this.provider.gitBlobSha(bytes) : null);
      }
      ctx.localSnapshotId = ctx.id;
      transition(ctx, SyncState.FETCHING_REMOTE);
      this._emit("engine:phase", { ctx, state: SyncState.FETCHING_REMOTE });
      let remoteHead = null;
      try {
        remoteHead = await this.provider.getBranchHead();
        ctx.observedRemoteHead = remoteHead.sha;
        const remoteCommit = await this.provider.getCommit(remoteHead.sha);
        var remoteEntries = await this._treeMap(await this.provider.getTree(remoteCommit.treeSha));
      } catch (err) {
        if (err instanceof SyncError && err.httpStatus === 404) {
          ctx.remoteHeadless = true;
          remoteHead = null;
          var remoteEntries = /* @__PURE__ */ new Map();
        } else {
          throw err;
        }
      }
      transition(ctx, SyncState.RESOLVING_BASE);
      this._emit("engine:phase", { ctx, state: SyncState.RESOLVING_BASE });
      const baseResolution = await this._resolveBase(ctx, remoteHead ? remoteHead.sha : null);
      if (baseResolution.unresolved) {
        ctx.baseUnresolved = true;
        ctx.conflicts = [{ path: "__base__", reason: "BASE_UNRESOLVED", detail: baseResolution.reason }];
        transition(ctx, SyncState.CONFLICT_PAUSED, "BASE_UNRESOLVED");
        finish(ctx, { state: SyncState.CONFLICT_PAUSED, result: { paused: true, kind: "BASE_UNRESOLVED" } });
        return ctx.result;
      }
      const baseEntries = baseResolution.baseEntries;
      if (baseResolution.bootstrapDownload) {
        ctx.bootstrapDownload = true;
      }
      transition(ctx, SyncState.PLANNING);
      this._emit("engine:phase", { ctx, state: SyncState.PLANNING });
      ctx.expectedRemoteHead = remoteHead ? remoteHead.sha : null;
      const overrides = ctx.overrides || /* @__PURE__ */ new Map();
      const plan = await this.planner.build({
        baseEntries,
        remoteEntries,
        localFiles: scan.files,
        localShas,
        mode: ctx.mode,
        overrides,
        enumErrorOccurred: scan.enumErrorOccurred,
        bootstrap: ctx.bootstrapDownload === true
      });
      ctx.plan = plan;
      transition(ctx, SyncState.MERGING);
      this._emit("engine:phase", { ctx, state: SyncState.MERGING });
      await this._runMerges(ctx, plan, baseEntries, remoteEntries);
      if (plan.conflicts.length > 0) {
        await this._saveConflicts(ctx, plan, baseEntries, remoteEntries);
        transition(ctx, SyncState.CONFLICT_PAUSED, "conflicts=" + plan.conflicts.length);
        finish(ctx, {
          state: SyncState.CONFLICT_PAUSED,
          result: {
            paused: true,
            kind: "FILE_CONFLICTS",
            conflictCount: plan.conflicts.length,
            conflicts: plan.conflicts.map((c) => ({ path: c.path, reason: c.reason }))
          }
        });
        return ctx.result;
      }
      const remoteWrites = plan.uploads.length + plan.deletionsRemote.length;
      if (remoteWrites === 0) {
        await this._applyLocalChanges(ctx, plan);
        await this._rebuildManifest(ctx, plan);
        if (remoteHead) {
          await this.metadataStore.setConfirmedCommit(this.config.repoKey, remoteHead.sha, ctx.id);
        }
        transition(ctx, SyncState.SUCCESS, "无远端变更");
        finish(ctx, { state: SyncState.SUCCESS, result: this._result(ctx, remoteHead ? remoteHead.sha : null, plan) });
        return ctx.result;
      }
      transition(ctx, SyncState.COMMITTING);
      this._emit("engine:phase", { ctx, state: SyncState.COMMITTING });
      const { batches, skipped } = this.commitBuilder.build({
        operationId: ctx.id,
        uploads: await this._materializeUploads(ctx, plan),
        deletionsRemote: plan.deletionsRemote,
        provider: this.provider.platform
      });
      ctx.skippedLarge = skipped;
      let finalSha;
      if (batches.length === 0) {
        finalSha = remoteHead ? remoteHead.sha : null;
      } else if (this.provider.platform === "github") {
        finalSha = await this._pushAtomic(ctx, batches, remoteEntries);
      } else {
        finalSha = await this._pushPerFile(ctx, batches);
      }
      if (batches.length > 0 && !finalSha) {
        throw new SyncError({
          category: SyncErrorCategory.REMOTE_CHANGED,
          code: "PUSH_UNCONFIRMED",
          operation: "push",
          message: "推送后无法确认远端引用状态,本轮不标记成功",
          retryable: true,
          recoverable: false
        });
      }
      await this._applyLocalChanges(ctx, plan);
      await this._rebuildManifest(ctx, plan);
      const confirmedSha = finalSha || (remoteHead ? remoteHead.sha : null);
      if (confirmedSha) {
        await this.metadataStore.setConfirmedCommit(this.config.repoKey, confirmedSha, ctx.id);
      }
      transition(ctx, SyncState.SUCCESS);
      finish(ctx, { state: SyncState.SUCCESS, result: this._result(ctx, confirmedSha, plan) });
      return ctx.result;
    } catch (err) {
      const syncErr = err instanceof SyncError ? err : new SyncError({
        category: SyncErrorCategory.UNKNOWN,
        phase: ctx.state,
        message: err && err.message || String(err),
        detail: err && err.stack || "",
        cause: err
      });
      syncErr.phase = syncErr.phase || ctx.state;
      ctx.error = syncErr;
      if (ctx.state !== SyncState.CONFLICT_PAUSED) {
        try {
          transition(ctx, SyncState.FAILED);
        } catch (e) {
          ctx.state = SyncState.FAILED;
        }
      }
      finish(ctx, { state: ctx.state, error: syncErr, result: { paused: ctx.state === SyncState.CONFLICT_PAUSED } });
      throw syncErr;
    }
  }
  // ---------- 阶段实现 ----------
  _checkConfig(ctx) {
    if (!ctx.owner || !ctx.repo) {
      throw new SyncError({ category: SyncErrorCategory.REPOSITORY, phase: SyncState.CHECKING, message: "仓库地址未配置或无法解析", recoverable: true });
    }
    if (!ctx.branch) {
      throw new SyncError({ category: SyncErrorCategory.BRANCH, phase: SyncState.CHECKING, message: "分支未配置", recoverable: true });
    }
    if (!this.provider.token) {
      throw new SyncError({ category: SyncErrorCategory.AUTH, phase: SyncState.CHECKING, message: "Token 未配置", recoverable: true });
    }
  }
  async _treeMap(entries) {
    const map = /* @__PURE__ */ new Map();
    for (const e of entries || []) {
      if (String(e.type).toLowerCase() !== "blob") continue;
      map.set(e.path, { sha: e.sha, type: e.type, size: e.size || 0 });
    }
    return map;
  }
  /**
   * BASE 解析(2.0 方案 §7.3):
   * - 确认基准存在且远端可达 → 使用;
   * - 提交丢失 → 尝试合并基重建;
   * - 无法证明共同祖先 → BASE_UNRESOLVED(不自动选边);
   * - 首次同步: 空仓库(BASE=null)直接进入;远端已有内容则交由首同步向导。
   */
  async _resolveBase(ctx, remoteHeadSha) {
    const repoKey = this.config.repoKey;
    const baseSha = this.metadataStore.getBaseCommit(repoKey);
    if (baseSha) {
      try {
        const baseCommit = await this.provider.getCommit(baseSha);
        return { baseEntries: await this._treeMap(await this.provider.getTree(baseCommit.treeSha)), baseSha };
      } catch (err) {
        const mergeBase = await this.provider.getMergeBase(baseSha, remoteHeadSha);
        if (mergeBase) {
          const mbCommit = await this.provider.getCommit(mergeBase);
          ctx.baseRebuiltFrom = mergeBase;
          return { baseEntries: await this._treeMap(await this.provider.getTree(mbCommit.treeSha)), baseSha: mergeBase };
        }
        return { unresolved: true, reason: "确认基准 " + baseSha.slice(0, 8) + " 在远端不可访问,且找不到共同祖先" };
      }
    }
    let initial = null;
    try {
      initial = await this.provider.getInitialCommit();
    } catch (err) {
      if (err instanceof SyncError && err.httpStatus === 404) initial = null;
      else throw err;
    }
    if (!initial) {
      return { baseEntries: /* @__PURE__ */ new Map(), baseSha: null };
    }
    const scan = await this.workspace.scan({ range: this.config.syncRange });
    if (scan.files.length === 0) {
      return { baseEntries: await this._treeMap(await this.provider.getTree(initial.treeSha)), baseSha: initial.sha, bootstrapDownload: true };
    }
    return {
      unresolved: true,
      reason: "首次同步: 本地与远端都有内容,无法证明共同基准,需要通过首同步向导明确选择"
    };
  }
  async _runMerges(ctx, plan, baseEntries, remoteEntries) {
    for (const mergeItem of plan.merges) {
      const path = mergeItem.path;
      const baseBytes = mergeItem.baseSha ? (await this.provider.getBlob(mergeItem.baseSha)).bytes : null;
      const remoteBytes = (await this.provider.getBlob(mergeItem.remoteSha)).bytes;
      const localBytes = await this._readLocalBytes(path);
      const result = await this.merger.merge({
        path,
        base: baseBytes ? { bytes: baseBytes } : null,
        local: { bytes: localBytes },
        remote: { bytes: remoteBytes }
      });
      if (result.merged) {
        await this.contentAdapter.writeFileBlob(path, new Blob([result.content]), "raw", "update");
        plan.uploads.push({ path, bytes: result.content, op: "update", merged: true });
        plan.unchanged += 0;
      } else {
        plan.conflicts.push({
          path,
          reason: result.conflicts[0] && result.conflicts[0].reason || "无法自动合并",
          baseSha: mergeItem.baseSha,
          localSha: await this.provider.gitBlobSha(localBytes),
          remoteSha: mergeItem.remoteSha
        });
      }
    }
    plan.merges.length = 0;
  }
  async _saveConflicts(ctx, plan, baseEntries, remoteEntries) {
    const conflicts = [];
    for (const c of plan.conflicts) {
      let snapshots = null;
      try {
        const localBytes = await this._readLocalBytes(c.path);
        const remoteBytes = c.remoteSha ? (await this.provider.getBlob(c.remoteSha)).bytes : null;
        const baseBytes = c.baseSha ? (await this.provider.getBlob(c.baseSha)).bytes : null;
        snapshots = {
          localB64: localBytes ? this.provider.bytesToBase64(localBytes) : null,
          remoteB64: remoteBytes ? this.provider.bytesToBase64(remoteBytes) : null,
          baseB64: baseBytes ? this.provider.bytesToBase64(baseBytes) : null
        };
      } catch (err) {
        snapshots = { localB64: null, remoteB64: null, baseB64: null };
      }
      conflicts.push({ path: c.path, reason: c.reason, baseSha: c.baseSha, localSha: c.localSha, remoteSha: c.remoteSha, snapshots });
    }
    await this.conflictService.saveSet({
      repoKey: this.config.repoKey,
      operationId: ctx.id,
      conflicts
    });
    ctx.conflicts = conflicts.map((c) => ({ path: c.path, reason: c.reason }));
  }
  /** 读取待上传内容(读取版本 = 提交版本;超限在 CommitBuilder 预检) */
  async _materializeUploads(ctx, plan) {
    const uploads = [];
    for (const item of plan.uploads) {
      if (item.bytes) {
        uploads.push(item);
        continue;
      }
      const format = this._uploadFormat(item.path);
      const blob = await this.contentAdapter.readFileBlob(item.path, format);
      if (!blob) {
        throw new SyncError({
          category: SyncErrorCategory.LOCAL_FILE,
          code: "READ_EMPTY",
          operation: "materializeUploads",
          path: item.path,
          message: "本地文件读取为空,已停止上传: " + item.path,
          retryable: false,
          recoverable: true
        });
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.length === 0 && /\.sy$/i.test(item.path)) {
        throw new SyncError({
          category: SyncErrorCategory.LOCAL_FILE,
          code: "EMPTY_DOC",
          operation: "materializeUploads",
          path: item.path,
          message: "笔记文件内容为空,拒绝上传: " + item.path,
          retryable: false,
          recoverable: true
        });
      }
      uploads.push(Object.assign({}, item, { bytes, format }));
    }
    return uploads;
  }
  _uploadFormat(path) {
    if (this.config.syncFileType === "markdown" && /\.sy$/i.test(path)) return "markdown";
    return "raw";
  }
  /** GitHub: 原子树提交 + 引用 CAS + 回读确认(空仓库时首推创建引用) */
  async _pushAtomic(ctx, batches, remoteEntries) {
    let finalSha = null;
    for (const batch of batches) {
      if (batch.uploads.length === 0 && batch.github.deletePaths.length === 0) continue;
      let headNow = null;
      try {
        headNow = await this.provider.getBranchHead();
      } catch (err) {
        if (!(err instanceof SyncError && err.httpStatus === 404)) throw err;
      }
      if (headNow) {
        if (!ctx.expectedRemoteHead || headNow.sha !== ctx.expectedRemoteHead) {
          throw new SyncError({
            category: SyncErrorCategory.REMOTE_CHANGED,
            code: "REMOTE_HEAD_MOVED",
            operation: "prePushCheck",
            message: "远端分支在规划后已变化(" + headNow.sha.slice(0, 8) + "),本轮重新规划",
            retryable: true,
            recoverable: false
          });
        }
        transition(ctx, SyncState.VERIFYING_REMOTE_HEAD);
        ctx.expectedRemoteHead = headNow.sha;
      }
      const treeBaseSha = headNow ? (await this.provider.getCommit(headNow.sha)).treeSha : null;
      const entries = [];
      for (const upload of batch.uploads) {
        const blobSha = await this.provider.createBlob(upload.bytes);
        entries.push({ path: upload.path, sha: blobSha, mode: "100644" });
      }
      for (const dp of batch.github.deletePaths) {
        entries.push({ path: dp.path, sha: null, mode: "100644" });
      }
      const tree = await this.provider.createTree(treeBaseSha, entries);
      const parentSha = finalSha || (headNow ? headNow.sha : null);
      const commit = await this.provider.createCommit({
        message: batch.message,
        treeSha: tree.sha,
        parents: parentSha ? [parentSha] : []
      });
      transition(ctx, SyncState.PUSHING);
      if (!headNow) {
        const confirmed = await this.provider.ensureBranchRef(commit.sha);
        finalSha = confirmed.confirmedSha;
        ctx.expectedRemoteHead = finalSha;
      } else {
        try {
          const confirmed = await this.provider.updateBranchRef(commit.sha, { expectedHead: headNow.sha });
          finalSha = confirmed.confirmedSha;
        } catch (err) {
          throw this.provider.mapUpdateRefFailure(err);
        }
      }
    }
    return finalSha;
  }
  /** Gitee: 逐文件写入 + 操作日志 + 部分失败显式化(空仓库由 Gitee 分支参数自动建分支) */
  async _pushPerFile(ctx, batches) {
    let lastHead = "";
    let lastCommitSha = "";
    for (const batch of batches) {
      if (batch.gitee.operations.length === 0) continue;
      if (ctx.state === SyncState.COMMITTING) {
        transition(ctx, SyncState.PUSHING);
      }
      const result = await this.provider.applyFileOperations(batch.gitee.operations, { message: batch.message });
      lastHead = result.remoteHead || lastHead;
      const commits = (result.operations || []).map((o) => o.commitSha).filter(Boolean);
      if (commits.length > 0) lastCommitSha = commits[commits.length - 1];
    }
    if (!lastHead) {
      lastHead = lastCommitSha;
    }
    if (!lastHead) {
      const head = await this.provider.getBranchHead();
      lastHead = head.sha;
    }
    return lastHead;
  }
  /** 远端确认后应用本地侧变更(下载/本地删除),破坏性动作先备份 */
  async _applyLocalChanges(ctx, plan) {
    const formatOf = (path) => this.config.syncFileType === "markdown" && /\.sy$/i.test(path) ? "markdown" : "raw";
    for (const item of plan.downloads) {
      const src = await this.provider.getFileContent(item.path, ctx.observedRemoteHead);
      const blob = new Blob([src.bytes]);
      await this.contentAdapter.writeFileBlob(item.path, blob, formatOf(item.path), item.op === "create" ? "create" : "update");
    }
    for (const item of plan.deletionsLocal) {
      await this.contentAdapter.removeFileWithBackup(item.path);
    }
    if (plan.downloads.length > 0 || plan.deletionsLocal.length > 0) {
      await this.contentAdapter.kernel.refreshFiletree().catch(() => {
      });
    }
  }
  async _rebuildManifest(ctx, plan) {
    const scan = await this.workspace.scan({ range: this.config.syncRange });
    await this.manifestStore.replaceAll(scan.files.map((f) => f.path));
  }
  _result(ctx, sha, plan) {
    return {
      success: true,
      operationId: ctx.id,
      commitSha: sha,
      remoteHead: sha,
      uploads: plan.uploads.length,
      downloads: plan.downloads.length,
      deletionsRemote: plan.deletionsRemote.length,
      deletionsLocal: plan.deletionsLocal.length,
      skippedDeletes: plan.skippedDeletes,
      skippedLarge: ctx.skippedLarge || [],
      unchanged: plan.unchanged,
      conflicts: 0
    };
  }
  async _readLocalBytes(path) {
    const blob = await this.contentAdapter.kernel.getFile(path);
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  }
};

// src/sync/sync-controller.js
var ENGINE_STATE_FILE = "engine-state.json";
var SyncController = class {
  /**
   * @param {object} deps {
   *   plugin, settings, events, notify, i18n,
   *   makeEngineDeps: (ctx) => {provider, workspace, contentAdapter, metadataStore,
   *     manifestStore, conflictService, planner, merger, commitBuilder, events, config},
   *   repoInfo: () => {provider, owner, repo, branch, token},
   *   autoSync: {pause(), resume(), markAutoTick()}
   * }
   */
  constructor(deps) {
    this.plugin = deps.plugin;
    this.settings = deps.settings;
    this.events = deps.events;
    this.notify = deps.notify;
    this.i18n = deps.i18n || ((k, fb) => fb);
    this.makeEngineDeps = deps.makeEngineDeps;
    this.repoInfo = deps.repoInfo;
    this.autoSync = deps.autoSync;
    this.queue = new SyncQueue();
    this.retryPolicy = new RetryPolicy({ enabled: false });
    this.state = SyncState.IDLE;
    this.lastContext = null;
    this.conflictPaused = null;
    this.autoTick = false;
    this._autoSkipNotified = false;
    this.retryTimer = null;
  }
  /** 恢复持久化的冲突暂停状态(onload) */
  async restore() {
    try {
      const saved = await this.plugin.loadData(ENGINE_STATE_FILE);
      if (saved && saved.conflictPaused) {
        this.conflictPaused = saved.conflictPaused;
        this.state = SyncState.CONFLICT_PAUSED;
        this.events.emit("state:changed", { state: this.state, conflictPaused: this.conflictPaused });
      }
    } catch (err) {
      console.warn("[SY-GSP] 恢复暂停状态失败:", err && err.message);
    }
  }
  _persistState() {
    const payload = this.conflictPaused ? { conflictPaused: this.conflictPaused } : {};
    this.plugin.saveData(ENGINE_STATE_FILE, payload).catch((err) => {
      this.notify(this.i18n("sygspPersistFailed", "⚠️ 状态保存失败,重启后可能丢失暂停状态"), "error");
      console.warn("[SY-GSP] 状态持久化失败:", err && err.message);
    });
  }
  /** 自动同步定时器回调前打标: 区分定时触发与手动触发 */
  markAutoTick() {
    this.autoTick = true;
  }
  isConflictPaused() {
    return !!this.conflictPaused;
  }
  /**
   * 发起一次同步。
   * @param {object} opts {trigger, mode, overrides(Map), resolutionOf?}
   */
  async syncNow({ trigger = SyncTrigger.MANUAL, mode = SyncMode.AUTO, overrides = null } = {}) {
    const info = this.repoInfo();
    const key = SyncQueue.keyOf(info);
    if (this.conflictPaused) {
      const isResolution = overrides !== null || mode !== SyncMode.AUTO;
      if (!isResolution) {
        const wasAuto = this.autoTick;
        this.autoTick = false;
        if (wasAuto) {
          if (!this._autoSkipNotified) {
            this._autoSkipNotified = true;
            this.notify(this.i18n("sygspPausedMsg", "⚠️ 同步冲突未处理,自动同步已暂停,请先处理冲突"), "error");
          }
          return { skipped: true };
        }
        this.events.emit("conflict:reopen", { conflictPaused: this.conflictPaused });
        return { skipped: true, conflict: true };
      }
    }
    this.autoTick = false;
    const ctx = createSyncContext({
      trigger,
      mode: this.conflictPaused && overrides ? SyncMode.AUTO : mode,
      provider: info.provider,
      owner: info.owner,
      repo: info.repo,
      branch: info.branch
    });
    if (overrides) ctx.overrides = overrides;
    return this.queue.enqueue(
      key,
      () => this._runWithRetry(ctx),
      { mergeable: trigger === SyncTrigger.AUTOMATIC, label: ctx.id }
    );
  }
  async _runWithRetry(ctx) {
    this.state = ctx.state;
    this.lastContext = ctx;
    this.events.emit("state:changed", { state: this.state, ctx });
    let attempt = 0;
    for (; ; ) {
      try {
        const engine = new SyncEngine(this.makeEngineDeps(ctx));
        const result = await engine.run(ctx);
        if (result && result.paused) {
          await this._onFailed(ctx, new SyncError({
            category: SyncErrorCategory.CONFLICT,
            code: result.kind,
            phase: ctx.state,
            message: ctx.conflicts && ctx.conflicts[0] && (ctx.conflicts[0].reason || ctx.conflicts[0].detail) || "同步已暂停"
          }));
          return result;
        }
        await this._onFinished(ctx, result);
        return result;
      } catch (err) {
        const syncErr = err instanceof SyncError ? err : toSyncError(err, { phase: ctx.state });
        const decision = this.retryPolicy.decide(syncErr, attempt);
        if (!decision.retry || ctx.state === SyncState.CONFLICT_PAUSED) {
          await this._onFailed(ctx, syncErr);
          throw syncErr;
        }
        attempt += 1;
        ctx.attempt = attempt;
        try {
          transition(ctx, SyncState.RETRYING);
        } catch (e) {
          ctx.state = SyncState.RETRYING;
        }
        this.events.emit("state:changed", { state: SyncState.RETRYING, ctx });
        this.notify(
          this.i18n("sygspRetrying", "⚠️ 同步失败,准备重试") + " (" + attempt + "/" + (decision.replan ? 2 : 3) + "): " + syncErr.message,
          "error"
        );
        if (decision.delayMs > 0) {
          await new Promise((resolve) => {
            this.retryTimer = setTimeout(resolve, decision.delayMs);
          });
        }
        ctx = createSyncContext({
          trigger: SyncTrigger.RETRY,
          mode: ctx.mode,
          provider: ctx.provider,
          owner: ctx.owner,
          repo: ctx.repo,
          branch: ctx.branch
        });
        ctx.attempt = attempt;
        this.lastContext = ctx;
      }
    }
  }
  async _onFinished(ctx, result) {
    this.state = SyncState.SUCCESS;
    if (this.conflictPaused) {
      this.conflictPaused = null;
      this._autoSkipNotified = false;
      this._persistState();
      this.autoSync.resume();
      this.notify(this.i18n("sygspResolvedMsg", "✅ 冲突已处理,自动同步已恢复"), "info");
    }
    this.events.emit("state:changed", { state: this.state, ctx });
    this.events.emit("sync:success", { ctx, result });
  }
  async _onFailed(ctx, syncErr) {
    if (ctx.state === SyncState.CONFLICT_PAUSED) {
      const kind = ctx.baseUnresolved ? "BASE_UNRESOLVED" : "FILE_CONFLICTS";
      this.conflictPaused = {
        kind,
        repoKey: this.repoKey(),
        operationId: ctx.id,
        reason: kind === "BASE_UNRESOLVED" ? ctx.conflicts[0] && ctx.conflicts[0].detail || "基准无法解析" : "存在未处理冲突",
        conflictCount: kind === "FILE_CONFLICTS" ? (ctx.conflicts || []).length : 0
      };
      this._persistState();
      this.autoSync.pause();
      this.state = SyncState.CONFLICT_PAUSED;
      this.events.emit("state:changed", { state: this.state, ctx, conflictPaused: this.conflictPaused });
      this.events.emit("sync:conflict", { ctx, conflictPaused: this.conflictPaused });
      return;
    }
    this.state = SyncState.FAILED;
    this.events.emit("state:changed", { state: this.state, ctx, error: syncErr });
    this.events.emit("sync:error", { ctx, error: syncErr });
  }
  repoKey() {
    const info = this.repoInfo();
    return SyncQueue.keyOf(info);
  }
  /** 用户冲突决策: 逐文件 keep_local/keep_remote → 重新规划执行 */
  async resolveConflicts(decisions) {
    const overrides = new Map(Object.entries(decisions || {}));
    if (this.conflictPaused && this.conflictPaused.kind === "BASE_UNRESOLVED") {
      return this._resolveBaseUnresolved(overrides);
    }
    return this.syncNow({ trigger: SyncTrigger.CONFLICT_RESOLUTION, overrides });
  }
  /** 基准失效恢复: 明确选择一方为新基准后执行一次强制方向同步 */
  async _resolveBaseUnresolved(overrides) {
    const choice = overrides.get("__base__");
    if (choice !== "keep_local" && choice !== "keep_remote") {
      throw new SyncError({
        category: SyncErrorCategory.UNKNOWN,
        message: "基准恢复需要明确选择 keep_local 或 keep_remote",
        recoverable: true
      });
    }
    const mode = choice === "keep_local" ? SyncMode.LOCAL_OVER_REMOTE : SyncMode.REMOTE_OVER_LOCAL;
    const result = await this.syncNow({ trigger: SyncTrigger.CONFLICT_RESOLUTION, mode });
    if (result && result.result && result.result.success) {
      await this.plugin.saveData(ENGINE_STATE_FILE, {});
      this.conflictPaused = null;
      this._persistState();
    }
    return result;
  }
  dismissConflictPause() {
    this.conflictPaused = null;
    this._persistState();
    this.events.emit("state:changed", { state: this.state });
  }
  destroy() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }
};

// src/storage/sync-metadata-store.js
var METADATA_FILE = "sync-metadata.json";
var SCHEMA_VERSION = 1;
var SyncMetadataStore = class {
  /**
   * @param {object} plugin 思源插件实例(saveData/loadData)
   */
  constructor(plugin) {
    this.plugin = plugin;
    this.data = { schemaVersion: SCHEMA_VERSION, repositories: {}, legacyHints: {} };
  }
  static keyOf({ provider, owner, repo, branch }) {
    return provider + ":" + owner + "/" + repo + ":" + branch;
  }
  async load() {
    try {
      const data = await this.plugin.loadData(METADATA_FILE);
      if (data && typeof data === "object") {
        this.data = {
          schemaVersion: data.schemaVersion || SCHEMA_VERSION,
          repositories: data.repositories || {},
          legacyHints: data.legacyHints || {}
        };
      }
    } catch (err) {
      if (err && !/not found|不存在/i.test(String(err.message || err))) {
        throw new SyncError({
          category: SyncErrorCategory.LOCAL_FILE,
          code: "METADATA_LOAD_FAILED",
          operation: "loadMetadata",
          message: "同步元数据读取失败: " + String(err && err.message || err),
          retryable: false,
          recoverable: true,
          cause: err
        });
      }
    }
    return this.data;
  }
  /** 读取指定仓库分支的基准信息 */
  get(repoKey) {
    return this.data.repositories[repoKey] || null;
  }
  getBaseCommit(repoKey) {
    const entry = this.get(repoKey);
    return entry && entry.lastConfirmedCommit ? entry.lastConfirmedCommit : null;
  }
  /**
   * 写入确认基准(仅允许在远端确认成功后调用)。
   */
  async setConfirmedCommit(repoKey, commitSha, operationId) {
    this.data.repositories[repoKey] = {
      lastConfirmedCommit: commitSha,
      lastSuccessfulAt: (/* @__PURE__ */ new Date()).toISOString(),
      lastOperationId: operationId || ""
    };
    await this._persist();
  }
  /** 记录旧版基准线索(仅诊断用,不作为基准) */
  async setLegacyHint(repoKey, hint) {
    if (hint) this.data.legacyHints[repoKey] = hint;
    await this._persist();
  }
  getLegacyHint(repoKey) {
    return this.data.legacyHints[repoKey] || null;
  }
  /** 清空基准(按仓库,或不带参数全量重置) */
  async clear(repoKey) {
    if (repoKey) {
      delete this.data.repositories[repoKey];
      delete this.data.legacyHints[repoKey];
    } else {
      this.data.repositories = {};
      this.data.legacyHints = {};
    }
    await this._persist();
  }
  async _persist() {
    try {
      await this.plugin.saveData(METADATA_FILE, this.data);
    } catch (err) {
      throw new SyncError({
        category: SyncErrorCategory.LOCAL_FILE,
        code: "METADATA_SAVE_FAILED",
        operation: "saveMetadata",
        message: "同步基准保存失败,本轮结果不会被记录: " + String(err && err.message || err),
        retryable: false,
        recoverable: true,
        cause: err
      });
    }
  }
};

// src/storage/sync-history-store.js
var HISTORY_FILE = "sync-history.json";
var HISTORY_LIMIT = 100;
var SyncHistoryStore = class {
  constructor(plugin) {
    this.plugin = plugin;
    this.entriesByRepo = {};
    this._loaded = false;
  }
  async load() {
    this._loaded = true;
    try {
      const data = await this.plugin.loadData(HISTORY_FILE);
      if (data && typeof data.entriesByRepo === "object") {
        this.entriesByRepo = data.entriesByRepo;
      }
    } catch (err) {
      if (err && !/not found|不存在/i.test(String(err.message || err))) {
        throw new SyncError({
          category: SyncErrorCategory.LOCAL_FILE,
          code: "HISTORY_LOAD_FAILED",
          operation: "loadHistory",
          message: "同步历史读取失败: " + String(err && err.message || err),
          recoverable: true,
          cause: err
        });
      }
    }
    return this.entriesByRepo;
  }
  list(repoKey) {
    return this.entriesByRepo[repoKey] || [];
  }
  /**
   * 追加一条历史。同一 operationId 只记录一条(重复触发合并时去重)。
   */
  async append(repoKey, entry) {
    const record = {
      id: entry.operationId,
      trigger: entry.trigger || "",
      startedAt: entry.startedAt || "",
      finishedAt: entry.finishedAt || (/* @__PURE__ */ new Date()).toISOString(),
      state: entry.state || "",
      phase: entry.phase || "",
      baseCommit: entry.baseCommit || null,
      expectedRemoteHead: entry.expectedRemoteHead || null,
      result: entry.result || null,
      error: entry.error || null,
      conflictCount: entry.conflictCount || 0
    };
    const list = this.entriesByRepo[repoKey] || (this.entriesByRepo[repoKey] = []);
    const dedupIdx = list.findIndex((e) => e.id === record.id);
    if (dedupIdx >= 0) list.splice(dedupIdx, 1);
    list.push(record);
    while (list.length > HISTORY_LIMIT) list.shift();
    await this._persist();
    return record;
  }
  async _persist() {
    try {
      await this.plugin.saveData(HISTORY_FILE, { entriesByRepo: this.entriesByRepo });
    } catch (err) {
      throw new SyncError({
        category: SyncErrorCategory.LOCAL_FILE,
        code: "HISTORY_SAVE_FAILED",
        operation: "saveHistory",
        message: "同步历史保存失败: " + String(err && err.message || err),
        recoverable: true,
        cause: err
      });
    }
  }
};

// src/storage/local-manifest-store.js
var MANIFEST_FILE = "local-manifest.json";
var LocalManifestStore = class {
  constructor(plugin) {
    this.plugin = plugin;
    this.paths = /* @__PURE__ */ new Set();
    this.savedAt = "";
  }
  async load() {
    try {
      const data = await this.plugin.loadData(MANIFEST_FILE);
      this.paths = new Set(data && data.paths || []);
      this.savedAt = data && data.savedAt || "";
    } catch (err) {
      console.warn("[SY-GSP] 本地清单加载失败(删除判定将进入安全模式):", err && err.message);
      this.paths = /* @__PURE__ */ new Set();
    }
    return this;
  }
  has(path) {
    return this.paths.has(String(path));
  }
  get size() {
    return this.paths.size;
  }
  /** 用最新扫描结果整体替换 */
  async replaceAll(paths) {
    this.paths = new Set((paths || []).map((p) => String(p)));
    this.savedAt = (/* @__PURE__ */ new Date()).toISOString();
    await this.plugin.saveData(MANIFEST_FILE, { paths: [...this.paths], savedAt: this.savedAt });
  }
  /** 清空(仓库/分支切换、用户重置时) */
  async clear() {
    this.paths = /* @__PURE__ */ new Set();
    this.savedAt = (/* @__PURE__ */ new Date()).toISOString();
    await this.plugin.saveData(MANIFEST_FILE, { paths: [], savedAt: this.savedAt });
  }
};

// src/storage/migration.js
var LEGACY_STORAGE_DIR = "data/storage/petal/SGSP";
var LEGACY_FILES = {
  platform: "plugin_config_platform.json",
  github: "plugin_config_git_sync_github.json",
  gitee: "plugin_config_git_sync_gitee.json"
};
var MIGRATABLE_KEYS = [
  "upload_platform",
  "upload_sub_platform",
  "repository_address",
  "repository_branch",
  "submit_token",
  "submit_user_email",
  "ignore_file",
  "asset_prefix",
  "enabled_sync",
  "sync_conflict_file",
  "sync_range",
  "sync_strategy",
  "sync_file_type",
  "sync_mode",
  "sync_interval"
];
var Migration = class {
  /**
   * @param {object} kernel 内核 API
   * @param {object} settings SettingsPanel 实例(set/setAndSave/get)
   * @param {object} metadataStore SyncMetadataStore
   */
  constructor(kernel, settings, metadataStore) {
    this.kernel = kernel;
    this.settings = settings;
    this.metadataStore = metadataStore;
  }
  async _readLegacyJson(name) {
    const path = LEGACY_STORAGE_DIR + "/" + name;
    const blob = await this.kernel.getFile(path);
    if (!blob) return null;
    const text = await blob.text();
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error("旧版配置解析失败(" + name + "): " + String(err && err.message || err));
    }
  }
  /**
   * 执行迁移。返回报告 {migratedKeys, repoKey, legacyHint, errors[]}。
   * 不触发任何远端写入;成功后仍要求用户走只读诊断 + 首次写入预览。
   */
  async migrate({ provider, owner, repo, branch }) {
    const report = { migratedKeys: [], repoKey: "", legacyHint: null, errors: [] };
    const platformCfg = {};
    const gitCfg = {};
    let platformFound = false;
    let gitFound = false;
    try {
      const raw = await this._readLegacyJson(LEGACY_FILES.platform);
      if (raw && typeof raw === "object") {
        Object.assign(platformCfg, raw);
        platformFound = true;
      }
    } catch (err) {
      report.errors.push(String(err.message || err));
    }
    try {
      const fileName = provider === "gitee" ? LEGACY_FILES.gitee : LEGACY_FILES.github;
      const raw = await this._readLegacyJson(fileName);
      if (raw && typeof raw === "object") {
        Object.assign(gitCfg, raw);
        gitFound = true;
      }
    } catch (err) {
      report.errors.push(String(err.message || err));
    }
    if (!platformFound && !gitFound) return report;
    platformCfg.upload_platform = 0;
    platformCfg.upload_sub_platform = provider === "gitee" ? 1 : 0;
    for (const [cfg, prefix] of [
      [platformCfg, "platform."],
      [gitCfg, "git."]
    ]) {
      for (const key of Object.keys(cfg)) {
        const value = cfg[key];
        if (value === void 0 || value === null) continue;
        if (typeof value !== "number" && !MIGRATABLE_KEYS.includes(key)) continue;
        try {
          await this.settings.setAndSave(key, value);
          report.migratedKeys.push(prefix + key);
        } catch (err) {
          report.errors.push("迁移 " + prefix + key + " 失败: " + String(err && err.message || err));
        }
      }
    }
    if (gitCfg.latest_commit_sha) {
      report.legacyHint = {
        sha: String(gitCfg.latest_commit_sha),
        time: String(gitCfg.latest_commit_time || "")
      };
      try {
        const repoKey = this.metadataStore.constructor.keyOf({ provider, owner, repo, branch });
        await this.metadataStore.setLegacyHint(repoKey, report.legacyHint);
      } catch (err) {
        report.errors.push("记录旧基准线索失败: " + String(err && err.message || err));
      }
    }
    return report;
  }
};

// src/util/event-bus.js
function createEventBus() {
  const handlers = {};
  return {
    on(name, fn) {
      if (!handlers[name]) handlers[name] = [];
      handlers[name].push(fn);
      return this;
    },
    off(name, fn) {
      const list = handlers[name];
      if (list) {
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i] === fn) list.splice(i, 1);
        }
      }
      return this;
    },
    emit(name, payload) {
      const list = handlers[name] || [];
      for (let i = 0; i < list.length; i++) {
        try {
          list[i](payload);
        } catch (e) {
        }
      }
      return this;
    }
  };
}

// src/plugin/repo-address.js
function parseRepoAddress(addr) {
  const cleaned = String(addr == null ? "" : addr).trim().replace(/\.git$/, "");
  const patterns = [
    /^(?:https?:\/\/|git:\/\/)?([^/:]+)\/([^/]+)\/([^/]+)$/,
    /^git@([^:]+):([^/]+)\/(.+)$/
  ];
  for (const re of patterns) {
    const m = re.exec(cleaned);
    if (m) {
      return { host: m[1], owner: m[2], repo: m[3].replace(/\.git$/, "") };
    }
  }
  return { host: "", owner: "", repo: "" };
}

// src/ui/settings-panel.js
var PLATFORM_CONFIG_FILES = {
  github: "plugin_config_git_sync_github",
  gitee: "plugin_config_git_sync_gitee"
};
var SETTING_DEFAULTS = Object.freeze({
  upload_platform: 0,
  upload_sub_platform: 0,
  repository_address: "",
  repository_branch: "",
  submit_token: "",
  submit_user_email: "",
  ignore_file: "",
  asset_prefix: "",
  enabled_sync: true,
  sync_conflict_file: true,
  sync_range: 0,
  sync_strategy: 0,
  sync_file_type: 0,
  sync_mode: 0,
  sync_interval: 6e5,
  // SY-GSP 新增
  sygsp_auto_retry: false,
  sygsp_success_notify: true,
  sygsp_blob_request_limit: 33554432
  // 32MB
});
var PER_PLATFORM_KEYS = Object.freeze([
  "repository_address",
  "repository_branch",
  "submit_token",
  "submit_user_email"
]);
var SettingUtils = class {
  /**
   * @param {object} opts {plugin, name, width, height, confirmCallback, destroyCallback}
   */
  constructor(opts) {
    this.plugin = opts.plugin;
    this.name = opts.name || "settings";
    this.file = this.name.endsWith(".json") ? this.name : this.name + ".json";
    this.settings = /* @__PURE__ */ new Map();
    this.elements = /* @__PURE__ */ new Map();
    const q2 = opts.q;
    this.plugin.setting = new q2.Setting({
      width: opts.width,
      height: opts.height,
      confirmCallback: () => {
        for (const key of this.settings.keys()) this.updateValueFromElement(key);
        this.save();
        if (opts.confirmCallback) opts.confirmCallback(this.dump());
      },
      destroyCallback: () => {
        if (opts.destroyCallback) opts.destroyCallback();
        for (const key of this.settings.keys()) this.updateElementFromValue(key);
      }
    });
  }
  async load() {
    const data = await this.plugin.loadData(this.file);
    if (data) {
      for (const [key, item] of this.settings) {
        if (data[key] !== void 0 && data[key] !== null) item.value = data[key];
      }
    }
    return data || null;
  }
  async save(value) {
    return this.plugin.saveData(this.file, value || this.dump());
  }
  get(key) {
    const item = this.settings.get(key);
    return item ? item.value : void 0;
  }
  set(key, value) {
    const item = this.settings.get(key);
    if (item) {
      item.value = value;
      this.updateElementFromValue(key);
    }
  }
  async setAndSave(key, value) {
    this.set(key, value);
    await this.save();
  }
  take(key) {
    const item = this.settings.get(key);
    return item ? item.value : void 0;
  }
  disable(key) {
    const el = this.elements.get(key);
    if (el) el.disabled = true;
  }
  enable(key) {
    const el = this.elements.get(key);
    if (el) el.disabled = false;
  }
  dump() {
    const data = {};
    for (const [key, item] of this.settings) {
      if (item.type !== "button") data[key] = item.value;
    }
    return data;
  }
  /** 声明一个设置项并挂到思源 Setting 面板 */
  addItem(item) {
    this.settings.set(item.key, item);
    const element = this.createElement(item);
    this.elements.set(item.key, element);
    this.plugin.setting.addItem({
      title: item.title,
      description: item.description,
      direction: item.direction || "rows",
      createActionElement: () => element
    });
    return element;
  }
  updateValueFromElement(key) {
    const item = this.settings.get(key);
    const el = this.elements.get(key);
    if (!item || !el) return;
    if (item.type === "checkbox") item.value = el.checked;
    else if (item.type === "slider") item.value = Number(el.value);
    else if (item.type === "number") item.value = Number(el.value);
    else if (item.type !== "button" && item.type !== "hint") item.value = el.value;
  }
  updateElementFromValue(key) {
    const item = this.settings.get(key);
    const el = this.elements.get(key);
    if (!item || !el) return;
    if (item.type === "checkbox") el.checked = !!item.value;
    else if (item.type === "select") el.value = String(item.value);
    else if (item.type !== "button" && item.type !== "hint") el.value = item.value === void 0 || item.value === null ? "" : String(item.value);
  }
  createElement(item) {
    let el;
    switch (item.type) {
      case "select": {
        el = document.createElement("select");
        el.className = "b3-select fn__flex-center fn__size200";
        for (const [value, label] of Object.entries(item.options || {})) {
          const opt = document.createElement("option");
          opt.value = value;
          opt.textContent = label;
          el.appendChild(opt);
        }
        el.value = String(item.value);
        break;
      }
      case "checkbox": {
        el = document.createElement("input");
        el.type = "checkbox";
        el.className = "b3-switch fn__flex-center";
        el.checked = !!item.value;
        break;
      }
      case "slider": {
        el = document.createElement("input");
        el.className = "b3-slider fn__flex-center fn__size200";
        el.type = "range";
        el.min = item.min;
        el.max = item.max;
        el.step = item.step || 1;
        el.value = item.value;
        break;
      }
      case "number": {
        el = document.createElement("input");
        el.className = "b3-text-field fn__flex-center fn__size200";
        el.type = "number";
        el.value = item.value;
        break;
      }
      case "textarea": {
        el = document.createElement("textarea");
        el.className = "b3-text-field fn__block";
        el.value = item.value === void 0 || item.value === null ? "" : String(item.value);
        if (item.placeholder) el.placeholder = item.placeholder;
        break;
      }
      case "hint": {
        el = document.createElement("div");
        el.className = "b3-label__text";
        el.textContent = item.value || "";
        break;
      }
      case "button": {
        el = document.createElement("button");
        el.className = "b3-button b3-button--outline";
        el.textContent = item.title || "";
        if (item.action && item.action.callback) el.addEventListener("click", item.action.callback);
        break;
      }
      default: {
        el = document.createElement("input");
        el.className = "b3-text-field fn__flex-center fn__size200";
        el.type = "text";
        el.value = item.value === void 0 || item.value === null ? "" : String(item.value);
        if (item.placeholder) el.placeholder = item.placeholder;
        break;
      }
    }
    if (item.action && item.action.callback && item.type !== "button") {
      el.addEventListener("change", () => {
        this.updateValueFromElement(item.key);
        item.action.callback();
      });
    }
    return el;
  }
};

// src/ui/settings-builder.js
var SettingsPanelBuilder = class {
  /**
   * @param {object} deps {plugin, q, i18n, onPlatformChanged(platform), onRepoFieldChanged(), metadataStore}
   */
  constructor(deps) {
    this.plugin = deps.plugin;
    this.q = deps.q;
    this.i18n = deps.i18n;
    this.onPlatformChanged = deps.onPlatformChanged;
    this.onRepoFieldChanged = deps.onRepoFieldChanged;
    this.metadataStore = deps.metadataStore;
  }
  currentPlatform() {
    return this.utils && Number(this.utils.get("upload_sub_platform")) === 1 ? "gitee" : "github";
  }
  async build() {
    const t = this.i18n;
    this.utils = new SettingUtils({
      plugin: this.plugin,
      q: this.q,
      name: "settings",
      confirmCallback: () => {
        if (this.onRepoFieldChanged) this.onRepoFieldChanged();
      }
    });
    this._registerItems(t);
    await this.utils.load();
    const platform = this.currentPlatform();
    const platformFile = PLATFORM_CONFIG_FILES[platform] + ".json";
    const saved = await this.plugin.loadData(platformFile);
    for (const key of PER_PLATFORM_KEYS) {
      if (saved && saved[key] !== void 0 && saved[key] !== null) this.utils.set(key, saved[key]);
    }
    this._platformFile = platformFile;
    this._refreshBaseHints();
    return this.utils;
  }
  _registerItems(t) {
    const u = this.utils;
    const val = (key) => {
      const current = u.get(key);
      return current === void 0 ? SETTING_DEFAULTS[key] : current;
    };
    u.addItem({
      key: "upload_platform",
      type: "select",
      value: val("upload_platform"),
      title: t.platformType,
      description: t.platformTypeDesc,
      options: { 0: t.platform && t.platform.git || "Git 仓库" },
      action: { callback: () => {
      } }
    });
    u.addItem({
      key: "upload_sub_platform",
      type: "select",
      value: val("upload_sub_platform"),
      title: t.subGitPlatformType,
      description: t.subGitplatformTypeDesc,
      options: {
        0: t.platform && t.platform.subPlatform && t.platform.subPlatform.git.githubAPI || "GitHub API",
        1: t.platform && t.platform.subPlatform && t.platform.subPlatform.git.giteeAPI || "Gitee API"
      },
      action: {
        callback: async () => {
          const next = Number(u.take("upload_sub_platform"));
          await this._savePlatformFile();
          const nextFile = PLATFORM_CONFIG_FILES[next === 1 ? "gitee" : "github"] + ".json";
          const data = await this.plugin.loadData(nextFile) || {};
          for (const key of PER_PLATFORM_KEYS) u.set(key, data[key] !== void 0 ? data[key] : "");
          this._platformFile = nextFile;
          await this.utils.save();
          if (this.onPlatformChanged) await this.onPlatformChanged();
        }
      }
    });
    u.addItem({
      key: "repository_address",
      type: "textinput",
      value: val("repository_address"),
      title: t.gitRepoAddress,
      placeholder: t.gitRepoAddressPlaceHolder,
      description: t.gitRepoAddressDesc,
      action: { callback: () => this._confirmResetBase() }
    });
    u.addItem({
      key: "repository_branch",
      type: "textinput",
      value: val("repository_branch"),
      title: t.gitRepoBranch,
      placeholder: t.gitRepoBranchPlaceHolder,
      description: t.gitRepoBranchDesc,
      action: { callback: () => this._confirmResetBase() }
    });
    u.addItem({
      key: "submit_token",
      type: "textinput",
      value: val("submit_token"),
      title: t.gitTokenORkey,
      description: t.gitTokenORkeyDesc
    });
    u.addItem({
      key: "submit_user_email",
      type: "textinput",
      value: val("submit_user_email"),
      title: t.gitUserEmail,
      placeholder: t.gitUserEmailPlaceHolder,
      description: t.gitUserEmailDesc
    });
    u.addItem({
      key: "ignore_file",
      type: "textarea",
      value: val("ignore_file"),
      title: t.ignoreFile,
      placeholder: t.ignoreFilePlaceHolder,
      description: t.ignoreFileDesc
    });
    u.addItem({
      key: "asset_prefix",
      type: "textarea",
      value: val("asset_prefix"),
      title: t.assetPrefix,
      placeholder: t.assetPrefixPlaceHolder,
      description: t.assetPrefixDesc
    });
    u.addItem({
      key: "enabled_sync",
      type: "checkbox",
      value: val("enabled_sync") !== false,
      title: t.enableSync,
      description: t.enableSyncDesc
    });
    u.addItem({
      key: "sync_conflict_file",
      type: "checkbox",
      value: val("sync_conflict_file") !== false,
      title: t.syncGenConflictFile,
      description: t.syncGenConflictFileDesc
    });
    u.addItem({
      key: "sync_range",
      type: "select",
      value: val("sync_range"),
      title: t.syncRange,
      description: t.syncRangeDesc,
      options: { 0: t.workSpace, 1: t.dataFile, 2: t.noteFile }
    });
    u.addItem({
      key: "sync_strategy",
      type: "select",
      value: val("sync_strategy"),
      title: t.syncStrategy,
      description: t.syncStrategyDesc,
      options: { 0: t.autoSyncStrategy, 1: t.selectUpload, 2: t.keepRemoteCover, 3: t.keepLocalCover }
    });
    u.addItem({
      key: "sync_file_type",
      type: "select",
      value: val("sync_file_type"),
      title: t.noteType,
      description: t.noteTypeDesc,
      options: { 0: t.siyuanFile, 1: t.markdownFile }
    });
    u.addItem({
      key: "sync_mode",
      type: "select",
      value: val("sync_mode"),
      title: t.syncMode,
      description: t.syncModeDesc,
      options: { 0: t.autoSync, 1: t.manualSync, 2: t.fullManualSync }
    });
    u.addItem({
      key: "sync_interval",
      type: "number",
      value: val("sync_interval"),
      title: t.syncInterval,
      description: t.syncIntervalDesc
    });
    u.addItem({
      key: "sygsp_auto_retry",
      type: "checkbox",
      value: !!val("sygsp_auto_retry"),
      title: t.sygspAutoRetryTitle || "自动重试(网络类错误)",
      description: t.sygspAutoRetryDesc || "仅对网络超时与远端变化类错误有限重试,其余错误不自动重试"
    });
    u.addItem({
      key: "sygsp_success_notify",
      type: "checkbox",
      value: val("sygsp_success_notify") !== false,
      title: t.sygspSuccessNotifyTitle || "自动同步成功时通知",
      description: t.sygspSuccessNotifyDesc || "关闭后自动同步成功不打扰(手动同步始终提示)"
    });
    u.addItem({
      key: "latest_commit_sha",
      type: "hint",
      value: t.noCommitFile || "暂无提交",
      title: t.latestCommitSha,
      description: t.latestCommitShaDesc,
      direction: "rows"
    });
    u.addItem({
      key: "latest_commit_time",
      type: "hint",
      value: "",
      title: t.latestCommitTime,
      description: t.latestCommitTimeDesc,
      direction: "rows"
    });
  }
  /** 载入完成后刷新基准展示项 */
  _refreshBaseHints() {
    if (!this.utils || !this.metadataStore) return;
    const info = this._parsedRepo();
    const repoKey = this.metadataStore.constructor.keyOf({
      provider: this.currentPlatform(),
      owner: info.owner,
      repo: info.repo,
      branch: this.utils.get("repository_branch") || ""
    });
    const base = repoKey ? this.metadataStore.get(repoKey) : null;
    this.utils.set(
      "latest_commit_sha",
      base && base.lastConfirmedCommit ? base.lastConfirmedCommit : this.i18n.noCommitFile || "暂无提交"
    );
    this.utils.set("latest_commit_time", base && base.lastSuccessfulAt ? base.lastSuccessfulAt : "");
  }
  async _confirmResetBase() {
    const t = this.i18n;
    const q2 = this.q;
    const key = "latest_commit_sha";
    const hasBase = this.metadataStore && Object.keys(this.metadataStore.data.repositories || {}).length > 0;
    if (hasBase && q2 && q2.confirm) {
      q2.confirm(t.confirm_title_info, t.confirm_modifyrepo_reset_commit, async () => {
        if (this.metadataStore) {
          const info = this._parsedRepo();
          const repoKey = this.metadataStore.constructor.keyOf({
            provider: this.currentPlatform(),
            owner: info.owner,
            repo: info.repo,
            branch: this.utils.get("repository_branch") || ""
          });
          await this.metadataStore.clear(repoKey);
        }
      });
    }
  }
  async _savePlatformFile() {
    if (!this._platformFile) return;
    const data = {};
    for (const key of PER_PLATFORM_KEYS) data[key] = this.utils.get(key);
    await this.plugin.saveData(this._platformFile, data);
  }
  /** 持久化当前平台配置(平台切换/关闭设置时调用) */
  async persistPlatformConfig() {
    await this._savePlatformFile();
    await this.utils.save();
  }
  /** 解析仓库地址 → {owner, repo} */
  _parsedRepo() {
    const addr = String(this.utils ? this.utils.get("repository_address") : "");
    return parseRepoAddress(addr);
  }
};

// src/ui/notification-service.js
var NotificationService = class {
  constructor({ q: q2, i18n, stateFile = "notify-state.json" } = {}) {
    this.q = q2;
    this.i18n = i18n;
    this.topBarElement = null;
    this._lastToastText = "";
    this._autoFailNotified = false;
  }
  setTopBarElement(el) {
    this.topBarElement = el;
  }
  /** 基础 toast(带同文案去重) */
  toast(text, type = "info", timeout = 3e3) {
    if (!this.q || typeof this.q.showMessage !== "function") return;
    if (text && text === this._lastToastText) return;
    this._lastToastText = text;
    setTimeout(() => {
      if (text === this._lastToastText) this._lastToastText = "";
    }, timeout + 1e3);
    this.q.showMessage(text, timeout, type);
  }
  /** 手动触发: 开始同步始终可见 */
  syncStarted(trigger) {
    if (trigger === "automatic") return;
    this.toast(this.i18n && this.i18n.gSyncStartMsg || "🔄 开始同步…", "info");
    this._badge("syncing");
  }
  syncSuccess(result, { automatic = false, successNotify = true } = {}) {
    const detail = result ? " (↑" + (result.uploads || 0) + " ↓" + (result.downloads || 0) + " 删远" + (result.deletionsRemote || 0) + " 删本" + (result.deletionsLocal || 0) + ")" : "";
    if (automatic) {
      if (successNotify) this.toast(this.i18n && this.i18n.gSyncSuccessMsg || "✅ 同步成功" + detail, "info");
    } else {
      this.toast(this.i18n && this.i18n.gSyncSuccessMsg || "✅ 同步成功" + detail, "info");
    }
    this._badge("success");
  }
  syncError(syncErr, { automatic = false } = {}) {
    const summary = syncErr && syncErr.toDisplayText ? syncErr.toDisplayText() : String(syncErr && syncErr.message || syncErr);
    if (automatic && this._autoFailNotified && this._lastAutoFailCategory === syncErr.category) {
    } else {
      this._autoFailNotified = automatic || this._autoFailNotified;
      this._lastAutoFailCategory = syncErr.category;
      this.toast("❌ " + summary, "error", 6e3);
    }
    this._badge("error");
  }
  conflictPaused({ kind, conflictCount, reason } = {}) {
    const isBase = kind === "BASE_UNRESOLVED";
    const text = isBase ? this.i18n && this.i18n.sygspBaseUnresolvedMsg || "🔴 同步基准无法确认,自动同步已暂停,请打开插件菜单处理" : this.i18n && this.i18n.gSyncConflictMsg || "🔴 检测到同步冲突,自动同步已暂停";
    this.toast(conflictCount ? text + "(" + conflictCount + " 个文件)" : text, "error", 6e3);
    this._badge("conflict");
  }
  conflictResolved() {
    this.toast(this.i18n && this.i18n.gSyncResolvedMsg || "✅ 冲突已处理,自动同步已恢复", "info");
    this._badge("success");
  }
  pausedAutoSkip() {
    this.toast(this.i18n && this.i18n.gSyncPausedMsg || "⚠️ 同步冲突未解决,自动同步已暂停,请处理冲突", "error");
  }
  _badge(kind) {
    const el = this.topBarElement;
    if (!el || !el.classList) return;
    el.classList.remove("git-syncing", "git-sync-success", "git-sync-failed", "git-sync-conflict-paused");
    if (kind === "syncing") el.classList.add("git-syncing");
    else if (kind === "success") el.classList.add("git-sync-success");
    else if (kind === "error") el.classList.add("git-sync-failed");
    else if (kind === "conflict") el.classList.add("git-sync-conflict-paused");
  }
};

// src/ui/conflict-dialog.js
var ConflictDialog = class {
  /**
   * @param {object} deps {q, i18n, conflictService, onDecide(async decisionsMap), notify}
   */
  constructor(deps) {
    this.q = deps.q;
    this.i18n = deps.i18n;
    this.conflictService = deps.conflictService;
    this.onDecide = deps.onDecide;
    this.notify = deps.notify;
    this.dialog = null;
    this.set = null;
  }
  /** 展示一个冲突集;conflictSet 为 ConflictService.saveSet 返回值 */
  show(conflictSet) {
    const q2 = this.q;
    this.set = conflictSet;
    const t = this.i18n;
    this.dialog = new q2.Dialog({
      title: t && t.gSyncConflictTitle || "⚠️ 检测到同步冲突",
      content: '<div id="sygspConflictDialog" class="fn__flex-column" style="padding:16px;gap:8px;"></div>',
      width: "720px",
      height: "60vh",
      destroyCallback: () => {
        this.dialog = null;
      }
    });
    const root = this.dialog.element.querySelector("#sygspConflictDialog");
    this._render(root, conflictSet);
  }
  close() {
    if (this.dialog) {
      this.dialog.destroy();
      this.dialog = null;
    }
  }
  _render(root, set) {
    const t = this.i18n;
    root.textContent = "";
    const desc = document.createElement("div");
    desc.className = "b3-label__text";
    desc.textContent = t && t.gSyncConflictDesc || "本地与远端的数据同时被修改,自动同步已暂停。请选择处理方式:";
    root.appendChild(desc);
    const count = document.createElement("div");
    count.className = "ft__on-surface";
    count.textContent = t && t.sygspConflictCount || "冲突文件: " + set.conflicts.length;
    root.appendChild(count);
    const list = document.createElement("div");
    list.className = "fn__flex-1";
    list.style.overflow = "auto";
    for (const conflict of set.conflicts) {
      list.appendChild(this._conflictRow(conflict));
    }
    root.appendChild(list);
    root.appendChild(this._actionBar(set));
  }
  _conflictRow(conflict) {
    const t = this.i18n;
    const row = document.createElement("div");
    row.className = "b3-label";
    row.dataset.path = conflict.path;
    const pathLine = document.createElement("div");
    pathLine.className = "fn__flex";
    pathLine.style.alignItems = "center";
    const name = document.createElement("span");
    name.className = "fn__flex-1 ft__breakword";
    name.textContent = conflict.path;
    pathLine.appendChild(name);
    row.appendChild(pathLine);
    const reason = document.createElement("div");
    reason.className = "b3-label__text";
    reason.textContent = conflict.reason || "";
    row.appendChild(reason);
    const buttons = document.createElement("div");
    buttons.className = "fn__flex fn__flex-wrap";
    buttons.style.gap = "8px";
    buttons.appendChild(this._btn(t && t.gSyncKeepLocal || "保留本地版本", () => this._decideOne(conflict.path, "keep_local")));
    buttons.appendChild(this._btn(t && t.gSyncKeepRemote || "保留远端版本", () => this._decideOne(conflict.path, "keep_remote")));
    if (conflict.snapshots && (conflict.snapshots.localB64 || conflict.snapshots.remoteB64)) {
      buttons.appendChild(this._btn(t && t.sygspExportCopies || "导出三方副本", () => this._exportCopies(conflict)));
    }
    row.appendChild(buttons);
    return row;
  }
  _actionBar(set) {
    const t = this.i18n;
    const bar = document.createElement("div");
    bar.className = "fn__flex";
    bar.style.gap = "8px";
    bar.appendChild(this._btn(t && t.sygspKeepAllLocal || "全部保留本地", () => this._decideAll("keep_local"), "b3-button b3-button--text"));
    bar.appendChild(this._btn(t && t.sygspKeepAllRemote || "全部保留远端", () => this._decideAll("keep_remote"), "b3-button b3-button--text"));
    const spacer = document.createElement("div");
    spacer.className = "fn__flex-1";
    bar.appendChild(spacer);
    bar.appendChild(this._btn(t && t.gSyncLater || "稍后处理", () => this.close(), "b3-button b3-button--cancel"));
    return bar;
  }
  _btn(label, onClick, cls = "b3-button b3-button--outline") {
    const btn = document.createElement("button");
    btn.className = cls;
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    return btn;
  }
  async _decideOne(path, decision) {
    await this.conflictService.decide(this.set.operationId, path, decision);
    this.set.conflicts = this.set.conflicts.filter((c) => c.path !== path);
    if (this.dialog && this.dialog.element) {
      const root = this.dialog.element.querySelector("#sygspConflictDialog");
      this._render(root, this.set);
    }
    await this._flushIfAllDecided();
  }
  async _decideAll(decision) {
    for (const conflict of [...this.set.conflicts]) {
      await this.conflictService.decide(this.set.operationId, conflict.path, decision);
    }
    this.set.conflicts = [];
    this.close();
    await this._flushIfAllDecided();
  }
  async _flushIfAllDecided() {
    const overrides = this.conflictService.collectOverrides(this.set.operationId);
    if (overrides.size === 0) return;
    if (this.dialog) this.close();
    try {
      await this.onDecide(overrides);
    } catch (err) {
      const msg = err && (err.message || err.toString()) || String(err);
      this.notify("❌ " + (this.i18n && this.i18n.gSyncResolveFailedMsg || "处理冲突的同步失败,冲突仍待处理") + ": " + msg, "error");
    }
  }
  async _exportCopies(conflict) {
    try {
      const dir = "temp/SY-GSP/conflicts/" + this.set.operationId + "/";
      const stem = conflict.path.replace(/\//g, "_");
      const writes = [];
      if (conflict.snapshots && conflict.snapshots.baseB64) {
        writes.push([dir + stem + ".base", conflict.snapshots.baseB64]);
      }
      if (conflict.snapshots && conflict.snapshots.localB64) {
        writes.push([dir + stem + ".local", conflict.snapshots.localB64]);
      }
      if (conflict.snapshots && conflict.snapshots.remoteB64) {
        writes.push([dir + stem + ".remote", conflict.snapshots.remoteB64]);
      }
      for (const [path, b64] of writes) {
        const bytes = base64ToBytes(b64);
        await this._putFile(path, bytes);
      }
      const t = this.i18n;
      this.notify((t && t.sygspExportCopiesDone || "已导出到") + " " + dir, "info");
    } catch (err) {
      this.notify("❌ " + String(err && err.message || err), "error");
    }
  }
  async _putFile(path, bytes) {
    if (!this._kernel) {
      throw new SyncError({ category: SyncErrorCategory.LOCAL_FILE, message: "内核能力未注入" });
    }
    await this._kernel.putFile(path, new Blob([bytes]), false);
  }
  setKernel(kernel) {
    this._kernel = kernel;
  }
};
function base64ToBytes(b64) {
  const clean = String(b64 || "").replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// src/ui/diagnosis-panel.js
var DiagnosisPanel = class {
  /**
   * @param {object} deps {q, i18n, runChecks: async () => [{name, ok, detail}],
   *   previewPlan: async () => {uploads, downloads, deletionsRemote, deletionsLocal, conflicts, skippedDeletes},
   *   onChooseBase: async ("keep_local"|"keep_remote") => void,
   *   onFirstWriteConfirmed: async () => void,
   *   notify}
   */
  constructor(deps) {
    this.q = deps.q;
    this.i18n = deps.i18n;
    this.runChecks = deps.runChecks;
    this.previewPlan = deps.previewPlan;
    this.onChooseBase = deps.onChooseBase;
    this.onFirstWriteConfirmed = deps.onFirstWriteConfirmed;
    this.notify = deps.notify;
    this.dialog = null;
  }
  show({ mode = "diagnosis" } = {}) {
    const q2 = this.q;
    const t = this.i18n;
    this.dialog = new q2.Dialog({
      title: t && t.sygspDiagnosisTitle || "SY-GSP 只读诊断",
      content: '<div id="sygspDiagnosis" class="fn__flex-column" style="padding:16px;gap:8px;"></div>',
      width: "640px",
      height: "70vh",
      destroyCallback: () => {
        this.dialog = null;
      }
    });
    const root = this.dialog.element.querySelector("#sygspDiagnosis");
    this._renderLoading(root);
    this._run(mode, root);
  }
  close() {
    if (this.dialog) {
      this.dialog.destroy();
      this.dialog = null;
    }
  }
  async _run(mode, root) {
    const checks = await this._safe(this.runChecks);
    this._render(root, mode, checks);
  }
  async _safe(fn) {
    try {
      return await fn() || [];
    } catch (err) {
      return [{ name: "诊断执行失败", ok: false, detail: String(err && err.message || err) }];
    }
  }
  _renderLoading(root) {
    root.textContent = "";
    const loading = document.createElement("div");
    loading.className = "fn__loading";
    loading.innerHTML = '<img width="64px" src="/stage/loading-pure.svg"/>';
    root.appendChild(loading);
  }
  async _render(root, mode, checks) {
    const t = this.i18n;
    root.textContent = "";
    const title = document.createElement("div");
    title.className = "b3-label";
    title.textContent = t && t.sygspDiagnosisDesc || "以下检查均为只读操作,不会修改本地或远端数据";
    root.appendChild(title);
    for (const check of checks) {
      const row = document.createElement("div");
      row.className = "b3-label";
      const line = document.createElement("div");
      line.className = "fn__flex";
      const icon = document.createElement("span");
      icon.textContent = check.ok ? "✅" : "❌";
      icon.style.marginRight = "6px";
      const name = document.createElement("span");
      name.textContent = check.name;
      line.appendChild(icon);
      line.appendChild(name);
      row.appendChild(line);
      if (check.detail) {
        const detail = document.createElement("div");
        detail.className = "b3-label__text ft__breakword";
        detail.textContent = check.detail;
        row.appendChild(detail);
      }
      root.appendChild(row);
    }
    if (mode === "base_recovery") {
      root.appendChild(this._baseRecoveryActions());
    } else if (mode === "first_sync") {
      root.appendChild(await this._firstSyncPreview());
    }
  }
  _baseRecoveryActions() {
    const t = this.i18n;
    const bar = document.createElement("div");
    bar.className = "fn__flex";
    bar.style.gap = "8px";
    const warn = document.createElement("div");
    warn.className = "b3-label__text fn__flex-1";
    warn.textContent = t && t.sygspBaseRecoveryWarn || "本地与远端无法证明共同基准。选择一侧为准后执行一次覆盖同步(被覆盖侧的冲突副本会导出备份):";
    bar.appendChild(warn);
    bar.appendChild(this._btn(t && t.sygspChooseRemote || "以下载远端为准", () => this._choose("keep_remote")));
    bar.appendChild(this._btn(t && t.sygspChooseLocal || "以上传本地为准", () => this._choose("keep_local")));
    bar.appendChild(this._btn(t && t.cancel || "取消", () => this.close(), "b3-button b3-button--cancel"));
    return bar;
  }
  async _firstSyncPreview() {
    const t = this.i18n;
    const box = document.createElement("div");
    box.className = "b3-label fn__flex-column";
    box.style.gap = "6px";
    const title = document.createElement("div");
    title.textContent = t && t.sygspPreviewTitle || "首次写入前的同步计划预览:";
    box.appendChild(title);
    const preview = await this._safe(this.previewPlan);
    for (const item of preview) {
      const line = document.createElement("div");
      line.className = "b3-label__text";
      line.textContent = item.name + ": " + item.detail;
      box.appendChild(line);
    }
    const actions = document.createElement("div");
    actions.className = "fn__flex";
    actions.style.gap = "8px";
    const confirm = this._btn(t && t.sygspConfirmFirstWrite || "确认并开始首次同步", async () => {
      try {
        await this.onFirstWriteConfirmed();
        this.notify(t && t.sygspFirstWriteConfirmed || "✅ 已确认,开始执行首次同步", "info");
        this.close();
      } catch (err) {
        this.notify("❌ " + String(err && err.message || err), "error");
      }
    }, "b3-button b3-button--text");
    actions.appendChild(confirm);
    actions.appendChild(this._btn(t && t.cancel || "取消", () => this.close(), "b3-button b3-button--cancel"));
    box.appendChild(actions);
    return box;
  }
  _choose(choice) {
    this.close();
    Promise.resolve(this.onChooseBase(choice)).catch((err) => {
      this.notify("❌ " + String(err && err.message || err), "error");
    });
  }
  _btn(label, onClick, cls = "b3-button b3-button--outline") {
    const btn = document.createElement("button");
    btn.className = cls;
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    return btn;
  }
};

// src/ui/runtime-logs.js
var RuntimeLogs = class {
  constructor(limit = 200) {
    this.limit = limit;
    this.entries = [];
  }
  append(level, text) {
    this.entries.push({
      at: (/* @__PURE__ */ new Date()).toISOString(),
      level,
      text: String(text).slice(0, 1e3)
    });
    while (this.entries.length > this.limit) this.entries.shift();
  }
  info(text) {
    this.append("info", text);
  }
  error(text) {
    this.append("error", text);
  }
  render() {
    return this.entries.map((e) => "[" + e.at.replace("T", " ").slice(0, 19) + "] [" + e.level + "] " + e.text).join("\n");
  }
};
function openLogsDialog({ q: q2, i18n, logs }) {
  const dialog = new q2.Dialog({
    title: i18n && i18n.gSyncRuntimeLogsTitle || "SY-GSP 运行日志",
    content: '<div style="padding:12px;display:flex;height:100%;"></div>',
    width: "720px",
    height: "60vh"
  });
  const root = dialog.element.firstElementChild;
  const textarea = document.createElement("textarea");
  textarea.className = "b3-text-field fn__flex-1";
  textarea.readOnly = true;
  textarea.style.fontFamily = "monospace";
  textarea.value = logs.render() || "暂无日志";
  root.appendChild(textarea);
}

// src/ui/sync-history-panel.js
var _SyncHistoryPanel = class _SyncHistoryPanel {
  constructor(opts) {
    this._opts = opts;
    this._i18n = opts.i18n || {};
    this._provider = opts.provider || {};
    this._abort = new AbortController();
    this._destroyed = false;
    this._commits = [];
    this._page = 0;
    this._hasMore = true;
    this._startRef = "";
    this._dataSource = "0";
    this._selectedSha = "";
    this._loadingCommits = false;
    this._commitsSeq = 0;
    this._filesSeq = 0;
    this._loadingCount = /* @__PURE__ */ new Map();
    this._loadingOverlays = /* @__PURE__ */ new Map();
    this._placeholders = /* @__PURE__ */ new WeakMap();
    this._buildDom();
    this._bindEvents();
    this._init();
  }
  /** 释放：取消全部事件监听（AbortController signal），移除残留遮罩 */
  destroy() {
    this._destroyed = true;
    if (this._abort) this._abort.abort();
    for (const o of this._loadingOverlays.values()) o.remove();
    this._loadingOverlays.clear();
    this._loadingCount.clear();
  }
  // ─────────── 初始化 ───────────
  async _init() {
    if (this._destroyed) return;
    this._setPlaceholder(this._filesEl, this._i18n.selectCommitHint);
    this._showLoading(this._rootEl);
    try {
      await this._fillNotebooks();
    } catch (err) {
      this._notifyFail(err, this._i18n.loadFailed);
    } finally {
      this._hideLoading(this._rootEl);
    }
    await this._reloadCommits();
  }
  /** 笔记本下拉：首项 value="" 全部，其余 value=data/<id> */
  async _fillNotebooks() {
    const list = await this._opts.listNotebooks();
    const notebooks = Array.isArray(list) ? list : [];
    this._notebookSelect.textContent = "";
    const all = this._option("", this._i18n.allNotebookName);
    all.title = this._i18n.allNotebooks;
    this._notebookSelect.appendChild(all);
    for (const nb of notebooks) {
      if (!nb || !nb.id) continue;
      this._notebookSelect.appendChild(this._option("data/" + nb.id, nb.name || nb.id));
    }
  }
  // ─────────── DOM 骨架 ───────────
  _buildDom() {
    const i18n = this._i18n;
    const root = this._el("div", "history__root fn__flex fn__flex-column", "height:100%;min-height:0;box-sizing:border-box");
    const toolbar = this._el("div", "history__toolbar fn__flex fn__space", "padding:8px;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--b3-theme-background-light)");
    const sourceSelect = this._el("select", "b3-select history__source");
    sourceSelect.appendChild(this._option("0", i18n.dataSourceLocal));
    sourceSelect.appendChild(this._option("1", i18n.dataSourceRemote));
    const countEl = this._el("span", "history__count ft__on-surface ft__smaller", "", i18n.totalPrefix + " 0 " + i18n.totalSuffix);
    const localInfo = this._el("span", "history__local ft__on-surface ft__smaller");
    const sha = this._opts.localCommitSha || "";
    localInfo.textContent = i18n.localCommitLabel + ": " + (sha ? sha.slice(0, 8) : "-");
    if (this._opts.localCommitTime) localInfo.title = this._opts.localCommitTime;
    const notebookSelect = this._el("select", "b3-select history__notebook");
    const pathInput = this._el("input", "b3-text-field history__path", "width:160px");
    pathInput.type = "text";
    pathInput.placeholder = i18n.fileSearchPlaceholder;
    const sinceLabel = this._el("span", "ft__on-surface ft__smaller", "", i18n.startTime);
    const sinceInput = this._el("input", "b3-text-field history__since", "width:150px");
    sinceInput.type = "datetime-local";
    const untilLabel = this._el("span", "ft__on-surface ft__smaller", "", i18n.endTime);
    const untilInput = this._el("input", "b3-text-field history__until", "width:150px");
    untilInput.type = "datetime-local";
    const searchBtn = this._el("button", "b3-button b3-button--outline history__search", "", i18n.search);
    searchBtn.type = "button";
    toolbar.append(
      sourceSelect,
      countEl,
      localInfo,
      notebookSelect,
      pathInput,
      sinceLabel,
      sinceInput,
      untilLabel,
      untilInput,
      searchBtn
    );
    const body = this._el("div", "history__body fn__flex fn__flex-1", "min-height:0");
    const commitsEl = this._el(
      "div",
      "history__commits b3-list b3-list--background",
      "flex:0 0 320px;width:320px;overflow-y:auto;position:relative;margin:0;border-right:1px solid var(--b3-theme-background-light)"
    );
    const right = this._el("div", "history__right fn__flex fn__flex-column", "flex:1;min-width:0;min-height:0");
    const filesEl = this._el(
      "div",
      "history__files b3-list",
      "flex:0 0 auto;max-height:40%;overflow-y:auto;min-height:0;position:relative;padding:2px 0;margin:0;border-bottom:1px solid var(--b3-theme-background-light)"
    );
    const diffEl = this._el("div", "history__diff fn__flex", "flex:1;min-height:0;position:relative");
    const leftCol = this._buildDiffCol(i18n.commitVersion, true);
    const rightCol = this._buildDiffCol(i18n.localVersion, false);
    diffEl.append(leftCol.el, rightCol.el);
    right.append(filesEl, diffEl);
    body.append(commitsEl, right);
    root.append(toolbar, body);
    [this._rootEl, this._sourceSelect, this._countEl, this._notebookSelect, this._pathInput] = [root, sourceSelect, countEl, notebookSelect, pathInput];
    [this._sinceInput, this._untilInput, this._searchBtn, this._commitsEl, this._filesEl, this._diffEl] = [sinceInput, untilInput, searchBtn, commitsEl, filesEl, diffEl];
    [this._leftTitle, this._rightTitle, this._leftTextarea, this._rightTextarea] = [leftCol.title, rightCol.title, leftCol.textarea, rightCol.textarea];
    this._opts.container.appendChild(root);
  }
  /** 创建元素：tag + 可选 class + 可选内联样式 + 可选文本 */
  _el(tag, cls, css, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (css) e.style.cssText = css;
    if (text !== void 0) e.textContent = text;
    return e;
  }
  /** 对比列：上方小标题 + 下方只读 textarea */
  _buildDiffCol(titleText, withBorder) {
    const col = this._el(
      "div",
      "history__col fn__flex fn__flex-column",
      "flex:1;min-width:0;min-height:0" + (withBorder ? ";border-right:1px solid var(--b3-theme-background-light)" : "")
    );
    const title = this._el(
      "div",
      "history__col-title",
      "padding:6px 8px;font-size:12px;color:var(--b3-theme-on-surface);border-bottom:1px solid var(--b3-theme-background-light);white-space:nowrap;overflow:hidden;text-overflow:ellipsis",
      titleText
    );
    const textarea = this._el(
      "textarea",
      "history__text fn__flex-1",
      "width:100%;min-height:0;resize:none;border:none;outline:none;padding:8px;box-sizing:border-box;font-family:var(--b3-font-family-code,monospace);font-size:12px;line-height:1.5;color:var(--b3-theme-on-background);background:transparent"
    );
    textarea.readOnly = true;
    textarea.spellcheck = false;
    col.append(title, textarea);
    return { el: col, title, textarea };
  }
  // ─────────── 事件绑定 ───────────
  _bindEvents() {
    const signal = this._abort.signal;
    for (const [el, type] of [[this._sourceSelect, "change"], [this._notebookSelect, "change"], [this._searchBtn, "click"]]) {
      el.addEventListener(type, () => this._reloadCommits(), { signal });
    }
    this._pathInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this._reloadCommits();
    }, { signal });
    this._commitsEl.addEventListener("click", (e) => {
      const item = e.target.closest(".history__commit");
      if (item && item.dataset.sha) this._selectCommit(item.dataset.sha);
    }, { signal });
    this._commitsEl.addEventListener("scroll", () => {
      if (this._commitsEl.scrollTop + this._commitsEl.clientHeight >= this._commitsEl.scrollHeight - 24) this._loadCommitsPage();
    }, { signal });
    this._filesEl.addEventListener("click", (e) => {
      const nameEl = e.target.closest(".history__filename");
      if (nameEl && nameEl.dataset.path) {
        this._loadDiff(nameEl.dataset.path);
        return;
      }
      const rb = e.target.closest(".history__btn--rollback");
      if (rb && rb.dataset.path) {
        this._runFileAction("rollback", rb.dataset.path);
        return;
      }
      const dl = e.target.closest(".history__btn--download");
      if (dl && dl.dataset.path) {
        this._runFileAction("download", dl.dataset.path);
        return;
      }
    }, { signal });
  }
  // ─────────── 提交列表 ───────────
  /** 按当前筛选条件重置列表并从第一页重新加载 */
  async _reloadCommits() {
    if (this._destroyed) return;
    this._commitsSeq += 1;
    this._filesSeq += 1;
    if (this._dataSource === "0" && !this._opts.localCommitSha) {
      this._dataSource = "1";
      this._sourceSelect.value = "1";
      this._opts.notify(this._i18n.noLocalCommit, "info");
    }
    this._startRef = this._dataSource === "0" ? this._opts.localCommitSha : this._opts.branchName;
    this._commits = [];
    this._page = 0;
    this._hasMore = Boolean(this._startRef);
    this._selectedSha = "";
    this._commitsEl.scrollTop = 0;
    this._countEl.textContent = this._i18n.totalPrefix + " 0 " + this._i18n.totalSuffix;
    this._removePlaceholder(this._commitsEl);
    this._commitsEl.textContent = "";
    this._clearDiff();
    this._renderFiles(null, this._i18n.selectCommitHint);
    if (!this._startRef) {
      this._setPlaceholder(this._commitsEl, this._i18n.emptyCommits);
      return;
    }
    await this._loadCommitsPage();
  }
  /** 加载下一页并追加；返回条数不足 perPage 时停止翻页 */
  async _loadCommitsPage() {
    if (this._destroyed || this._loadingCommits || !this._hasMore) return;
    const seq = this._commitsSeq;
    this._loadingCommits = true;
    const el = this._commitsEl;
    this._showLoading(el);
    try {
      const query = { sha: this._startRef, perPage: _SyncHistoryPanel.PER_PAGE, page: this._page };
      const path = this._queryPath();
      if (path) query.path = path;
      const since = this._sinceInput.value ? new Date(this._sinceInput.value).toISOString() : "";
      if (since) query.since = since;
      const until = this._untilInput.value ? new Date(this._untilInput.value).toISOString() : "";
      if (until) query.until = until;
      const list = await this._provider.listCommits(query);
      if (this._destroyed || seq !== this._commitsSeq) return;
      const items = Array.isArray(list) ? list : [];
      this._appendCommits(items);
      this._hasMore = items.length >= _SyncHistoryPanel.PER_PAGE;
      this._page += 1;
    } catch (err) {
      if (this._destroyed || seq !== this._commitsSeq) return;
      this._hasMore = false;
      this._notifyFail(err, this._i18n.loadFailed);
    } finally {
      this._loadingCommits = false;
      if (!this._destroyed) this._hideLoading(el);
    }
  }
  /** 去重追加提交（含 DOM 渲染与计数更新） */
  _appendCommits(list) {
    const seen = new Set(this._commits.map((c) => c.sha));
    const frag = document.createDocumentFragment();
    for (const c of list) {
      if (!c || !c.sha || seen.has(c.sha)) continue;
      seen.add(c.sha);
      this._commits.push(c);
      frag.appendChild(this._createCommitItem(c));
    }
    this._countEl.textContent = this._i18n.totalPrefix + " " + this._commits.length + " " + this._i18n.totalSuffix;
    if (this._commits.length === 0) {
      this._setPlaceholder(this._commitsEl, this._i18n.emptyCommits);
      return;
    }
    this._removePlaceholder(this._commitsEl);
    this._commitsEl.appendChild(frag);
  }
  /** 列表项：第一行提交信息首行，第二行小字灰色=作者+本地时间 */
  _createCommitItem(commit) {
    const item = this._el("div", "b3-list-item history__commit", "cursor:pointer;display:flex;align-items:center");
    item.dataset.sha = commit.sha;
    item.title = commit.message || commit.sha;
    const wrap = this._el("div", "fn__flex fn__flex-column fn__flex-1", "min-width:0");
    const title = this._el(
      "div",
      "history__commit-title",
      "overflow:hidden;text-overflow:ellipsis;white-space:nowrap",
      (commit.message || "").split("\n")[0] || commit.sha
    );
    const date = commit.date ? new Date(commit.date) : null;
    const time = date && !isNaN(date.getTime()) ? date.toLocaleString() : "";
    const meta = this._el(
      "div",
      "history__commit-meta ft__on-surface ft__smaller",
      "overflow:hidden;text-overflow:ellipsis;white-space:nowrap",
      [commit.author, time].filter(Boolean).join(" · ")
    );
    wrap.append(title, meta);
    item.appendChild(wrap);
    if (commit.sha === this._selectedSha) this._setHighlight(item, true);
    return item;
  }
  /** 选中提交：高亮 + 加载文件列表 + 清空对比区 */
  _selectCommit(sha) {
    if (!sha || sha === this._selectedSha) return;
    this._selectedSha = sha;
    for (const item of this._commitsEl.querySelectorAll(".history__commit")) {
      this._setHighlight(item, item.dataset.sha === sha);
    }
    const commit = this._commits.find((c) => c.sha === sha);
    this._clearDiff();
    if (commit) this._loadFiles(commit);
  }
  /** 高亮切换（内联背景兜底：宿主未定义该 class 时也有选中反馈） */
  _setHighlight(item, on) {
    item.classList.toggle("b3-list-item--focus", on);
    item.style.backgroundColor = on ? "var(--b3-theme-primary-light)" : "";
  }
  // ─────────── 文件列表 ───────────
  /** 加载选中提交的变更文件（基准=本机上次提交，无则退化为其父提交） */
  async _loadFiles(commit) {
    if (this._destroyed) return;
    const seq = ++this._filesSeq;
    const el = this._filesEl;
    this._showLoading(el);
    try {
      const base = this._opts.localCommitSha || (commit.parents && commit.parents[0] || "");
      const files = await this._provider.compareCommits(base, commit.sha);
      if (this._destroyed || seq !== this._filesSeq) return;
      this._renderFiles(Array.isArray(files) ? files : []);
    } catch (err) {
      if (this._destroyed || seq !== this._filesSeq) return;
      this._renderFiles(null, this._i18n.loadFailed);
      this._notifyFail(err, this._i18n.loadFailed);
    } finally {
      if (!this._destroyed) this._hideLoading(el);
    }
  }
  /** 渲染文件行；files 为空/null 时显示占位提示 */
  _renderFiles(files, hint) {
    this._filesEl.textContent = "";
    this._removePlaceholder(this._filesEl);
    if (!files || !files.length) {
      this._setPlaceholder(this._filesEl, hint || this._i18n.emptyFiles);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const f of files) frag.appendChild(this._createFileRow(f));
    this._filesEl.appendChild(frag);
  }
  /** 文件行：状态徽标 + 可点击文件名 + 行尾操作按钮（removed 无按钮） */
  _createFileRow(file) {
    const i18n = this._i18n;
    const row = this._el("div", "b3-list-item history__file", "display:flex;align-items:center;gap:6px;padding:4px 8px");
    const status = _SyncHistoryPanel.STATUS_MAP[file.status] || { key: null, cls: "ft__primary" };
    const badge = this._el(
      "span",
      "history__status " + status.cls,
      "min-width:3em",
      status.key ? i18n[status.key] : file.status
    );
    const name = this._el(
      "span",
      "history__filename fn__flex-1",
      "cursor:pointer;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap",
      file.filename
    );
    name.dataset.path = file.filename;
    row.append(badge, name);
    if (file.status !== "removed") {
      row.append(
        this._createActionBtn("history__btn--rollback", i18n.rollbackFile, "⤴︎", file.filename),
        this._createActionBtn("history__btn--download", i18n.downloadFile, "↓", file.filename)
      );
    }
    return row;
  }
  _createActionBtn(cls, title, label, path) {
    const btn = this._el(
      "button",
      "b3-button b3-button--outline history__btn " + cls,
      "padding:1px 6px;height:22px;min-width:22px;line-height:20px;font-size:14px;flex:0 0 auto",
      label
    );
    btn.type = "button";
    btn.dataset.path = path;
    btn.title = title;
    return btn;
  }
  // ─────────── 内容对比 ───────────
  /** 点击文件名：左侧提交版本内容，右侧本地当前内容（失败显示空并轻提示） */
  async _loadDiff(path) {
    if (this._destroyed || !path || !this._selectedSha) return;
    const seq = ++this._filesSeq;
    const i18n = this._i18n;
    const el = this._diffEl;
    this._showLoading(el);
    this._leftTextarea.value = "";
    this._rightTextarea.value = "";
    this._leftTitle.textContent = i18n.commitVersion + " " + this._selectedSha.slice(0, 8);
    this._rightTitle.textContent = i18n.localVersion;
    try {
      const [left, right] = await Promise.allSettled([
        this._provider.getFileContent(path, this._selectedSha),
        this._provider.getFileContent(path, this._opts.branchName)
      ]);
      if (this._destroyed || seq !== this._filesSeq) return;
      if (left.status === "fulfilled" && left.value && typeof left.value.text === "string") this._leftTextarea.value = left.value.text;
      else if (left.status === "rejected") this._notifyFail(left.reason, i18n.fileLoadFailed);
      if (right.status === "fulfilled" && right.value && typeof right.value.text === "string") this._rightTextarea.value = right.value.text;
      else if (right.status === "rejected") {
        this._rightTextarea.value = "";
        this._notifyFail(right.reason, i18n.fileLoadFailed);
      }
    } finally {
      if (!this._destroyed) this._hideLoading(el);
    }
  }
  /** 清空对比区并复位标题 */
  _clearDiff() {
    this._leftTextarea.value = "";
    this._rightTextarea.value = "";
    this._leftTitle.textContent = this._i18n.commitVersion;
    this._rightTitle.textContent = this._i18n.localVersion;
  }
  // ─────────── 回滚 / 下载 ───────────
  /** 通用文件动作：遮罩 + 调用回调 + 结果轻提示 */
  async _runFileAction(kind, path) {
    if (this._destroyed) return;
    const i18n = this._i18n;
    const done = kind === "rollback" ? i18n.rollbackDone : i18n.downloadDone;
    const fail = kind === "rollback" ? i18n.rollbackFailed : i18n.downloadFailed;
    const fn = kind === "rollback" ? this._opts.onRollback : this._opts.onDownload;
    const el = this._filesEl;
    this._showLoading(el);
    try {
      await fn(path, this._selectedSha);
      if (!this._destroyed) this._opts.notify(done, "success");
    } catch (err) {
      if (!this._destroyed) this._notifyFail(err, fail);
    } finally {
      if (!this._destroyed) this._hideLoading(el);
    }
  }
  // ─────────── 查询参数 ───────────
  /** path 筛选：笔记本前缀与文件路径输入合并；输入以 data/ 开头视为完整路径直接使用 */
  _queryPath() {
    const nb = this._notebookSelect.value;
    const input = this._pathInput.value.trim().replace(/^\/+/, "");
    if (input.startsWith("data/")) return input;
    if (nb && input) return nb + "/" + input;
    return nb || input;
  }
  // ─────────── 工具方法 ───────────
  _option(value, text) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = text;
    return o;
  }
  /** 失败轻提示：优先原始错误信息，缺失时用兜底文案 */
  _notifyFail(err, fallback) {
    let msg = "";
    if (err) msg = err.message || String(err);
    this._opts.notify(msg || fallback, "error");
  }
  /** 容器上叠加绝对定位居中 loading 遮罩（按容器计数，支持并发请求） */
  _showLoading(el) {
    if (!el || this._destroyed) return;
    const count = this._loadingCount.get(el) || 0;
    if (count === 0) {
      const overlay = this._el(
        "div",
        "fn__loading",
        "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;z-index:10;background-color:var(--b3-theme-background);opacity:0.85"
      );
      const img = this._el("img");
      img.width = 64;
      img.src = "/stage/loading-pure.svg";
      img.alt = this._i18n.loadingText;
      overlay.appendChild(img);
      el.appendChild(overlay);
      el.style.position = "relative";
      this._loadingOverlays.set(el, overlay);
    }
    this._loadingCount.set(el, count + 1);
  }
  _hideLoading(el) {
    if (!el) return;
    const count = (this._loadingCount.get(el) || 0) - 1;
    if (count > 0) {
      this._loadingCount.set(el, count);
      return;
    }
    this._loadingCount.delete(el);
    const overlay = this._loadingOverlays.get(el);
    if (overlay) {
      overlay.remove();
      this._loadingOverlays.delete(el);
    }
  }
  /** 设置空态占位（自动替换已有占位） */
  _setPlaceholder(el, text) {
    this._removePlaceholder(el);
    const p = this._el("div", "history__placeholder", "padding:16px;text-align:center;font-size:13px;color:var(--b3-theme-on-surface)", text);
    el.appendChild(p);
    this._placeholders.set(el, p);
  }
  _removePlaceholder(el) {
    const p = this._placeholders.get(el);
    if (p) {
      p.remove();
      this._placeholders.delete(el);
    }
  }
};
__publicField(_SyncHistoryPanel, "PER_PAGE", 50);
// 变更状态 → i18n 键与配色（新增/修改/删除/重命名）
__publicField(_SyncHistoryPanel, "STATUS_MAP", {
  added: { key: "statusAdded", cls: "ft__success" },
  modified: { key: "statusModified", cls: "ft__primary" },
  removed: { key: "statusRemoved", cls: "ft__error" },
  renamed: { key: "statusRenamed", cls: "ft__warning" }
});
var SyncHistoryPanel = _SyncHistoryPanel;

// src/plugin/menu.js
function buildTopBarMenu({ q: q2, plugin, i18n, actions, conflictPaused }) {
  const t = i18n;
  const menu = new q2.Menu("SY-GSP", true);
  if (conflictPaused) {
    menu.addItem({
      iconHTML: "",
      label: t.sygspMenuResolveConflict || "🔴 处理冲突/恢复同步",
      click: actions.resolveConflict
    });
    menu.addSeparator();
  }
  menu.addItem({
    iconHTML: "",
    label: t.startSync,
    icon: "iconRefresh",
    click: actions.startSync
  });
  const refresh = menu.addItem({
    iconHTML: "",
    label: t.refreshOrRecover,
    icon: "iconRefresh",
    type: "submenu"
  });
  refresh.addItem({
    iconHTML: "",
    label: t.refreshWSTree,
    icon: "iconRefresh",
    click: actions.refreshWorkspaceTree
  });
  refresh.addItem({
    iconHTML: "",
    label: t.recoverAssets,
    icon: "iconImage",
    click: actions.recoverAssets
  });
  const range = menu.addItem({
    iconHTML: "",
    label: t.syncRange,
    icon: "iconFilter",
    type: "submenu"
  });
  addRadioItems(range, t.syncRange, [
    ["0", t.workSpace],
    ["1", t.dataFile],
    ["2", t.noteFile]
  ], "sync_range", actions);
  const strategy = menu.addItem({
    iconHTML: "",
    label: t.syncStrategy,
    icon: "iconSettings",
    type: "submenu"
  });
  addRadioItems(strategy, t.syncStrategy, [
    ["0", t.autoSyncStrategy],
    ["1", t.selectUpload],
    ["2", t.keepRemoteCover],
    ["3", t.keepLocalCover]
  ], "sync_strategy", actions);
  const fileType = menu.addItem({
    iconHTML: "",
    label: t.noteType,
    icon: "iconFile",
    type: "submenu"
  });
  addRadioItems(fileType, t.noteType, [
    ["0", t.siyuanFile],
    ["1", t.markdownFile]
  ], "sync_file_type", actions);
  const mode = menu.addItem({
    iconHTML: "",
    label: t.syncMode,
    icon: "iconClock",
    type: "submenu"
  });
  addRadioItems(mode, t.syncMode, [
    ["0", t.autoSync],
    ["1", t.manualSync],
    ["2", t.fullManualSync]
  ], "sync_mode", actions);
  menu.addSeparator();
  menu.addItem({
    iconHTML: "",
    label: t.syncHistory,
    icon: "iconHistory",
    click: actions.openHistory
  });
  menu.addItem({
    iconHTML: "",
    label: t.sygspMenuLogs || "运行日志",
    icon: "iconInfo",
    click: actions.openLogs
  });
  menu.addItem({
    iconHTML: "",
    label: t.sygspMenuDiagnosis || "只读诊断",
    icon: "iconHeart",
    click: actions.openDiagnosis
  });
  menu.addSeparator();
  menu.addItem({
    iconHTML: "",
    label: t.setting,
    icon: "iconSettings",
    click: actions.openSettings
  });
  return menu;
}
function addRadioItems(parent, title, options, settingKey, actions) {
  const current = String(parent ? actions.getSetting(settingKey) : "");
  for (const [value, label] of options) {
    parent.addItem({
      iconHTML: current === value ? "iconSelect" : "",
      label,
      click: async () => {
        await actions.setSettingAndSave(settingKey, Number(value));
      }
    });
  }
}

// src/plugin/index.js
var ICONS_MAIN = '<symbol id="iconGmailSync" viewBox="0 0 1024 1024"><path d="M998.4 627.2c-51.2 230.4-256 396.8-499.2 396.8-224 0-409.6-140.8-480-339.2h121.6c64 134.4 198.4 230.4 358.4 230.4 179.2 0 332.8-121.6 384-281.6l115.2-6.4zM499.2 0c224 0 409.6 140.8 480 339.2h-121.6c-64-134.4-198.4-230.4-358.4-230.4-179.2 0-332.8 121.6-384 281.6L0 396.8C51.2 172.8 256 0 499.2 0z" fill="#646A73"></path><path d="M998.4 332.8c0 32-25.6 57.6-57.6 64h-140.8c-19.2 0-32-12.8-32-32v-51.2c0-19.2 12.8-32 32-32h83.2V32c0-12.8 12.8-25.6 25.6-32h57.6c19.2 0 32 12.8 32 32v300.8zM0 659.2c0-32 25.6-57.6 57.6-64h140.8c19.2 0 32 12.8 32 32v51.2c0 19.2-12.8 32-32 32H115.2V960c0 12.8-12.8 25.6-25.6 32H32c-19.2 0-32-12.8-32-32v-300.8z" fill="#646A73"></path><path d="M665.6 569.6H512V473.6h249.6c12.8 0 12.8 0 12.8 6.4 6.4 70.4 0 134.4-38.4 192-38.4 57.6-96 96-160 108.8-83.2 19.2-166.4 0-236.8-51.2-57.6-44.8-89.6-102.4-96-172.8-19.2-147.2 64-275.2 204.8-313.6 89.6-19.2 172.8 0 243.2 57.6l6.4 6.4L620.8 384l-6.4-6.4c-25.6-25.6-64-38.4-108.8-38.4-83.2 0-153.6 64-160 147.2-12.8 89.6 44.8 172.8 134.4 192 51.2 12.8 96 6.4 140.8-25.6 19.2-19.2 38.4-44.8 44.8-76.8v-6.4z" fill="#646A73"></path></symbol>';
var ICONS_SYNC = '<symbol id="iconModeSync" viewBox="0 0 1024 1024"><path d="M512 128c-212.064 0-384 171.936-384 384h-64l106.624 149.312L277.312 512H213.344c0-164.928 133.728-298.656 298.656-298.656 61.6 0 118.848 18.624 166.4 50.56l46.912-51.904A380.544 380.544 0 0 0 512 128z m331.328 234.688L746.688 512h64c0 164.928-133.728 298.656-298.656 298.656a297.216 297.216 0 0 1-166.4-50.56l-46.912 51.904A380.544 380.544 0 0 0 512 896c212.064 0 384-171.936 384-384h64l-106.624-149.312z" fill="currentColor"></path></symbol>';
var SyGspPlugin = class extends q.Plugin {
  constructor(...args) {
    super(...args);
    this.isMobile = String(q.getFrontend ? q.getFrontend() : "desktop").indexOf("mobile") >= 0;
    this.timerTask = null;
    this.topBarElement = null;
    this.logs = new RuntimeLogs(200);
    this.events = createEventBus();
  }
  async onload() {
    try {
      this.kernel = createKernel(q);
      await this._initStores();
      this.notification = new NotificationService({ q, i18n: this.i18n });
      this.settingsBuilder = new SettingsPanelBuilder({
        plugin: this,
        q,
        i18n: this.i18n,
        metadataStore: this.metadataStore,
        onPlatformChanged: async () => {
          this.logs.info("平台已切换: " + this._platform());
        }
      });
      this.settingUtils = await this.settingsBuilder.build();
      await this._migrateFromLegacyIfNeeded();
      this.conflictDialog = new ConflictDialog({
        q,
        i18n: this.i18n,
        conflictService: this.conflictService,
        onDecide: (decisions) => this.controller.resolveConflicts(decisions),
        notify: (msg, type) => this.notification.toast(msg, type)
      });
      this.conflictDialog.setKernel(this.kernel);
      this.diagnosisPanel = new DiagnosisPanel({
        q,
        i18n: this.i18n,
        runChecks: () => this._runDiagnosis(),
        previewPlan: () => this._previewPlan(),
        onChooseBase: (choice) => this.controller.resolveConflicts({ __base__: choice }),
        onFirstWriteConfirmed: async () => {
          await this._saveEngineState({ firstWriteConfirmed: true });
          this.logs.info("首次写入已确认");
          await this.syncNow({ trigger: "manual" });
        },
        notify: (msg, type) => this.notification.toast(msg, type)
      });
      this.controller = this._buildController();
      await this.controller.restore();
      this.createIcons();
    } catch (err) {
      this.logs.error("onload 失败: " + (err && err.stack || err));
      console.error("[SY-GSP] onload 失败:", err);
    }
  }
  async onLayoutReady() {
    try {
      this._registerTopBar();
      this._bindEngineEvents();
      await this._applyStartupBehavior();
    } catch (err) {
      this.logs.error("onLayoutReady 失败: " + (err && err.stack || err));
      console.error("[SY-GSP] onLayoutReady 失败:", err);
    }
  }
  async onunload() {
    if (this.timerTask) {
      clearInterval(this.timerTask);
      this.timerTask = null;
    }
    if (this.controller) this.controller.destroy();
  }
  async uninstall() {
    q.showMessage(this.i18n.byePlugin);
  }
  createIcons() {
    this.addIcons(ICONS_MAIN);
    this.addIcons(ICONS_SYNC);
  }
  // ---------- 装配 ----------
  async _initStores() {
    this.metadataStore = new SyncMetadataStore(this);
    await this.metadataStore.load();
    this.historyStore = new SyncHistoryStore(this);
    await this.historyStore.load();
    this.manifestStore = new LocalManifestStore(this);
    await this.manifestStore.load();
    this.conflictService = new ConflictService(this);
    await this.conflictService.load();
  }
  /** 旧版 SGSP 设置迁移(仅首次;失败不影响使用,详见迁移报告) */
  async _migrateFromLegacyIfNeeded() {
    const marker = await this.loadData("migration-report.json");
    if (marker) return;
    const target = {
      setAndSave: async (key, value) => {
        if (PER_PLATFORM_KEYS.includes(key)) {
          const file = PLATFORM_CONFIG_FILES[this._platform()] + ".json";
          const data = await this.loadData(file) || {};
          data[key] = value;
          await this.saveData(file, data);
          this.settingsBuilder.utils.set(key, value);
        } else {
          await this.settingsBuilder.utils.setAndSave(key, value);
        }
      }
    };
    const migration = new Migration(this.kernel, target, this.metadataStore);
    const report = await migration.migrate(this._repoInfo()).catch((err) => ({
      migratedKeys: [],
      legacyHint: null,
      errors: [String(err && err.message || err)]
    }));
    await this.saveData("migration-report.json", report);
    if (report.migratedKeys.length > 0) {
      this.logs.info("旧版设置迁移完成: " + report.migratedKeys.length + " 项");
      const tpl = this.i18n.sygspMigrated || "已迁移旧版 SGSP 设置 {n} 项;同步基准需重新确认";
      q.showMessage(tpl.replace("{n}", String(report.migratedKeys.length)), 6e3, "info");
    }
    if (report.errors && report.errors.length > 0) {
      this.logs.error("旧版迁移错误: " + report.errors.join("; "));
    }
  }
  _platform() {
    return this.settingUtils && Number(this.settingUtils.take("upload_sub_platform")) === 1 ? "gitee" : "github";
  }
  _repoInfo() {
    if (!this.settingUtils) {
      return { provider: "github", owner: "", repo: "", branch: "", token: "" };
    }
    const addr = String(this.settingUtils.take("repository_address") || "");
    const parsed = parseRepoAddress(addr);
    return {
      provider: this._platform(),
      owner: parsed.owner,
      repo: parsed.repo,
      branch: String(this.settingUtils.take("repository_branch") || "").trim(),
      token: String(this.settingUtils.take("submit_token") || "")
    };
  }
  _repoKey(info) {
    return info.provider + ":" + info.owner + "/" + info.repo + ":" + info.branch;
  }
  _buildController() {
    const self = this;
    return new SyncController({
      plugin: this,
      settings: this.settingUtils,
      events: this.events,
      notify: (msg, type) => this.notification.toast(msg, type),
      i18n: (key, fallback) => this.i18n && this.i18n[key] || fallback,
      repoInfo: () => this._repoInfo(),
      autoSync: {
        pause: () => this._stopAutoSyncTimer(),
        resume: () => this._restartAutoSyncIfConfigured()
      },
      makeEngineDeps: (ctx) => self._makeEngineDeps(ctx)
    });
  }
  _makeEngineDeps(ctx) {
    const info = this._repoInfo();
    const self = this;
    const provider = info.provider === "gitee" ? new GiteeProvider({ owner: info.owner, repo: info.repo, branch: info.branch, token: info.token }) : new GitHubProvider({ owner: info.owner, repo: info.repo, branch: info.branch, token: info.token });
    const workspace = new WorkspaceAdapter(this.kernel, {
      getUserIgnore: () => this.settingUtils.take("ignore_file") || "",
      getSyncRange: () => Number(this.settingUtils.take("sync_range")) || 0,
      getNotebooks: async () => {
        const res = await this.kernel.lsNotebooks();
        return res && res.notebooks || [];
      }
    });
    const contentAdapter = new ContentAdapter(this.kernel, { backupDir: "temp/SY-GSP/backup/", i18n: this.i18n });
    const planner = new SyncPlanner({
      readLocal: async (path) => {
        const blob = await this.kernel.getFile(path);
        return blob ? { bytes: new Uint8Array(await blob.arrayBuffer()) } : null;
      },
      readRemoteBlobBySha: async (sha) => provider.getBlob(sha),
      guardLocalDelete: async (path) => workspace.guardLocalDelete(path, self.manifestStore, { remoteEntryExists: true })
    });
    return {
      provider,
      workspace,
      contentAdapter,
      metadataStore: this.metadataStore,
      manifestStore: this.manifestStore,
      conflictService: this.conflictService,
      planner,
      merger: new ThreeWayMerger(),
      commitBuilder: new CommitBuilder({
        requestLimit: Number(this.settingUtils.take("sygsp_blob_request_limit")) || 33554432
      }),
      events: this.events,
      config: {
        get repoKey() {
          return self._repoKey(info);
        },
        get syncRange() {
          return Number(self.settingUtils.take("sync_range")) || 0;
        },
        get syncFileType() {
          return Number(self.settingUtils.take("sync_file_type")) === 1 ? "markdown" : "raw";
        }
      }
    };
  }
  _saveEngineState(patch) {
    const current = this._engineState || {};
    this._engineState = Object.assign({}, current, patch);
    return this.saveData(ENGINE_STATE_FILE, this._engineState).catch((err) => {
      this.logs.error("状态保存失败: " + String(err && err.message || err));
    });
  }
  // ---------- 引擎事件 → 日志/通知/历史/面板 ----------
  _bindEngineEvents() {
    this.events.on("state:changed", ({ state, conflictPaused }) => {
      this.logs.info("状态: " + state + (conflictPaused ? " (冲突暂停: " + conflictPaused.kind + ")" : ""));
      if (this.notification) {
        if (this.controller && this.controller.isConflictPaused()) this.notification._badge("conflict");
      }
    });
    this.events.on("sync:success", ({ ctx, result }) => {
      this.logs.info(
        "同步成功 " + result.operationId + " ↑" + result.uploads + " ↓" + result.downloads + " 删远" + result.deletionsRemote + " 删本" + result.deletionsLocal
      );
      this._recordHistory(ctx, "SUCCESS", null, result);
      this.notification.syncSuccess(result, {
        automatic: ctx.trigger === "automatic",
        successNotify: this.settingUtils.get("sygsp_success_notify") !== false
      });
    });
    this.events.on("sync:error", ({ ctx, error }) => {
      this.logs.error("同步失败[" + error.category + "] " + error.toDisplayText());
      this._recordHistory(ctx, "FAILED", error, null);
      this.notification.syncError(error, { automatic: ctx.trigger === "automatic" });
    });
    this.events.on("sync:conflict", ({ ctx, conflictPaused }) => {
      this.logs.error("同步暂停[" + conflictPaused.kind + "] " + conflictPaused.reason);
      this._recordHistory(ctx, "CONFLICT_PAUSED", null, { paused: true, kind: conflictPaused.kind });
      this.notification.conflictPaused({
        kind: conflictPaused.kind,
        conflictCount: conflictPaused.conflictCount,
        reason: conflictPaused.reason
      });
      if (conflictPaused.kind === "FILE_CONFLICTS") {
        const set = this.conflictService.openSet(this._repoKey(this._repoInfo()));
        if (set) this.conflictDialog.show(set);
      } else {
        this.diagnosisPanel.show({ mode: "base_recovery" });
      }
    });
    this.events.on("conflict:reopen", () => {
      const set = this.conflictService.openSet(this._repoKey(this._repoInfo()));
      if (set) this.conflictDialog.show(set);
      else this.diagnosisPanel.show({ mode: "base_recovery" });
    });
  }
  // ---------- 同步入口 ----------
  async syncNow({ trigger = "manual", mode = "auto" } = {}) {
    const info = this._repoInfo();
    if (!info.owner || !info.repo || !info.branch || !info.token) {
      this.notification.toast(this.i18n.warnFinishSettingConfig || "请先完整填写设置", "error");
      this.openSetting();
      return { skipped: true };
    }
    const state = this._engineState || await this.loadData(ENGINE_STATE_FILE) || {};
    this._engineState = state;
    if (!state.firstWriteConfirmed && mode === "auto" && trigger !== "conflict_resolution") {
      this.diagnosisPanel.show({ mode: "first_sync" });
      return { skipped: true, firstRun: true };
    }
    const strategy = Number(this.settingUtils.take("sync_strategy")) || 0;
    if (mode === "auto" && strategy === 1) {
      this._openDirectionDialog();
      return { skipped: true, chooseDirection: true };
    }
    if (mode === "auto" && strategy === 2) mode = "remote_over_local";
    if (mode === "auto" && strategy === 3) mode = "local_over_remote";
    this.controller.retryPolicy.enabled = this.settingUtils.get("sygsp_auto_retry") === true;
    this.notification.syncStarted(trigger);
    return this.controller.syncNow({ trigger, mode });
  }
  /** 选择同步方向弹窗(策略 1) */
  _openDirectionDialog() {
    const t = this.i18n;
    let direction = "0";
    const dialog = new q.Dialog({
      title: t.sygspChooseDirectionTitle || "选择同步方向",
      content: '<div id="sygspDirection" style="padding:16px;"></div>',
      width: "520px"
    });
    const root = dialog.element.querySelector("#sygspDirection");
    const mkLabel = (value, text) => {
      const label = document.createElement("label");
      label.className = "fn__flex b3-label";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "upload";
      input.value = value;
      input.addEventListener("change", () => {
        direction = value;
      });
      const textEl = document.createElement("div");
      textEl.textContent = text;
      label.appendChild(input);
      label.appendChild(textEl);
      return label;
    };
    root.appendChild(mkLabel("0", t.sygspDirRemote || "⬇️ 下载云端数据覆盖本地"));
    root.appendChild(mkLabel("1", t.sygspDirLocal || "⬆️ 上传本地数据覆盖云端"));
    const bar = document.createElement("div");
    bar.className = "fn__flex";
    bar.style.justifyContent = "flex-end";
    bar.style.gap = "8px";
    const cancel = document.createElement("button");
    cancel.className = "b3-button b3-button--cancel";
    cancel.textContent = t.cancel || "取消";
    cancel.addEventListener("click", () => dialog.destroy());
    const confirm = document.createElement("button");
    confirm.className = "b3-button b3-button--text";
    confirm.textContent = t.sygspConfirm || "确定";
    confirm.addEventListener("click", () => {
      dialog.destroy();
      const mode = direction === "0" ? "remote_over_local" : "local_over_remote";
      if (this._hasUnresolvedBase()) {
        this.diagnosisPanel.show({ mode: "base_recovery" });
        return;
      }
      this.controller.retryPolicy.enabled = this.settingUtils.get("sygsp_auto_retry") === true;
      this.notification.syncStarted("manual");
      this.controller.syncNow({ trigger: "manual", mode });
    });
    bar.appendChild(cancel);
    bar.appendChild(confirm);
    root.appendChild(bar);
  }
  _hasUnresolvedBase() {
    return !this.metadataStore.getBaseCommit(this._repoKey(this._repoInfo()));
  }
  // ---------- 自动同步 ----------
  _restartAutoSyncIfConfigured() {
    this._stopAutoSyncTimer();
    if (!this.settingUtils) return;
    if (Number(this.settingUtils.take("sync_mode")) !== 0) return;
    if (this.settingUtils.take("enabled_sync") === false) return;
    this.startAutoSyncTimer(Number(this.settingUtils.take("sync_interval")) || 6e5);
  }
  _stopAutoSyncTimer() {
    if (this.timerTask) {
      clearInterval(this.timerTask);
      this.timerTask = null;
      this.logs.info("自动同步已暂停");
    }
  }
  startAutoSyncTimer(intervalMs) {
    this._stopAutoSyncTimer();
    this.timerTask = setInterval(() => {
      if (this.controller.isConflictPaused()) return;
      this.controller.markAutoTick();
      this.syncNow({ trigger: "automatic" }).catch((err) => {
        this.logs.error("自动同步异常: " + String(err && err.message || err));
      });
    }, intervalMs);
    this.logs.info("自动同步已启动,间隔 " + Math.round(intervalMs / 1e3) + "s");
  }
  async _applyStartupBehavior() {
    const mode = Number(this.settingUtils.take("sync_mode")) || 0;
    const enabled = this.settingUtils.take("enabled_sync") !== false;
    if (this.controller.isConflictPaused()) {
      this.notification.conflictPaused({
        kind: this.controller.conflictPaused.kind,
        conflictCount: this.controller.conflictPaused.conflictCount
      });
    }
    if (!enabled) return;
    if (mode === 0) {
      this._restartAutoSyncIfConfigured();
    } else if (mode === 1) {
      this.syncNow({ trigger: "startup" }).catch((err) => this.logs.error("启动同步失败: " + String(err && err.message || err)));
    }
  }
  // ---------- UI 动作 ----------
  _registerTopBar() {
    if (this.isMobile) {
      this.topBarElement = document.querySelector("#toolbarMore");
    } else if (typeof q.addTopBar === "function") {
      q.addTopBar({
        icon: "iconGmailSync",
        title: this.i18n.addTopBarIcon || "SY-GSP",
        position: "right",
        callback: (event) => this._openMenu(event)
      });
      this.topBarElement = document.querySelector('button[data-id="iconGmailSync"]');
    }
    if (this.notification) this.notification.setTopBarElement(this.topBarElement);
  }
  _openMenu(event) {
    const actions = {
      startSync: () => this.syncNow({ trigger: "manual" }),
      refreshWorkspaceTree: () => this.kernel.refreshFiletree(),
      recoverAssets: () => this._recoverAssets(),
      openHistory: () => this.openSyncHistoryPanel(),
      openLogs: () => openLogsDialog({ q, i18n: this.i18n, logs: this.logs }),
      openDiagnosis: () => this.diagnosisPanel.show({ mode: "diagnosis" }),
      openSettings: () => this.openSetting(),
      resolveConflict: () => {
        const set = this.conflictService.openSet(this._repoKey(this._repoInfo()));
        if (set) this.conflictDialog.show(set);
        else this.diagnosisPanel.show({ mode: this.controller.conflictPaused && this.controller.conflictPaused.kind === "BASE_UNRESOLVED" ? "base_recovery" : "diagnosis" });
      },
      getSetting: (key) => this.settingUtils.take(key),
      setSettingAndSave: (key, value) => this.settingUtils.setAndSave(key, value)
    };
    const menu = buildTopBarMenu({
      q,
      plugin: this,
      i18n: this.i18n,
      actions,
      conflictPaused: this.controller.isConflictPaused()
    });
    const anchor = event && event.target ? event.target : this.topBarElement;
    if (anchor && anchor.getBoundingClientRect) {
      const rect = anchor.getBoundingClientRect();
      menu.open({ x: rect.right, y: rect.bottom });
    } else {
      menu.open({ x: window.innerWidth - 220, y: 32 });
    }
  }
  openSetting() {
    const setting = this.setting;
    if (setting && typeof setting.open === "function") setting.open();
  }
  openSyncHistoryPanel() {
    const info = this._repoInfo();
    if (!info.owner || !info.repo || !info.branch || !info.token) {
      this.notification.toast(this.i18n.warnFinishSettingConfig || "请先完整填写设置", "error");
      return;
    }
    const dialog = new q.Dialog({
      positionId: "mainSyncHistory",
      content: '<div id="sygspSyncHistory" class="fn__flex-column" style="height: 100%;"></div>',
      width: "90vw",
      height: "80vh",
      hideCloseIcon: false,
      destroyCallback: () => {
        if (this._historyPanel) {
          this._historyPanel.destroy();
          this._historyPanel = null;
        }
      }
    });
    const provider = this._makeProvider(info);
    const base = this.metadataStore.get(this._repoKey(info));
    this._historyPanel = new SyncHistoryPanel({
      container: dialog.element.querySelector("#sygspSyncHistory"),
      provider: {
        listCommits: (query) => provider.listCommits(query),
        compareCommits: (baseRef, headRef) => provider.compareCommits(baseRef, headRef),
        getFileContent: (path, ref) => provider.getFileContent(path, ref)
      },
      listNotebooks: async () => {
        const res = await this.kernel.lsNotebooks();
        return res && res.notebooks || [];
      },
      branchName: info.branch,
      localCommitSha: base && base.lastConfirmedCommit ? base.lastConfirmedCommit : "",
      localCommitTime: base && base.lastSuccessfulAt ? base.lastSuccessfulAt : "",
      i18n: this.i18n,
      onRollback: (path, ref) => this._writeCommitFile(path, ref, provider, true),
      onDownload: (path, ref) => this._writeCommitFile(path, ref, provider, false),
      notify: (msg, type) => this.notification.toast(msg, type)
    });
  }
  _makeProvider(info) {
    return info.provider === "gitee" ? new GiteeProvider({ owner: info.owner, repo: info.repo, branch: info.branch, token: info.token }) : new GitHubProvider({ owner: info.owner, repo: info.repo, branch: info.branch, token: info.token });
  }
  /** 历史面板: 回滚(覆盖本地)/下载(另存到隔离目录) */
  async _writeCommitFile(path, ref, provider, overwrite) {
    try {
      const content = await provider.getFileContent(path, ref);
      const bytes = content.bytes;
      if (!bytes || bytes.length === 0) {
        this.notification.toast(this.i18n.sygspFileContentEmpty || "文件内容为空,已停止", "error");
        return;
      }
      const targetPath = overwrite ? path : "temp/SY-GSP/downloads/" + String(path).replace(/^\/+/, "");
      await this.kernel.putFile(targetPath, new Blob([bytes]), false);
      const tpl = overwrite ? this.i18n.sygspRollbackDone || "已回滚" : this.i18n.sygspDownloadDone || "已下载";
      this.notification.toast(tpl + ": " + targetPath, "info");
    } catch (err) {
      this.notification.toast("❌ " + String(err && err.message || err), "error");
    }
  }
  /** 更新资源路径(菜单) */
  async _recoverAssets() {
    try {
      const adapter = new ContentAdapter(this.kernel, { backupDir: "temp/SY-GSP/backup/" });
      const result = await adapter.replaceAssetPrefix({ path: "", assetsPrefix: this.settingUtils.take("asset_prefix") || "" });
      q.showMessage((this.i18n.updateLocalAssetsPathSucc || "资源路径已更新") + " (" + result.updated + ")", 3e3, "info");
    } catch (err) {
      q.showMessage((this.i18n.updateLocalAssetsPathFailed || "资源路径更新失败") + ": " + String(err && err.message || err), 6e3, "error");
    }
  }
  // ---------- 诊断 ----------
  async _runDiagnosis() {
    const checks = [];
    const info = this._repoInfo();
    checks.push({
      name: "仓库配置",
      ok: !!(info.owner && info.repo && info.branch),
      detail: info.owner ? info.provider + ": " + info.owner + "/" + info.repo + " @ " + info.branch : "仓库地址无法解析,请检查设置"
    });
    checks.push({ name: "Token", ok: !!info.token, detail: info.token ? "已配置" : "未配置" });
    try {
      const probePath = "temp/SY-GSP/probe.txt";
      await this.kernel.putFile(probePath, new Blob(["ok"]), false);
      const blob = await this.kernel.getFile(probePath);
      const ok = !!blob && await blob.text() === "ok";
      await this.kernel.removeFile(probePath);
      checks.push({ name: "本地文件读写", ok, detail: ok ? "temp/SY-GSP/ 读写正常" : "内容校验失败" });
    } catch (err) {
      checks.push({ name: "本地文件读写", ok: false, detail: String(err && err.message || err) });
    }
    if (info.owner && info.branch) {
      try {
        const provider = this._makeProvider(info);
        const head = await provider.getBranchHead();
        checks.push({ name: "远端可达", ok: true, detail: "HEAD " + head.sha.slice(0, 8) });
        const repoKey = this._repoKey(info);
        const base = this.metadataStore.getBaseCommit(repoKey);
        const hint = this.metadataStore.getLegacyHint(repoKey);
        checks.push({
          name: "同步基准",
          ok: !!base,
          detail: base ? "已确认基准 " + base.slice(0, 8) : hint ? "旧版基准线索 " + String(hint.sha).slice(0, 8) + "(未验证,需通过首同步向导确认)" : "无确认基准(首次同步将进入向导)"
        });
      } catch (err) {
        checks.push({ name: "远端可达", ok: false, detail: String(err && err.message || err) });
      }
    }
    const migrationReport = await this.loadData("migration-report.json");
    if (migrationReport) {
      const errs = migrationReport.errors || [];
      checks.push({
        name: "旧版设置迁移",
        ok: errs.length === 0,
        detail: "迁移 " + (migrationReport.migratedKeys || []).length + " 项" + (errs.length ? ";错误: " + errs.join("; ") : "")
      });
    }
    return checks;
  }
  /** 首次写入预览: 只读统计,不执行任何写入 */
  async _previewPlan() {
    const info = this._repoInfo();
    const rows = [];
    if (!info.owner || !info.branch) {
      return [{ name: "同步计划", detail: "配置不完整,无法预览" }];
    }
    const workspace = new WorkspaceAdapter(this.kernel, {
      getUserIgnore: () => this.settingUtils.take("ignore_file") || "",
      getSyncRange: () => Number(this.settingUtils.take("sync_range")) || 0,
      getNotebooks: async () => {
        const res = await this.kernel.lsNotebooks();
        return res && res.notebooks || [];
      }
    });
    const scan = await workspace.scan({ range: Number(this.settingUtils.take("sync_range")) || 0 });
    rows.push({
      name: "本地扫描(同步范围内)",
      detail: scan.files.length + " 个文件" + (scan.enumErrorOccurred ? "(存在目录枚举异常)" : "")
    });
    try {
      const provider = this._makeProvider(info);
      const head = await provider.getBranchHead();
      const commit = await provider.getCommit(head.sha);
      const tree = await provider.getTree(commit.treeSha);
      const remotePaths = new Set(tree.filter((e) => e.type === "blob").map((e) => e.path));
      rows.push({ name: "远端文件", detail: remotePaths.size + " 个文件,HEAD " + head.sha.slice(0, 8) });
      const localSet = new Set(scan.files.map((f) => f.path));
      let onlyLocal = 0;
      for (const p of localSet) if (!remotePaths.has(p)) onlyLocal += 1;
      let onlyRemote = 0;
      for (const p of remotePaths) if (!localSet.has(p)) onlyRemote += 1;
      rows.push({ name: "路径差异(粗略)", detail: "仅本地 " + onlyLocal + " / 仅远端 " + onlyRemote + "(内容级判定在首次同步时执行)" });
    } catch (err) {
      rows.push({ name: "远端读取", detail: "失败: " + String(err && err.message || err) });
    }
    rows.push({ name: "首次写入模式", detail: "将进入首同步向导: 明确以本地或远端为准后执行一次覆盖同步" });
    return rows;
  }
  // ---------- 历史 ----------
  async _recordHistory(ctx, state, error, result) {
    const info = this._repoInfo();
    try {
      await this.historyStore.append(this._repoKey(info), {
        operationId: ctx.id,
        trigger: ctx.trigger,
        startedAt: ctx.startedAt,
        finishedAt: (/* @__PURE__ */ new Date()).toISOString(),
        state,
        phase: ctx.phase,
        baseCommit: ctx.baseCommit,
        expectedRemoteHead: ctx.expectedRemoteHead,
        result: result ? {
          uploads: result.uploads,
          downloads: result.downloads,
          deletionsRemote: result.deletionsRemote,
          deletionsLocal: result.deletionsLocal,
          commitSha: result.commitSha
        } : null,
        error: error ? error.toSerializable() : null,
        conflictCount: (ctx.conflicts || []).length
      });
    } catch (err) {
      this.logs.error("历史记录保存失败: " + String(err && err.message || err));
    }
  }
};

module.exports = module.exports.default || module.exports;
