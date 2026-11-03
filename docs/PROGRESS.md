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

---

## 十二、P3：`@sb/adapters-vault`（2026-10-30 23:0x）

### 12.1 交付

| 文件 | 内容 |
|---|---|
| `src/vault.ts` | `VaultPort` 实现：listRaw（含 sha256）/ listNodes / readRaw / readNode / writeNode（原子写）/ head / isClean / commitFiles / resetHard |
| `src/lock.ts` | `FileLock`：O_EXCL 原子创建、pid+时间戳、陈旧锁回收、幂等释放 |
| `src/index.ts` | 公开面 |

### 12.2 安全约束（测试锁定）

1. **路径逃逸**：`wiki/../../evil.md`、`/tmp/evil.md`、`../outside.md` 全部被拒（`PATH_ESCAPE`）。
2. **写边界**：只允许写 `wiki/`；写 `raw/` 返回 `NOT_WIKI_PATH`。
3. **原子写**：临时文件 + rename，测试断言目录里没有 `.tmp-` 残留。
4. **空提交**：无变更时抛 `NO_CHANGES`，不产生空 commit。
5. **可回滚**：`resetHard` 后文件内容与 HEAD 都回到指定提交。
6. **单写者**：第二个持有者 `LOCK_HELD`；陈旧锁超过 `staleMs` 自动回收。

### 12.3 验证

```
✓ 边界检查通过：4 个包 / 45 个文件，0 违规
✔ no dependency violations found (62 modules, 174 dependencies cruised)

 Test Files  13 passed (13)
      Tests  112 passed (112)     # P2 的 95 + P3 新增 17
```

### 12.4 决策（续）

| # | 决策 | 理由 | 代价 |
|---|---|---|---|
| D17 | 引入 `@types/node`，tsconfig 全局 `types: ["node"]` | 适配器需要 fs/path/crypto/child_process 的类型 | 纯包编译期也能看到 Node 全局 → 由边界脚本补禁 `process/Buffer/__dirname/__filename/require` |
| D18 | 锁用 `O_EXCL` 文件而非 `flock` | 跨平台、零依赖、可观测（锁文件里有 pid/时间） | 需要陈旧锁回收策略（已实现 staleMs） |
| D19 | `FsVault` 不注入 `Clock` | git 提交时间由 git 自己管，vault 没有需要注入时间的写入 | 无 |

### 12.5 尚未完成（与设计 §9 的差异）

- **提交两阶段的"意图表"与启动对账 `Recover()` 没做**：它需要 `application/commit-draft` 用例配合（写 intent → 提交 → 记账），放到 P5 应用层与 commit 用例一起落地，避免现在做一个没人调用的对账器。
- `commitFiles` 目前是"add 全部指定文件 → commit"，还没有"提交前比对目标节点 content_hash"的守卫（那属于应用层编排）。

---

## 十三、测试方案 + 应用层 + 可启动的 mock 审核台（2026-10-30 23:1x）

### 13.1 新增内容

| 包/应用 | 职责 | 测试 |
|---|---|---|
| `@sb/adapters-search-memory` | SearchIndex 内存实现（从 vault 建索引；供 mock 与规则评估） | 6 例 |
| `@sb/testing` | 测试夹具（7 篇原文 + 3 个节点）、`MockAgent`、`createHarness()` | 3 例 |
| `@sb/app` | 用例：`ingestAndTriage` / `draftDigest` / `decideReview` + 读模型 `listQueue` / `reviewView` | 5 例 |
| `@sb/server` | HTTP + 服务端渲染审核台（无前端框架，手机可用） | 3 例（e2e） |

### 13.2 实际跑通的闭环

在临时数据目录启动真实服务后，用 curl 走完：

```
POST /actions/ingest   → 303，队列出现 4 篇（另 2 篇低价值、1 篇超长已自动延后）
POST /actions/digest   → 303 → /review/draft-xxxx
GET  /review/draft-xxxx → HTML 含「通过并入库」、3 条 claims、目标节点「反脆弱」
POST /review/:id/accept → 303
校验：wiki/concepts/反脆弱.md 新增 3 条 claim；git log 出现
      `digest: raw/knowledge/cubox/mock-2026-10-01 反脆弱的第二条证据.md`
```

页面快照：`docs/snapshots/10-dashboard-before.html`、`11-review.html`、`12-dashboard-after.html`。

### 13.3 工程化调整

1. **`@types/node` + `types: ["node"]`**：适配器需要 Node 类型；纯包改用边界脚本补禁 `process/Buffer/__dirname/__filename/require`。
2. **边界检查支持分层开关**：`forbidThrow/forbidClock/forbidRandom/forbidNodeGlobals` 取代单一 `pure`——应用层允许 `AppError`、但仍禁止读时钟。
3. **契约扩展**：`SearchIndex.allDocs()`（规则评估需要现有节点快照）、`DraftRepo.listByStatus()`（待审列表）、`IdGenerator` 端口。
4. **运行方式**：`tsx` 运行 TS（Node 原生 strip-types 对跨包相对导入要求 `.ts` 扩展名，暂不改造；P4 切构建产物后移除）。

### 13.4 验证

```
✓ 边界检查通过：7 个包 / 58 个文件，0 违规
✔ no dependency violations found (78 modules, 214 dependencies cruised)

 Test Files  17 passed (17)
      Tests  129 passed (129)
```

### 13.5 已知缺口

1. **真实模型 provider 未接**（P4）：`MockAgent` 是确定性替身，不代表真实提炼质量。
2. **`commit_intent` 两阶段与启动对账 `Recover()` 未实现**：`decideReview` 目前是「写文件 → git commit → 记状态」，失败用 `resetHard` 兜底；断电恢复类测试缺失（P5）。
3. **写 wiki 与写状态不同事务**：极端情况下 git 成功、库失败会留下不一致；对账器补上后可收敛。
4. **UI 无鉴权**，只绑 `127.0.0.1`。

---

## 十四、真实模型接入方案（ADR 0005，仅方案，未实现）

按用户要求先定方案、不落代码。核心结论：

1. **模型是易变供应商**：`AgentPort` 是唯一接缝，后面加三层——路由（能力→模型，配置驱动）、执行（预算/缓存/幂等/超时/降级/计量）、评估（golden set 准入）。
2. **按能力路由，不按模型名**：`ModelProfile` 声明上下文/结构化输出/敏感级别/价格/限流；业务只引用 profile id。
3. **成本在调用前算**：`estInput = 字数×0.7 + prompt + 检索`，三级闸门（单次/单任务/每日）；缓存 key 含 `contentHash + promptSha + profileId + 检索节点`，复跑免费；`draftIdem` 保证一篇 raw 只有一份待审草稿。
4. **降级链**：超时/限流/5xx 才降级；契约违反只重试一次后进人工；降级必须写 provenance 并在人审页显示。
5. **golden set 是唯一能对抗换代的资产**：30–50 条标注，门槛是格式 100%、可验证 100%、目标命中 ≥90%、`mustNotContain` 零违规、判断密度 ≥60%、成本达标。

### 决策（续）

| # | 决策 | 理由 | 代价 |
|---|---|---|---|
| D20 | 路由按能力而非模型名；固定快照禁用 `-latest` | 模型换代只改配置；行为可归因 | 需要维护 profile 配置表 |
| D21 | 预算法在调用前、缓存与幂等在执行层 | 避免"事后看账单"与重复付费 | 预估有误差，需保守系数 |
| D22 | golden set 作为换型准入门槛 | 没有它，换模型等于盲赌 | 初期需要标注 30–50 篇 |

### 待用户拍板（P4.2 前必须确认）

1. `dedao` / `podcast` 付费内容是否允许发云模型（否则需本地模型）。
2. 日/月预算上限。
3. 判断密度可接受下限。
4. golden set 由谁维护标注。

---

## 十五、P4.1：模型运行时骨架（2026-10-31）

### 15.1 交付

`@sb/agent-runtime`（24 例测试，不接真实模型）：

- **路由**：`ModelProfile` + `TaskPolicy`，按能力（上下文/结构化输出/工具调用/敏感度）筛选，支持 `fallbackTo` 追加与去重、禁用跳过并记录拒绝原因。
- **预算**：调用前估算 `estInput = 字数×0.7 + prompt + 检索`；单次与每日双闸门；跨天自动归零。
- **缓存**：`contentHash + promptSha256 + profileId + 检索节点` 为 key；命中不调用模型、不计费。
- **执行**：超时/限流/5xx 重试（≤2）后降级；契约违反只重试一次（回喂错误），再失败抛 `CONTRACT_VIOLATION`；拒答不重试。
- **契约**：`AgentPort` 升级为返回 `AgentOutcome { proposal, provenance, cost }`；`DigestRequest` 增加 `sensitivity`；`validateDraftProposal` 做结构校验。
- **配置样例**：`config/model-profiles.example.json`（P4.2 接入加载与校验）。

### 15.2 验证

```
✓ 边界检查通过：8 个包 / 65 个文件，0 违规
✔ no dependency violations found (95 modules, 260 dependencies cruised)

 Test Files  20 passed (20)
      Tests  153 passed (153)     # P3 后 129 + P4.1 新增 24
```

### 15.3 决策（续）

| # | 决策 | 理由 | 代价 |
|---|---|---|---|
| D23 | `AgentPort` 返回 `AgentOutcome` 而非裸 `DraftProposal` | 换模型/降级必须可归因（profileId、fallbackChain、tokens） | 所有调用点改一次 |
| D24 | 契约校验放在 domain（`validateDraftProposal`） | 纯函数、可单测；provider 适配器无法绕过 | 领域包新增一个文件 |
| D25 | 缓存按 `profileId` 分桶 | 不同模型输出不可互用，避免"降级后拿到强模型缓存" | 换模型后首次调用不命中 |

