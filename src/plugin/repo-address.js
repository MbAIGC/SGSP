/**
 * 仓库地址解析(与旧版 qc 语义一致):
 * 支持 https://host/owner/repo(.git)、git:// 与 git@host:owner/repo(.git)。
 */

export function parseRepoAddress(addr) {
  const cleaned = String(addr == null ? "" : addr).trim().replace(/\.git$/, "");
  const patterns = [
    /^(?:https?:\/\/|git:\/\/)?([^/:]+)\/([^/]+)\/([^/]+)$/,
    /^git@([^:]+):([^/]+)\/(.+)$/,
  ];
  for (const re of patterns) {
    const m = re.exec(cleaned);
    if (m) {
      return { host: m[1], owner: m[2], repo: m[3].replace(/\.git$/, "") };
    }
  }
  return { host: "", owner: "", repo: "" };
}
