# ADR 0001 · 技术栈选型

- 状态：已采纳（P0）
- 日期：2026-10-30

## 背景

MVP（`secondbrain-mvp/`）用纯 `.mjs` 跑通了流程，但用户明确指出"这种还是比较脆弱的"。脆弱的具体来源是：没有类型边界、模块靠约定、状态变更散落、失败靠字符串。

## 决策

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | **Node.js ≥ 22**（原生 ESM、`node:test`/`fetch` 可用） | 与服务端目标一致；无需额外运行时 |
| 语言 | **TypeScript 5.9，strict 全家桶** | 类型边界是脆弱的根因对策；`noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` 能把边界错误前移到编译期 |
| 测试 | **vitest 5** | 零配置跑 TS、快、支持 `it.each` 与并发文件 |
| 依赖规则 | **dependency-cruiser 18** + 自研源码级脚本 | 前者管图、后者管源码细节（`throw`、时钟、随机数） |
| 领域层依赖 | **零**（不允许 import 任何包与 `node:` 模块） | 纯函数才能穷举测试、才能在任意环境运行 |

## 刻意推迟的决策

| 决策 | 何时定 | 候选 |
|---|---|---|
| HTTP 框架 | P5（有 CLI 之后） | **Fastify**（schema-first、轻、插件少）> 裸 `node:http`（零依赖但手写路由/校验）> NestJS（DI 完整但对单服务过重） |
| 数据库 | P2 第一天 | `node:sqlite`（零依赖、API 较新）vs `better-sqlite3`（成熟、需原生编译） |
| 运行时构建 | P4 前 | `tsc` 构建（需切 NodeNext + 显式扩展名）vs `tsx` 直跑 |

推迟的理由：这些选择不影响领域层契约。领域层已经用纯函数和 `Result` 把"变化点"隔离在外，选错只影响一层实现，不会扩散。

## 后果

- 需要 `tsconfig` 与构建步骤（当前只跑测试，不产 `dist`）。
- `moduleResolution: Bundler` 让 import 不带扩展名；**运行时时必须重新评估**（见 D9）。
- 领域层零依赖的代价：文件/节点是否存在必须由应用层预先解析后注入（`knownRawPaths`、`existingNodes`）。
