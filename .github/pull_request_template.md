## 变更内容

<!-- 一句话说明改了什么、为什么 -->

## 文档（硬约束，见 AGENTS.md / docs/MAINTENANCE.md）

- [ ] `docs/PROGRESS.md` 已追加章节（含验证输出）
- [ ] 相关活文档已更新：DOMAIN / MONOREPO / TESTING / README（按改动范围）
- [ ] 新决策已写入 `docs/adr/NNNN-*.md`（编号连续）
- [ ] 新增文档已登记 `docs/INDEX.md`
- [ ] 阶段结束：已新建 `docs/STAGE-<date>.md` 快照（未覆盖旧快照）

## 验证

- [ ] `pnpm run check` 五项全绿（boundaries → docs → typecheck → depcruise → test）
- [ ] 如涉及模型：`pnpm check:model <config>` 通过
