# AGENTS.md

本文件给代码代理（以及未来的维护者）定工作约定。**改动代码前先读文档，改动后必须更新文档。**

## 1. 开工前必读

按顺序：

1. `docs/INDEX.md` —— 文档地图与更新时机
2. `docs/STAGE-2026-10-31.md` —— 当前架构与阶段状态
3. 按改动范围读：`docs/DOMAIN.md`（领域）、`docs/MONOREPO.md`（包与依赖）、`docs/TESTING.md`（测试）、`docs/adr/`（已定决策，不要重新发明）

## 2. 架构边界（不可协商）

- `@sb/domain`：零依赖、零 I/O、不 `throw`、不读时钟/随机数；
- `@sb/contracts`：只声明端口与 DTO；
- `@sb/app`：只依赖 domain + contracts；
- 适配器实现端口，入口（`apps/*`）负责组装；
- 只有 `application` 的 commit 用例可以写 wiki。

违反会被 `pnpm run boundaries` / `pnpm run depcruise` 拦下。

## 3. 文档维护（硬约束）

每次改动必须同步：

| 改动类型 | 必须更新 |
|---|---|
| 任何代码改动 | `docs/PROGRESS.md` 追加章节 + 决策编号（D 连续递增） |
| 架构 / 依赖边界 / 状态机 | 新增或更新 `docs/adr/NNNN-*.md`；更新 `docs/DOMAIN.md` / `docs/MONOREPO.md` |
| 命令 / 目录 / 运行方式 | `README.md`；必要时 `docs/TESTING.md` |
| 测试结构 / 数量 | `docs/TESTING.md` |
| 新增文档 | 登记到 `docs/INDEX.md`（否则 `pnpm run docs:check` 失败） |
| 阶段结束 | 新增 `docs/STAGE-<date>.md` 快照（不要覆盖旧快照） |

**PROGRESS 只追加，不改历史章节**；决策编号与 ADR 编号连续，不跳号。

## 4. 提交前

```bash
pnpm run check   # boundaries → docs → typecheck → depcruise → test
```

五项全绿才能提交。

## 5. 提交信息

```
feat(scope): 一句话
fix(scope): 一句话
docs(scope): 一句话
ci: 一句话
```

一个阶段 / 一个大改动 = 一个提交（用户约定）。

## 6. 不要做的事

- 只改代码不更新文档；
- 覆盖或重写 `docs/PROGRESS.md` 的历史章节；
- 悄悄新增 ADR 而不登记到 `docs/INDEX.md`；
- 修改 `docs/STAGE-*.md` 的历史结论（新阶段另建文件）；
- 在业务层直接调用 provider SDK 或写文件。
