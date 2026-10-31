# 测试方案

> 目标：**不接外部模型、不碰生产 vault，也能把整条生产链路跑起来**。
> 五个层次，越往下越接近真实；`pnpm run check` 一次跑完全部。

---

## 1. 测试金字塔

| 层 | 位置 | 依赖 | 数量 | 特点 |
|---|---|---|---|---|
| 领域单测 | `packages/domain/test` | 无 | 58 | 纯函数：状态矩阵、规则、策略、文本工具 |
| 契约冒烟 | `packages/contracts/test` | 无 | 7 | 用假实现证明端口可实现、DTO 形状稳定 |
| 适配器集成 | `packages/adapters-*/test` | 真实临时目录 / `:memory:` SQLite / 真实 git | 34 | 迁移、事务、乐观锁、路径逃逸、锁 |
| 应用集成 | `packages/app/test` | 真实 git + SQLite + MockAgent | 7 | 完整流程 + 用量账本 |
| 端到端 | `apps/server/test` | 真实 HTTP 服务 + 浏览器级 HTML | 3 | 起服务、走 UI 路由、断言 wiki 与 git |
| 云端链路 | `apps/server/test/cloud.test.ts` | 本地假 OpenAI 服务，无外网/无费用 | 2 | provider→runner→存储→入库→usage 全链路 |
| 运行时 | `packages/agent-runtime/test` | fake provider，无真实模型 | 30 | 路由/预算/缓存/重试/降级/契约校验/配置解析 |
| provider | `packages/adapters-agent-openai/test` | 本地假 HTTP 服务，无真实网络 | 6 | 请求体、鉴权、providerOptions 透传、429/5xx/content_filter/超时 |

当前总数：**172 例 / 23 个文件**。

---

## 2. 常用命令

```bash
pnpm test                 # 全部（vitest）
pnpm run check            # 边界 + 类型 + 依赖图 + 测试（CI 同款）
pnpm test -- packages/app # 只跑某一层
pnpm test -- -t '事件回放' # 按用例名过滤
pnpm test:watch           # 开发时监听
```

> 测试不需要模型 key、不需要网络、不需要真实 vault。

---

## 3. 测试夹具（`@sb/testing`）

```ts
import { createHarness } from '@sb/testing';

const harness = await createHarness();   // 临时目录 + 真实 git + 内存 SQLite + MockAgent
// harness.vault / harness.store / harness.search / harness.agent / harness.clock / harness.ids
await harness.cleanup();                 // 删临时目录、关连接
```

夹具自带 7 篇 mock 原文 + 3 个既有节点，覆盖：

| 场景 | 文件 | 预期 |
|---|---|---|
| patch 已有节点 | `mock-2026-10-01 反脆弱的第二条证据.md` | 并入「反脆弱」 |
| 全新概念 | `mock-2026-10-02 幂律分布.md` | 新建「幂律分布」 |
| 同一事件第一份 | `mock-E999 长期主义与时间套利.md` | 入库成为 canonical |
| 同一事件第二份 | `mock-E999b 长期主义（另一份转录）.md` | **红色阻断** |
| 低价值 | `mock-2026-10-03 产品快讯.md` | `deferred(low_value)` |
| 超长 | `mock-超长访谈.md`（约 7.4 万字） | `deferred(too_long)` |

`MockAgent` 是**确定性替身**：读取 frontmatter 的 `node_hint` 与检索命中，产出 patch/新建草稿。它不调用任何模型，因此测试可重复。

---

## 4. 启动可交互的 mock 审核台

```bash
pnpm demo                       # = pnpm --filter @sb/server start
# → http://127.0.0.1:8787

PORT=9000 DATA_DIR=/tmp/sb-demo pnpm demo   # 换端口/数据目录
```

- 首次启动会在 `DATA_DIR/vault` 播种 mock 原文与节点，并建立真实 git 仓库；
- 首页点「扫描 raw/ 并分档」→ 队列出现 4 篇 → 对任一篇「生成草稿」→ 审阅页 → 「通过并入库」；
- 每次入库都会在 `DATA_DIR/vault` 里产生一个 `digest: <raw>` commit；
- 想重置：删掉 `DATA_DIR` 再启动。

页面快照（无需启动服务即可预览）：`docs/snapshots/11-review.html`、`docs/snapshots/12-dashboard-after.html`、`docs/snapshots/13-usage.html`。

用量查看：首页卡片，或 `GET /api/usage`、`GET /usage`。只计量不拦截。

---

## 5. 加测试的三种场景

### 5.1 改领域规则/状态机

改 `packages/domain/src/**` 后：

1. 同步改 `packages/domain/test/state-matrix.test.ts` 里手抄的迁移表（双重记账，防漂移）；
2. 规则改动在 `rules.test.ts` 补「命中 / 不命中 / 边界」三例。

### 5.2 写新适配器

用临时目录或 `:memory:`，**不要** mock 文件系统：

```ts
const store = SqliteStore.open({ path: ':memory:', clock });
migrate(store.database, clock);
```

### 5.3 写应用层用例

用 `createHarness()` 组装，断言：

- 状态迁移（`state.kind`）；
- 副作用（wiki 文件内容、git commit 存在）；
- 读模型（`ReviewViewV1.actions.accept` / `blockedBy`）。

---

## 6. CI

`.github/workflows/ci.yml`：Node 22/24 矩阵 × `boundaries` / `typecheck` / `depcruise` / `test`。

> 注意：`node:sqlite` 在 Node 22 上可能需要 `--experimental-sqlite`；若 22 矩阵失败，收窄到 24 或加 flag（见 PROGRESS 遗留项）。

---

## 7. 已知限制

1. `MockAgent` 是启发式替身，**不代表真实模型质量**；接真模型后需要另做「质量抽检」测试。
2. 端到端测试覆盖的是 UI 路由与 HTML 关键字，不是像素级渲染。
3. 提交两阶段的 `commit_intent` 与启动对账 `Recover()` 尚未实现，因此没有「崩溃注入」类测试（P5 补）。
