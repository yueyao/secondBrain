# 包布局与子模块接入指南

> 目标：把"领域 / 契约 / 适配器 / 应用 / 入口"拆成独立包，让后续子模块可以并行加入，**任何新包都不能绕过依赖规则**。

---

## 1. 当前布局

```
secondbrain-server/                     # monorepo 根（Git 仓库根）
├─ package.json                         # 根脚本 + 共享 devDependencies
├─ pnpm-workspace.yaml                  # packages/* 与 apps/*
├─ tsconfig.base.json                   # 共享编译选项 + @sb/* 路径映射
├─ tsconfig.json                        # CI 用：一次类型检查所有包
├─ vitest.config.ts                     # @sb/* 别名 + 统一测试入口
├─ .dependency-cruiser.cjs              # 图级依赖规则
├─ tools/check-boundaries.mjs           # 源码级规则 + 包清单校验
├─ packages/
│  ├─ domain/           @sb/domain          # 纯领域：状态机 / 策略 / 10 条规则（零依赖）
│  ├─ contracts/        @sb/contracts       # 端口接口 + 跨端 DTO（只依赖 domain）
│  ├─ adapters-sqlite/  @sb/adapters-sqlite # StateStore 的 SQLite 实现（允许 node:）
│  ├─ adapters-vault/   @sb/adapters-vault  # fs + git + 单写者锁（允许 node:）
│  ├─ adapters-search-memory/ @sb/adapters-search-memory  # 内存检索
│  ├─ app/              @sb/app             # 应用层用例（只依赖端口）
│  └─ testing/          @sb/testing         # 测试夹具 + MockAgent + harness
├─ apps/                                # 入口（cli / server），尚未创建
└─ docs/                                # PROGRESS / DOMAIN / MONOREPO / adr
```

**已规划、尚未创建的包**（按阶段落地）：

| 包名 | 层 | 职责 | 允许依赖 |
|---|---|---|---|
| `@sb/adapters-sqlite` | 适配器 | StateStore 实现、迁移、事件表 | domain, contracts（**已实现**） |
| `@sb/adapters-vault` | 适配器 | 文件系统 + git + flock | domain, contracts（**已实现**） |
| `@sb/adapters-agent` | 适配器 | 模型 provider、schema 校验、预算 | domain, contracts |
| `@sb/app` | 应用 | 用例（triage/digest/commit/recover） | domain, contracts |
| `@sb/obs` | 基础设施 | 日志、指标 | domain, contracts |
| `@sb/config` | 基础设施 | 配置解析（zod） | contracts |
| `apps/cli` | 入口 | 人审与运维命令 | 全部 |
| `apps/server` | 入口 | JSON API | 全部 |

---

## 2. 依赖矩阵（唯一事实来源）

| 包 | 可依赖 |
|---|---|
| `@sb/domain` | **无**（零依赖，连 `node:` 都不允许） |
| `@sb/contracts` | `@sb/domain` |
| `@sb/agent-runtime` | `@sb/domain`、`@sb/contracts` |
| `@sb/adapters-agent-openai` | `@sb/agent-runtime`、`@sb/contracts` |
| `@sb/adapters-*` | `@sb/domain`、`@sb/contracts` |
| `@sb/testing` | domain、contracts、各适配器（仅供测试与 demo） |
| `@sb/app` | `@sb/domain`、`@sb/contracts` |
| `apps/*` | 以上全部 |

强制手段（三层）：

1. `tools/check-boundaries.mjs` 的 `PACKAGES` 表：裸导入白名单 + 包清单登记；
2. `.dependency-cruiser.cjs`：图级方向与环形依赖；
3. `packages/*/package.json` 的 `dependencies` 声明（检查会比对白名单）。

> 新增包必须**同时**改这三处，否则检查会失败——这是有意的摩擦，防止依赖悄悄变乱。

---

## 3. 如何接入一个新子模块（以 `@sb/adapters-sqlite` 为例）

```bash
mkdir -p packages/adapters-sqlite/src packages/adapters-sqlite/test
```

### ① 包清单

```json
{
  "name": "@sb/adapters-sqlite",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@sb/domain": "workspace:*",
    "@sb/contracts": "workspace:*"
  }
}
```

### ② tsconfig

```json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }
```

### ③ 公开面

`src/index.ts` 只导出该包愿意对外承诺的内容；包外禁止深引 `src/*`（检查会拦）。

### ④ 登记边界规则

在 `tools/check-boundaries.mjs` 的 `PACKAGES` 增加一行：

```js
{ dir: 'adapters-sqlite', name: '@sb/adapters-sqlite', allowedBare: ['@sb/domain', '@sb/contracts'], allowNode: true, pure: false },
```

- `allowNode: true`：适配器本来就要用 `node:fs` / `node:sqlite`
- `pure: false`：允许 `throw`、`Date.now`（适配器负责把系统异常转成领域错误）

### ⑤ 路径映射（仅当入口需要被别名使用时）

`tsconfig.base.json` 的 `paths` 与 `vitest.config.ts` 的 `alias` 各加一行。若该包只被 `apps/*` 直接 import，可省略。

### ⑥ 测试

```bash
mkdir -p packages/adapters-sqlite/test
# 测试文件放在 packages/*/test/**/*.test.ts 会被根 vitest 自动发现
pnpm test
```

### ⑦ 更新文档

- 本文件 §1 表格；
- `docs/PROGRESS.md` 的变更记录；
- 若引入新的跨层契约，更新 `docs/DOMAIN.md` 或 `packages/contracts`。

### ⑧ 校验

```bash
pnpm run check   # boundaries → typecheck → depcruise → test
```

---

## 4. 为什么现在用"单一 tsconfig + paths"，而不用 project references

| 方案 | 现在（P1，只跑测试） | 将来（P4，需要产物） |
|---|---|---|
| 单一 tsconfig + paths | 简单、无需构建顺序、一次检查全仓库 | 无增量构建 |
| project references + composite | 需要 `tsc -b` 与构建顺序，测试阶段纯负担 | 支持增量、可分别发布 |

切换时机：**当第一个包需要产出 `dist/` 给运行时使用时**（预计 P4）。切换时保留同样的 `@sb/*` 包名，只改 `exports` 指向。

---

## 5. 常用命令

```bash
pnpm install          # 安装 workspace 依赖
pnpm run check        # 全量校验（CI 用）
pnpm run boundaries   # 只跑边界检查
pnpm run typecheck    # 只跑类型检查
pnpm run depcruise    # 只跑依赖图规则
pnpm test             # 只跑测试
pnpm --filter @sb/domain test   # 只跑某个包（当前测试统一在根）
```
