# 实施进展记录 · P0 + P1

> 项目：`secondbrain-server`
> 阶段：**P0 工程底座 ✅ ／ P1 领域层 ✅**
> 记录时间：2026-10-30
> 依据：`../secondBrain-服务端详细设计-v2.md`（§2 依赖规则、§4 领域层、§17 失败处理、§18 状态矩阵）

---

## 一、状态总览

| 阶段 | 内容 | 状态 | 验证方式 |
|---|---|---|---|
| P0 | 工程底座（TS strict、依赖边界、测试框架、CI 脚本） | ✅ 完成 | `npm run check` 全绿 |
| P1 | 领域层（模型、状态机、策略、10 条规则）+ 单测 | ✅ 完成 | 67 个测试通过 |
| P2 | SQLite 适配器 + 迁移 + 仓储 | ⬜ 未开始 | — |
| P3 | vault 适配器（git/锁）+ 对账 `Recover()` | ⬜ 未开始 | — |
| P4 | agent 适配器 + zod 契约 + 预算 | ⬜ 未开始 | — |
| P5 | 用例 + CLI | ⬜ 未开始 | — |

**本轮不含**：HTTP、数据库、模型调用、CLI、UI。领域层刻意做到"零 I/O、零依赖"，这样后续每一层都能被单独替换。

---

## 二、交付物清单

```
secondbrain-server/
├─ package.json                     # 脚本：typecheck / test / boundaries / depcruise / check
├─ tsconfig.json                    # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
├─ .dependency-cruiser.cjs          # 图级依赖规则（4 条）
├─ scripts/check-boundaries.mjs     # 源码级依赖与纯度检查（零依赖）
├─ src/domain/
│  ├─ model/                        # 8 个模型文件（result/errors/identifiers/finding/triage/draft/raw-state/rule-input）
│  ├─ state-machine.ts              # 事件 × 状态完整迁移表 + 守卫 + 回放
│  ├─ text.ts                       # 确定性文本工具（判断句计数、2-gram 相似度）
│  ├─ policies/                     # triage / 长文 / 档位配额（各带版本号）
│  └─ rules/                        # 10 条预警规则 + 注册表
├─ test/                            # 7 个测试文件（矩阵 / 守卫 / 规则 / 策略 / 标识符 / 文本）
├─ docs/PROGRESS.md                 # 本文件
├─ docs/DOMAIN.md                   # 领域层参考手册
└─ docs/adr/                        # 架构决策记录
```

规模：`src` 25 个文件 / 1,329 行；`test` 8 个文件 / 795 行。

---

## 三、验证记录（真实输出）

### 3.1 边界检查

```
$ node scripts/check-boundaries.mjs
✓ 边界检查通过：25 个领域文件，0 违规
  - 无 node: 内置模块、无第三方依赖、无 domain 外引用
  - 无 throw、无 Date.now/new Date、无 Math.random
```

### 3.2 类型检查

```
$ npx tsc --noEmit
(无输出，退出码 0)
```

`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax` 全部开启，没有用 `any` 或 `@ts-ignore`。

### 3.3 依赖规则

```
$ npx depcruise src --config .dependency-cruiser.cjs
✔ no dependency violations found (25 modules, 59 dependencies cruised)
```

### 3.4 单元测试

```
$ npx vitest run
 ✓ test/tier-policy.test.ts (3 tests)
 ✓ test/text.test.ts (9 tests)
 ✓ test/policies.test.ts (10 tests)
 ✓ test/identifiers.test.ts (15 tests)
 ✓ test/state-guards.test.ts (9 tests)
 ✓ test/state-matrix.test.ts (4 tests)
 ✓ test/rules.test.ts (17 tests)

 Test Files  7 passed (7)
      Tests  67 passed (67)
```

### 3.5 一条命令全量校验

```
$ npm run check        # boundaries → typecheck → depcruise → test
✔ no dependency violations found
 Test Files  7 passed (7)
      Tests  67 passed (67)
```

---

## 四、本轮最重要的一件事：状态矩阵的"双重记账"

`test/state-matrix.test.ts` 里**手工重抄了一遍设计文档 §18 的迁移表**，然后：

1. 断言 `ALLOWED_TRANSITIONS` 与手抄表**逐项一致**（键集合 + 每个状态的允许事件集合）；
2. 穷举 **18 状态 × 24 事件 = 432 个组合**，断言"表外组合全部拒绝、表内组合目标状态正确"；
3. 单独断言 4 个终态不接受任何事件；
4. 断言非法迁移的错误里带 `from / event / allowed`（供未来的 `sb explain` 使用）。

