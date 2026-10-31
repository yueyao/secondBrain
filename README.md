# secondbrain-server

secondBrain 知识生产流程的服务端实现，**pnpm workspaces monorepo**。当前完成 P0-P3（工程底座 / 领域层 / SQLite 适配器 / Vault 适配器）+ 应用层 + 可启动的 mock 审核台 + 测试方案。

- 流程契约：[../secondBrain-生产逻辑.md](../secondBrain-生产逻辑.md)
- 总体设计：[../secondBrain-服务端详细设计-v2.md](../secondBrain-服务端详细设计-v2.md)
- 包布局与接入指南：[docs/MONOREPO.md](docs/MONOREPO.md)
- 实施进展与决策日志：[docs/PROGRESS.md](docs/PROGRESS.md)
- 领域层手册：[docs/DOMAIN.md](docs/DOMAIN.md)

## 包布局

| 包 | 职责 | 依赖 | 状态 |
|---|---|---|---|
| `@sb/domain` | 纯领域：状态机 / 策略 / 10 条预警规则 | 无（零依赖、零 I/O） | ✅ |
| `@sb/contracts` | 端口接口 + 跨端 DTO（ReviewView / QueueItem） | `@sb/domain` | ✅ |
| `@sb/adapters-sqlite` | StateStore 实现、迁移、事务、乐观锁、事件流 | domain + contracts | ✅ |
| `@sb/adapters-vault` | 文件系统 + git 提交 + 单写者文件锁 | domain + contracts | ✅ |
| `@sb/adapters-search-memory` | 内存检索（mock 用） | domain + contracts | ✅ |
| `@sb/app` | 用例：triage / digest / review / commit | domain + contracts | ✅ |
| `@sb/testing` | 测试夹具、MockAgent、harness | 域 + 适配器 | ✅ |
| `@sb/agent-runtime` | 能力路由 / 预算 / 缓存 / 重试 / 降级 / 契约校验（P4.1 ✅） | domain + contracts | ✅ |
| `@sb/adapters-agent-*` | 真实 provider 适配器（OpenAI 兼容 / 本地） | domain + contracts | ⬜ P4.2 |
| `@sb/app` | 用例：triage / digest / commit / recover | domain + contracts | ⬜ P5 |
| `apps/cli` | 人审与运维命令 | 全部 | ⬜ P5 |
| `@sb/server` | mock 审核台：HTTP + 服务端渲染 UI | 全部 | ✅ |

依赖方向由工具强制：`tools/check-boundaries.mjs`（源码级）+ `.dependency-cruiser.cjs`（图级）+ 各包 `package.json` 声明三者交叉校验。

## 快速开始（含可交互 mock 审核台）

```bash
pnpm install
pnpm demo          # → http://127.0.0.1:8787（自动播种 mock 数据）
```

首页「扫描 raw/ 并分档」→ 队列「生成草稿」→ 审阅页「通过并入库」，每一步都会在 demo vault 里产生真实 git commit。
测试方案见 [docs/TESTING.md](docs/TESTING.md)，页面快照见 `docs/snapshots/`。

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
pnpm test             # vitest：20 个文件 / 153 例
```

## 能证明什么

- **状态机不可绕过**：18 状态 × 24 事件 = 432 个组合穷举；迁移表在测试里被独立重抄一遍做双重记账。
- **阻断级预警真的挡得住**：`ACCEPT` 遇 `block` finding 返回 `BLOCK_FINDINGS_PRESENT`。
- **提交前目标被改会拒绝**：`TARGET_MOVED`；缺守卫输入 → `GUARD_MISSING_CONTEXT`（不允许默认通过）。
- **契约可实现**：`packages/contracts/test/ports.test.ts` 用假实现证明端口不是纸上接口。
- **事件可回放**：状态与事件同事务写入；`applyEvents` 重建的状态与库里逐字段一致（篡改事件顺序会失败）。
- **事务与锁可验证**：回滚不留痕、乐观锁只允许一个写者成功、任务领取原子且围栏令牌自增。
- **vault 不可被越狱**：路径逃逸（`..`/绝对路径）与非 wiki 写入会被拒绝；提交失败可 `resetHard` 回滚。
- **包边界可执行**：深引 `@sb/domain/src/*`、domain→contracts 反向依赖、未登记的新包，都会让 CI 失败。

## 目录

```
packages/domain/       纯领域：状态 / 迁移表 / 策略 / 规则 + 测试
packages/contracts/    端口（StateStore/Vault/SearchIndex/Agent/Lock/Clock）+ DTO + 契约测试
packages/adapters-sqlite/  StateStore 实现：迁移、事务、乐观锁、事件流 + 21 例测试
packages/adapters-vault/   fs + git 提交 + 单写者锁（含路径逃逸防护）+ 17 例测试
tools/                 零依赖检查脚本（包边界）
docs/                  PROGRESS / DOMAIN / MONOREPO / ADR
apps/                  入口（待创建）
```

## 不做的事（当前）

HTTP、数据库、模型调用、CLI、UI。契约已在 `@sb/contracts` 定义，实现留给对应适配器包。
