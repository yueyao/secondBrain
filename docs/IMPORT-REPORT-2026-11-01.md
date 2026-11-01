# Legacy 导入 dry-run 报告 · 2026-11-01

> 目的：在写任何状态之前，把旧 vault 的处理记录（cache / digest-log / triage-log / wiki 引用）
> 与新系统做一次对账，回答"哪些已处理、哪些待办、哪些不能直接导入"。
> 本次**只读**：未写 SQLite、未改任何文件、未动 git。

## 1. 输入与方法

| 来源 | 数量 | 用途 |
|---|---|---|
| `raw/**/*.md` | **4,408** | 待分类全集 |
| `_workspace/cache/raw-processing-cache.json` | 3,791 | triage / digest 状态、score、reasons、content_hash |
| `_workspace/outputs/digest-log.md` | 1,466 | 已处理日志（交叉校验） |
| `_workspace/outputs/triage-log.md` | 23 | 幂等日志（几乎未使用） |
| `wiki/**/*.md` 中 `[[raw/…]]` | 4,532 文件 / 1,253 命中 | 已沉淀的直接证据 |

方法：路径统一 NFC 归一化 → 按优先级分类（wiki 引用 > cache digested > medium/high > 其他）→ 冲突检测 → 体积分桶。

## 2. 分类结果

| 分类 | 数量 | 含义 | 导入建议 |
|---|---|---|---|
| **committed** | **1,253** | wiki 有来源引用（知识已沉淀） | 直接标 `committed`，sha 用 vault 基线 `ba2e0a0` |
| **queued** | **2,209** | cache 标记 medium/high 且未 digest | 待办队列（但需按体积拆分，见 §3） |
| **review** | **141** | cache 说 digested，但 wiki 无引用 | 待人工确认，默认 `deferred` |
| **deferred** | **188** | low / skipped / digest 延后 | `deferred`（其中 21 个是 `_index.md` 元文件，应排除） |
| **untriaged** | **617** | 从未进过流水线 | 全部是**禁用来源**，新 ingest 会 `source_disabled` → `deferred` |

合计 4,408。

## 3. 关键发现（影响导入策略）

### 3.1  backlog 里 1,080 篇超过 60k 字符

| 分类 | 总数 | >60k 字符 | 占比 |
|---|---|---|---|
| queued | 2,209 | **1,080** | 49% |
| committed | 1,253 | 320 | 26% |
| review | 141 | 21 | 15% |
| deferred | 188 | 4 | 2% |

新系统当前 ingest 策略：`charCount > 60_000` → `TRIAGE_LONG` → **deferred（too_long）**。
也就是说，若把 2,209 篇原样导入 `queued`，其中 1,080 篇会立刻违反新策略。

**建议**：导入时拆成两批——

- `queued` ← **1,129 篇**（≤60k）；
- `deferred(too_long)` ← **1,080 篇**（等 long-text policy 落地后再放开）。

> 注意：旧流水线能处理长文（committed 里 320 篇 >60k），新系统目前不能。这是**能力回退**，
> 应作为 P6.2（long-text policy 接入分片 digest）处理，否则 1,080 篇 backlog 永远进不了队列。

### 3.2 617 篇 untriaged 全部来自禁用来源

| 来源 | 数量 |
|---|---|
| `newsletters` | 609 |
| `自媒体` | 8 |

它们不在 `enabledSources`（cubox/notions/podcast/dedao/general）内，新 ingest 会直接
`TRIAGE_SCOPE → deferred(source_disabled)`。**不会进入队列，也不需要导入状态**（首次 ingest 自然处理）。

### 3.3 冲突几乎为零

| 检查项 | 结果 |
|---|---|
| cache 有记录但文件不存在 | **0** |
| wiki 引用但文件不存在（死链） | 33 |
| digest-log 有记录但文件不存在 | 34 |
| triage-log 有记录但文件不存在 | 3 |
| 未知 triage 状态 | **0** |
| 未知 digest 状态 | **0** |
| 未知 triage reason（与领域层词表比对） | **0** ✅ |
| content_hash 格式非法 | **0** ✅ |

**结论**：cache 的 `reasons` 词表（`human_story/interesting/novel_view/useful/durable_claim/reinforces_existing/personal_relevance`）
与领域层 `TriageReason` **完全一致**，score 可直接搬运；hash 可直接作为 `ContentHash`。

### 3.4 141 篇 review 需要你决策

这些文章 cache 标记 `digested`，但 wiki 里找不到任何来源引用。可能原因：

- digest 后 claims 被人工回退；
- 产出节点被合并/删除；
- 引用格式丢失（但其他 1,253 篇格式一致，概率低）。

默认建议：标 `deferred` 并输出清单，由你抽查后决定是否重跑。

## 4. 导入映射（apply 计划）

| 旧状态 | 新状态 | 数量 | 备注 |
|---|---|---|---|
| wiki 引用 | `committed` | 1,253 | `commitSha = ba2e0a0`（vault 基线） |
| medium/high，≤60k | `queued` | **1,129** | 直接进入待办 |
| medium/high，>60k | `deferred(too_long)` | **1,080** | 等 long-text policy |
| low/skipped/延后 | `deferred` | 188（排除 21 个 `_index.md`） | |
| digested 但 wiki 无引用 | `deferred(review)` | 141 | 待人工 |
| 未进流水线 | 不写 | 617 | 首次 ingest 自动 `source_disabled` |

导入后第一次 ingest 的预期：**已处理 0 新增，队列 ≈ 1,129**。

### 成本 / 时间预估

| 指标 | 值 |
|---|---|
| 队列 | 1,129 篇 |
| 模型成本（$0.0025/篇） | **≈ $2.82** |
| 串行耗时（15.6s/篇） | ≈ 4.9 小时 |
| 3 并发 | ≈ 1.6 小时 |

## 5. 与之前估算的差异（已修正）

| 之前说 | 实际 | 原因 |
|---|---|---|
| 已处理 1,286 | **1,253** | 33 条 wiki 引用是死链（文件不存在） |
| 队列 2,579 | **1,129** | 1,080 长文应 deferred；617 禁用来源不入队 |
| 成本 $6.4 | **$2.82** | 同上 |
| deferred 415 | 188 | 之前把 review/low 混在一起算 |

## 6. 下一步

1. 确认 §3.4 的 141 篇处理方式（默认 deferred）；
2. 确认长文策略：先 deferred（推荐）还是绕过策略直接入队；
3. 在目标机器（或本地先行）执行 apply；
4. 小批量真实处理，重点验证 patch 分支；
5. 排期 P6.2 long-text policy（影响 1,080 篇 backlog）。

## 7. 复现

```bash
pnpm import:dry-run            # 只读；明细写到 .sb-import/dry-run.json（已 gitignore）
```