这是刻意的冗余：实现和规格由两个独立来源描述，任何一边改动都会立刻报错。测试输出里 `checked === 18 * 24` 是硬断言，防止有人缩小枚举绕过。

---

## 五、决策日志

| # | 决策 | 理由 | 后果 / 代价 |
|---|---|---|---|
| D1 | 用 TypeScript strict，而不是纯 JS | 用户指出 `.mjs` 脆弱；脆弱的第一来源是"没有类型边界" | 需要构建步骤（P4 之前用 vitest/tsx 直接跑，不产 dist） |
| D2 | 领域层用 `Result` 而不是异常 | 状态机、策略、规则要能被穷举测试；异常会让"非法迁移"变成控制流跳转 | 调用方要显式处理 `ok/error`；边界检查禁止 `throw` |
| D3 | 时钟由 `ctx.now` 注入，禁止 `Date.now()` | 同一输入必须得到同一输出，回放才能校验 | 每个用例要传 `now`；换来可重放 |
| D4 | 品牌类型（RawPath/DraftId/CommitSha/ContentHash） | 防止把"随便一个字符串"当路径传进领域 | 构造要走 `parse*()`，返回 `Result` |
| D5 | 状态矩阵测试手抄规格 | 单一来源的表容易"实现即规格"地漂移 | 改规格要改两处，但这是有意为之 |
| D6 | 预警用 `Finding` 数据结构，而不是字符串 | 便于 CLI/未来 UI 渲染、逐条单测、`explain` | 规则必须声明 `ruleId / severity / detail` |
| D7 | 规则从设计稿的 9 条扩到 **10 条** | 补上 `r-source-disabled`（source-scope 闸门），否则禁用来源只能靠应用层自觉 | 与设计文档 §4.3 的表格差 1 条，已在 `docs/DOMAIN.md` 说明 |
| D8 | 重试守卫用 `max(状态里的 attempts, 事件里的 attempts)` | 初版只读事件值，测试发现调用方传小值即可绕过上限 | 已修，并留了为什么这么写的注释 |
| D9 | tsconfig 用 `moduleResolution: Bundler` | P1 只跑测试、不需要产物；Bundler 省掉 `.js` 扩展名 | **P4 落地运行时前要重新评估**（可能切 NodeNext + 显式扩展名） |
| D10 | 本轮不建 `application/adapters/runtime` 目录 | 先让"依赖只能向内"这条规则在最小集合里被验证 | 边界脚本目前检查"domain 不引用外层"，暂时不需要外层存在 |

---

## 六、缺陷与修正（真实发生）

### 6.1 规则文件里的 `this.id` 陷阱

初版两条规则用对象方法简写 + `this.id`。方法被解构或单独调用时 `this` 会丢失，属于典型的"今天能跑、明天迁移就炸"。已全部改为**字面量 ruleId**，并在规则测试里断言"命中时 `finding.ruleId` 与规则自身 id 一致"。

### 6.2 重试上限可被绕过

初版 `RETRY` 守卫只读事件里的 `attempts`，于是调用方传 `attempts: 1` 就能在 `attempts: 3` 的状态上继续重试。测试 `attempts 达到上限时 RETRY 被拒绝` 捕获。修正为取 `max(from.attempts, event.attempts)`，并在代码里写清"避免调用方传小值绕过上限"。

### 6.3 `r-near-duplicate-node` 的阈值边界

`幂律分布` vs `幂律` 的 2-gram Dice 恰好是 **0.5**。测试把"≥0.5 命中"这一边界固定下来，避免以后调阈值时无意改变行为。

---

## 七、已知边界（P1 范围内刻意不做）

1. **不做 I/O**：没有读文件、没有 git、没有数据库。raw 路径是否存在由应用层通过 `knownRawPaths` 传入。
2. **不做语义**：triqge 只数"判断句"，真正的价值判断在模型侧；领域层不引入任何模型依赖。
3. **不做事件持久化**：`event` 表在 P2 实现；领域层已提供 `applyEvents()` 供回放测试。
4. **不校验 frontmatter**：那是 `format-spec` 的适配器职责（Parser 边界用 zod）。
5. **`expired` 只记录"从哪来"**，不做自动清理策略；TTL 扫描属于应用层定时任务。
6. **`abandoned` 的 canonical 指针可为空**：人工 ABANDON 时没有 canonical，这在类型上被显式建模（`RawPath | null`），而不是靠约定。

