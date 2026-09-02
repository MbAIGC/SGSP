# DSF-M1.1「同步结果日志信息增强」实施验证总结

对应计划: [DSF-SGSP同步引擎重构实施计划.md](./DSF-SGSP同步引擎重构实施计划.md) 第 4.1 节(M1)的后续增强,版本仍为 SGSP 0.4.0。

## 背景

M1 上线后用户实测反馈:

1. token 配置正确,同步范围由「工作空间」调整为「笔记文件」后同步成功 —— **401 与 token 无关**,M1 的错误呈现机制未发现缺陷;
2. 前端运行日志信息过少:只知道「🔄 开始同步…」与「✅ 同步成功」,不知道**本次同步了哪些文件**;无文件变更时也不提示,用户误以为没有执行。

## 目标

- 成功且有文件操作:日志与通知显示「新增/更新/删除」文件数量摘要,日志另附具体路径明细;
- 成功但无文件操作:明确提示「未检测到文件变更,已停止同步」;
- 运行日志面板实时刷新(原为打开时的静态快照),同步进行中的新条目自动出现。

## 关键方案与落实

| 项 | 方案 | 落实 |
| --- | --- | --- |
| M1.1-01 文件操作统计 | `patch/apply-patch.mjs` 在两个 `addFileToWorkArea(t,s,i)` 方法体开头注入 `try{__gSyncFlow&&__gSyncFlow.trackFile(i,s&&s.path?s.path:"")}catch(e){}`(锚点数量断言 ==2);runtime 新增 `host.trackFile(op, path)` 按 create/update/delete 记录路径(每类上限 100) | 完成,注入后 `node --check` 通过 |
| M1.1-02 成功消息带摘要 | `runSync` 成功路径读取 `host.syncStats`:有变更 → `✅ 同步成功(新增 2, 更新 1, 删除 1)` + 日志明细行「本次同步文件: 新增 2 个 (data/a.sy, data/b.sy); …」;无变更 → `✅ 同步成功(未检测到文件变更,已停止同步)`;`sync:success` 事件新增 `fileStats` 字段,历史 message 同步携带摘要 | 完成 |
| M1.1-03 日志面板实时刷新 | `showRuntimeLogs` 打开 Dialog 后以 `setTimeout` 链每 1 秒重渲染 `#gSyncRuntimeLogBox` 内容;`destroyCallback` 置位 `closed` 停止刷新,避免定时器泄漏;空日志保留「暂无运行日志」占位 | 完成 |
| M1.1-04 i18n | 新增 5+5 键:`gSyncCreatedLabel`/`gSyncUpdatedLabel`/`gSyncDeletedLabel`/`gSyncFilesDetailLabel`/`gSyncNoChangeMsg`(zh/en),`patchJson` 幂等补齐,未覆盖已有键 | 完成 |

## 行为对照

| 场景 | 前端 toast | 运行日志面板 | sync:success 事件 |
| --- | --- | --- | --- |
| 同步成功 + 有文件操作 | `✅ 同步成功(新增 2, 更新 1, 删除 1)` | 成功行 + 「本次同步文件: …」明细行(每类前 5 个路径,超出以「等 N 个」省略) | `fileStats: {created, updated, deleted}` |
| 同步成功 + 无文件操作 | `✅ 同步成功(未检测到文件变更,已停止同步)` | 同 toast 文案一条 | `fileStats: {0,0,0}` |
| 同步失败 / 冲突 | 不变(M1 行为) | 不变 | 不变 |

成功 toast 仍受 `sgsp_sync_notify` 开关控制(默认开);失败与冲突通知不受该开关影响。

## 验证结果

- `node --test tests/sync-flow.test.mjs`: **31/31 通过**(28 个既有回归 + 3 个新增 M1.1 测试: 成功含文件统计 toast/日志/事件、无变更提示、日志面板实时刷新与关闭清理);
- `node patch/apply-patch.mjs`: 成功生成 index.js,注入锚点断言全部通过(两个 addFileToWorkArea、blob 预检、错误传播、设置项);
- `node --check index.js`: 语法通过;`grep` 确认 trackFile 注入恰好 2 处;
- `node smoke/verify.mjs`: **22/22 通过**,成功/失败/冲突路径不受影响;
- `i18n/zh_CN.json`、`i18n/en_US.json` 均含新增键,幂等补齐无覆盖。

## 已知限制

- 文件统计依赖 `addFileToWorkArea` 注入,统计的是**实际进入工作区提交**的文件操作;若同步在进入该方法前失败(如网络中断),本轮统计为空,不会出现误导性摘要(成功路径本身不会执行)。
- 路径明细每类最多展示前 5 个,超出以「等 N 个」省略,避免超大同步刷爆面板;完整数量仍显示在摘要中。
- 运行日志面板刷新间隔固定 1 秒,极端情况下(同步在 1 秒内完成)用户可能需等待一次刷新周期看到最终条目。
