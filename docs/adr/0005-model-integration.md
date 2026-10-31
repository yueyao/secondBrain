# ADR 0005 · 真实模型接入方案（路由 / 执行 / 评估）

- 状态：已采纳；P4.1（运行时骨架）已实现，P4.2（真实 provider）待启动
- 日期：2026-10-30
- 关联：`docs/PROGRESS.md` D14/D15、设计文档 §10、`docs/TESTING.md`

## 背景

两个现实约束：

1. **模型变化快**：模型上下线、能力、价格、限流策略都在变。如果模型名或 SDK 进入业务代码，每次换代都要改核心逻辑。
2. **成本是硬约束**：一次 digest 的上下文是"全文 + 检索命中 + 规范"，按当前语料规模（一篇 2–8 万 token），如果批量跑，单日成本可能失控。

## 决策

**模型是易变的供应商，不是架构的一部分。**

已有的 `AgentPort` 就是唯一接缝（`packages/contracts/src/ports/agent.ts`）。在它后面新增三层，业务层（状态机 / 规则 / 审核 / 提交）保持零感知：

```
application（用例）
   │  只依赖 AgentPort
   ▼
[ 路由层 ]  任务 → 能力需求 → 具体模型（配置驱动，代码不写模型名）
   ▼
[ 执行层 ]  统一 runner：预算 / 缓存 / 幂等 / 超时 / 重试 / 降级 / 计量
   ▼
[ 适配器 ]  OpenAI 兼容 / 本地 Ollama / 其它 provider
   ▲
[ 评估层 ]  golden set 回归；达标才允许进入路由
```

**换模型 = 改一行配置 + 跑一次 golden set**，不改任何业务代码。

---

## 1. 契约层（已有，保持不变）

```ts
interface DigestRequest {
  rawPath; content;
  retrieved: ScoredHit[];          // 有界检索结果，由应用层预先检索
  tools: readonly AgentTool[];     // 只读白名单
  budget: AgentBudget;             // token 上限
}
// 返回 DraftProposal（tier / rationale / claims[] / nodes[]），必须通过结构校验
```

约束：

- **只读工具白名单**：agent 永远拿不到写能力。
- **输出必须过 schema**：非法输出 = 契约违反，重试一次后 `failed`，**绝不产生半成品草稿**。
- 适配器只允许出现在 `@sb/adapters-agent-*`；业务包 import provider SDK 视为违规（P4 加入边界脚本）。

---

## 2. 路由层：按能力路由，不按模型名路由

### 2.1 能力画像（ModelProfile，配置表）

```jsonc
{
  "id": "strong-reasoning-2026-01",      // 业务只引用这个 id
  "provider": "openai-compatible",
  "model": "xxx-2026-01",                 // 固定快照，禁止 -latest
  "capabilities": {
    "contextTokens": 128000,
    "structuredOutput": true,
    "toolCalls": true,
    "languages": ["zh", "en"],
    "sensitivity": ["public"]             // 允许处理哪些敏感级别
  },
  "pricing": { "inPerMTokens": 0, "outPerMTokens": 0 },   // 由你填写
  "limits": { "maxConcurrency": 4, "requestsPerMinute": 60 },
  "health": { "enabled": true, "fallbackTo": ["balanced-2026-01"] }
}
```

### 2.2 任务策略（TaskPolicy）

| 任务 | 能力需求 | 典型档位 | 单任务 token 预算 |
|---|---|---|---|
| `triage` | 短上下文 + 中文判断 | **便宜小模型** | 2k |
| `digest` | 长上下文 + 结构化 + 工具 | 强模型 | 60k |
| `review-rewrite` | 长上下文 + 结构化 | 同 digest 或降一档 | 60k |
| `decide` | 长上下文 + 检索综合 | 强模型 | 40k |

> 规律：**只有 digest 值得用强模型**。triage 是"值不值得"，judge 错一次的成本远低于 digest 一次的钱。

### 2.3 敏感度分流

`raw/` 含得到课程全文、播客转录（付费内容）。每个来源打敏感级别：

| 来源 | 默认级别 | 允许的 provider |
|---|---|---|
| `dedao` / `podcast` | `restricted` | 本地模型，或白名单内的云 provider |
| `cubox`（公开网页剪藏） | `public` | 任意已启用 provider |
| `general`（手工录入） | 由 frontmatter 声明，默认 `restricted` | 同上 |

**这是需要你拍板的第一件事**：restricted 是否允许发云模型。

---

## 3. 执行层：预算、缓存、幂等、降级

### 3.1 预算公式（跑之前就算）

```text
estInput  = ceil(charCount × 0.7) + promptTokens + retrievedTokens
            # 中文约 0.7 token/字（实测口径）
estOutput = 400 + expectedClaims × 120
estCost   = estInput/1e6 × priceIn + estOutput/1e6 × priceOut
```

三级闸门：