### 15.4 下一步（P4.2，需要用户确认）

1. 敏感度边界（付费内容能否发云模型）；
2. 日/月预算上限；
3. 判断密度门槛；
4. golden set 标注由谁维护。

---

## 十六、用量计量（2026-10-31，替代硬预算）

用户决定：**不设预算上下限，但必须知道消耗了多少。**

### 16.1 交付

| 位置 | 内容 |
|---|---|
| `@sb/contracts` | `UsageRecord` / `UsageRepo` 端口；`Transaction` 增加 `usage` |
| `@sb/adapters-sqlite` | 迁移 v2 建 `usage_record` 表；`append / listAll / listByDay` |
| `@sb/app` | 起草时**同事务**写 usage；新增 `usageSummary`（按天 / 按 profile / 总计，含估算成本） |
| `@sb/agent-runtime` | `BudgetLimits` 两个上限改为可选：不填 = 纯计量，不拦截 |
| `@sb/server` | 首页用量卡片；`GET /usage` 页面；`GET /api/usage` |

价格表为空时成本显示 0，但 tokens、调用数、缓存命中始终准确；填上价格即可得到估算成本。

### 16.2 验证

```
✓ 边界检查通过：8 个包 / 65 个文件，0 违规
✔ no dependency violations found (97 modules, 282 dependencies cruised)

 Test Files  20 passed (20)
      Tests  157 passed (157)
```

实际启动后走一遍（mock）：`/api/usage` 返回 `1 call / 1200 in / 300 out / cost 0`，`/usage` 页面按天与 profile 展示一致。

### 16.3 决策（续）

| # | 决策 | 理由 | 代价 |
|---|---|---|---|
| D26 | 预算不做硬拦截，改为 usage 账本 + 汇总 | 硬上限容易卡死任务；用户要的是"看得见" | 需要人工判断何时停 |
| D27 | usage 与草稿同事务写入 | 草稿存在但账本缺失会导致成本漏记 | 每次起草多一次 insert |
| D28 | 成本按"当前价格表 × 历史 tokens"估算 | 价格会变，精确账单需要供应商对账单 | 估算值，非最终账单 |

### 16.4 下一步

- P4.2 真实 provider（仍需确认付费内容是否上云）；
- `sb stats --cost` CLI（目前只有 HTTP 页面与 API）；
- 把 `config/model-profiles.example.json` 接成真正的配置加载与校验。


---

## 十七、P4.2：真实 provider 接线（决策 A：全部走云模型）

### 17.1 决策

用户确认：得到/播客内容均为自费购买、仅自用、不公开 → **按方案 A，全部来源走云模型**，不再做敏感度分流。`sensitivity` 字段保留，作为将来切本地模型的开关。

### 17.2 交付

| 位置 | 内容 |
|---|---|
| `@sb/adapters-agent-openai` | OpenAI 兼容 `/chat/completions`：Bearer 鉴权、`response_format: json_object`、超时控制、错误分类（429→rate_limit、5xx→upstream、content_filter→refusal、超时→timeout） |
| `@sb/agent-runtime/config.ts` | `parseModelPolicy`：profiles / policies / budget 结构校验；未配置的任务复用 digest 策略；重复 id、悬空 fallback、非法敏感度都会报错 |
| `apps/server/src/runtime.ts` | 启动时按 `MODEL_BASE_URL` 选择 mock / cloud；云端模式组装 `OpenAICompatibleProvider + AgentRunner`，价格表注入 `AppContext.pricing` |
| `apps/server/src/prompt.ts`（合并入 runtime） | digest 系统提示 + 渲染函数；`promptSha256` 进入 provenance 与缓存 key |
| 安全 | `MODEL_API_KEY` 只从环境变量读取；缺失时启动即失败；`config/model-profiles.json` 与 `.sb-demo/` 已加入 `.gitignore` |

### 17.3 实测

| 场景 | 结果 |
|---|---|
| 默认启动（无环境变量） | mock 模式，首页显示「mock 模型模式」，`/api/health` 正常 |
| `MODEL_BASE_URL` 存在但缺 `MODEL_API_KEY` | 启动即失败：`缺少 MODEL_API_KEY（不要写进配置文件或日志）` |
| provider 单测（本地假 HTTP 服务） | 鉴权头、请求体、JSON 输出、429/5xx、content_filter、超时、非 JSON 原文全部覆盖 |

### 17.4 验证

```
✓ 边界检查通过：9 个包 / 73 个文件，0 违规
✔ no dependency violations found
 Test Files  22 passed (22)
      Tests  168 passed (168)
```

### 17.5 下一步

1. 填 `config/model-profiles.json` 的真实 `model` 与 `pricing`，用你的 key 跑一篇真原文；
2. 用真实产出建立 golden set（30–50 篇）；
3. 若要本地模型：新增 `@sb/adapters-agent-ollama` 与本地 profile，代码不改。

---

## 十八、DeepSeek 接入（2026-10-31）

### 18.1 结论

DeepSeek 兼容 OpenAI 协议，**不需要新适配器**；只加了配置与一层"厂商参数透传"。

| 内容 | 说明 |
|---|---|
| `ModelProfile.providerOptions` | 配置里的厂商私有参数原样并入请求体（DeepSeek 的 `thinking` / `reasoning_effort`） |
| `config/model-profiles.deepseek.example.json` | flash（triage，thinking 关闭）+ v4-pro（digest，thinking high，fallback flash） |
| `scripts/check-model-config.ts` | `pnpm check:model [config]`：解析配置并打印每个任务的 profile 链，不调用模型 |
| 测试 | providerOptions 透传 1 例；DeepSeek 示例配置解析 1 例（总计 170 例） |

DeepSeek 关键事实（来自官方文档，2026-10）：

- 模型：`deepseek-flash`、`deepseek-v4-pro`；上下文 1M，最大输出 384K；
- JSON 输出：支持，但输出不合法时会返回空白 content → runner 按契约失败重试；
- thinking：默认开启；`{"thinking":{"type":"disabled"}}` 关闭，`reasoning_effort` 可调；
- 价格（峰值 cache-miss）：flash $0.3/$1.2，pro $1.32/$3.96 每百万 tokens；off-peak 减半。

### 18.2 验证

```
$ pnpm run check:model config/model-profiles.deepseek.example.json
✓ 配置合法
  triage → deepseek-flash → deepseek-v4-pro
  digest → deepseek-v4-pro → deepseek-flash

 Test Files  22 passed (22)
      Tests  170 passed (170)
```

### 18.3 待办

1. 用真实 key 跑一篇，核对 token 与官方账单口径（尤其 cache hit）；
2. 账本支持 cache-hit 单价与 off-peak 时段（目前单一定价，偏保守）；
3. golden set 建立后，对比 flash 与 v4-pro 的质量/成本曲线。

### 18.4 调整（2026-10-31）：默认全部使用 deepseek-flash

用户决定先用 flash 跑。配置调整：

- 所有任务的 `profileOrder` 改为 `["deepseek-flash"]`；
- `deepseek-flash.health.fallbackTo` 置空，避免失败时意外调用 v4-pro 产生更高费用；
- `deepseek-v4-pro` 保留在配置中，作为手动升级选项（改 `profileOrder` 即可）；
- root 脚本新增 `pnpm demo:deepseek`（默认 base URL 为 api.deepseek.com，读取 `config/model-profiles.json`）；
- 新增**云端链路端到端测试**（本地假 OpenAI 服务）：验证 provider → runner → 存储 → git 入库 → usage 记账全链路，断言 tokens 1234/234 与成本 0.001702。

### 18.5 最新验证

```
$ pnpm check:model config/model-profiles.json
✓ 配置合法
  triage / digest / review-rewrite / decide → deepseek-flash

 Test Files  23 passed (23)
      Tests  172 passed (172)
```


---

## 十九、P5 简化版：幂等重放 + 失败即停（2026-10-31）

### 19.1 决策

不做完整 `commit_intent` 对账器（8 个崩溃点判定），改为五条规则：原子写、写前 hash 比对、提交带 draftId、两阶段状态、启动重放 approved 草稿。详见 ADR 0006。

### 19.2 交付

| 层 | 改动 |
|---|---|
| contracts | `HashPort`、`DraftRecord.targetHashes`、`VaultReader.lastCommitMessage()` |
| sqlite | 迁移 v3：`draft.target_hashes` |
| vault | `lastCommitMessage()` |
| app | `decideReview` 拆两阶段（批准 → `commitApproved`）；新增 `recoverPending` / `markRolledBack`；patch 幂等（已写入的 claim 不重复追加） |
| server | 启动时先 `recoverPending()`，脏工作区/失败即拒绝启动 |

### 19.3 验证

```
✓ 边界检查：9 个包 / 69 个文件，0 违规
 Test Files  24 passed (24)
      Tests  176 passed (176)     # 新增 recovery 4 例
```

真实启动验证：

- 干净工作区 → 正常启动并返回 git head；
- 人为在 wiki 里制造未提交改动 → 启动失败：`DIRTY_VAULT ... 请人工确认后执行 git checkout -- .`

### 19.4 决策（续）

