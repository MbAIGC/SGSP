# SGSP 同步严重数据丢失 Bug：错误将“本地不存在”判断为“本地删除”

## Bug 严重级别
**P0 / 数据安全问题**

## 问题现象
在两个或多个设备使用 SGSP 同步同一个 GitHub 仓库时，即使设备之间没有同时编辑同一个文档，也可能发生远端文档被错误删除。

典型场景：
1. GitHub 中存在 `C.sy`。
2. 设备 A 本地工作空间中没有 `C.sy`。
3. “本地不存在”可能是同步范围未包含、设备从未下载、本地状态不完整、新设备首次加入、文件枚举异常等原因。
4. SGSP 将 LOCAL 不存在直接解释为用户删除。
5. SGSP 将 DELETE 上传到 GitHub。
6. GitHub 中原本存在的 `C.sy` 被错误删除。

这是错误删除/数据丢失，不是普通同步冲突。

## 根本问题
必须区分：
- `LOCAL 没有文件`
- `用户主动删除了文件`

二者不能等价。

## 正确的同步语义

| BASE | LOCAL | REMOTE | 正确判断 |
|---|---|---|---|
| 不存在 | 不存在 | 存在 | 远端新增 → 下载，绝不能删除 REMOTE |
| 存在 | 不存在 | 存在 | 可以判断为本地相对于 BASE 删除 |
| 存在 | 存在 | 不存在 | 远端相对于 BASE 删除 |
| 存在 | 修改 | 未修改 | 上传 LOCAL |
| 存在 | 未修改 | 修改 | 下载 REMOTE |
| 存在 | 修改 | 修改 | 三方合并；无法安全合并则冲突 |
| 不存在 | 存在 | 存在 | 双方新增 → 比较内容；不同则冲突/合并 |

## 最重要的安全规则

> **LOCAL 文件不存在 ≠ LOCAL 删除。**

只有能够证明：

```text
BASE 中存在该文件
AND
LOCAL 从 BASE 的“存在”状态变成“不存在”
```

才能解释为本地删除。

如果 BASE 无法确定：

> **禁止自动生成删除操作。**

宁可同步失败或提示用户确认，也不能自动删除远端。

## 特别注意同步范围

不在当前同步范围中的文件，绝不能因为 LOCAL 枚举不到就判断为用户删除。

例如 GitHub：

```text
notebook/
├── A.sy
├── B.sy
└── C.sy
```

如果当前同步范围不包含 `C.sy`，则不能生成：

```text
delete C.sy
```

## 重点检查代码路径

```text
syncDataToCloud()
        ↓
handleAutoRemoteAndLocalFileSync()
        ↓
lastSyncCommit / BASE
        ↓
compareCommitFiles()
        ↓
本地文件枚举
        ↓
workArea
        ↓
本地/远端文件状态判断
        ↓
createTree / createBlob
        ↓
commitAndPushFileToRemote()
```

重点寻找任何将“LOCAL 文件集合缺失”直接转换为 DELETE operation 的逻辑，例如：

```js
if (!localFile) {
    deleteRemoteFile();
}
```

或：

```js
if (!localFiles.has(path)) {
    changes.push({ path, type: 'delete' });
}
```

## 修复要求

建立明确的：

```text
BASE
LOCAL
REMOTE
```

三方状态模型。

每个文件应得到：

```text
ADDED
MODIFIED
DELETED
UNCHANGED
CONFLICT
UNKNOWN
```

其中 `UNKNOWN` 非常重要。

无法确定是：
- 真正删除；
- 本地没有同步到；
- 不属于当前同步范围；
- 本地状态缺失；

时必须进入 `UNKNOWN`，而不是 `DELETED`。

> **UNKNOWN 状态禁止产生远端删除操作。**

## 验收测试

### Test 1：远端新增不能被本地缺失覆盖

```text
BASE   = 无 C.sy
LOCAL  = 无 C.sy
REMOTE = 有 C.sy
```

预期：
```text
REMOTE C.sy 仍存在
LOCAL C.sy 被下载
```

### Test 2：真正的本地删除

```text
BASE   = 有 C.sy
LOCAL  = 无 C.sy
REMOTE = 有 C.sy
```

必须能够识别为本地删除。

### Test 3：同步范围外文件不能被删除

```text
REMOTE = 有 C.sy
LOCAL sync scope = 不包含 C.sy
```

预期：
```text
REMOTE C.sy 仍然存在
```

### Test 4：新设备加入

新设备第一次同步，本地没有远端已有文件。

预期：
```text
不能生成错误 DELETE 操作
```

### Test 5：BASE 丢失

如果本地无法确定 BASE：

```text
禁止自动删除远端文件
```

## 最终目标

> **数据安全优先于同步成功率。**

同步系统宁可：

```text
FAILED
```

也不能：

```text
SUCCESS
但实际上删除了用户数据
```

核心原则：

> **未知 ≠ 删除。**