---

## 八、下一步（P2，待启动）

| 任务 | 验收 |
|---|---|
| SQLite 适配器：schema + 迁移运行器 + 仓储 | `migrate` 可对空库重跑；`PRAGMA integrity_check` 通过 |
| 状态与事件同事务写入 | 用例失败时状态与 event 一起回滚 |
| 乐观锁（`version` 列） | 并发更新只有一个成功，另一个得到 `ConcurrencyError` |
| 事件回放 | 用 `applyEvents` 重建状态，与 DB 逐字段一致 |

**启动 P2 前需要一个确认**：数据库选型——Node 22+ 内置 `node:sqlite`（零依赖但 API 较新），还是 `better-sqlite3`（成熟但需原生编译）。当前建议前者，等 P2 第一行代码前再定。

---

## 九、变更时间线

| 时间 | 事件 |
|---|---|
| 2026-10-30 22:2x | 建项目、装依赖（typescript 5.9.3 / vitest 5.0.5 / dependency-cruiser 18.7.0） |
| 2026-10-30 22:2x | P0：tsconfig、依赖规则、边界脚本 |
| 2026-10-30 22:2x | P1：模型 → 策略 → 规则 → 状态机 |
| 2026-10-30 22:2x | 首次 `npm run check`：1 个测试失败（重试守卫），修正后全绿 |
| 2026-10-30 22:29 | 67 测试通过、25 模块 59 依赖无违规 |

---

## 十、v2 重构：Monorepo（2026-10-30 22:3x）

### 10.1 为什么改

用户要求：仓库要上 Git，按 **pnpm monorepo** 组织，后续还有别的子模块要加入。原单包结构无法在"物理层面"约束新模块的依赖方向。

### 10.2 变更内容

| 变更 | 说明 |
|---|---|
| 引入 pnpm workspaces | `pnpm-workspace.yaml`（`packages/*`、`apps/*`），根 `package.json` 持有共享 devDependencies 与脚本 |
| `src/` → `packages/domain/src/` | 领域层独立成 `@sb/domain`，零依赖不变 |
| 新增 `@sb/contracts` | 端口（StateStore / VaultReader+Writer / SearchIndex / AgentPort / LockPort / Clock）+ 跨端 DTO（ReviewViewV1 / QueueItemV1） |
| tsconfig 拆分 | `tsconfig.base.json`（共享 strict 选项 + `@sb/*` paths）+ 根 `tsconfig.json`（覆盖所有包）+ 每包 `tsconfig.json` |
| vitest 统一入口 | 根 `vitest.config.ts`：`@sb/*` 别名 + `packages/*/test/**` 自动发现 |
| 边界检查升级为多包 | `tools/check-boundaries.mjs`：包白名单、禁止深引、禁止 domain→contracts、包清单必须登记 |
| CI 改 pnpm | `pnpm/action-setup@v4` + `pnpm install --frozen-lockfile` + `pnpm run check` |

### 10.3 验证记录

```
$ pnpm run check
✓ 边界检查通过：2 个包 / 35 个文件，0 违规
  - @sb/domain: 允许依赖 [无]，纯函数包=true
  - @sb/contracts: 允许依赖 [@sb/domain]，纯函数包=true
✔ no dependency violations found (45 modules, 130 dependencies cruised)

 Test Files  8 passed (8)
      Tests  74 passed (74)      # 原 67 + 契约冒烟 7
```

### 10.4 新增的契约冒烟测试（7 例）

`packages/contracts/test/ports.test.ts` 用假实现证明端口"可实现、能注入"：

1. `StateStore.transaction` 传递 tx 并按预期抛错；
2. `VaultPort` 完成读→写→提交→回滚闭环；
3. `SearchIndex` 返回带 `score/matchType` 的命中；
4. `AgentPort` 收到**只读工具白名单**（断言不含 `write_node`）并返回 `DraftProposal`；
5. `Clock` / `LockPort` 可注入（不读系统时钟）；
6. `ReviewViewV1` 字段完整、`actions.accept` 可驱动按钮、可 JSON 序列化；
7. `QueueItemV1` 允许 `triage/draftId` 为空。

### 10.5 决策日志（续）