| # | 决策 | 理由 | 代价 |
|---|---|---|---|
| D30 | 不做 `commit_intent` 表 | 单写者 + 幂等重放已覆盖崩溃场景 | 无法自动判定"未知 HEAD"（拒绝启动） |
| D31 | `approved` 作为 durable 中间态 | 崩溃后重启有明确的重放入口 | 状态机多一个稳定态 |
| D32 | patch 幂等按"claim 文本是否已存在"判断 | 重渲染会重复追加；内容比对不足 | 极少数同文 claim 会误判为已写（可接受） |
| D33 | 只有真的写过文件才 `resetHard` | TARGET_MOVED 发生在写入前，回滚会误删外部改动 | 需要 `wroteAny` 标记 |

### 19.5 剩余缺口

1. 完整对账（未知 HEAD 自动判定）仍不做，按 ADR 0006 的触发条件再升级；
2. golden set 与真实模型质量基线；
3. prune / decide 用例；
4. cache-hit 与 off-peak 计价。

---

## 二十、文档维护机制（2026-10-31）

用户要求"整个方案要持续维护好"。把这件事从"口头约定"做成**机制**：

### 20.1 交付

| 文件 | 作用 |
|---|---|
| `AGENTS.md` | 代理/维护者工作约定：必读顺序、架构边界、文档维护硬约束、提交规范 |
| `docs/INDEX.md` | 文档地图：每份文档的用途与"何时更新"，以及阅读路径 |
| `docs/MAINTENANCE.md` | 维护规则：三类文档寿命、改动→文档对照表、检查机制、评审清单、反模式 |
| `scripts/check-docs.mjs` | 机械检查：文档未登记、ADR 编号断号、文档链接失效 → CI 失败 |
| `.github/pull_request_template.md` | PR 检查清单（文档 + 验证） |
| `package.json` | `check` 链路加入 `docs:check`：boundaries → **docs** → typecheck → depcruise → test |

### 20.2 检查规则

1. `docs/` 下每份 `.md` 必须出现在 `docs/INDEX.md`；
2. ADR 编号必须从 `0001` 连续；
3. `README.md` / `AGENTS.md` / `docs/INDEX.md` / `docs/MAINTENANCE.md` 中引用的 `docs/...md` 必须存在；
4. `docs/PROGRESS.md` 必须存在且有章节。

### 20.3 验证

```
$ pnpm run docs:check
✓ 文档检查通过：8 份文档，6 个 ADR，引用完整、编号连续
```

### 20.4 约定（今后每次改动）

1. 读 `docs/INDEX.md` 决定要读哪些文档；
2. 改代码；
3. 按 `docs/MAINTENANCE.md` 第 2 节更新文档；
4. `pnpm run check` 五项全绿；
5. 一个阶段/大改动 = 一个提交。


---

## 二十一、真实模型基线（DeepSeek Flash，2026-10-31）

### 21.1 运行

`scripts/baseline.ts`（新增 `pnpm baseline`）：从真实 vault 复制 30 篇 5–15KB 文章到隔离 vault `.sb-real`，先看 triage 分布，再挑一篇 queued 走 digest → accept。

### 21.2 结果

| 指标 | 值 |
|---|---|
| triage 分布（30 篇） | queued 18（60%）、deferred 12（40%） |
| 选中样本 | 2025 年终总结（约 7KB，22 条判断句） |
| digest 耗时 | 15.6s |
| claims | 11 条（密度 0.5），inference 1 条（9%） |
| 节点 | 5 个 new concept |
| findings | 仅 INFERRED_CLAIMS（warn） |
| tokens | 2721 in / 1411 out |
| 估算成本 | $0.00251（峰值 cache-miss） |
| 重试/契约失败 | 0 |
| git | 一次提交 `77f00d5`，5 文件 190 行 |

### 21.3 发现的问题

1. **所有新节点共享全部 claims**（5 节点 × 11 claims 重复）：schema 缺少"节点 ↔ claims"映射，这是 P6 第一优先级；
2. 节点命名偏抽象，跨文章近义重复风险（精确匹配无法识别）；
3. 本次为空库，全部 `new`；patch 分支未验证（需带既有节点再跑）。

### 21.4 结论

flash 产出可用、来源 100% 可追溯、成本可忽略（2,000 篇 backlog ≈ $10）；瓶颈在 schema 与人工审核，不在模型。

### 21.5 验证

```
$ pnpm baseline
{'deferred': 12, 'queued': 18}
claims=11 inference=1 nodes=5 cost=$0.00251

 Test Files  24 passed (24)
      Tests  176 passed (176)
```

（基线脚本不改动领域/应用逻辑，测试数不变。）


---

## 二十二、部署与多端同步架构（2026-11-01，ADR 0007）

### 22.1 背景

此前默认单机单写者。用户要求最终部署在**一台机器**（VPS/本地/远端），同时保留本地采集与 Obsidian 阅读，必须回答"服务端与本地如何同步"。

### 22.2 决策（D34-D41）

| 编号 | 决策 |
|---|---|
| D34 | **服务端是唯一写者**：wiki 只由审核台 accept 写入；本地 Obsidian 只读 |
| D35 | 部署在单台常驻机器，systemd 托管，不做 SaaS |
| D36 | raw 单向：本地采集 → 服务器（只增不改） |
| D37 | wiki 单向：服务器 → 本地（pull 阅读） |
| D38 | 总线：VPS bare git 为主通道，GitHub 私有仓库每日 mirror |
| D39 | 状态库只存服务器、不同步；提供手动 backup/restore |
| D40 | accept 前同步守卫：`fetch` + 脏/远端领先则拒绝（fail closed） |
| D41 | 审核走浏览器访问服务器；本地不跑服务进程 |

### 22.3 交付

- `docs/adr/0007-hosting-and-sync.md`（决策与拓扑）
- `docs/SYNC.md`（操作手册：角色、流程、冲突、备份、手动迁移状态库）

### 22.4 实现状态

| 能力 | 状态 |
|---|---|
| 单写者 + 幂等恢复（ADR 0006） | ✅ |
| accept 前同步守卫 | ⬜ P7.1 |
| bare 仓库 / systemd / mirror / 备份脚本 | ⬜ P7.2 |
| 本地 wiki 只读强制 | ⬜ 约定，后续加 pre-push hook |

### 22.5 待办顺序

1. legacy dry-run（只读，可在本地先跑）；
2. P7.1 同步守卫；
3. P7.2 部署脚本（bare 仓库/systemd/备份）；
4. 服务器端执行 legacy apply；
5. 小批量真实处理（重点验证 patch 分支）。


---

## 二十三、Legacy 导入 dry-run（2026-11-01）

### 23.1 交付

`scripts/import-dry-run.ts`（`pnpm import:dry-run`）：只读对账，产出分类与冲突；明细写 `.sb-import/dry-run.json`（gitignore），摘要写 `docs/IMPORT-REPORT-2026-11-01.md`。

### 23.2 结果

| 分类 | 数量 |
|---|---|
| committed（wiki 引用） | 1,253 |
| queued（medium/high 未 digest） | 2,209 |
| review（digested 但 wiki 无引用） | 141 |
| deferred（low/skipped/延后） | 188（含 21 个 `_index.md`） |
| untriaged（禁用来源） | 617 |

冲突：cache 缺失 0、hash 非法 0、状态/原因词表未知 0；wiki 死链 33、digest-log 缺失 34。

### 23.3 关键发现

1. **queued 里 1,080 篇 >60k 字符**，新 ingest 会 `TRIAGE_LONG → deferred`。导入需拆成 1,129 queued + 1,080 deferred(too_long)，否则违反新策略；旧流水线能处理长文，新系统目前不能（能力回退，P6.2 待补）。
2. 617 篇 untriaged 全部来自禁用来源（newsletters 609、自媒体 8），不会入队。
3. cache 的 triage 词表与领域层完全一致，score/hash 可直接搬运。

### 23.4 修正后的预期

导入后队列 **1,129**；成本 **≈$2.82**；串行 4.9h、3 并发 1.6h。

### 23.5 验证

```
$ pnpm import:dry-run
counts: {committed:1253, queued:2209, review:141, deferred:188, untriaged:617}
longText: {queued:1080, committed:320, review:21, deferred:4}
conflicts: {cacheMissingOnDisk:0, invalidHashes:0, unknownReasons:0, wikiMissingOnDisk:33}

 Test Files  24 passed (24)
      Tests  176 passed (176)
```

### 23.6 待确认

1. 141 篇 review 的处理方式（默认 deferred 待人工）；
2. 1,080 篇长文：先 deferred（推荐）还是绕过策略；
3. apply 在服务器还是本地先试。


### 23.7 修订（2026-11-01）：长文口径 + 重新 triage

**Bug 修正**：初版 dry-run 用文件字节数判断长文，中文 1 字符≈3 字节，导致"1,080 篇长文"的误判。改为 `content.length`（字符）后：

| 指标 | 初版（错） | 修订版 |
|---|---|---|
| backlog >60k 字符 | 1,080 | **350** |
| backlog >200k 字符 | 90 | **4** |
| 旧口径 queued | 2,209 | 2,205 |
| 旧口径 deferred_long | — | 4 |

**阈值调整**（用户决策："重新跑数据，尽量让大部分直接入队"）：

- `longTextThreshold`：60,000 → **200,000** 字符（runtime 可用 `LONG_TEXT_THRESHOLD` 覆盖）；
- digest/review/decide 的 `maxInputTokens`：60,000 → **250,000**。

**按新规则重新 triage**（`pnpm import:dry-run --retriage`，3,014 篇非 committed/review）：

| 结果 | 数量 |
|---|---|
| queued | **1,955**（可处理源的 82%） |
| deferred(low) | 438 |
| deferred(source_disabled) | 617 |
| deferred(too_long) | 4 |

