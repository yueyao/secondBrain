# secondbrain-server

secondBrain 知识生产流程的服务端实现，**pnpm workspaces monorepo**。当前完成 P0-P3（工程底座 / 领域层 / SQLite 适配器 / Vault 适配器）+ 应用层 + 可启动的 mock 审核台 + 测试方案。

- 流程契约：[../secondBrain-生产逻辑.md](../secondBrain-生产逻辑.md)
- 总体设计：[../secondBrain-服务端详细设计-v2.md](../secondBrain-服务端详细设计-v2.md)
- 包布局与接入指南：[docs/MONOREPO.md](docs/MONOREPO.md)
- 文档地图（先看这个）：[docs/INDEX.md](docs/INDEX.md)
- 维护规则（改代码必读）：[AGENTS.md](AGENTS.md) · [docs/MAINTENANCE.md](docs/MAINTENANCE.md)
- 多端同步手册：[docs/SYNC.md](docs/SYNC.md)
- 实施进展与决策日志：[docs/PROGRESS.md](docs/PROGRESS.md)
- **当前阶段快照**：[docs/STAGE-2026-10-31.md](docs/STAGE-2026-10-31.md)
- 领域层手册：[docs/DOMAIN.md](docs/DOMAIN.md)

## 包布局

| 包 | 职责 | 依赖 | 状态 |
|---|---|---|---|
| `@sb/domain` | 纯领域：状态机 / 策略 / 10 条预警规则 | 无（零依赖、零 I/O） | ✅ |
| `@sb/contracts` | 端口接口 + 跨端 DTO（ReviewView / QueueItem） | `@sb/domain` | ✅ |
| `@sb/adapters-sqlite` | StateStore 实现、迁移、事务、乐观锁、事件流 | domain + contracts | ✅ |
| `@sb/adapters-vault` | 文件系统 + git 提交 + 单写者文件锁 | domain + contracts | ✅ |
| `@sb/adapters-search-memory` | 内存检索（mock 用） | domain + contracts | ✅ |
| `@sb/app` | 用例：triage / digest / review / commit / compose（主编台） | domain + contracts | ✅ |
| `@sb/testing` | 测试夹具、MockAgent、MockComposer、harness | 域 + 适配器 | ✅ |
| `@sb/agent-runtime` | 能力路由 / 预算 / 缓存 / 重试 / 降级 / 契约校验 / ComposeRunner / DeAiRunner | domain + contracts | ✅ |
| `@sb/adapters-agent-openai` | OpenAI 兼容 provider（json / text 两种输出模式） | agent-runtime + contracts | ✅ |
| `apps/server` | 审核台 + 素材库 + 主编台 + 运维中心：HTTP + 服务端渲染 UI | 全部 | ✅ |
| `apps/worker` | 自动流水线：ingest → 起草（不自动入库） | 全部 | ✅ |

依赖方向由工具强制：`tools/check-boundaries.mjs`（源码级）+ `.dependency-cruiser.cjs`（图级）+ 各包 `package.json` 声明三者交叉校验。

## 快速开始（含可交互 mock 审核台）

```bash
pnpm install
pnpm demo          # → http://127.0.0.1:8787（自动播种 mock 数据）
```

首页「扫描 raw/ 并分档」→ 队列「生成草稿」→ 审阅页「通过并入库」，每一步都会在 demo vault 里产生真实 git commit。
主编台 `/compose`：选知识节点创建文章 →「AI 生成大纲」→「生成正文 v1」→ 正文里的引用可点回原文，版本历史逐版累积（mock 模式自动使用 MockComposer，不产生费用）。
测试方案见 [docs/TESTING.md](docs/TESTING.md)，页面快照见 `docs/snapshots/`。
关于页 `/about` 汇总工作台全部功能与实时数据概览；`/deai` 是独立的「去 AI 味」体检与改写工具。

## 支持哪些模型

适配器实现的是 **OpenAI 兼容协议**（`/chat/completions`），所以"支持"= 任何兼容端点：

