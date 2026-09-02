/**
 * 忽略规则: 与旧版逐字对齐的通配语义。
 * - 精确匹配不区分大小写;
 * - 通配符 "*" 转为 ".*" 后做全串正则匹配;
 * - 用户配置以 ";" 分隔,自动去空白与首尾斜杠。
 */

/** 默认忽略项(与旧版一致) */
export const DEFAULT_IGNORES = Object.freeze([
  "data/plugins/*",
  "data/widgets/*",
  ".lock",
  "temp/*",
]);

/** 引擎自身的持久化目录绝不进入同步范围(含 Token 的设置文件在此) */
export const ALWAYS_IGNORES = Object.freeze(["data/storage/petal/SY-GSP/*"]);

export function normalizeUserIgnores(raw) {
  return String(raw == null ? "" : raw)
    .split(";")
    .map((s) => s.trim().replace(/^\/+|\/+$/g, "").trim())
    .filter((s) => s.length > 0);
}

/** path 是否命中 patterns 任一规则 */
export function isIgnored(path, patterns) {
  const p = String(path == null ? "" : path).toLowerCase();
  return patterns.some((pattern) => {
    const s = String(pattern).toLowerCase();
    if (s.indexOf("*") === -1) return p === s;
    return new RegExp("^" + s.replace(/\*/g, ".*") + "$").test(p);
  });
}

/** 合并 默认 + 固定 + 用户 + 额外 规则(供扫描与写入守卫共用) */
export function buildIgnoreList(userRaw, extra = []) {
  return [
    ...DEFAULT_IGNORES,
    ...ALWAYS_IGNORES,
    ...normalizeUserIgnores(userRaw),
    ...normalizeUserIgnores(Array.isArray(extra) ? extra.join(";") : String(extra || "")),
  ];
}
