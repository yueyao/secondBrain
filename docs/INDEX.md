# 文档地图

> 改代码前从这里开始；每份文档的"何时更新"决定它属于活文档还是历史快照。
> 新增文档必须登记到本文件，否则 `pnpm run docs:check` 会失败。

| 文档 | 用途 | 更新时机 |
|---|---|---|
| [docs/STAGE-2026-10-31.md](docs/STAGE-2026-10-31.md) | 当前阶段快照：架构、完成度、已知缺口、决策索引 | **每个阶段结束时新建一份**，不覆盖历史 |
| [docs/PROGRESS.md](docs/PROGRESS.md) | 连续实施日志：每个阶段做了什么、验证输出、决策 D1… | **每次改动追加一章**，只追加不改历史 |
| [docs/DOMAIN.md](docs/DOMAIN.md) | 领域层手册：状态、迁移表、守卫、规则、不变式 | 状态机 / 规则 / 策略变化时 |
| [docs/MONOREPO.md](docs/MONOREPO.md) | 包布局、依赖矩阵、新增子模块步骤 | 包增删、依赖方向变化时 |
| [docs/TESTING.md](docs/TESTING.md) | 测试金字塔、夹具用法、启动 mock 审核台 | 测试结构或数量变化时 |
| [docs/BASELINE-2026-10-31.md](docs/BASELINE-2026-10-31.md) | 真实模型基线：triage 分布、单篇质量/成本/稳定性、发现的问题 | 每次真实模型基线跑完后新建一份（按日期） |
| [docs/MAINTENANCE.md](docs/MAINTENANCE.md) | 文档维护规则、检查机制、评审清单 | 维护流程本身变化时 |
| [docs/INDEX.md](docs/INDEX.md) | 本文件：文档地图 | 任何文档增删时 |
| [docs/adr/0001-stack.md](docs/adr/0001-stack.md) | 技术栈选型 | 换语言/测试框架/包管理器时 |
| [docs/adr/0002-domain-purity.md](docs/adr/0002-domain-purity.md) | 领域纯度：Result、注入时钟、品牌类型 | 领域层约束变化时 |
| [docs/adr/0003-monorepo.md](docs/adr/0003-monorepo.md) | Monorepo 组织方式 | 包结构/构建方式变化时 |
| [docs/adr/0004-database.md](docs/adr/0004-database.md) | 数据库选型（node:sqlite） | 换库/迁移策略变化时 |
| [docs/adr/0005-model-integration.md](docs/adr/0005-model-integration.md) | 模型接入：路由/执行/评估、DeepSeek、预算计量 | 模型接入方式、路由或预算策略变化时 |
| [docs/adr/0006-simplified-recovery.md](docs/adr/0006-simplified-recovery.md) | 简化版崩溃恢复（幂等重放） | 恢复策略变化、升级为完整对账时 |

## 阅读路径

- **第一次接触项目**：STAGE → README → DOMAIN
- **要改领域逻辑**：DOMAIN → ADR 0002 → TESTING（状态矩阵）
- **要加包 / 加适配器**：MONOREPO → ADR 0003
- **要接模型 / 调成本**：ADR 0005 → `config/model-profiles.*.json`
- **要动提交 / 恢复逻辑**：ADR 0006 → `packages/app/src/commands.ts`

## 代码入口（非文档）

| 位置 | 说明 |
|---|---|
| `packages/domain/` | 状态机 / 规则 / 策略 |
| `packages/contracts/` | 端口与 DTO |
| `packages/app/` | 用例与读模型 |
| `packages/agent-runtime/` | 路由 / 预算 / 缓存 / 重试 / 降级 |
| `packages/adapters-*/` | SQLite / vault / 检索 / OpenAI 兼容 provider |
| `apps/server/` | 审核台 + JSON API |
| `tools/check-boundaries.mjs` | 边界检查 |
| `scripts/check-docs.mjs` | 文档检查 |