| # | 决策 | 理由 | 代价 |
|---|---|---|---|
| D11 | 包按**层**切分，不按功能切分 | 层边界稳定，功能会变；`@sb/domain` 独立成包才能被工具物理隔离 | 早期包稍多，但每个包职责单一 |
| D12 | 暂不引入 turbo / nx | 2 个包、无产物，编排器没有收益 | 触发条件写在 ADR 0003：包 > 5 或需要按图构建时再评估 |
| D13 | 单一 tsconfig + paths，暂不用 project references | 测试阶段没有构建顺序需求 | **P4 落地运行时时必须切换**，且 `exports` 要从 `.ts` 改为 `dist/` |

### 10.6 待办（monorepo 相关）

1. `packages/*/package.json` 的 `exports` 仍指向 `./src/index.ts`，只适用于开发/测试；P4 前改 `dist/` 并加 build 脚本。
2. 根 `tsconfig.json` 一次检查全部包，包多起来后改为 `tsc -b` 增量构建。
3. `apps/` 目前只有 README 占位；P5 创建 `apps/cli` 时按 `docs/MONOREPO.md` §3 登记边界规则。

---

## 十一、P2：`@sb/adapters-sqlite`（2026-10-30 22:3x）

### 11.1 交付内容

| 文件 | 内容 |
|---|---|
| `src/migrations.ts` | v1 schema：raw_item / draft / review_decision / commit_record / job / event |
| `src/migrate.ts` | 幂等迁移运行器（每版本一个事务）+ `schemaStatus()`（版本 + integrity_check） |
| `src/state-codec.ts` | 状态 ↔ (kind 列 + JSON 列)；读时校验枚举，坏数据在适配器边界暴露 |
| `src/mapping.ts` | 行 ↔ 契约记录映射（乐观锁/JSON 字段） |
| `src/sqlite-store.ts` | `StateStore` 实现：事务（可嵌套）、5 个仓储、乐观锁、原子领取任务、事件流 |
| `src/node-sqlite.d.ts` | 最小 `node:sqlite` 类型声明（避免引入 @types/node，保持领域层干净） |

### 11.2 验收对照（设计文档 P2 条目）

| 验收项 | 结果 |
|---|---|
| `migrate` 可对空库重跑 | ✅ 第二次 applied=[] / skipped=[1]；schema_migrations 单行 |
| 状态与事件同事务 | ✅ 抛错时 raw_item 与 event 一起回滚（count 都为 0） |
| 乐观锁 | ✅ 版本陈旧返回 false，状态不变；同一事务内两次 CAS 只有第一次成功 |
| 事件回放一致 | ✅ 8 个事件回放后与库中状态逐字段相等；**篡改事件顺序会返回 `INVALID_TRANSITION`** |
| 任务领取 | ✅ `UPDATE ... RETURNING *` 原子领取，`attempts` / `fencing_token` 自增，lease 计算正确 |
| 中文与 JSON 字段 | ✅ claim/节点/findings/proposal 均 JSON 往返 |

### 11.3 验证记录

```
✓ 边界检查通过：3 个包 / 42 个文件，0 违规
✔ no dependency violations found (56 modules, 160 dependencies cruised)

 Test Files  11 passed (11)
      Tests  95 passed (95)        # P1 74 + P2 新增 21
```

P2 新增测试分布：`migrations` 4 例、`store` 13 例、`replay` 4 例。

### 11.4 决策（续）

| # | 决策 | 理由 | 代价 |
|---|---|---|---|
| D14 | 用 `node:sqlite` 而非 better-sqlite3 | 零原生编译、`DatabaseSync` 与单写者契合；实测支持 `RETURNING` | 实验性 API；用最小类型声明隔离 |
| D15 | 状态存 `kind` 列 + `state_data` JSON 列 | kind 可索引可查询；JSON 保留完整可辨识联合 | 跨版本字段演进需要迁移脚本 |
| D16 | `upsert` 只用于导入/初始化，状态流转必须走 `compareAndSwapVersion` | 避免并发下静默覆盖 | 调用方要区分两种写入语义（已写注释） |

### 11.5 已知缺口（留给后续阶段）

1. **围栏令牌尚未在写入侧校验**：`fencing_token` 已在领取时自增，但状态写入还没带 `WHERE fencing_token = ?`——要到 P5 有 worker 循环时才落地（否则没有"陈旧 worker"可防）。
2. **租约续期未实现**：长模型调用需要心跳续租；P4/P5 补。
3. **wiki_node / FTS 表未建**：检索索引属于 P6，端口 `SearchIndex` 已定，实现待做。
4. **job 死信（`state='dead'`）未实现自动转移**：当前只有状态枚举，转移策略在 worker 里加。
5. 迁移的"半迁移恢复"只测了重复执行，没有测断电中断；P3 与对账一起补。