**导入计划更新**：committed 1,253 + queued 1,955 + deferred 438 + source_disabled 617 + too_long 4 + review 141；跳过 21 个 `_index.md`。队列成本 ≈$4.89，串行 8.5h、3 并发 2.8h。

**决策**：

| # | 决策 | 说明 |
|---|---|---|
| D42 | 141 篇 review 按 `deferred` 处理 | 待人工抽查，不自动重跑 |
| D43 | 长文阈值提升到 200k 字符 | 200k 以内直接入队；仅 4 篇例外 |
| D44 | 导入队列以"重新 triage"为准 | 旧 cache 状态仅作交叉校验 |


---

## 二十四、Legacy 导入 apply（2026-11-01）

### 24.1 决策

用户选择方案 C（并集）：队列 = 旧 cache medium/high ∪ 新规则 triage 达标。

### 24.2 交付

| 文件 | 内容 |
|---|---|
| `scripts/legacy-plan.ts` | 共用的导入计划：分类、并集队列、deferred 原因、合成 draftId |
| `scripts/import-apply.ts` | `pnpm import:apply --state <dir> [--apply]`：只写 SQLite；带预演、幂等、导入后 ingest 验证 |
| `apps/server/src/runtime.ts` | 新增 `vaultRoot` 选项（复用真实 vault + 独立状态库） |

### 24.3 结果（本地临时库 `.sb-import-test`）

| 项 | 值 |
|---|---|
| 写入 | 4,408（skipped 0） |
| committed | 1,253 |
| queued（并集） | **2,302**（两者都认可 1,852 + 仅旧台账 353 + 仅新规则 97） |
| deferred | 853（low 70 / source_disabled 617 / too_long 4 / user 162） |
| 元文件 | 21 个 `_index.md` → deferred(user)，不入队 |
| 验证 | 导入后 ingest：observed 4,408、**newItems 0** |
| 幂等 | 第二次 apply：inserted 0、skipped 4,408 |

**说明**：并集理论值 2,308，实际 2,302，差 6 个元文件（新规则会把它们判为可入队；apply 统一按元文件延后）。

### 24.4 验证

```
$ pnpm import:apply --state .sb-import-test --apply
{"phase":"import","inserted":4408,"skipped":0}
{"phase":"verify","before":4408,"after":4408,"newItems":0,"ok":true}

$ pnpm import:apply --state .sb-import-test --apply   # 第二次
{"phase":"import","inserted":0,"skipped":4408}

 Test Files  24 passed (24)
      Tests  176 passed (176)
```

### 24.5 待办

1. 服务器定下来后，用 `--state /srv/secondbrain/state` 正式导入；
2. 小批量真实处理（重点验证 patch 分支）；
3. 6 个元文件 / 141 review / 33 死链 / 4 超长文的后续清理。


---

## 二十五、服务端自动流水线（2026-11-01）

### 25.1 决策

用户决定：**不在本地做生产**，全部在服务端自动运行，避免两端逻辑不同步（ADR 0008）。

### 25.2 交付

| 内容 | 说明 |
|---|---|
| `apps/worker` | 定时 ingest + 为 queued 条目起草；**不自动入库**；JSON 日志；`pnpm worker` / `pnpm worker:once` |
| `deploy/` | env 示例、systemd unit（server/worker）、sync/backup 脚本与 timer |
| `docs/DEPLOY.md` | 从零部署步骤（目录、仓库、systemd、首次导入、验证、恢复） |
| `docs/adr/0008-automation.md` | D45-D49：双进程、tick 语义、timer 分工、失败处理、可观测性 |

### 25.3 worker 语义

每次 tick：ingest 全部新 raw（幂等）→ 取 queued 前 N 篇 → 逐篇起草 → 失败记日志下轮重试。
默认 5 分钟一次、每轮最多 5 篇；串行执行避免 SQLite 写竞争。

### 25.4 验证

```
 Test Files  25 passed (25)
      Tests  178 passed (178)     # 新增 worker 2 例
```

worker 测试断言：tick 后草稿数 = 队列数、**committed 为 0**（绝不自动入库）、二次 tick 不重复起草。

### 25.5 待办

1. P7.1 accept 前同步守卫；
2. 目标机器确定后按 DEPLOY.md 部署并在服务器执行 legacy apply；
3. 并发 >1 的任务锁、失败熔断、审核通知。


---

## 二十六、P7.1 accept 前同步守卫（2026-11-01）

### 26.1 交付

| 层 | 改动 |
|---|---|
| contracts | `VaultReader` 增加 `fetch()` / `remoteBehind()` |
| adapters-vault | `git fetch --prune`；`remoteBehind` 用 `HEAD..@{upstream}` 计数，兼容未诞生的 HEAD（新克隆空仓库） |
| app | `commitApproved` 写入前先 fetch，远端领先则抛 `OUT_OF_SYNC`（fail closed），不写文件也不回滚 |
| 错误码 | 新增 `OUT_OF_SYNC` |

### 26.2 行为

- 无 remote / 离线：fetch 静默忽略，`remoteBehind` 返回 0（本地可用）；
- 远端有新提交：accept 被拒，提示先 `git pull`；
- 与 ADR 0006 互补：恢复管"自己崩了"，守卫管"别人改了"。

### 26.3 验证

```
 Test Files  25 passed (25)
      Tests  179 passed (179)     # 新增 FsVault 远端落后检测 1 例
```

新增测试：本地 clone 落后远端 1 个提交时，`fetch()` 后 `remoteBehind() >= 1`。

### 26.4 待办

1. 目标机器确定后按 `docs/DEPLOY.md` 部署；
2. 服务器端执行 legacy apply（`inserted 4408`）；
3. 服务器访问控制（HTTPS / 认证）；
4. 本地 wiki 只读的强制手段（pre-push hook）。


### 25.6 安全护栏（2026-11-03）

worker 启动时若未配置 `MODEL_BASE_URL` 且未显式设置 `WORKER_ALLOW_MOCK=1`，**直接拒绝启动**。
原因：生产环境误用 MockAgent 会给真实文章写入假草稿；该护栏保证"要么真实模型，要么显式承认在演示"。


---

## 二十七、服务器部署（2026-11-03，腾讯云 Lighthouse）

### 27.1 环境

| 项 | 值 |
|---|---|
| 实例 | Lighthouse `lhins-iux3d3gt`（ap-singapore） |
| 系统 | OpenCloudOS 9.4，2C / 1.9G（swap 2G），磁盘 50G |
| 运行时 | Node v24.22.2（node:sqlite 可用）、pnpm 10.34.5、git 2.43、sqlite3 3.42、systemd 255 |
| 网络 | GitHub 直连可用（无需代理） |

### 27.2 部署内容

| 项 | 位置/状态 |
|---|---|
| 代码 | `/srv/secondbrain/repo`（GitHub public，已同步 `72297c7`） |
| vault | `/srv/secondbrain/vault`（私有仓库，Deploy Key 只读） |
| raw | `/srv/secondbrain/vault/raw`（独立私有仓库，第二把只读 Deploy Key） |
| 状态库 | `/srv/secondbrain/state/state.db`（已导入 4,408 条） |
| env | `/etc/secondbrain/secondbrain.env`（600） |
| 服务 | `secondbrain-server.service`（运行中，127.0.0.1:8787） |
| 定时 | `secondbrain-sync.timer`（15min）、`secondbrain-backup.timer`（每日 03:17） |
| 备份 | `/srv/secondbrain/backup/state-2026-11-03.db`（3.5M，integrity ok） |

### 27.3 验证

```
/health → {"ok": true, "head": "ba2e0a0..."}
state: committed 1,253 / queued 2,302 / deferred 853
UI <title>审核台 · secondBrain
worker: 未配置模型时启动被拒绝（mock 护栏生效）
sync: vault/raw 均 "Already up to date"
```

### 27.4 待办

1. DeepSeek key 写入 `/etc/secondbrain/secondbrain.env`（用户 SSH 操作），并设置 `MODEL_BASE_URL`；
2. 启动 worker，观察首批真实起草；
3. UI 通过 SSH 隧道访问；后续可加 Caddy + 认证；
4. 内存余量约 600M，worker 启动后需观察。


---

## 二十八、P6.1 节点 ↔ claims 映射（2026-11-03）

### 28.1 问题

基线发现：同一篇草稿的每个节点都会写入**全部 claims**（5 节点 × 15 claims = 75 行，其中 60 行重复）。原因是 `NodeChange` 没有"节点由哪些 claim 支撑"的结构。

### 28.2 交付

| 层 | 改动 |
|---|---|
| domain | `NodeChange.claimIndexes: number[]`；`validateDraftProposal` 校验下标（非空、整数、不重复、在范围内）；未提供时回退 `[]`（渲染用全部，兼容旧草稿） |
| app | `claimsForNode`：按 `claimIndexes` 选 claims；`renderNew/PatchedNode` 只写对应 claims |
| prompt | schema 增加 `claimIndexes`，规则要求"每个节点至少 1 个、不要把所有下标塞给每个节点"；prompt version 1 → 2（缓存 key 随之变化） |
| testing | MockAgent 输出全部下标（保持测试行为） |
| tests | 新增 `draft-validation.test.ts` 5 例（合法/缺省/越界/重复/空数组） |

### 28.3 验证

```
 Test Files  26 passed (26)
      Tests  184 passed (184)
```

### 28.4 遗留

- 服务器上已生成的 3 篇草稿没有 `claimIndexes`（回退为全部 claims），建议 reject 后重新起草；
- 全量跑之前先抽审新草稿，确认节点与 claims 的对应质量。


