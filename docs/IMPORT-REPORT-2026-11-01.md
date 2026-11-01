# Legacy 导入 dry-run 报告 · 2026-11-01（修订版）

> 目的：在写任何状态之前，把旧 vault 的处理记录与新系统对账，回答"哪些已处理、哪些待办、哪些不能直接导入"。
> 本次**只读**：未写 SQLite、未改任何文件、未动 git。
> 修订说明：初版误用"文件字节数"判断长文（中文 1 字符 ≈ 3 字节），已改为**字符数**（`content.length`），数字以本版为准。

## 1. 输入与方法

| 来源 | 数量 | 用途 |
|---|---|---|
| `raw/**/*.md` | **4,408** | 待分类全集 |
| `_workspace/cache/raw-processing-cache.json` | 3,791 | 旧 triage / digest 状态、score、reasons、hash |
| `_workspace/outputs/digest-log.md` | 1,466 | 已处理日志（交叉校验） |
| `_workspace/outputs/triage-log.md` | 23 | 幂等日志（几乎未使用） |
| `wiki/**/*.md` 的 `[[raw/…]]` | 4,532 文件 / 1,253 命中 | 已沉淀的直接证据 |

方法：路径 NFC 归一化 → 分类 → 冲突检测 → **按新规则重新 triage**（`--retriage`）。

## 2. 分类结果（旧状态口径）

| 分类 | 数量 | 含义 |
|---|---|---|
| **committed** | **1,253** | wiki 有来源引用（知识已沉淀） |
| **queued** | **2,205** | 旧 cache 标记 medium/high 且未 digest |
| **review** | **141** | cache 说 digested，但 wiki 无引用 |
| **deferred** | **188** | low / skipped / digest 延后（含 21 个 `_index.md` 元文件） |
| **untriaged** | **617** | 从未进过流水线（全部是禁用来源） |

## 3. 按新规则重新 triage（决定导入队列）

对 3,014 篇"非 committed、非 review"的原文，用新系统规则重跑 triage：

| 结果 | 数量 | 说明 |
|---|---|---|
| **queued** | **1,955** | 可直接入队（占可处理源的 82%） |
| deferred（low） | 438 | 判断句不足，延后 |
| deferred（source_disabled） | 617 | newsletters 609 + 自媒体 8，非知识库来源 |
| deferred（too_long） | 4 | >200k 字符，等分片策略 |

**结论**：按新规则，**1,955 篇直接入队**，占总 backlog 的 65%、占可处理来源的 82%。

## 4. 长文阈值调整

| 项 | 旧值 | 新值 | 影响 |
|---|---|---|---|
| `longTextThreshold`（字符） | 60,000 | **200,000** | >60k 的 350 篇 backlog 可入队；仅 4 篇 >200k 延后 |
| digest `maxInputTokens` | 60,000 | **250,000** | 支持约 20 万字符原文 |
| DeepSeek flash 上下文 | — | 1M tokens | 余量充足 |

> 说明：此前"1,080 篇 >60k"是字节数误判；按字符数，>60k 的 backlog 只有 **350 篇**。

## 5. 冲突检测（干净）

| 检查项 | 结果 |
|---|---|
| cache 有记录但文件不存在 | **0** |
| wiki 引用但文件不存在（死链） | 33 |
| digest-log 有记录但文件不存在 | 34 |
| triage-log 有记录但文件不存在 | 3 |
| 未知 triage / digest 状态 | **0** |
| 未知 triage reason | **0** ✅ |
| content_hash 非法 | **0** ✅ |

cache 的 `reasons` 词表与领域层 `TriageReason` 完全一致，score 与 hash 可直接使用。

## 6. 导入映射（apply 计划）

| 旧状态 | 新状态 | 数量 | 依据 |
|---|---|---|---|
| wiki 引用 | `committed` | 1,253 | sha = `ba2e0a0` |
| 重新 triage 为 high/medium | `queued` | **1,955** | 新规则 |
| 重新 triage 为 low | `deferred` | 438 | 新规则 |
| 禁用来源 | `deferred(source_disabled)` | 617 | 来源白名单 |
| >200k 字符 | `deferred(too_long)` | 4 | 长文策略 |
| digested 但 wiki 无引用 | `deferred(review)` | 141 | 你已确认 defer |
| `_index.md` 元文件 | **跳过** | 21 | 不是文章 |

导入后第一次 ingest 的预期：**已处理 0 新增，队列 1,955**。

### 成本 / 时间预估

| 指标 | 值 |
|---|---|
| 队列 | 1,955 篇 |
| 模型成本（$0.0025/篇） | **≈ $4.89** |
| 串行耗时（15.6s/篇） | ≈ 8.5 小时 |
| 3 并发 | ≈ 2.8 小时 |

## 7. 下一步

1. 确认导入队列口径：**用重跑后的 1,955**（推荐，符合"重新跑数据"）还是旧 cache 的 2,205；
2. 确认 apply 运行位置：本地临时库验证（可删）→ 服务器正式导入；
3. 服务器就位后执行 apply，再小批量真实处理，重点验证 patch 分支；
4. follow-up：4 篇超长文 + 33 条死链 + 141 篇 review 清理。

## 8. apply 验证（本地临时库，2026-11-01）

已用 `pnpm import:apply --state .sb-import-test --apply` 在本地临时库执行：

| 阶段 | 结果 |
|---|---|
| 计划 | raw 4,408 → committed 1,253 / queued **2,302** / deferred 853 |
| 写入 | inserted **4,408**、skipped 0 |
| 验证 | 再跑 `ingestAndTriage`：observed 4,408、**newItems 0**，状态分布与计划一致 |
| 幂等 | 第二次 apply：inserted 0、skipped 4,408 |
| 事件 | 每次实际导入记一条 `import:legacy` 事件（0 插入时不记） |

**队列 2,302 与并集 2,308 的差异**：6 个 `_index.md` 元文件在"新规则 triage"里会被判为可入队，但 apply 统一按元文件 `deferred(user)` 处理，避免把目录索引当文章处理。

deferred 853 的构成：`low_value` 70、`source_disabled` 617、`too_long` 4、`user` 162（141 review + 21 元文件）。

状态库位置：`.sb-import-test/state.db`（已 gitignore，可随时删除重建）。

## 9. 复现

```bash
pnpm import:dry-run --retriage [--long-threshold 200000]
# 明细：.sb-import/dry-run.json（已 gitignore）
```
