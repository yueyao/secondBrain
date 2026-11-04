# 领域层参考手册（P1）

> 面向后续开发者的"最小必要知识"：状态、迁移、守卫、规则、策略。
> 完整依据见 `../../secondBrain-服务端详细设计-v2.md`。

---

## 1. 分层与依赖

```
packages/domain      @sb/domain     纯领域（零 I/O、零依赖）
packages/contracts   @sb/contracts  端口 + DTO（只依赖 domain）
packages/adapters-*  P2+            实现端口
apps/*               P5+            入口
```

强制手段（两道，缺一不可）：

| 手段 | 检查什么 | 命令 |
|---|---|---|
| `scripts/check-boundaries.mjs` | 源码级：禁止 `node:`、第三方包、domain 外相对路径、`throw`、`Date.now`、`Math.random` | `npm run boundaries` |
| `.dependency-cruiser.cjs` | 图级：依赖方向、环形依赖、孤立模块 | `npm run depcruise` |

---

## 2. 状态模型

状态是**可辨识联合**（`packages/domain/src/model/raw-state.ts`），不是字符串：

| kind | 含义 | 携带数据 |
|---|---|---|
| `ingested` | 已摄取，未筛选 | — |
| `triaged` | 已分档，未入队 | — |
| `quarantined` | 输入不可用（隔离） | `reason` |
| `queued` | 待加工 | `triage` |
| `drafting` | 起草中 | `draftId / triage / startedAt` |
| `draft_ready` | 草稿就绪，待审 | `draftId / triage / findings` |
| `in_review` | 人已打开审阅 | `+ openedAt` |
| `changes_requested` | 人要求修改 | `+ note` |
| `approved` | 人已通过 | `+ actor / approvedAt` |
| `committing` | 提交中（两阶段） | `+ intentId / preCommitSha` |
| `committed` | 已入库（终态） | `+ commitSha` |
| `rejected` | 已驳回（终态） | `reason / auto` |
| `deferred` | 延后/放弃 | `reason / triage` |
| `rolled_back` | 提交失败已回滚 | `reason / attempts` |
| `failed` | 处理失败 | `errorClass / code / attempts` |
| `blocked` | 需人工介入 | `reason / triage` |
| `expired` | 过期（终态） | `from` |
| `abandoned` | 被 canonical 取代（终态） | `canonicalRawPath / note` |

**终态**：`committed / rejected / expired / abandoned`，不接受任何事件。

---

## 3. 迁移表（与 §18 一致，由矩阵测试锁定）

| 状态 | 事件 → 目标 |
|---|---|
| `ingested` | `INGESTED`→`triaged`；`QUARANTINE`→`quarantined` |
| `triaged` | `TRIAGE_QUEUED`→`queued`；`TRIAGE_LOW`→`deferred`；`TRIAGE_LONG`→`deferred`；`TRIAGE_SCOPE`→`deferred` |
| `quarantined` | `UNBLOCK`→`triaged` |
| `queued` | `DRAFT_START`→`drafting`；`DEFER`→`deferred` |
| `drafting` | `DRAFT_OK`→`draft_ready`；`DRAFT_FAIL`→`failed`；`DRAFT_REFUSAL`→`rejected`；`LEASE_LOST`→`queued` |
| `draft_ready` | `REVIEW_OPEN`→`in_review`；`SUPERSEDE`→`abandoned`；`EXPIRE`→`expired` |
| `in_review` | `ACCEPT`→`approved`；`REJECT`→`rejected`；`REQUEST_CHANGES`→`changes_requested`；`DEFER`→`deferred`；`EXPIRE`→`deferred` |
| `changes_requested` | `DRAFT_START`→`drafting` |
| `approved` | `COMMIT_INTENT`→`committing` |
| `committing` | `COMMIT_OK`→`committed`；`COMMIT_FAIL`→`rolled_back` |
| `rolled_back` / `failed` | `RETRY`→`queued` |
| `blocked` | `UNBLOCK`→`queued`；`ABANDON`→`abandoned` |
| `deferred` | `RETRY`→`queued` |
| `committed` / `rejected` / `expired` / `abandoned` | 无 |

### 守卫（"允许迁移"≠"迁移成功"）

