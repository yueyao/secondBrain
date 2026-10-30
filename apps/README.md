# apps/

入口层。每个交付形态一个包，都依赖 `@sb/domain` + `@sb/contracts` + 需要的适配器包。

| 包 | 形态 | 阶段 | 说明 |
|---|---|---|---|
| `cli` | 命令行 | P5 | `sb triage / digest / review list\|show\|accept\|reject / doctor / stats` —— 本轮人审的唯一界面 |
| `server` | JSON API | P6 | `/api/v1/reviews` 等只读+决策端点，供未来 UI 复用 |

约束：apps 不允许被任何 `packages/*` 引用（依赖只能向内）。新增 app 时按 `docs/MONOREPO.md` §3 登记边界规则。