| 供应商 / 端点 | 状态 | 备注 |
|---|---|---|
| **DeepSeek** | ✅ 已提供配置 | `deepseek-flash` / `deepseek-v4-pro`，见下 |
| **OpenAI** | ✅ | 任意官方模型名 |
| Qwen / DashScope 兼容模式、Moonshot、智谱、MiniMax、OpenRouter | ✅ | 填 base URL + model 即可 |
| vLLM / Ollama / LM Studio / LiteLLM 网关 | ✅ | 本地或自建网关 |
| Google Gemini | ✅ | 官方提供 OpenAI 兼容端点 |
| Anthropic Claude 原生协议 | ⬜ | 需另写适配器或经网关转换 |

先自检配置（不调用模型、不花钱）：

```bash
pnpm check:model config/model-profiles.deepseek.example.json
# 输出每个任务在 public/restricted 下解析出的 profile 链
```

## 接 DeepSeek（推荐先跑这个）

```bash
cp config/model-profiles.deepseek.example.json config/model-profiles.json
MODEL_API_KEY=<从环境变量给，不要写进文件> pnpm demo:deepseek
```

配置里的分工：

| profile | 模型 | 用途 | 关键参数 |
|---|---|---|---|
| `deepseek-flash` | `deepseek-flash` | **全部任务（当前默认）** | `thinking: disabled`（快、省） |
| `deepseek-v4-pro` | `deepseek-v4-pro` | 需要更强模型时手动切换 | `thinking: enabled` + `reasoning_effort: high` |

> 当前默认：所有任务都用 `deepseek-flash`，且不自动降级到 v4-pro（避免意外产生更高费用）。想升级：把策略里的 `profileOrder` 改成 `deepseek-v4-pro`。

> 价格按峰值期 cache-miss 单价填（flash $0.3 / $1.2，pro $1.32 / $3.96 每百万 tokens），off-peak 减半；缓存命中更便宜。当前账本按单一定价估算，属保守值。

## 接其他 OpenAI 兼容端点

```bash
cp config/model-profiles.example.json config/model-profiles.json
# 编辑：填 model 与 pricing（每百万 token 单价），按需改 fallback
MODEL_BASE_URL=https://<你的网关>/v1 \
MODEL_API_KEY=<从环境变量给，不要写进文件> \
MODEL_CONFIG=config/model-profiles.json \
pnpm demo
```

- 有 `MODEL_BASE_URL` → 云端模式（首页显示「云模型模式」）；没有 → mock 模式；
- key 缺失会启动即失败，不会静默降级；
- 每次调用的 tokens / 成本（按 pricing 估算）在 `/usage` 与 `/api/usage` 可查。

## 维护与所有权

项目运行只依赖「服务器 + GitHub 仓库」，不依赖任何个人电脑在线：

| 仓库 | 用途 |
|---|---|
| `secondBrain`（代码） | server / worker / 全部源码与文档 |
| `secondBrain-vault`（私有） | `wiki/` 知识节点与 git 历史 |
| `secondBrain-raw`（私有） | `raw/` 原文语料 |

- 运维中心 `/operations` 的「GitHub 仓库与维护」列出三个仓库的远端、分支、HEAD、领先/落后，可逐仓库或全部更新、检查远端、修改远端（换账号/迁移用）；
- 代码仓库更新后需要重启 `secondbrain-server` / `secondbrain-worker`；vault/raw 由 sync timer 每 15 分钟自动 fast-forward，vault 的本地提交会自动推回 GitHub 备份（也可在运维页手动「推送此仓库」）；
- 换机器、换 GitHub owner、轮换密钥、备份恢复的完整步骤见 [docs/MAINTAINERS.md](docs/MAINTAINERS.md)。

## 工程校验

```bash
pnpm install
pnpm run check     # boundaries → typecheck → depcruise → test
```

单条命令：

```bash
pnpm run boundaries   # 包边界、深引、纯度（无 node: / 无第三方 / 无 throw / 无时钟）
pnpm run typecheck    # tsc --noEmit（strict + exactOptionalPropertyTypes）
pnpm run depcruise    # 依赖方向、环形依赖
pnpm test             # vitest：40 个文件 / 363 例
```

## 能证明什么