---

## 二十九、文章库与管理后台 UI（2026-11-03）

### 29.1 交付

| 页面/能力 | 说明 |
|---|---|
| `/articles` | 文章库：4,408 篇全量列表；按状态筛选（queued/committed/draft_ready/deferred…）、标题/路径搜索、分页（50/页） |
| `/articles/<path>` | 文章详情：状态、来源、字数、triage（状态/分数/判断句/reasons）、提交 sha、草稿（tier/模型/prompt 版本/rationale/findings/claims/节点及 claimIndexes）、去审阅入口 |
| `/admin` | 管理后台：状态分布、pending 草稿数、今日调用与成本、环境信息（mode/dataDir/vaultRoot）、最近事件、扫描入口与快捷链接 |
| 导航 | 首页/文章库/管理/用量/搜索 |

新增查询：`listArticles`、`articleDetail`、`adminSummary`（`packages/app/src/queries.ts`）。
`Runtime` 增加 `dataDir` / `vaultRoot` 只读字段供后台展示。

### 29.2 验证

```
 Test Files  26 passed (26)
      Tests  187 passed (187)   # 新增 e2e 3 例（文章库/详情/管理后台）
```


---

## 三十、管理后台增强 + 中文状态（2026-11-03）

### 30.1 交付

| 内容 | 说明 |
|---|---|
| 中文状态映射 | 全部 18 个状态、triage 等级、判断理由、草稿状态、worker 阶段均显示中文（筛选下拉 value 仍为英文） |
| 今日进度 | 今日起草 / 今日入库 / 今日调用 / 输入输出 tokens / 估算成本 / 速率（篇/小时）/ 剩余队列 / 预计跑完时间 |
| 运行状态 | worker 阶段（扫描/起草/等待/离线）、当前正在起草的文章（标题/路径/已运行秒数）、上轮 tick 统计、超 10 分钟未更新告警 |
| 队列与状态 | 总数、待处理、待审核、已入库、pending/已驳回草稿、状态分布（中文） |
| worker 心跳 | worker 每次 tick/每篇起草前写 `DATA_DIR/worker-status.json`（原子写），服务端读取展示 |
| 用量 | UsageSummary 增加首次/末次调用时间，用于计算速率与 ETA |

### 30.2 验证

```
 Test Files  26 passed (26)
      Tests  187 passed (187)
```

### 30.3 说明

- 心跳文件写失败不影响 worker 主流程；
- 速率按"今日调用次数 / 首次到末次调用时长"估算，样本少时会偏高，跑一会儿后趋于稳定。


---

## 三十一、暂停/继续控制（2026-11-03）

### 31.1 机制

- worker 每轮开始、每篇起草前检查 `DATA_DIR/worker-pause.json`；
- 暂停 = 当前文章处理完、不再开始下一篇；已进入的模型调用不中断；
- 继续 = 删除该文件，worker 最多 10 秒内恢复；
- 管理后台「运行状态」区块提供「暂停（完成当前任务后）」/「继续处理」按钮。

### 31.2 验证

```
 Test Files  26 passed (26)
      Tests  188 passed (188)   # 新增 worker 暂停语义 1 例
```

### 31.3 自动处理是怎么跑起来的（说明）

1. systemd 开机启动 `secondbrain-server`（UI）与 `secondbrain-worker`；
2. worker 循环：ingest 新 raw → 取 queued 前 8 篇 → 逐篇 `draftDigest`（写状态库与草稿）→ 写心跳 `worker-status.json` → 休眠 2 分钟；
3. 失败单篇记日志、下一轮重试；崩溃由 systemd 拉起，启动时 `recoverPending` 对账；
4. `secondbrain-sync.timer` 每 15 分钟 `git pull`（raw/wiki）；`secondbrain-backup.timer` 每日 03:17 快照 state.db；
5. 草稿不会自动入库：accept 只能由人在审核台点击。


---

## 三十二、管理后台信息架构重构（设计稿，2026-11-03）

用户反馈：现有后台满足基本需求，但分层与操作便利性不满意。

**诊断**：`/admin` 把监控、运维、内容统计混在一页；主任务（审核）没有独立入口；文章库筛选弱；18 个状态平铺；数字不可下钻；写操作无结果回显。

**设计**（`docs/ADMIN-DESIGN.md`）：

- 一级导航：工作台 `/`、文章库 `/articles`、审核 `/review`、运维 `/operations`、用量 `/usage`；
- 全局顶栏：worker 状态灯 + 待审计数；
- 状态分 5 组：待处理/待审核/已入库/已延后/异常；
- 工作台回答"今天该做什么"；运维页只放系统控制并回显"上次执行时间/结果"；
- 数字即入口（KPI 下钻到带筛选的列表）。

**实施顺序**：P8.1 拆分与顶栏 → P8.2 文章库分组筛选 → P8.3 审核中心 → P8.4 运维动作 → P8.5 批量与异常中心。

状态：待用户确认后实施。


---

## 三十三、P8.1 拆分运维页 + 全局顶栏（2026-11-03）

- `/admin` → **301** → `/operations`（标题「运维中心」）；
- 全局顶栏：品牌 + 工作台/文章库/审核/运维/用量/搜索 + 右侧 worker 状态灯 + 待审计数 badge；
- `/api/overview` 返回 `workerPhase`，页面 5 秒轮询刷新状态灯与徽标，状态变化提示刷新（输入中不打断）；
- 测试 188 例全绿（e2e 更新为 301/运维中心断言）。


---

## 三十四、P8.2 文章库分组/筛选/排序（2026-11-03）

- 6 个分组 tab：全部 / 待处理 / 待审核 / 已入库 / 已延后 / 异常（tab 带计数）；
- 筛选：来源、时间范围（今天/7 天/30 天）、triage 等级、关键词；排序：最近更新/判断句数/字数/标题；
- 所有筛选进 URL（可分享），分页保留条件；旧 `state=` 参数仍兼容；
- 测试 188 例全绿。


---

## 三十五、P8.3 审核中心（2026-11-03）

- `/review`：待审草稿列表；勾选/全选本页；**批量通过**（服务端逐篇 accept，成功/失败分别计数后回显）；失败项留在待审；
- 键盘：`j/k` 移动、`a` 勾选、`r` 取消勾选、Enter 打开；
- 批量通过有二次确认；单篇 accept 仍走原有校验（阻断级 finding 会被拒）；
- 测试 188 例全绿。


---

## 三十六、P8.4 运维中心动作（2026-11-03）

- 「立即扫描新原文」「立即同步 git」「立即备份状态库」三个按钮；
- 每次执行写 `DATA_DIR/last-ops.json`（时间/动作/成功失败/详情），运维页显示最近 5 条；
- 运维页展示 worker 日志最近 12 行（journalctl，权限不足时提示）；
- 测试 188 例全绿。


---

## 三十七、P8.5 异常中心 + 详情时间线（2026-11-03）

- 顶栏新增「异常」入口（`/exceptions` → `/articles?group=error`），集中查看 failed/blocked/rolled_back/quarantined 等；
- 文章详情新增「时间线」：按 aggregateId 过滤 events，展示该文章最近 20 条事件；
- 测试 188 例全绿。


---

## 三十八、claims 页 + 使用说明页（2026-11-03）

- `/claims`：已入库草稿的全部 claims（判断句、是否推断、来源原文、所属草稿）；
- `/guide`：产出如何使用（Obsidian 阅读、检索、审核追溯、JSON API、git 回滚）；
- 测试 188 例全绿。


### 38.1 修正（2026-11-03）

`/claims` 之前读"已审核草稿"，而服务器尚无 accept 记录（1,253 篇 legacy 导入没有草稿记录）→ 显示 0。
改为**从 wiki Markdown 反向解析 claims**（节点内 `- 文本（来源：[[raw/…]]）`），可立即看到已入库知识。


---

## 三十九、知识节点可视化（2026-11-03）

- `/nodes`：全部 wiki 节点（名称/别名/类型/claims 数/来源数），按 claims 数排序；类型 tab（概念/主题/人物）+ 搜索；
- `/nodes/<file>`：节点详情（定义、views、来源原文链接、相关概念）；
- 数据来自已加载的搜索索引（含 body），无需逐文件读取；
- 说明：已入库**文章**在 `/articles?group=committed`，已入库**知识**在 `/nodes`。


---

## 四十、起草背压：待审上限 300（2026-11-03）

- worker 每轮开始统计 pending 草稿，达到 `WORKER_MAX_PENDING_DRAFTS`（默认 300）时**停止起草**（ingest 仍继续）；
- 心跳标记 `pausedReason: pending_limit`；运维页显示「已触发背压 X/300」并链接审核中心；
- 防止审核跟不上时模型 API 过度消耗；
- 测试 188 → 189 例。


### 40.1 运维可配置（2026-11-03）

- 运维页新增「生产配置」：待审上限输入框，保存到 `DATA_DIR/ops-config.json`；worker 每轮读取，无需重启；
- 优先级：ops-config.json > WORKER_MAX_PENDING_DRAFTS 环境变量 > 默认 300。


---

## 四十一、批量通过优化（2026-11-03）

- fetch 节流：`git fetch` 5 秒内只执行一次（批量 accept 从 N 次降为 1 次）；
- 批量 accept 改为后台任务：POST 立即返回 jobId，审核页每秒轮询 `/api/jobs/<id>` 显示"已处理 X/Y（成功/失败）"，完成后自动刷新。


---

## 四十二、数据可视化增强（2026-11-03）

