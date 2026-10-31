# ADR 0006 · 简化版崩溃恢复（幂等重放，不做对账器）

- 状态：已采纳并实现
- 日期：2026-10-31
- 关联：设计文档 §9/§19、ADR 0005

## 背景

原始 P5 方案是完整的两阶段提交 + 启动对账：

- 新增 `commit_intent` 表记录"打算提交什么"；
- 启动时按 8 个崩溃点逐一判定（已提交 / 未提交 / 不可判定）；
- 不可判定时拒绝启动。

这套方案正确，但**实现与测试成本偏高**，且对单写者、单人使用的系统来说过度设计。

用户提出的替代思路：**"失败了就不写入、不覆盖；用规则绕过对账。"**

## 决策

不做 `commit_intent` × 8 崩溃点矩阵，改为 **幂等重放 + 失败即停**。

### 五条规则

1. **原子写**：临时文件 + rename（已有），不会出现半写文件。
2. **写前比对**：起草时记录目标文件的 sha256；accept 时若文件已变 → 拒绝覆盖（`TARGET_MOVED`）。
3. **提交带 draftId**：`digest: <raw> [draft-xxxx]`，作为"是否已提交"的幂等依据。
4. **两阶段状态**：先落 `approved`（durable，含决策记录），再写文件 + commit，最后落 `committed`。任一步失败，DB 停在 `approved`。
5. **启动只做重放**：把 `approved` 的草稿重新走一遍 `commitApproved`——
   - 文件内容已一致 → 跳过写；
   - 最近一次 commit 带该 `draftId` → 只补 DB 状态，不再提交；
   - 无关脏改动 / 仍有未提交内容 → **拒绝启动**并提示人工处理。

### 崩溃场景的收敛

| 崩溃点 | 重放结果 |
|---|---|
| 写完文件、未 commit | `git add` 已有差异 → 补 commit |
| commit 成功、DB 未更新 | 识别 commit message 中的 draftId → 只更新 DB |
| 只写了临时文件 | 目标文件未变、临时文件被忽略 → 正常重写 |
| 目标文件被外部修改 | 基线 hash 不匹配 → `TARGET_MOVED`，回滚到 `rolled_back`，**不覆盖** |
| 未知脏改动且无待恢复草稿 | `DIRTY_VAULT`，拒绝启动 |
| 回滚后仍有脏改动 | 拒绝启动（要求 `git checkout -- .`） |

## 代价（明确接受）

- 不自动处理"HEAD 被外部移动到未知提交"——拒绝启动，人工判断；
- 不自动合并外部对 wiki 的修改——拒绝覆盖，交给人；
- 极端情况下（重放时再次崩溃）会在下次启动继续重放，但不会重复写或重复提交（幂等）。

## 实现

| 位置 | 改动 |
|---|---|
| `@sb/contracts` | `HashPort`（应用层不读 Node 全局）、`DraftRecord.targetHashes`、`VaultReader.lastCommitMessage()` |
| `@sb/adapters-sqlite` | 迁移 v3：`draft.target_hashes` |
| `@sb/adapters-vault` | `lastCommitMessage()` |
| `@sb/app` | `decideReview` 拆为"批准"与 `commitApproved` 两阶段；新增 `recoverPending()`；`markRolledBack()` |
| `@sb/server` | 启动时 `recoverPending()`，失败即拒绝启动 |

## 验证

`packages/app/test/recovery.test.ts` 四个场景（不注入 SIGKILL，直接构造半成品状态）：

1. 文件已写、无 commit → 重放补 commit；
2. commit 已存在、DB 仍 approved → 只更新 DB，HEAD 不变；
3. 无待恢复草稿但工作区脏 → `DIRTY_VAULT` 拒绝启动；
4. 目标文件被改 → `TARGET_MOVED`，外部改动保留、状态回滚。

另外用真实 server 启动验证了：干净工作区正常启动；人为脏改动拒绝启动并打印明确指引。

## 何时升级为完整对账

出现以下任一情况再引入 `commit_intent`：

- 支持多写者/多进程；
- 需要"崩溃后自动判定未知提交"而不想人工介入；
- 提交涉及跨仓库/外部系统（无法靠 git 事实判定）。