| 级别 | 规则 | 超限行为 |
|---|---|---|
| 单次 | `estCost > taskLimit` | 拒绝执行，记录 `BudgetExceeded`，不落草稿 |
| 单任务 | 重试累计超 `taskLimit × 1.5` | 停止重试，转人工 |
| 每日 | `dailyUsage + estCost > dailyLimit` | 只停**新**任务，已跑的完成 |

> 钱必须在**调用前**算，而不是事后看账单。

### 3.2 缓存与幂等

```text
cacheKey   = sha256(contentHash + promptSha256 + profileId + sorted(retrievedNodeIds))
draftIdem  = sha256(rawPath + contentHash + promptVersion + profileId)
```

- 同 key 已有成功草稿 → **直接复用，不调用模型**（复跑/重试免费）。
- 同一篇 raw 只允许一份"待审草稿"（`draftIdem` 唯一索引）；重试复用同一幂等键。
- 失败重试不重复计费：usage 按调用记录，重试也记，但**缓存命中不计**。

### 3.3 超时 / 重试 / 降级

| 错误类 | 重试 | 降级 | 说明 |
|---|---|---|---|
| 超时 / 限流 / 5xx | ≤2 次，指数退避 | ✅ | 换 `fallbackTo` 里的下一个 profile |
| 契约违反（非法 JSON） | 1 次（回喂错误） | ❌ | 换模型大概率同样失败，进人工 |
| 拒答（safety） | 0 | ❌ | 记 `rejected(auto)` + 理由 |
| 预算超限 | 0 | ❌ | 落 `failed`，等人工 |

降级必须写 provenance：`{ profileId, fallbackChain: [...] }`，人审页要显示"这条是降级模型产的"。

---

## 4. 评估层：golden set 是唯一能对抗模型换代的资产

### 4.1 标注格式（JSONL，一行为一篇）

```jsonc
{
  "id": "gs-001",
  "raw": "raw/knowledge/podcast/mock-E999 长期主义与时间套利.md",
  "sensitivity": "restricted",
  "expected": {
    "targets": [{ "name": "长期主义", "action": "patch", "required": true }],
    "claims": ["长期主义不是坚持久，而是让选择复利", "中断一次不是少赚而是曲线归零"],
    "mustNotContain": ["具体价格", "投资建议", "未经核实的数字"]
  },
  "notes": "同一事件还有 gs-002（E999b），用于验证重复源拦截"
}
```

建议 30–50 条，覆盖：播客长访谈、课程、短 cubox、重复事件对、低价值快讯、超长文。

### 4.2 指标与准入门槛

| 指标 | 门槛 | 说明 |
|---|---|---|
| 格式合规率 | **100%** | schema 不过就不该进队列 |
| claim 可验证率 | **100%** | 每条必须能回链 raw |
| 目标节点命中率 | ≥ 90% | 该 patch 的必须 patch |
| mustNotContain 违规 | **0** | 硬红线 |
| 判断密度 | ≥ 60% | 对照人机对话基线（实测无人约 65–70%） |
| 成本/篇 | ≤ 预算 | 与质量一起看，不看单一指标 |

**流程**：新模型 → 跑 golden set → 出报告 → 达标才写入路由配置；不达标只能作为"实验 profile"，不进生产。

---

## 5. 可观测与换型流程

- **provenance 已入库**：`provider / model / promptVersion / inputTokens / latencyMs`，再加 `profileId` 与 `fallbackChain`。
- **每篇成本可查**：`sb stats --cost` 输出按来源、按 profile、按天的花费与失败重试浪费。
- **换模型 SOP**（4 步）：
  1. 加 profile（配置，不改代码）；
  2. 跑 golden set，附报告；
  3. 灰度：`triage` 先切（便宜、可试错），再切 `digest`；
  4. 观察 3 天：失败率、抽检质量、成本曲线。

---

## 6. 不做的事

| 反模式 | 原因 |
|---|---|
| 业务层 `import openai` | 供应商锁死；P4 用边界规则禁止 |
| `-latest` 浮动别名 | 行为漂移无法归因 |
| digest 降到小模型省钱 | 知识质量不可逆，比省下的钱贵 |
| 失败后无限重试 | 成本无底洞，必须有 `failed`/人工兜底 |
| "自动重试直到成功" | 同上，且会掩盖系统性问题 |
| 无 golden set 就换模型 | 等于盲赌；质量退化无法发现 |

---

## 7. 落地顺序（P4，方案已定，代码未动）

| 阶段 | 内容 | 是否需要真模型 |
|---|---|---|
| P4.1 | profile/task-policy 配置 + runner + 预算 + 缓存 + 幂等 + **fake provider** | 否（可测超时/限流/非法 JSON/预算超限/降级） |
| P4.2 | 接一个真实 provider，跑 golden set 拿基线 | 是 |
| P4.3 | 成本看板 + 降级链 + provenance 扩展 | 否 |
| P4.4 | 第二个 provider，验证"换模型只改配置" | 是 |

---

## 8. 待你拍板