- 运维页新增「整体进度」：已入库/全部 + 真实比例进度条；
- 「最近 7 天吞吐」：每天生成草稿数的柱状图（真数据，非装饰）；
- 顶栏 worker 状态增加脉冲点（起草/扫描/等待/暂停/停止 用语义色）；
- 纯 CSS/SVG 绘制，未引入图表库；测试 189 例。


---

## 四十三、Compose C1：文章与版本表（2026-11-03）

- 迁移 v4：`article`（标题/主题/节点/大纲/状态/当前版本）+ `article_version`（版本链：versionNo、内容、引用、basedOn、source、instruction、模型/tokens/cost）；
- 设计原则：版本只增不改、可回退（restore 生成新版本）、大纲存 article.outline 不进版本链；
- 后续 C1 续：contracts 仓储 + app 用例 + `/compose` 选节点/大纲页；C2 改稿指令与 vN+1；C3 diff/恢复；C4 发布导出。


---

## 四十四、知识节点页改为面积图（2026-11-03）

- `/nodes` 顶部新增面积图：横轴为节点 claims 数分箱（0/1/2–3/4–9/10–19/20+），纵轴为节点数量；
- 图表下方显示各类型节点数与 claims 总数；列表保留在下方供检索；
- 纯内联 SVG（无图表库），真数据；测试 189 例。


---

## 四十五、Compose C1 收尾：创建文章 + 大纲（2026-11-03）

- app：`createArticle` / `saveArticleOutline` / `listComposeArticles`；
- `/compose` 页面：节点多选（前 20 个 + claims 数）、标题/主题、创建文章、文章列表；
- 下一轮：文章详情页 + 大纲 AI 生成 + v1 正文生成（C2）。


### 44.1 修订：面积图改为矩形树图（2026-11-03）

用户要求"所有节点按大小生成矩形结构"，`/nodes` 顶部改为 **squarified treemap**：每个节点一个矩形，面积 ∝ claims 数，颜色按节点类型（概念/主题/人物），悬浮显示名称与 claims 数，标签仅在大矩形内显示。


### 44.2 修订：矩形树图 → 气泡图（2026-11-03）

4,532 个节点用 treemap 会过密。改为 **packed bubble**：仅展示 claims 最多的 **Top 60 枢纽**，直径 ∝ claims 数，颜色按类型，点击进入节点详情；尾部节点折叠并提示数量。


### 45.1 命名（2026-11-03）

Compose 页面正式命名为 **「主编台」**（导航/标题/说明同步）；理由：这是人对 AI 写的稿子做主编判断、定结构、签发的地方，比"创作"更符合职责，也与审核中心（审的是原始草稿）区分开。


### 44.3 气泡滑杆 + 榜单（2026-11-03）

- 气泡图增加 Top N 滑杆（20–200，步进 10），拖动后按 URL `?top=N` 重绘；
- 下方节点表格改为**枢纽榜单**：序号 + 名称/别名 + claims 比例条 + 数值，仅显示前 60；
- 测试 189 例。


---

## 四十六、素材库命名 + C2 文章详情/大纲（2026-11-03）

- 导航加入「主编台」；「文章库」更名为「素材库」（导航/标题/说明）；
- `/compose/<id>`：文章详情，节点 claims 预览（每节点前 12 条）+ 大纲编辑保存；
- 下一步 C2：大纲 AI 生成 + v1 正文生成（结构化正文+引用）。


---

## 四十七、主编台 AI 大纲（2026-11-03）

- 文章详情增加「AI 生成大纲」：服务端直接调用 DeepSeek（MODEL_BASE_URL/KEY），基于所选节点 claims 生成 4–7 节 Markdown 大纲并保存；
- 说明：这是快速原型，模型调用暂时写在 server 层；后续应迁到 agent-runtime 的 compose 任务策略（统一预算/重试/缓存/记账）。


---

## 四十八、主编台 C2：模型接入（AI 大纲 + 正文 v1 版本链）（2026-11-03）

### 48.1 交付

| 层 | 改动 |
|---|---|
| contracts | 新增 `ComposePort`（`ComposeRequest` / `ComposeResult` / `ComposeKind` / `ComposeNodeMaterial`）：大纲与正文都从同一端口出；provenance 复用 digest 的 `AgentProvenance` |
| domain | `CITATION_MARKER` + `extractCitationSources`：正文引用 `（来源：[[raw/...]]）` 的纯函数解析（按出现顺序去重、只认 `raw/`）；+2 例 |
| agent-runtime | `AgentTask` 增加 `compose`；新增 `ComposeRunner`（路由 → 预算 preflight → text 调用 → 文本契约校验 → 重试 → 降级 → 记账 → provenance）；`CompletionRequest.responseFormat`（默认 json，text 模式不发送 `response_format`）；+13 例 |
| adapters-agent-openai | provider 支持 text 模式：不强制 JSON、raw 保留原始 Markdown（不再 JSON.parse）；+2 例 |
| app | `generateArticleOutline` / `generateArticleBody`：业务校验、引用补 claim 原文、`article_version` 版本链（v1 `ai_initial`、v2+ `ai_refine`、`basedOnVersionId`、tokens/cost）、事件 `article:version_created`，正文生成后状态转 `review`；`AppContext.composer?` + 新错误码 `MODEL_UNAVAILABLE`；+6 例 |
| testing | `MockComposer`：确定性生成大纲/正文（正文 ≥400 字、≥2 个引用标记），e2e 无需模型 key；+5 例 |
| server | 大纲/正文两个生成动作都走 `ComposePort`（删除第 47 章 server 直连 DeepSeek 的原型）；`/compose/<id>`：大纲编辑、生成正文按钮（无大纲时禁用）、正文 Markdown 渲染（引用可点回 `/articles/<raw>`）、版本历史表；+3 例 e2e |
| config | `model-profiles*.json` 增加 `compose` 任务策略（`maxOutputTokens` 8000、`expectedClaims` 12、不需要结构化输出） |

### 48.2 决策（D50-D53）

| 编号 | 决策 | 理由 |
|---|---|---|
| D50 | compose 是独立任务策略，不借用 digest | 正文不需要结构化输出，靠文本契约 + 引用标记；独立策略便于单独调模型/预算 |
| D51 | 大纲/正文用 **text 模式**，不强制 JSON | 长文包成 JSON 一旦截断就整体非法、重试浪费；Markdown 直接回传更稳 |
| D52 | 引用格式统一为 `（来源：[[raw/...]]）`，由 domain 纯函数解析 | 与 wiki claims 同格式；不信任模型自报结构，解析不到引用就拒收 |
| D53 | 第 47 章 server 直连模型的原型迁到 `ComposePort` | mock/cloud 对称、可单测、统一预算与 provenance；server 层不再出现 provider 调用 |

### 48.3 验证

```
pnpm run check
 Test Files  29 passed (29)
      Tests  223 passed (223)
```

新增 34 例（agent-runtime 13 + MockComposer 5 + provider 2 + config 3 + domain 2 + app 6 + e2e 3）。

### 48.4 已知边界 / 下一步

- C3：改稿指令（vN+1）与 diff/restore（版本表已支持，缺 UI 与指令透传）；
- C4：发布/导出（定稿 → 导出 Markdown / 发布状态）；
- compose 调用暂未写 `usage_record`（该表是 digest 专用结构），成本记在 `article_version.cost`，`/usage` 暂不含主编台；后续迁移 usage 表时一起做；
- 提示词暂放组合根 `apps/server/runtime.ts`，与 digest 提示词同处；后续可抽独立 prompt 包做版本管理。


---

## 四十九、生成成本护栏：材料 claims 抽样（2026-11-03）

### 49.1 问题

C2 首次真实生成（4 个顶级主题节点）实测：**输入 92,638 tokens / 成本 $0.033 / 23.8s**。
原因：顶级节点各有 193–428 条 claims，全量喂进 prompt；模型最终只引用了 26 条。多节点文章会线性放大，既贵又让模型难以聚焦。

### 49.2 交付

- `loadArticleMaterial` 对每个节点的 claims 做 **等距抽样**（`MAX_CLAIMS_PER_NODE = 60`，去重文本、保持时间顺序）；
- 抽样只影响"喂给模型的判断池"；正文生成后仍按引用标记回溯原文，节点页展示的 claimCount 不变；
- 新增 `sampleClaimsForPrompt` 纯函数 + 3 例测试（不抽样/等距抽样/重复文本去重）；
- 文档：ADR 0005 §13 补充材料抽样说明。

### 49.3 决策

| 编号 | 决策 | 理由 |
|---|---|---|
| D54 | 单节点生成材料上限 60 条 claims，等距抽样 | 顶级节点 claims 数百条，全量输入成本高且分散模型注意力；等距取样保留时间跨度，比截断更公平 |

### 49.4 验证

```
pnpm run check
 Test Files  29 passed (29)
      Tests  226 passed (226)
```

生产环境复跑同一篇文章生成 v2：输入 tokens 从 92,638 降至 **20,983（-77%）**，成本从 $0.0331 降至 **$0.0122（-63%）**，输出 4,894 tokens / 正文 9,261 字符；v2 写入版本链并成为当前版本。
另：第一次 v2 请求曾因模型输出不满足文本契约（引用不足）返回 500，重试后成功；抽样后材料变小，引用合规率预计改善，继续观察。


---

## 五十、Compose C3：改稿指令 + 版本 diff / 恢复（2026-11-03）

### 50.1 交付