| 守卫 | 触发条件 | 错误码 |
|---|---|---|
| 无阻断预警 | `in_review` + `ACCEPT` 时存在 `severity: block` 的 finding | `BLOCK_FINDINGS_PRESENT` |
| 目标未变 | `approved` + `COMMIT_INTENT` 时 `targetHashesUnchanged === false` | `TARGET_MOVED` |
| 守卫输入必须显式 | 同上但未提供该输入（禁止"默认通过"） | `GUARD_MISSING_CONTEXT` |
| 重试未超限 | `RETRY` 时 `max(状态 attempts, 事件 attempts) >= 3` | `RETRY_EXHAUSTED` |
| 可回到队列 | `deferred / failed / blocked` 缺少 `triage` | `MISSING_TRIAGE` |

### 错误码

| 码 | 含义 |
|---|---|
| `INVALID_TRANSITION` | 表外组合（detail 里带 `from / event / allowed`） |
| `INTERNAL_TRANSITION_GAP` | 表里有、switch 没实现（矩阵测试会先炸） |
| `BLOCK_FINDINGS_PRESENT` | 有阻断预警 |
| `TARGET_MOVED` | 提交前目标节点被改过 |
| `GUARD_MISSING_CONTEXT` | 缺少守卫输入 |
| `RETRY_EXHAUSTED` | 重试超限，转人工 |
| `MISSING_TRIAGE` | 状态缺 triage，无法回队列 |

---

## 4. 预警规则（10 条）

规则是**纯函数 + 显式输入**（`RuleInput` 只读快照），输出 `Finding`。

| ruleId | 级别 | 命中条件 | 为什么要它 |
|---|---|---|---|
| `r-source-disabled` | block | `sourceKey` 不在 `enabledSources` | source-scope 闸门 |
| `r-source-already-digested` | block | 同一 raw 已 `committed` | 防重复入库 |
| `r-event-already-digested` | block | 同 `eventId` 的另一来源已 `committed` | **重复源拦截（试跑 35% 失败来源）** |
| `r-new-node-name-taken` | block | 新建节点与现有名称/别名相同 | 防制造重复节点 |
| `r-patch-target-missing` | block | patch 目标不存在 | 防"静默变新建" |
| `r-source-exists` | block | claim 的 `source` 不在已知 raw 集合 | 防断链 |
| `r-claim-count` | block / warn | 超上限 → block；低于下限 → warn | 档位配额不自洽 |
| `r-event-in-queue` | warn | 同事件在队列中 | 提示先处理信息量大的那份 |
| `r-near-duplicate-node` | warn | 新建节点与现有节点 Dice ≥ 0.5 | 提示可能应并入 |
| `r-inferred-claims` | warn | 存在 `inference: true` 的 claim | 事实与推断分离 |

`evaluateAll(input)` 按 `block → warn → ok` 排序；`hasBlock()` / `summarizeSeverity()` 给应用层做闸门。

> 与设计文档 §4.3 的差异：多出 `r-source-disabled`（设计稿把它放在配置层，实现时下沉为规则，避免应用层自觉）。

---

## 5. 策略（带版本）

| 策略 | 版本 | 输入 | 输出 |
|---|---|---|---|
| `triage-policy` | v1 | `judgments`（判断句数）、`charCount` | `{status, score, reasons[], policyId, policyVersion}` |
| `long-text-policy` | v1 | `charCount` | `isTooLong`（默认阈值 60,000 字） |
| `tier-policy` | v1 | `tier`、`claimCount` | `ok / below_min / above_max` |

档位配额：`patch 1-25`、`standard 1-25`、`accelerated 1-12`、`full 1-60`。

---

## 6. 不变式（改代码前请先读）

1. **状态只能通过 `transition()` 改变**；`ALLOWED_TRANSITIONS` 是唯一事实来源。
2. **失败是值，不是异常**：领域层不 `throw`。
3. **时间与随机性由外部注入**：`ctx.now`；id 由应用层生成。
4. **领域层不做 I/O**：raw 是否存在、节点是否存在，全部由应用层解析后传入。
5. **规则之间不互相依赖**：每条规则独立求值，顺序只影响展示。
6. **新增规则必须**：写规则文件 → 注册到 `registry.ts` → 在 `test/rules.test.ts` 补"命中/不命中/边界"三例。
7. **新增状态或事件必须**：改 `ALLOWED_TRANSITIONS` → 改 `state-machine.ts` → **同时改 `test/state-matrix.test.ts` 的手抄表**（否则测试失败是预期行为）。
8. **改策略行为必须升版本号**，并更新 `docs/PROGRESS.md` 的决策日志。

---

## 7. 常用命令

```bash
pnpm run boundaries   # 包边界与纯度检查
pnpm run typecheck    # tsc --noEmit（strict）
pnpm run depcruise    # 依赖图规则
pnpm test             # vitest（74 例，2 个包）
pnpm run check        # 以上全部（CI 用）
```
