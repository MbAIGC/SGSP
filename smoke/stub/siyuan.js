/**
 * siyuan SDK stub — 仅用于端到端冒烟验证(smoke/verify.mjs)。
 * 模拟插件运行时需要用到的 siyuan SDK API。
 */

class Plugin {
  constructor() {
    this.name = "GIT-SYNC-PLUGIN";
    this.i18n = {};
    this.data = {};
  }
  loadData() {
    return Promise.resolve(null);
  }
  saveData() {
    return Promise.resolve();
  }
  addTopBar() {
    return { classList: { add() {}, remove() {} }, querySelector() { return null; }, setAttribute() {} };
  }
  addIcons() {}
}

module.exports = {
  Plugin,
  Dialog: class {
    constructor() {
      this.element = { querySelector() { return { addEventListener() {} }; } };
    }
    destroy() {}
  },
  Menu: class {
    constructor() {}
    addItem() {}
    open() {}
    fullscreen() {}
  },
  showMessage() {},
  confirm() {},
  getFrontend() { return "desktop"; },
  fetchSyncPost() { return Promise.resolve({ code: 0, data: null }); },
  fetchPost() {},
  openTab() {},
  split() {},
  Setting: class {
    addItem() {}
  },
};