| 层 | 改动 |
|---|---|
| app | `refineArticle`：按指令基于当前版本生成 vN+1（`ai_refine`，instruction 落库、`basedOnVersionId` 指向前一版）；`restoreArticleVersion`：把旧版本内容恢复为**新版本**（`restore`，note="恢复自 vN"，模型字段为 null）；`composeArticleDiff`：取任意两版并计算行级 diff；`composeArticleView` 版本项补 `instruction`/`note`；+10 例 |
| app | 新增 `diff.ts`：行级 LCS（`diffLines`/`diffStats`，1-based 行号、CRLF 归一、平局先删后增保证确定性）；+7 例 |
| testing | `MockComposer` 在收到改稿指令时把指令写进正文（`> 改稿要求：…`），让 mock 模式的版本 diff 有真实变化 |
| server | 新增动作路由 `/actions/compose/refine`、`/actions/compose/restore`；新增只读页 `/compose/<id>/diff?from=&to=`；文章详情页加「改稿」表单、版本历史加「指令/备注」列与「对比当前 / 对比上一版」「恢复此版」操作；+2 例 e2e |
| server | 版本历史当前版本标记「当前」；旧版本恢复有二次确认 |

### 50.2 决策（D55-D57）

| 编号 | 决策 | 理由 |
|---|---|---|
| D55 | 改稿 = 版本链追加 `ai_refine`，指令随版本落库 | 每版可追溯到"当时让模型改什么"，便于比较与复盘；旧版本永远不被覆盖 |
| D56 | 恢复旧版 = 生成新版本（`restore`），不移动指针 | 历史不可变、可反复恢复；用户看到的"当前"始终是最大版本号 |
| D57 | diff 用 app 层行级 LCS 纯函数，不引入 diff 库 | 文章百行级，Myers 优化无必要；纯函数可在无模型/无网络下测试 |

### 50.3 验证（与 C4 合并跑）

```
pnpm run check
 Test Files  31 passed (31)
      Tests  259 passed (259)
```

---

## 五十一、Compose C4：定稿 / 重新打开 / 导出 Markdown（2026-11-03）

### 51.1 交付

| 层 | 改动 |
|---|---|
| app | `publish.ts`：`finalizeArticle`（有当前版本才能定稿，重复定稿拒绝）、`reopenArticle`（final→review）、`exportArticleMarkdown`（按当前版本生成 Markdown，含标题/主题/状态/版本/导出时间/正文/引用来源清单）、`articleExportFilename`（标题清洗 + 按码点截断 60 + 空回退）；+13 例 |
| server | 动作路由 `/actions/compose/finalize`、`/actions/compose/reopen`；下载路由 `GET /compose/<id>/export.md`（`text/markdown` + RFC 5987 中文文件名）；详情页头部按钮：导出 Markdown / 定稿 / 重新打开，状态徽标区分已定稿；+1 例 e2e |
| docs | 新增 ADR 0009：文章模型与发布流程（版本链、状态机、引用、diff、导出格式） |

### 51.2 决策（D58-D60）

| 编号 | 决策 | 理由 |
|---|---|---|
| D58 | 定稿 = `status='final'`；重复定稿拒绝；重新打开回 `review` | final 是"可发布"的唯一信号，避免多次定稿产生歧义；改稿/恢复自动回 review |
| D59 | 导出基于**当前版本**，任意状态可导出，文件头标注状态 | 实用：草稿也能导出给人看；正式发布时看状态即可，不必用导出动作反向锁状态 |
| D60 | 导出格式 = Markdown（`# 标题` + 元信息引用块 + 正文 + `## 引用来源` 的 `[[raw/...]]` 清单） | 直接兼容 Obsidian/静态站点；引用来源可继续回溯原文，不接外部发布渠道 |

### 51.3 验证

```
pnpm run check
 Test Files  31 passed (31)
      Tests  259 passed (259)   # 本轮新增 33 例（diff 7 + 改稿/恢复/对比 10 + 定稿/导出 13 + e2e 3）
```

生产环境（腾讯云 Lighthouse）用真实文章跑通：改稿生成 v3、diff 页展示行级变化、恢复 v2 生成 v4（不产生模型费用）、定稿、下载 `AI 时代的认知与商业机会-v4.md`、重新打开回待主编审。

### 51.4 已知边界 / 下一步

- 发布渠道仍未接：定稿后的分发（公众号/博客/静态站）需要新的应用用例与 target 适配器，不在 UI 层直接写外部系统；
- 人工直接编辑正文（`manual_edit`）还没开放 UI，目前只能"指令改稿"或"恢复旧版"；
- 文章列表页只有状态与大纲标记，还没显示当前版本号/字数（详情页齐全）；
- `/usage` 仍不含 compose 调用，成本只记在 `article_version.cost`。


---

## 五十二、关于页 /about：工作台功能地图（2026-11-03）

### 52.1 交付

- 新增独立页面 `/about`（导航「关于」）：一句话定位 + 实时数据概览（原文总数 / 已入库 / 待审草稿 / 知识节点 / claims / 主编台文章 / 今日调用 / 今日成本）；
- 6 步工作流卡片（扫描 → AI 起草 → 人工审核 → 入库 → 主编成文 → 定稿导出）；
- 11 个功能页面卡片（工作台 / 素材库 / 审核 / 主编台 / 节点 / claims / 搜索 / 异常 / 运维 / 用量 / 使用说明），每张卡带入口链接与能力说明；
- 核心概念表（raw / 草稿 / claims / wiki 节点 / 文章版本链 / 人工闸门）+ 系统能力（自动化、节奏控制、模型与成本、数据与安全、同步备份、工程约束）；
- 运行信息（模式 mock/cloud、worker 阶段、vault HEAD、数据目录、vault 根、页面生成时间）；
- 数据与运维/用量页同源查询（`counts` / `listPendingDrafts` / `nodeStats` / `usageSummary` / `listComposeArticles` / `worker-status.json`），不新增表或索引；
- e2e 新增 1 例：页面 200、关键区块与入口齐全、导航含 `/about`。

### 52.2 决策

| 编号 | 决策 | 理由 |
|---|---|---|
| D61 | `/about` 作为功能地图，与 `/guide` 分工：About = 系统有什么、怎么运作；guide = 产出怎么用 | 新人先建立整体认知，再按需查具体用法；避免把功能总览塞进使用说明页 |

### 52.3 验证

```
pnpm run check
 Test Files  31 passed (31)
      Tests  260 passed (260)
```


---

## 五十三、去 AI 味：独立能力（检测 + 受约束改写）（2026-11-03）

### 53.1 交付

| 层 | 改动 |
|---|---|
| domain | 新增 `ai-flavor.ts`：8 条规则（框架路标词 15 / AI 黑话 15 / 否定二分与排比 10 / 宏大叙事 15 / 宣传腔 10 / 套话结尾 15 / 句长均匀 10 / 标点格式 10，权重合计 100）、命中档位 0/0.5/1、加权评分与轻/中/重分级；`metrics`（句长变异系数、段落变异、用词变化、口语密度、具体信息点）与「人味信号」highlights；纯函数、零 I/O；+24 例 |
| contracts | 新增 `DeAiPort`（`DeAiRequest`/`DeAiResult`/`DeAiStyle`/`DeAiIssue`）：改写输入带体检命中项、必保留引用、目标字数区间；`ArticleVersionSource` 增加 `deai` |
| agent-runtime | `AgentTask` 增加 `deai`；新增 `DeAiRunner`（路由→预算→text 调用→文本契约→重试/降级→记账→provenance）：输出必须是字符串、长度在 0.7–1.4 倍原文区间、引用集合 ⊆ 原文引用且原文引用全部保留（防止编造来源）；+15 例 |
| testing | `MockDeAi`：确定性替换框架词/黑话、片段级保留 `（来源：[[raw/...]]）`、回补/截断到目标长度；+6 例 |
| app | `deAiText`（体检→改写→复检，防御校验引用覆盖与长度）、`deAiArticleVersion`（对当前正文改写并生成 `source='deai'` 新版本，note 记录前后分数，状态回 review）；+9 例 |
| server | 独立页 `/deai`：粘贴文本 →「先做体检」/「去 AI 味改写」，展示评分条、命中项与原文示例、指标、人味信号、规则权重表、改写后对照；主编台文章详情页增加「去 AI 味」按钮（生成新版本）；`/about` 功能地图与导航同步收录；+4 例 e2e |
| config | 三份模型配置增加 `deai` 任务策略（text 模式、maxOutputTokens 8000、expectedClaims 10） |

### 53.2 决策（D62-D66）

| 编号 | 决策 | 理由 |
|---|---|---|
| D62 | 检测（规则）与改写（模型）分离 | 让模型"自由改"容易编造事实/虚构经历/删引用；先用确定性规则定位问题，再让模型按清单清除 |
| D63 | 评分沿用业界权重法：8 项权重合计 100，命中 1–2 处 0.5、≥3 处 1，轻(<30)/中(30–60)/重(>60) | 与中文社区「去 AI 味体检官」的权重表一致，分数可复现、可对比；但明确只是参考值 |
| D64 | 改写硬约束：保事实/数字/观点归属/引用，长度 ±30%，不编造第一人称经历 | 这是去 AI 味最常见的翻车点（编细节、删引用、越改越长）；契约校验兜底 |
| D65 | 文体门：公文/学术/新闻的规范用语不算 AI 味，只删空话不强行口语化 | 避免误伤正式文本；页面固定展示文体提醒 |
| D66 | 独立页 + 文章版本集成，不原地覆盖 | `/deai` 可处理任意文本；文章内一键生成新版本（source=deai），可 diff/恢复/定稿，历史可追溯 |

### 53.3 依据（业界实践）