- **状态机不可绕过**：18 状态 × 24 事件 = 432 个组合穷举；迁移表在测试里被独立重抄一遍做双重记账。
- **阻断级预警真的挡得住**：`ACCEPT` 遇 `block` finding 返回 `BLOCK_FINDINGS_PRESENT`。
- **提交前目标被改会拒绝**：`TARGET_MOVED`；缺守卫输入 → `GUARD_MISSING_CONTEXT`（不允许默认通过）。
- **契约可实现**：`packages/contracts/test/ports.test.ts` 用假实现证明端口不是纸上接口。
- **事件可回放**：状态与事件同事务写入；`applyEvents` 重建的状态与库里逐字段一致（篡改事件顺序会失败）。
- **事务与锁可验证**：回滚不留痕、乐观锁只允许一个写者成功、任务领取原子且围栏令牌自增。
- **vault 不可被越狱**：路径逃逸（`..`/绝对路径）与非 wiki 写入会被拒绝；提交失败可 `resetHard` 回滚。
- **崩溃后可恢复**：批准后崩溃 → 启动时幂等重放（补提交或只补状态）；目标文件被外部修改 → 拒绝覆盖并回滚；无关脏改动 → 拒绝启动。
- **主编台全流程可离线验证**：MockComposer 走完整 HTTP 链路（建文章 → 生成大纲 → 正文 v1 → 改稿 vN+1 → 行级 diff → 恢复旧版 → 定稿 → 导出 Markdown），正文引用能解析回 raw 原文，版本只增不改。
- **界面按“工程蓝图”方向重做**：冷灰蓝纸面/蓝墨/信号橙、工程网格、直角面板与刻角、读数条统计；长列表统一分页（claims 25、nodes 50、topics 15、review 25；首页总览只给读数与前 10/15 条，其余跳分页页）与折叠（气泡图、体检问题区），不再一次渲染上千行。
- **去 AI 味可离线验证**：规则体检（8 项加权）不依赖模型；改写契约（长度区间、不得编造引用、不得丢引用）用 MockDeAi 全链路覆盖，真实模型只需替换端口实现。
- **知识库可导航、可体检、成稿有契约、可复述**：`/qa` 把主题 claims 或文章正文抽成 Q-A 链（Q 切要害；A 四段：结论/形式化/论证步/边界），用于选题与审稿；`/topics` 把 118 个 topic 节点汇总成 MOC（主题 claims/入链/文章覆盖/未成文缺口）；`/kb-health` 只读检查断链/孤立/重复/无来源/陈旧节点；主编台正文附「写作契约 + 审引清单」（引用是否来自 claims、能否回溯 raw、与版本记录是否一致），均为确定性检查、不依赖模型自评。
- **模型输出有契约**：digest 走 JSON 契约校验，compose 走文本契约（长度 + 至少 2 个引用标记）；不合规回喂重试一次，再失败落 `CONTRACT_VIOLATION`。
- **包边界可执行**：深引 `@sb/domain/src/*`、domain→contracts 反向依赖、未登记的新包，都会让 CI 失败。

## 目录

```
packages/domain/          纯领域：状态 / 迁移表 / 策略 / 规则 / 文本与引用解析 + 测试
packages/contracts/       端口（StateStore/Vault/SearchIndex/Agent/Compose/Lock/Clock）+ DTO + 契约测试
packages/adapters-sqlite/ StateStore 实现：迁移、事务、乐观锁、事件流
packages/adapters-vault/  fs + git 提交 + 单写者锁（含路径逃逸防护）
packages/adapters-search-memory/ 内存检索（mock 用）
packages/adapters-agent-openai/  OpenAI 兼容 provider（json / text）
packages/agent-runtime/   路由 / 预算 / 缓存 / 重试 / 降级 / AgentRunner / ComposeRunner
packages/app/             用例：triage / digest / review / commit / compose
packages/testing/         测试夹具、MockAgent、MockComposer、harness
apps/server/              审核台 + 素材库 + 主编台 + 运维中心（node:http + SSR）
apps/worker/              自动流水线（ingest → 起草，不自动入库）
tools/                    零依赖检查脚本（包边界）
docs/                     PROGRESS / DOMAIN / MONOREPO / ADR
```

## 不做的事（当前）

CLI（人审与运维都在 Web UI）、多用户与权限系统、移动端 App、向量检索/重排、发布分发渠道（微信公众号等）。模型只做"提议"：草稿必须人工审核，主编台文章也必须人工确认后才会进入后续发布流程。