1. **敏感度边界**：`dedao` / `podcast`（付费内容）是否允许发云模型？不允许则必须接本地模型。
2. **预算上限**：日/月各多少？（决定批量历史积压能否跑、能否双模型互审）
3. **质量底线**：判断密度可接受下限（当前无人实测 65–70%）。
4. **golden set 归属**：谁维护标注？这决定"换模型"能否被验证。

> 这四项不确认，P4.1 可以做（配置与 runner 不依赖真实模型），但 P4.2 无法开始。


---

## 9. 实施进展（P4.1，2026-10-31）

已实现 `@sb/agent-runtime`（**不接真实模型**，用 fake provider 验证行为）：

| 文件 | 内容 |
|---|---|
| `src/route.ts` | `ModelProfile` / `TaskPolicy` / `routeProfiles`：能力筛选、敏感度分流、fallbackTo 追加与去重、禁用跳过 |
| `src/budget.ts` | `estimateCost`（调用前估算）、`costOf`、`BudgetLedger`（单次/每日闸门 + 跨天归零） |
| `src/cache.ts` | `proposalCacheKey`（contentHash + promptSha + profileId + 检索节点）、内存缓存 |
| `src/runner.ts` | `CompletionProvider` 接口 + `AgentRunner`：路由 → 预算 → 缓存 → 调用 → 契约校验 → 重试 → 降级 → 记账 → provenance |
| `src/errors.ts` | `AgentProviderError`（timeout/rate_limit/upstream/refusal）与 `AgentRuntimeError` 分类 |

契约同步升级：`AgentPort.draft` 现在返回 `AgentOutcome { proposal, provenance, cost }`；`DigestRequest` 增加 `sensitivity`。应用层据此把真实 `provider/model/promptVersion/tokens/latencyMs` 写进 `DraftRecord`。

**测试 24 例**覆盖：路由（能力/敏感度/禁用/降级链）、预算（估算/单次/每日/跨天）、缓存命中与不命中、超时重试、重试耗尽降级、契约违反重试一次、拒答不重试、预算超限在调用前拦截、无可用 profile。

**尚未做**（P4.2/P4.3）：

1. 真实 provider 适配器（OpenAI 兼容 / 本地模型）与密钥管理。
2. 把 `config/model-profiles.example.json` 接入配置加载与校验（目前是文档样例）。
3. `sb stats --cost` 成本看板与按 profile 的用量统计。
4. golden set 结构与评测脚本（需要用户先提供标注与预算）。


---

## 10. 修订（2026-10-31）：不做硬上限，改为"只计量"

用户决定：**不设预算上下限，但必须知道消耗了多少。**

据此调整：

1. `BudgetLedger` 的两个上限改为**可选**；不填即"纯计量模式"，`preflight` 不拦截，只累计。
2. 新增 **usage 账本**（`packages/contracts/src/ports/usage.ts` + SQLite `usage_record` 表）：
   每次模型调用记录 `at / rawPath / draftId / profileId / provider / model / inputTokens / outputTokens / latencyMs / cacheHit`。
3. 每次起草在**同一事务**内写 usage，保证草稿与账本一致。
4. 汇总接口 `usageSummary`：按天、按 profile 的调用数、tokens、缓存命中、估算成本（价格表为空时成本为 0，tokens 仍准确）。
5. 服务端新增 `GET /usage` 页面与 `GET /api/usage`；首页增加"今日调用 / 输入 tokens / 输出 tokens / 估算成本"。

保留的能力：如果将来想加回上限，只需在配置里填 `taskCostLimit` / `dailyCostLimit`，代码不用改。


---

## 11. 决策 A（2026-10-31）：全部来源走云模型

用户确认：**所有来源都是自己付费购买、仅自己使用、不会公开**，因此按方案 A 处理，不做敏感度分流。

落实方式：

- 配置里的 profile 统一声明 `sensitivity: ["public", "restricted"]`；
- 应用层仍计算 `sensitivity`（`dedao`/`podcast` → restricted），但路由不会因此拒绝云模型；
- `sensitivity` 字段保留为**未来可用的开关**：若某天想切本地模型，只需在配置里删掉 `restricted` 并新增本地 profile，代码不动。

同时落地 P4.2 的基础设施：

| 内容 | 说明 |
|---|---|
| `@sb/adapters-agent-openai` | OpenAI 兼容 `/chat/completions`：鉴权、`response_format: json_object`、超时、错误分类（429/5xx/content_filter/超时） |
| `@sb/agent-runtime/config.ts` | `parseModelPolicy`：profiles/policies/budget 校验；未显式配置的任务复用 digest 策略 |
| 服务端接线 | 有 `MODEL_BASE_URL` → 云端模式（`OpenAICompatibleProvider` + `AgentRunner`）；否则 mock 模式 |
| 价格表 | 从配置读取，注入 `AppContext.pricing`，用于 `/usage` 的估算成本 |
| 安全 | key 只从 `MODEL_API_KEY` 环境变量读取；启动时缺失直接失败，不落日志 |

**注**：模块名里的 "openai" 指协议（OpenAI-compatible），不是供应商锁定；任何兼容网关/本地 OpenAI 兼容服务都可接入。
