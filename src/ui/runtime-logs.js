/**
 * RuntimeLogs: 运行日志(内存环形缓冲 + 面板展示)。
 * 记录同步关键事件与错误摘要(已脱敏),不包含 Token 等敏感信息。
 */

export class RuntimeLogs {
  constructor(limit = 200) {
    this.limit = limit;
    this.entries = [];
  }

  append(level, text) {
    this.entries.push({
      at: new Date().toISOString(),
      level,
      text: String(text).slice(0, 1000),
    });
    while (this.entries.length > this.limit) this.entries.shift();
  }

  info(text) {
    this.append("info", text);
  }

  error(text) {
    this.append("error", text);
  }

  render() {
    return this.entries
      .map((e) => "[" + e.at.replace("T", " ").slice(0, 19) + "] [" + e.level + "] " + e.text)
      .join("\n");
  }
}

/** 打开运行日志对话框 */
export function openLogsDialog({ q, i18n, logs }) {
  const dialog = new q.Dialog({
    title: (i18n && i18n.gSyncRuntimeLogsTitle) || "SY-GSP 运行日志",
    content: '<div style="padding:12px;display:flex;height:100%;"></div>',
    width: "720px",
    height: "60vh",
  });
  const root = dialog.element.firstElementChild;
  const textarea = document.createElement("textarea");
  textarea.className = "b3-text-field fn__flex-1";
  textarea.readOnly = true;
  textarea.style.fontFamily = "monospace";
  textarea.value = logs.render() || "暂无日志";
  root.appendChild(textarea);
}
