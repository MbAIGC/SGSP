/**
 * SettingsPanel: 设置界面(SettingUtils 轻量实现 + 全部设置项)。
 * - 与旧版相同的设置键名(迁移直接复用);
 * - 新增键: sygsp_auto_retry / sygsp_success_notify / sygsp_blob_request_limit;
 * - 平台切换时重载子平台配置文件(与旧版交互一致)。
 */

export const PLATFORM_CONFIG_FILES = {
  github: "plugin_config_git_sync_github",
  gitee: "plugin_config_git_sync_gitee",
};

export const SETTING_DEFAULTS = Object.freeze({
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
  sync_interval: 600000,
  // SY-GSP 新增
  sygsp_auto_retry: false,
  sygsp_success_notify: true,
  sygsp_blob_request_limit: 33554432, // 32MB
});

/** 平台配置文件中的独立键(仓库地址/分支/Token/邮箱按平台分文件保存,与旧版一致) */
export const PER_PLATFORM_KEYS = Object.freeze([
  "repository_address",
  "repository_branch",
  "submit_token",
  "submit_user_email",
]);

export class SettingUtils {
  /**
   * @param {object} opts {plugin, name, width, height, confirmCallback, destroyCallback}
   */
  constructor(opts) {
    this.plugin = opts.plugin;
    this.name = opts.name || "settings";
    this.file = this.name.endsWith(".json") ? this.name : this.name + ".json";
    /** @type {Map<string, object>} */
    this.settings = new Map();
    /** @type {Map<string, HTMLElement>} */
    this.elements = new Map();
    const q = opts.q;
    this.plugin.setting = new q.Setting({
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
      },
    });
  }

  async load() {
    const data = await this.plugin.loadData(this.file);
    if (data) {
      for (const [key, item] of this.settings) {
        if (data[key] !== undefined && data[key] !== null) item.value = data[key];
      }
    }
    return data || null;
  }

  async save(value) {
    return this.plugin.saveData(this.file, value || this.dump());
  }

  get(key) {
    const item = this.settings.get(key);
    return item ? item.value : undefined;
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
    return item ? item.value : undefined;
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
      createActionElement: () => element,
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
    else if (item.type !== "button" && item.type !== "hint") el.value = item.value === undefined || item.value === null ? "" : String(item.value);
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
        el.value = item.value === undefined || item.value === null ? "" : String(item.value);
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
        el.value = item.value === undefined || item.value === null ? "" : String(item.value);
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
}