- [Wikipedia:Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)：意义拔高、宣传腔、否定二分、三连排比、套话结尾、破折号/emoji 等；
- [humanizer-chinese](https://github.com/Warm1hear/humanizer-chinese)：36 条中文模式（宏大开场、升华结尾、讲义腔路标词、"不是 X 而是 Y"、排比对仗、互联网黑话、欧化翻译腔）；
- [去 AI 味体检官](https://github.com/masonweb3/de-ai-flavor)：8 检查项权重法（本实现评分方法来源）；
- CCL 2023 量化结论：AI 连接词密度约人类 3 倍、对偶句 4 次对 0.67 次、语气词密度约 1/5——支撑"框架词/对仗/句长均匀"三类权重最高。

### 53.4 验证

```
pnpm run check
 Test Files  35 passed (35)
      Tests  318 passed (318)   # 本轮新增 58 例
```

新增 58 例：domain 24 + agent-runtime 15 + MockDeAi 6 + app 9 + e2e 4。
真实模型验证：用 AI 味明显的样例（139 字）体检 68 分「重度」；改写后复检分数下降（见部署记录）。

### 53.5 已知边界 / 下一步

- 检测是启发式：引用、专名、被讨论的词、公文规范腔可能误伤；页面上明确"看聚簇不看孤例"；
- 分数不跨文体可比，且不承诺通过任何 AI 检测工具（业内检测器本身也不可靠）；
- 引用保护只校验 `raw/` 引用；其他引用格式（URL、书名）尚未纳入；
- MockDeAi 是规则替换，真实效果依赖模型；改写后建议人工复读。


---

## 五十四、去 AI 味：长度策略修正（真实模型反馈）（2026-11-03）

### 54.1 问题

真实云端模型处理一段 139 字、通篇套话的样例时，输出 68 字（把"首先/赋能/闭环/值得注意的是/未来可期"全部删掉后只剩一句实义）。
原统一长度下限 0.7x（97 字）判定为「改写后不足 97 字」，两次重试后失败——这是策略与目标冲突：**删套话必然变短**，统一 ±30% 会逼模型把套话换个说法补回来。

### 54.2 修正

- app 新增 `deAiLengthTarget(textLength, score)`：下限按 AI 味分数自适应——重度（≥60）**0.45x**、中度（30–60）**0.6x**、轻度（<30）**0.75x**；上限保持 1.4x（不得明显变长）；
- 应用层长度校验改为对比目标区间；执行层契约仍校验 `request.target`，两层口径一致；
- 提示词第 9 条改为「篇幅相当（±30%）；套话多导致变短是正常的，但不得删掉具体信息点（数字/人名/引语/引用/事件）」；prompt version 1 → 2；
- ADR 0010 D3 同步更新；新增 2 例目标区间测试。

### 54.3 决策

| 编号 | 决策 | 理由 |
|---|---|---|
| D67 | 改写长度下限按 AI 味分数自适应（0.45/0.6/0.75），上限固定 1.4x | 去 AI 味的本质是删冗余而非等量替换；自适应下限既允许删套话，又防止把信息删光 |

### 54.4 验证

```
pnpm run check
 Test Files  35 passed (35)
      Tests  320 passed (320)
```

真实模型复跑同一 139 字样例：改写成功，输出约 60–80 字，复检 AI 味分从 68 降到低分（部署后记录）。


---

## 五十五、去 AI 味：改写质量门（没降分自动重试）（2026-11-03）

### 55.1 问题

真实文章（9,261 字、51 处 `（来源：[[raw/...]]）` 引用）改写后复检分数 **58 → 58**：模型为了保住引用几乎整句照抄，只删了几个"首先/此外"，分数没有下降。引用密集时模型天然保守，一次改写不足以保证效果。

### 55.2 修正

- 提示词（v2 → v3）明确：带引用的句子也要重写，只把"（来源：[[raw/...]]）"留在对应句末；整句照抄视为失败；目标是让复检分数明显下降；
- 应用层加**质量门**：`before.score ≥ 30` 且 `after.score > before.score - 5`（没有明显下降）时，用"第二次改写"指令再调一次模型；采用两次中更低分且合规的结果；最多两次，第二次不合规/更差则保留第一次；
- 应用层校验抽成 `validate()` 复用（长度区间、引用覆盖、非空），成本按两次累计返回。

### 55.3 决策

| 编号 | 决策 | 理由 |
|---|---|---|
| D68 | 改写质量门：未明显降分则用更强指令重试一次，采用较低分结果 | 引用密集/长文场景模型容易保守照抄；靠提示词单次不可靠，用复检分数做客观门禁；限一次避免成本失控 |

### 55.4 验证

```
pnpm run check
 Test Files  35 passed (35)
      Tests  322 passed (322)
```

（真实文章复跑结果见部署记录。）


---

## 五十六、去 AI 味：提示词迭代与真实效果（2026-11-03）

### 56.1 现象与迭代

真实文章（9,000+ 字、51 处 `（来源：[[raw/...]]）`）改写后复检分数长期不动。逐版排查：

| 版本 | 改动 | 观察 |
|---|---|---|
| v3 | 明确"带引用句子也要改" | 输出 99% 行与原文相同（模型优先保引用，几乎照抄） |
| v4 | 新增"禁止照抄：不得连续 20 字与原文相同，整句照抄视为失败" | 句子开始重组（相似度 0.966），但分数仍 28→28 |
| v5 | 新增标点/排比约束（不用破折号、不给普通词加引号、不连续三句同长同开头） | 破折号清零、改写更自然，复检仍被"排比/格式"启发式扣分 |

### 56.2 结论（真实效果）

- **短文本（AI 套话密度高）效果显著**：139 字样例体检 68 分「重」→ 改写后 13 分「轻」，成本 $0.0003；
- **长文 + 引用密集**：模型在"必须保留所有引用与事实"约束下偏保守，加上体检的排比启发式（连续三句同长/同开头）对事实型段落有假阳性，分数下降有限（58→58）；
- 这属于检测启发式的假阳性和长文改写难度，不是接口/集成问题：改写结果仍然保留引用、版本可 diff/恢复，页面也如实展示复检分数。

### 56.3 决策

| 编号 | 决策 | 理由 |
|---|---|---|
| D69 | 暂不做长文分块改写；先接受"长文效果有限"并如实展示分数 | 分块涉及"按小节切分、跨段引用归属、拼接后指标一致性"，复杂度高；短文本与中等长度文本已可用，长文先靠"重试 + 人工复读"，分块列为后续优化 |

### 56.4 验证

```
pnpm run check
 Test Files  35 passed (35)
      Tests  322 passed (322)
```

真实样例（短文本）：68 → 13；文章集成：生成 v5/v6 两个 `source='deai'` 版本，引用全部保留（51 处标记/19 个来源），成本约 $0.008/次。


---

## 五十七、运维中心：GitHub 仓库状态与更新 + 维护手册（2026-11-04）

### 57.1 交付

| 层 | 改动 |
|---|---|
| server | 新增 `apps/server/src/repos.ts`：三个仓库（代码 / vault / raw）状态采集（远端、分支、HEAD、工作区、领先/落后、fetch 错误）、`git pull --ff-only`、远端 URL 校验与切换；覆盖配置持久化到 `<DATA_DIR>/repos.json` |
| server | `/operations` 新增「GitHub 仓库与维护」区块：逐仓库卡片 + 全部更新 + 检查远端（`?fetch=1` 执行 fetch）+ 修改远端；所有动作复用 `runLogged` 写入运维审计 |
| views | 仓库卡片展示远端可点击地址、分支、HEAD（短 sha/标题/时间/作者）、工作区干净/未提交、领先落后徽标；维护说明与「维护与所有权手册」链接（由代码仓库远端推导 web 地址）；`/about` 运维卡片同步 |
| docs | 新增 [docs/MAINTAINERS.md](docs/MAINTAINERS.md)：仓库清单与鉴权、单人依赖清单、日常维护、迁移/换 owner 步骤、备份恢复、故障速查、关键文件位置；INDEX 登记；DEPLOY/SYNC/ADR 0007 增加指引 |
| tests | e2e +2：仓库区块渲染；非法远端 400、未知仓库 404 |

### 57.2 决策（D70-D72）

| 编号 | 决策 | 理由 |
|---|---|---|
| D70 | 运维页作为仓库维护的唯一界面：状态 + 更新 + 修改远端，不再依赖记忆服务器命令 | 换人维护时可发现、可操作、有审计（`last-ops.json`） |
| D71 | 远端地址允许在 UI 修改：写 `git remote set-url` 并持久化到 `DATA_DIR/repos.json` | 换 GitHub 账号 / 组织 / 自建 Git 服务不需要改代码或重装；仓库路径仍由部署布局决定 |
| D72 | 「服务器 + 三个 GitHub 仓库 + API key」是完整恢复的最小依赖，个人电脑只用于采集/阅读 | 交接这三样即可延续项目，不依赖任何个人电脑或账号在线 |

### 57.3 验证

```
pnpm run check
 Test Files  35 passed (35)
      Tests  324 passed (324)
```

部署后真实核验：运维页展示代码/vault/raw 三仓库（远端地址、分支、HEAD、同步状态），逐仓库更新与「检查远端」可用；非法远端被拒。

### 57.4 后续

- 代码仓库更新后自动重启服务（当前受 systemd 权限限制，页面提示手动 restart；后续可加 sudoers 白名单或部署 hook）；
- 仓库凭据轮换 UI（当前 deploy key 仍走 SSH 手动配置）；
- 定时 fetch + 落后告警（现在按需 fetch）。
