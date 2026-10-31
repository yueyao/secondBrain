# 文档维护机制

> 目标：让"方案在文档里持续可读、可追溯"，而不是只活在提交历史和某个人脑子里。
> 本文是维护规则；文档地图见 [docs/INDEX.md](docs/INDEX.md)。

---

## 1. 三类文档，三种寿命

| 类型 | 文件 | 寿命 | 规则 |
|---|---|---|---|
| **活文档** | `README.md`、`docs/DOMAIN.md`、`docs/MONOREPO.md`、`docs/TESTING.md` | 永久，持续修订 | 结构/命令/约束变化时必须同步改 |
| **连续日志** | `docs/PROGRESS.md` | 永久，只追加 | 每次改动追加一章；**不改历史章节** |
| **阶段快照** | `docs/STAGE-<date>.md` | 历史，不可变 | 阶段结束新建一份；不回头改旧快照 |
| **决策记录** | `docs/adr/NNNN-*.md` | 永久，可被新 ADR 取代 | 编号连续；被取代时在旧文件标注 |
| **地图** | `docs/INDEX.md` | 永久 | 任何文档增删必须同步 |

## 2. 改动 → 文档 对照表

| 你改了什么 | 必须更新 |
|---|---|
| 任何代码 | `docs/PROGRESS.md`（新章节 + 决策编号） |
| 状态机 / 规则 / 策略 | `docs/DOMAIN.md`（迁移表、规则表、不变式） |
| 包 / 依赖方向 / 构建 | `docs/MONOREPO.md`；必要时新增 ADR |
| 命令 / 目录 / 运行方式 | `README.md` |
| 测试结构 / 数量 | `docs/TESTING.md` |
| 新决策（架构、库、恢复策略、模型策略） | 新增 `docs/adr/NNNN-*.md`；旧 ADR 若失效要标注 |
| 新增/删除文档 | `docs/INDEX.md` |
| 阶段完成 | 新建 `docs/STAGE-<date>.md` |

## 3. 强制检查（不靠自觉）

```bash
pnpm run docs:check   # 文档检查（已包含在 pnpm run check 中）
```

`scripts/check-docs.mjs` 会拦截：

1. `docs/` 下存在未登记到 `docs/INDEX.md` 的文档；
2. ADR 编号不连续（如只有 0001、0003）；
3. `README.md` / `AGENTS.md` / `docs/INDEX.md` / 本文件里引用了不存在的 docs 路径（占位符除外）。

> 这套检查是"文档不会烂掉"的机械保证：新增 ADR 不登记、改名不同步，CI 直接红。

## 4. 每次改动的固定动作

1. 读 `docs/INDEX.md`，确认该读哪几份文档；
2. 改代码；
3. 按第 2 节更新文档；
4. `pnpm run check` 五项全绿（boundaries → docs → typecheck → depcruise → test）；
5. 一个阶段/大改动 = 一个提交，提交信息带 scope。

## 5. 评审清单（自查或他人评审）

- [ ] `docs/PROGRESS.md` 新增章节，含**验证输出**（不是"应该没问题"）
- [ ] 决策有编号（D 连续）或 ADR（编号连续）
- [ ] 新文档已登记 `docs/INDEX.md`
- [ ] 命令/目录变化同步到 `README.md`
- [ ] 测试数量变化同步到 `docs/TESTING.md`
- [ ] 没有覆盖历史快照 / PROGRESS 旧章节

## 6. 反模式（明确禁止）

| 反模式 | 后果 |
|---|---|
| 只改代码不写文档 | CI 暂时不红，但下一个人会重新发明决策 |
| 覆盖 `PROGRESS.md` 历史 | 决策链断裂，无法回看"当时为什么" |
| 新增 ADR 不登记 INDEX | `docs:check` 失败 |
| 改 `STAGE-*.md` 的历史结论 | 快照失真；应新建新阶段快照 |
| 用"应该/大概"描述验证 | 无法复核；必须贴命令与输出 |
| 文档与代码不一致时只改文档 | 以代码 + 测试为准，先修代码再改文档 |
