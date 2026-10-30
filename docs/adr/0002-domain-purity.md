# ADR 0002 · 领域层纯度与"失败即值"

- 状态：已采纳（P1）
- 日期：2026-10-30
- 关联：设计文档 §1（脆弱点）、§17.1（错误分类）、§18（状态矩阵）

## 背景

流程里有三类必须"不可绕过"的约束：

1. 只有人点通过之后才能写 wiki；
2. 任何失败都必须落成可观测的状态，而不是异常、日志或悬空文件；
3. 同一历史事件重放必须得到同一状态。

如果这些约束靠"开发者记得"，它们一定会在半年后失效。

## 决策

### 1. 失败是值，不是异常

领域层所有可预期的失败都返回 `Result<T, DomainError>`：

```ts
const result = transition(from, event, ctx);
if (!result.ok) {
  // 处理 INVALID_TRANSITION / BLOCK_FINDINGS_PRESENT / TARGET_MOVED ...
}
```

- 好处：状态迁移可以被穷举测试；"非法迁移"是**数据**，可以打印、可以 `explain`、可以计数。
- 代价：调用方必须显式分支；边界脚本禁止 `throw`（`src/domain` 内出现即 CI 失败）。

### 2. 时间与随机性一律注入

```ts
transition(from, event, { now: '2026-10-30T22:00:00+08:00', targetHashesUnchanged: true })
```

- 边界脚本禁止 `Date.now()`、`new Date()`、`Math.random()`。
- 好处：`applyEvents()` 回放可以逐字段比对；测试不需要 mock 时钟。
- 代价：每个用例都要传 `ctx`。

### 3. 标识符用品牌类型

`RawPath` / `DraftId` / `CommitSha` / `ContentHash` 都是 `string & { brand }`，只能通过 `parse*()` 构造（返回 `Result`）。

- 好处：把"随便一个字符串"挡在领域层外；路径穿越、绝对路径、错误 id 格式在边界就被拒。
- 代价：测试夹具需要集中构造（见 `test/helpers.ts`）。

### 4. 规则与实体分离

预警不是写在状态机里，而是独立规则：`RuleInput`（只读快照）→ `Finding | null`。

- 好处：每条规则可单独测试；未来 UI 直接渲染 `findings`；`sb explain` 可以逐条打印"规则 → 输入 → 结论"。
- 代价：`RuleInput` 需要应用层把"节点索引、raw 存在性、队列快照"一次性备齐。

## 强制手段

| 约束 | 工具 |
|---|---|
| 禁止 `throw` / 时钟 / 随机数 / `node:` / 第三方包 | `scripts/check-boundaries.mjs` |
| 依赖方向、环形依赖 | `.dependency-cruiser.cjs` |
| 状态矩阵与规格一致 | `test/state-matrix.test.ts`（手抄 §18 做双重记账） |
| 规则行为 | `test/rules.test.ts`（每条规则至少三例） |

## 后果

- 领域层可以在没有 Node、没有数据库、没有模型的环境里运行与测试（当前 67 例测试 300ms 内跑完）。
- P2/P3 适配器写错不会污染领域；换模型/换存储只影响适配器。
- 新增状态或事件时必须同时改三处（表、switch、测试手抄表）——这是**有意的摩擦**，用来防止状态机被随手扩张。
