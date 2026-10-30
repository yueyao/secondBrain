# ADR 0003 · Monorepo 组织方式

- 状态：已采纳
- 日期：2026-10-30
- 背景：后续还要接入多个子模块（适配器、应用、入口、观测），单包结构会让边界失守

## 决策

### 1. 用 pnpm workspaces，不引入 turbo / nx

- `pnpm-workspace.yaml` 声明 `packages/*` 与 `apps/*`；
- 根 `package.json` 持有共享 devDependencies 与统一脚本；
- 暂不加任务编排器：当前只有 2 个包，构建缓存没有收益。**触发条件**：包数量 > 5 或出现需要按图构建的产物时，再评估 turbo。

### 2. 包按"层"切分，不按"功能"切分

| 包 | 为什么单独成包 |
|---|---|
| `@sb/domain` | 零依赖纯函数，必须能脱离一切环境测试；单独成包才能被边界工具"物理隔离" |
| `@sb/contracts` | 端口与 DTO 是多方共用的契约（适配器实现、应用消费、CLI/UI 读取）；单独成包避免契约散落在实现里 |

后续按同样逻辑切：每个适配器一个包（实现可替换）、应用一个包（用例）、入口按交付形态分（cli / server）。

### 3. 包间只能走公开面

- `package.json` 的 `exports` 只暴露 `./src/index.ts`；
- 边界脚本禁止 `@sb/xxx/src/...` 深引；
- 依赖声明必须与白名单一致（脚本比对 `dependencies`）。

### 4. TypeScript 用单一 tsconfig + paths（暂时）

见 `docs/MONOREPO.md` §4：测试阶段不需要构建顺序；P4 出现产物需求时切换为 project references。

## 后果

- 新增包必须改三处（PACKAGES 表 / depcruise 规则 / package.json），摩擦是刻意的。
- `exports` 目前指向 `.ts`，只适用于开发与测试；**P4 落地运行时前必须改为 `dist/`**。
- 根 `check` 一次跑完所有包，CI 只需一条命令。
