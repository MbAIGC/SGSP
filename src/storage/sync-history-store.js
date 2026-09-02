/**
 * SyncHistoryStore: 持久化同步历史(2.0 方案 §9.1)。
 * - 每条记录含 trigger/state/phase/baseCommit/expectedRemoteHead/result/error/conflictCount;
 * - 按仓库分支隔离,环形保留最近 100 次;
 * - 以 operationId 去重;
 * - 不进入同步范围(存插件私有数据目录)。
 */

import { SyncError, SyncErrorCategory } from "../sync/sync-error.js";

export const HISTORY_FILE = "sync-history.json";
export const HISTORY_LIMIT = 100;

export class SyncHistoryStore {
  constructor(plugin) {
    this.plugin = plugin;
    /** @type {Object<string, Array>} repoKey -> entries(新在后) */
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
          message: "同步历史读取失败: " + String((err && err.message) || err),
          recoverable: true,
          cause: err,
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
      finishedAt: entry.finishedAt || new Date().toISOString(),
      state: entry.state || "",
      phase: entry.phase || "",
      baseCommit: entry.baseCommit || null,
      expectedRemoteHead: entry.expectedRemoteHead || null,
      result: entry.result || null,
      error: entry.error || null,
      conflictCount: entry.conflictCount || 0,
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
        message: "同步历史保存失败: " + String((err && err.message) || err),
        recoverable: true,
        cause: err,
      });
    }
  }
}
