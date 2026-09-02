/**
 * 浏览器侧路径工具与思源路径判断。
 * 只覆盖插件用到的 path 子集,不依赖 node:path。
 * 路径一律以 "/" 为分隔符的相对形式,如 "data/notebook/doc.sy"。
 */

export function basename(p) {
  const s = String(p == null ? "" : p);
  const idx = s.lastIndexOf("/");
  return idx >= 0 ? s.slice(idx + 1) : s;
}

export function dirname(p) {
  const s = String(p == null ? "" : p);
  const idx = s.lastIndexOf("/");
  return idx > 0 ? s.slice(0, idx) : "";
}

export function extname(p) {
  const name = basename(p);
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return "";
  return name.slice(idx);
}

export function join(...parts) {
  const merged = parts
    .filter((p) => p !== undefined && p !== null && String(p) !== "")
    .map((p) => String(p).replace(/^\/+|\/+$/g, ""))
    .join("/");
  return merged;
}

export function normalize(p) {
  return String(p == null ? "" : p).replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

/** 笔记本文档路径: data/<notebookId>(/<docId>)*.sy */
export function isSiyuanDocPath(p) {
  return /^data\/(\d{14}-[a-zA-Z0-9]+)(\/\d{14}-[a-zA-Z0-9]+)*(\.sy)?$/.test(String(p == null ? "" : p));
}

/** 思源笔记 markdown 路径: 与 .sy 同形但以 .md 结尾 */
export function isSiyuanMdPath(p) {
  return /^data\/(\d{14}-[a-zA-Z0-9]+)(\/\d{14}-[a-zA-Z0-9]+)*(\.md)?$/.test(String(p == null ? "" : p));
}

/** 路径任一段是否形如思源文档 ID(用于解析笔记本) */
export function hasDocIdSegment(p) {
  return /(\d{14}-[a-z0-9]{7})/g.test(String(p == null ? "" : p));
}

/** .sy -> .md / .md -> .sy 同名替换(仅替换最后一个扩展名) */
export function replaceExt(p, newExt) {
  const s = String(p == null ? "" : p);
  const idx = s.lastIndexOf(".");
  if (idx <= 0) return s + newExt;
  return s.slice(0, idx) + newExt;
}
