/**
 * MenuBuilder: 顶栏菜单(条目与旧版一致)。
 * 不承载业务逻辑,只组织入口与回调。
 */

export function buildTopBarMenu({ q, plugin, i18n, actions, conflictPaused }) {
  const t = i18n;
  const menu = new q.Menu("SY-GSP", true);

  if (conflictPaused) {
    menu.addItem({
      iconHTML: "",
      label: (t.sygspMenuResolveConflict) || "🔴 处理冲突/恢复同步",
      click: actions.resolveConflict,
    });
    menu.addSeparator();
  }

  menu.addItem({
    iconHTML: "",
    label: t.startSync,
    icon: "iconRefresh",
    click: actions.startSync,
  });
  const refresh = menu.addItem({
    iconHTML: "",
    label: t.refreshOrRecover,
    icon: "iconRefresh",
    type: "submenu",
  });
  refresh.addItem({
    iconHTML: "",
    label: t.refreshWSTree,
    icon: "iconRefresh",
    click: actions.refreshWorkspaceTree,
  });
  refresh.addItem({
    iconHTML: "",
    label: t.recoverAssets,
    icon: "iconImage",
    click: actions.recoverAssets,
  });

  const range = menu.addItem({
    iconHTML: "",
    label: t.syncRange,
    icon: "iconFilter",
    type: "submenu",
  });
  addRadioItems(range, t.syncRange, [
    ["0", t.workSpace],
    ["1", t.dataFile],
    ["2", t.noteFile],
  ], "sync_range", actions);

  const strategy = menu.addItem({
    iconHTML: "",
    label: t.syncStrategy,
    icon: "iconSettings",
    type: "submenu",
  });
  addRadioItems(strategy, t.syncStrategy, [
    ["0", t.autoSyncStrategy],
    ["1", t.selectUpload],
    ["2", t.keepRemoteCover],
    ["3", t.keepLocalCover],
  ], "sync_strategy", actions);

  const fileType = menu.addItem({
    iconHTML: "",
    label: t.noteType,
    icon: "iconFile",
    type: "submenu",
  });
  addRadioItems(fileType, t.noteType, [
    ["0", t.siyuanFile],
    ["1", t.markdownFile],
  ], "sync_file_type", actions);

  const mode = menu.addItem({
    iconHTML: "",
    label: t.syncMode,
    icon: "iconClock",
    type: "submenu",
  });
  addRadioItems(mode, t.syncMode, [
    ["0", t.autoSync],
    ["1", t.manualSync],
    ["2", t.fullManualSync],
  ], "sync_mode", actions);

  menu.addSeparator();
  menu.addItem({
    iconHTML: "",
    label: t.syncHistory,
    icon: "iconHistory",
    click: actions.openHistory,
  });
  menu.addItem({
    iconHTML: "",
    label: (t.sygspMenuLogs) || "运行日志",
    icon: "iconInfo",
    click: actions.openLogs,
  });
  menu.addItem({
    iconHTML: "",
    label: t.sygspMenuDiagnosis || "只读诊断",
    icon: "iconHeart",
    click: actions.openDiagnosis,
  });
  menu.addSeparator();
  menu.addItem({
    iconHTML: "",
    label: t.setting,
    icon: "iconSettings",
    click: actions.openSettings,
  });
  return menu;
}

function addRadioItems(parent, title, options, settingKey, actions) {
  const current = String(parent ? actions.getSetting(settingKey) : "");
  for (const [value, label] of options) {
    parent.addItem({
      iconHTML: current === value ? "iconSelect" : "",
      label,
      click: async () => {
        await actions.setSettingAndSave(settingKey, Number(value));
      },
    });
  }
}
