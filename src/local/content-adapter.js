/**
 * ContentAdapter: 思源格式与 Markdown 格式、冲突文档、资源路径的显式处理层。
 * 行为与旧版对齐(转换语义是数据安全的一部分,由 fixture 测试锁定)。
 */

import { basename, extname, replaceExt, isSiyuanDocPath } from "../util/path.js";

/** 二进制扩展名表(与旧版一致);命中者不做文本合并 */
export const BINARY_EXTENSIONS = [
  ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".mp4", ".avi", ".mov", ".mkv", ".pdf",
  ".doc", ".docx", ".xls", ".xlsx", ".ttf", ".woff2", ".woff", ".otf", ".eot", ".zip", ".tar",
  ".gz", ".rar", ".exe", ".dll", ".bin", ".tmp", ".swp", ".bak", ".log", ".so", ".dylib",
  ".dat", ".img", ".iso", ".bz2", ".mp3", ".wav", ".flac", ".aac", ".wmv", ".swf", ".apk",
  ".ipa", ".jar", ".class", ".pyc", ".o", ".obj", ".a", ".lib", ".pdb", ".db", ".sqlite",
  ".mdb", ".accdb", ".cur", ".ico", ".icns", ".cab", ".msi", ".msp", ".msu", ".nupkg",
  ".deb", ".rpm", ".pkg", ".dmg", ".torrent", ".crdownload", ".part",
];

export function isBinaryPath(path) {
  return BINARY_EXTENSIONS.indexOf(String(extname(path)).toLowerCase()) >= 0;
}

export class ContentAdapter {
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
      notebookId = (created && created.notebook && created.notebook.id) || notebookId;
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
      const kramdown = (block && block.kramdown) || "";
      // 原路径写入远端版本,本地内容生成冲突副本文档
      await this.kernel.putFile(path, remoteBlob, false);
      const conf = await this.kernel.sql("select * from blocks where id ='" + docId + "'");
      const info = (conf && conf[0]) || {};
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
}

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

/** 同步范围 → 扫描根路径(与旧版 Ir 对齐) */
export function syncRoots(range, notebooks) {
  if (range === 0) return [""];
  if (range === 1) return ["data"];
  const roots = ["data/assets", "data/.siyuan"];
  for (const n of notebooks || []) roots.push("data/" + n.id);
  return roots;
}
