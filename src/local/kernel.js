/**
 * 思源内核 API 封装。
 * 全部本地文件读写走内核 HTTP 接口(桌面/移动/浏览器前端通用),不依赖 Node。
 * 抽象为独立对象便于测试替身注入。
 */

export function createKernel(q) {
  async function post(path, data) {
    if (q && typeof q.fetchSyncPost === "function") {
      const res = await q.fetchSyncPost(path, data);
      if (res && typeof res.code === "number" && res.code !== 0) {
        throw new Error("内核请求失败 " + path + ": " + (res.msg || res.code));
      }
      return res && res.data !== undefined ? res.data : res;
    }
    const resp = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data || {}),
    });
    if (!resp.ok) throw new Error("内核请求失败 " + path + ": HTTP " + resp.status);
    const text = await resp.text();
    try {
      const json = JSON.parse(text);
      if (json && json.code && json.code !== 0) throw new Error("内核请求失败 " + path + ": " + (json.msg || json.code));
      return json && json.data !== undefined ? json.data : json;
    } catch (e) {
      if (e instanceof SyntaxError) return text;
      throw e;
    }
  }

  async function getFile(path) {
    const resp = await fetch("/api/file/getFile", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
    return resp.ok ? resp.blob() : null;
  }

  async function putFile(path, blob, isDir = false) {
    const form = new FormData();
    form.append("path", path);
    form.append("isDir", String(isDir));
    form.append("modTime", String(Date.now()));
    form.append("file", blob);
    const resp = await fetch("/api/file/putFile", { method: "POST", body: form });
    if (!resp.ok) throw new Error("写入本地文件失败 " + path + ": HTTP " + resp.status);
    return resp.json();
  }

  async function removeFile(path) {
    return post("/api/file/removeFile", { path });
  }

  /** 目录枚举: 统一返回 [{name,isDir,updated}] */
  async function readDir(path) {
    const data = await post("/api/file/readDir", { path });
    if (Array.isArray(data)) return data; // 测试替身直接返回数组
    const dirs = Array.isArray(data && data.dir) ? data.dir : [];
    const files = Array.isArray(data && data.file) ? data.file : [];
    return dirs.concat(files);
  }

  return {
    post,
    getFile,
    putFile,
    removeFile,
    readDir,
    exportMdContent: (id) => post("/api/export/exportMdContent", { id }),
    createDocWithMd: (notebook, path, markdown) => post("/api/filetree/createDocWithMd", { notebook, path, markdown }),
    createDoc: (notebook, path, title, md) => post("/api/filetree/createDoc", { notebook, path, title, md, listDocTree: false }),
    updateBlock: (dataType, data, id) => post("/api/block/updateBlock", { dataType, data, id }),
    getBlockKramdown: (id) => post("/api/block/getBlockKramdown", { id }),
    sql: (stmt) => post("/api/query/sql", { stmt }),
    lsNotebooks: () => post("/api/notebook/lsNotebooks", {}),
    createNotebook: (name) => post("/api/notebook/createNotebook", { name }),
    getNotebookConf: (notebook) => post("/api/notebook/getNotebookConf", { notebook }),
    refreshFiletree: () => post("/api/filetree/refreshFiletree", {}),
  };
}
