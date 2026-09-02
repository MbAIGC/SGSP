/**
 * LocalManifestStore: 本地文件清单(删除安全的「本地曾拥有」证据)。
 * 每次成功同步后重建为「同步范围内本地确实存在的路径集合」。
 */

export const MANIFEST_FILE = "local-manifest.json";

export class LocalManifestStore {
  constructor(plugin) {
    this.plugin = plugin;
    /** @type {Set<string>} */
    this.paths = new Set();
    this.savedAt = "";
  }

  async load() {
    try {
      const data = await this.plugin.loadData(MANIFEST_FILE);
      this.paths = new Set((data && data.paths) || []);
      this.savedAt = (data && data.savedAt) || "";
    } catch (err) {
      // 清单缺失 = 无删除证据,删除守卫将全部拒绝;必须可观测但不阻断只读能力
      console.warn("[SY-GSP] 本地清单加载失败(删除判定将进入安全模式):", err && err.message);
      this.paths = new Set();
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
    this.savedAt = new Date().toISOString();
    await this.plugin.saveData(MANIFEST_FILE, { paths: [...this.paths], savedAt: this.savedAt });
  }

  /** 清空(仓库/分支切换、用户重置时) */
  async clear() {
    this.paths = new Set();
    this.savedAt = new Date().toISOString();
    await this.plugin.saveData(MANIFEST_FILE, { paths: [], savedAt: this.savedAt });
  }
}
