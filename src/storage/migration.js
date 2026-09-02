/**
 * Migration: 旧版 SGSP 设置与元数据的只读迁移(2.0 方案 阶段 1)。
 * - 旧版数据位于 data/storage/petal/SGSP/*.json(经内核 /api/file/getFile 读取,只读);
 * - 设置键名逐字沿用,迁入本插件存储;
 * - 旧 latest_commit_sha 只作为 legacyHint 记录,绝不自动成为确认基准;
 * - 任何读取失败都返回到 report.errors,由诊断面板呈现。
 */

export const LEGACY_STORAGE_DIR = "data/storage/petal/SGSP";
export const LEGACY_FILES = {
  platform: "plugin_config_platform.json",
  github: "plugin_config_git_sync_github.json",
  gitee: "plugin_config_git_sync_gitee.json",
};

/** 旧版设置键 → 本插件设置键(值语义一致,键名沿用) */
export const MIGRATABLE_KEYS = [
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
  "sync_interval",
];

export class Migration {
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
      throw new Error("旧版配置解析失败(" + name + "): " + String((err && err.message) || err));
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

    // 完全没有旧版数据: 无需迁移
    if (!platformFound && !gitFound) return report;

    // 平台选择与子平台按目标仓库平台写入
    platformCfg.upload_platform = 0; // git 平台
    platformCfg.upload_sub_platform = provider === "gitee" ? 1 : 0;

    for (const [cfg, prefix] of [
      [platformCfg, "platform."],
      [gitCfg, "git."],
    ]) {
      for (const key of Object.keys(cfg)) {
        const value = cfg[key];
        if (value === undefined || value === null) continue;
        if (typeof value !== "number" && !MIGRATABLE_KEYS.includes(key)) continue;
        try {
          await this.settings.setAndSave(key, value);
          report.migratedKeys.push(prefix + key);
        } catch (err) {
          report.errors.push("迁移 " + prefix + key + " 失败: " + String((err && err.message) || err));
        }
      }
    }

    // 旧基准只作为线索记录,绝不写入 lastConfirmedCommit
    if (gitCfg.latest_commit_sha) {
      report.legacyHint = {
        sha: String(gitCfg.latest_commit_sha),
        time: String(gitCfg.latest_commit_time || ""),
      };
      try {
        const repoKey = this.metadataStore.constructor.keyOf({ provider, owner, repo, branch });
        await this.metadataStore.setLegacyHint(repoKey, report.legacyHint);
      } catch (err) {
        report.errors.push("记录旧基准线索失败: " + String((err && err.message) || err));
      }
    }
    return report;
  }
}
