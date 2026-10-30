# packages/

按**层**切分的包，不是按功能切分。依赖只能向内：

```
apps/*  →  packages/adapters-* / packages/app  →  packages/contracts  →  packages/domain
```

| 包 | 层 | 允许依赖 |
|---|---|---|
| `domain` | 最内层，纯函数 | 无 |
| `contracts` | 端口与 DTO | `domain` |
| `adapters-*` | I/O 实现 | `domain`、`contracts` |
| `app` | 用例 | `domain`、`contracts` |

新增包必须同时改：`tools/check-boundaries.mjs` 的 `PACKAGES`、`tsconfig.base.json` 的 `paths`、`vitest.config.ts` 的 `alias`、`docs/MONOREPO.md` 的矩阵。详见 `docs/MONOREPO.md`。
