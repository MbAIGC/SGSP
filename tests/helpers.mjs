/** 测试公共工具: 假插件实例(内存版 saveData/loadData)与内存内核 */

export function makeFakePlugin(opts = {}) {
  const store = opts.store || {};
  return {
    i18n: {},
    data: {},
    async saveData(name, payload) {
      if (opts.failSave) throw new Error("模拟写入失败");
      store[name] = JSON.parse(JSON.stringify(payload));
      return true;
    },
    async loadData(name) {
      return store[name] !== undefined ? JSON.parse(JSON.stringify(store[name])) : null;
    },
    __store: store,
  };
}

/** 内存文件系统内核(模拟思源 kernel 文件 API) */
export function makeFakeKernel(initial = {}) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set();

  function ensureDir(path) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }

  return {
    async getFile(path) {
      if (!files.has(path)) return null;
      return new Blob([files.get(path)]);
    },
    async putFile(path, blob, isDir = false) {
      if (isDir) {
        dirs.add(path);
        return { code: 0 };
      }
      ensureDir(path);
      files.set(path, new Uint8Array(await blob.arrayBuffer()));
      return { code: 0 };
    },
    async removeFile(path) {
      if (!files.delete(path)) throw new Error("文件不存在: " + path);
      return { code: 0 };
    },
    async readDir(path) {
      const prefix = path === "" ? "" : path.replace(/\/$/, "") + "/";
      const seen = new Map();
      let enumerated = false;
      for (const name of files.keys()) {
        if (!name.startsWith(prefix) || name === prefix) continue;
        enumerated = true;
        const rest = name.slice(prefix.length);
        const seg = rest.split("/")[0];
        const isDir = rest.includes("/");
        seen.set(seg, { name: seg, isDir, updated: Math.floor(Date.now() / 1000) });
      }
      for (const d of dirs) {
        if (d.startsWith(prefix) && d !== path) {
          enumerated = true;
          const rest = d.slice(prefix.length);
          const seg = rest.split("/")[0];
          if (seg) seen.set(seg, { name: seg, isDir: true, updated: Math.floor(Date.now() / 1000) });
        }
      }
      if (!enumerated && !files.has(path) && !dirs.has(path)) throw new Error("目录不存在: " + path);
      return [...seen.values()];
    },
    async exportMdContent(id) {
      const key = [...files.keys()].find((k) => k.includes(id));
      if (!key) throw new Error("文档不存在: " + id);
      const text = new TextDecoder().decode(files.get(key));
      return { content: "---\ntitle: x\n---\n# " + id + "\n" + text };
    },
    async updateBlock(dataType, data, id) {
      const key = [...files.keys()].find((k) => k.includes(id));
      if (key) files.set(key, new TextEncoder().encode(data));
      return { code: 0 };
    },
    async getBlockKramdown(id) {
      return { id, kramdown: "# " + id + "\n{kramdown}" };
    },
    async sql() {
      return [];
    },
    async lsNotebooks() {
      const notebooks = new Set();
      for (const name of files.keys()) {
        const m = /^data\/(\d{14}-[a-z0-9]{7})\//.exec(name);
        if (m) notebooks.add(m[1]);
      }
      return { notebooks: [...notebooks].map((id) => ({ id, name: id })) };
    },
    async createDocWithMd() {
      return { code: 0 };
    },
    async createDoc() {
      return { code: 0 };
    },
    async createNotebook(name) {
      return { notebook: { id: name, name } };
    },
    async refreshFiletree() {
      return { code: 0 };
    },
    __files: files,
  };
}
