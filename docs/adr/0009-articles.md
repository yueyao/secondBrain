# ADR 0009 · 文章模型与发布流程（Compose C1–C4）

- 状态：已采纳
- 日期：2026-11-03
- 关联：ADR 0005（模型接入）、ADR 0007（部署与同步）、`docs/PROGRESS.md` 第 43/46/48/49 章
- 代码入口：`packages/contracts/src/ports/article.ts`、`packages/adapters-sqlite/src/migrations.ts`（v4）、`packages/app/src/{compose,diff,publish}.ts`、`apps/server/src/{server,views}.ts`

## 1. 背景

wiki 流水线解决"把原文提炼成可复用判断"；主编台解决"把判断写成一篇能发的文章"。两者产物不同：

| | wiki | 文章 |
|---|---|---|
| 单元 | 知识节点 + claims | 带结构的正文 |
| 写入方式 | AI 起草 → 人工审核 → commit 进 vault | 人在主编台组织，AI 生成初稿/改稿 |
| 生命周期 | 长期累积、只增不改 | 有草稿→定稿的版本过程 |
| 是否入库 | 是（git 版本化） | 否（暂不写 vault） |

文章需要独立的状态机、版本链与发布语义；不能复用 raw 状态机，也不应把正文写进 wiki。

## 2. 决策

### D1 · 文章与知识分离，文章不自动写 vault

文章存 `state.db` 的 `article` / `article_version`（迁移 v4），不随 wiki 提交。优点：主编台可以自由改稿、回滚、导出，不会污染知识库；缺点：文章目前只存在服务器状态库，靠每日备份保护（ADR 0007）。

### D2 · 版本只增不改

`article_version` 只有 append，没有 update：

- v1 = `ai_initial`（AI 初稿）；
- 改稿 = `ai_refine`（带 instruction，`basedOnVersionId` 指向生成时的当前版本）；
- 恢复 = `restore`（把旧版本内容复制成**新版本**，`note` 记录"恢复自 vN"）；
- 人工编辑 = `manual_edit`（预留，暂未开放 UI）。

任何修改都不原地覆盖，因此 diff / 回滚 / 审计永远可用；版本号 = 当前最大 + 1。

### D3 · 文章状态机

```
draft ──生成正文──▶ review ──定稿──▶ final
  ▲                    ▲              │
  └────改稿/恢复───────┘              │
                               重新打开──┘
```

- `review`：有正文、等待主编判断；
- `final`：定稿（可发布）；此时任何改稿/恢复产生新版本都会回到 `review`；
- `reopen`：final → review，允许继续修改；
- 定稿前置条件：存在当前版本；重复定稿被拒（`INVALID_STATE`）。

### D4 · 引用是正文的一部分，不靠模型结构化输出

正文里每个来自知识库的判断后写 `（来源：[[raw/...]]）`，应用层用 `extractCitationSources` 解析成 `citations` 落库；正文没有引用就拒收（防止"看起来像文章但无法回溯"）。导出时再统一生成"引用来源"清单。

### D5 · 版本对比用行级 LCS，不引入 diff 库

`packages/app/src/diff.ts` 实现纯函数 `diffLines` / `diffStats`（行级 LCS、1-based 行号、确定性）。文章规模（百行级）不需要 Myers 优化，也不必增加依赖；diff 页只读展示新增/删除/未变行。

### D6 · 定稿与导出

- 导出基于**当前版本**，任意状态可导出（文件名与头部标注状态），导出格式：

```
# {标题}

> 主题：… · 状态：… · 版本 v{n} · 导出时间 {ISO}

{正文 Markdown}

---

## 引用来源

- [[raw/...]]
```

- 文件名：`<安全标题>-v<n>.md`（标题清洗非法字符、截断 60 字，空则 `article`），HTTP 下载用 RFC 5987 `filename*=UTF-8''…` 传中文名；
- 暂不接外部发布渠道（公众号/博客）；"定稿 + 导出 Markdown"就是当前发布路径。

## 3. 后果

- 文章版本链只增不删，长期会增长；单篇文章版本量小（通常个位数），可接受。
- 文章在状态库里，服务器磁盘故障靠每日 `state.db` 备份恢复；文章正文不随 vault 同步。
- diff / 导出是纯函数，可在无模型、无网络的测试里覆盖；主编台全流程 e2e 使用 `MockComposer`。
- 若未来需要"发布到 vault / 外部平台"，应新增 application commit 用例与目标适配器，不在 UI 层直接写文件。
