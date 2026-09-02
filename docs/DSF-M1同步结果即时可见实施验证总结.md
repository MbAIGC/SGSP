# DSF-M1「同步结果即时可见」实施验证总结

对应计划: [DSF-SGSP同步引擎重构实施计划.md](./DSF-SGSP同步引擎重构实施计划.md) 第 4.1 节(M1, SGSP 0.4.0)。

## 一、本轮要解决的问题

原插件同步过程对用户完全不可见: 开始/成功没有任何前端反馈,
失败也只在思源 `temp/git-sync.log` 里留下 `S.error` 日志,用户等很久后去翻日志才知道出错,
且错误信息千奇百怪、没有分类,难以判断该自己改配置还是重试。

## 二、问题定位

- 失败路径: 原 `runSync` 的 catch 只 `addLog("error", "同步失败: " + message)` +
  `notify("❌ 同步失败: " + message)` —— 有 toast,但 message 只取 cause 链中
  「第一个带 status 的节点」的消息,丢失更具体的底层信息;错误无分类,用户无法判断
  是 Token 问题还是网络问题。
- `formatErrorSummary` 的脱敏正则写成 `/Bearer\\s+[^\\s]+/gi`(正则字面量内双反斜杠),
  实际匹配的是字面量 `\s` 文本,Token 脱敏形同虚设。
- 成功/开始: 完全没有通知。
- 冲突错误 `Mr`(code 300)只提取单个文件,一轮同步多文件冲突时只提示一个。
- 持久化失败被静默吞掉(`.catch(function () {})`),状态保存失败用户无从知晓。

## 三、解决方案与落实

全部落实在 `src/sync-flow-runtime.js`(注入式运行时)+ `patch/apply-patch.mjs`(构建注入):

| 计划项 | 方案 | 落实 |
| --- | --- | --- |
| M1-01 开始/成功/失败即时通知 | 手动触发 toast「🔄 开始同步…」;成功 toast「✅ 同步成功」(受 `sgsp_sync_notify` 开关控制,默认开);失败 toast「❌ 同步失败: <摘要>(<分类文案>)」 | `runSync` 改造完成 |
| M1-02 错误分类器 | `classifyError(err)` 遍历 cause 链,按 status/文本特征分类: AUTH/PERMISSION/REPOSITORY/BRANCH/CONFLICT/PUSH_REJECTED/BLOB_LIMIT/GIT_API/NETWORK/UNKNOWN,附 `retryable`/`recoverable` 决策字段 | 模块级导出 + 挂载 `host.classifyError` |
| M1-03 错误摘要增强 + 脱敏 | `getErrorSummary` 遍历**完整** cause 链,同时保留最外层 HTTP 状态、最具体文件路径、最底层消息;`redactText` 修复双反斜杠 bug,Bearer token/token 值统一隐藏 | 完成,新增脱敏单测 |
| M1-04 同步历史 | `git-sync-history.json` 环形保留 50 条,条目含 operationId/state/category/message/fileCount;持久化失败 addLog + notify,不静默 | `addHistoryEntry` + `onAfterLoad` 恢复 |
| M1-05 多冲突 | `extractConflictInfo` 收集 cause 链中**全部** code===300 节点,弹窗标题与通知显示「N 个文件」,对话框内列出前 10 个;旧持久化数据(单文件字段)自动迁移 | 完成 |
| M1-06 事件总线 | `createEventBus`(on/off/emit,订阅者异常隔离),`host.events` 挂载;事件: sync:start/success/error/conflict/paused/resumed/history | 完成 |
| M1-07 设置面板 + 版本 | git/cloud 两个设置面板各注入 `sgsp_sync_notify`(默认开)、`sgsp_auto_retry`(默认关,行为 M2 启用)checkbox;i18n 补 8+8 键;版本 0.3.01 → 0.4.0 | `apply-patch.mjs` 锚点注入(count==2 断言)完成 |

## 四、验证结果

1. 单元测试 `node --test tests/sync-flow.test.mjs`:**28/28 通过**
   (16 个既有回归 + 12 个新增 M1 测试: 事件总线、classifyError 全分类、
   摘要链遍历、成功/失败/冲突通知、成功通知开关、自动定时不轰炸、
   多冲突收集与迁移、历史环形上限与重启恢复、持久化失败可观测、脱敏)。
2. 端到端冒烟 `node smoke/verify.mjs`(加载构建产物 index.js + siyuan stub):
   **22/22 通过**,新增非冲突失败路径断言(FAILED + 分类通知 + sync:error 事件 + 历史条目)
   与成功路径断言(SUCCESS + 成功通知 + 历史)。
3. 构建: 在隔离副本与仓库根目录各跑一次 `node patch/apply-patch.mjs`,
   两次生成的 `index.js` diff 一致;`node --check index.js` 通过;
   设置面板注入锚点数量断言(==2)通过。
4. 语法约束: runtime 注入代码无可选链/模板字符串/`??`,`node --check` 通过。

## 五、兼容性说明

- 既有 16 个测试全部保持绿色,行为契约未破坏: 冲突错误仍走 `handleConflict`
  (暂停+弹窗+徽标+持久化);「正在同步中」良性错误不改变状态;非冲突错误仍重抛
  给原异常处理器(但 toast 文案追加了分类标签)。
- 自动定时触发不再 toast「开始同步」(避免轰炸),但成功/失败结果仍会通知 ——
  符合「用户要知道结果」的原始诉求。
- `sgsp_auto_retry` 开关已就位但 M1 不触发任何重试行为,按计划由 M2 启用。
- 旧持久化数据(无 `conflicts` 字段)加载时自动迁移,不丢暂停状态。

## 六、未解决事项

- `sgsp_auto_retry` 的实际重试逻辑属 M2(状态机/错误基础设施之后),本期只落开关与分类字段。
- 同步历史目前只有运行时面板可见性(菜单「同步历史」),文件列表/失败重试按钮等
  增强交互留在后续里程碑。
