/**
 * WorkspaceAdapter: 本地工作区扫描与读写守卫(只负责本地,不触远端 API)。
 * - 扫描: 按同步范围根 BFS 内核 readDir,应用忽略规则;
 * - 目录枚举异常必须显式暴露: 枚举失败标记 enumErrorOccurred,
 *   删除安全判定据此拒绝一切远端删除(未知 ≠ 删除);
 * - 删除安全: 仅当「本地清单中存在该路径 + 属于当前同步范围 + 无枚举异常」才允许判定为本地删除。
 */

import { isIgnored, buildIgnoreList } from "./ignore-rules.js";
import { basename, isSiyuanDocPath } from "../util/path.js";

export class WorkspaceAdapter {
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
    if (range === undefined || range === null) range = this.getSyncRange();
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
    const roots = await this.rootsFor(range !== undefined ? range : this.getSyncRange());
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
          // 内核 updated 为秒;历史时钟偏差(本地时间超前)的条目按 0 处理,与旧版一致
          let updatedMs = new Date(entry.updated).getTime() * 1000;
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
    const r = range !== undefined ? range : this.getSyncRange();
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
    if (!(await this.inSyncScope(path))) reasons.push("不在当前同步范围");
    if (!manifest || !manifest.has(path)) {
      reasons.push("本地清单中不存在该文件(新设备/首次同步/从未下载)");
    }
    if (remoteEntryExists === false) reasons.push("远端已无此文件,无需删除");
    return { allow: reasons.length === 0, reasons };
  }
}
