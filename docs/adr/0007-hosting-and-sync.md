# ADR 0007 · 部署与多端同步

- 状态：已采纳（设计定稿；实现拆分为 P7.1 / P7.2）
- 日期：2026-11-01
- 关联：ADR 0006（幂等恢复）、设计文档 §6/§17

## 背景

此前所有设计与实现都默认「单机、单写者」。用户要求服务端部署在**一台机器**（VPS / 本地 / 远端均可），同时保留本地 Mac 的采集与 Obsidian 阅读体验。

由此产生必须回答的问题：

1. 谁拥有 vault（wiki 文件）的写权限？
2. raw（采集产物）如何从本地到服务器？
3. wiki 如何从服务器回到本地？
4. SQLite 状态库要不要同步？
5. 两端同时改动时如何保证不互相覆盖？

## 决策

### D34 · 服务端是唯一写者

- **wiki 只能由服务端写入**：写入路径唯一——审核台 accept → `commitApproved`；
- **本地 Obsidian 只读**：本地不允许直接修改 wiki（避免双写者冲突）；
- 依据：vault 的单写者锁、乐观锁、幂等重放都是为"单写进程"设计的；放开本地写会立刻引入分布式一致性问题。

### D35 · 部署形态：一台常驻机器

- 目标形态：**单台 Linux 机器**（VPS 优先，也可是旧笔记本/家里常开机器）；
- 进程由 **systemd** 托管（启动、崩溃重启、日志）；
- 不做 SaaS / Serverless；所有状态在机器本地（SQLite + vault 目录）。

### D36 · raw 单向：本地 → 服务器

- 本地采集（Cubox、播客转录）写入本地 `raw/`；
- 本地 `git push` 到同步仓库；服务器 `git pull`；
- raw 只增不改，冲突概率极低；服务器**不修改 raw**（只读）。

### D37 · wiki 单向：服务器 → 本地

- 服务器 accept 后 commit 并 push；
- 本地 `git pull` 后用 Obsidian 阅读；
- 本地对 wiki 的修改被**禁止**（`.gitignore` 不管这个，靠流程与权限：本地仓库设为只读拉取，或明确约定）。

### D38 · 同步总线：服务器 bare git 为主，GitHub 私有仓库为镜像

```
本地 ──push(raw)──▶ VPS bare repo ◀──mirror── GitHub（私有，异地备份）
本地 ◀─pull(wiki)── VPS bare repo
```

- **主通道**：VPS 上的 bare git 仓库（SSH 访问）：低延迟、不依赖 GitHub、不会误公开；
- **备份镜像**：每日 `git push --mirror` 到 GitHub 私有仓库（异地副本）；
- 不用 iCloud / Syncthing 等文件同步工具同步 git 仓库。

### D39 · 状态库只存服务器，不同步

- SQLite 是**派生数据**（状态、草稿、用量、事件），不同步；
- 服务器本地备份：每日 `sqlite3 state.db ".backup ..."` + 校验；
- 需要迁移机器时：**在目标机重建**（用 legacy import + wiki 推导），或复制快照后校验；
- 用户保留手动手段：`pnpm state:backup` / `pnpm state:restore`（脚本化，不自动）。

### D40 · accept 前同步守卫（fail closed）

服务端每次 accept 前：

1. `git fetch` 同步远端引用；
2. 若本地工作区不干净 → 拒绝写入（`DIRTY_VAULT`）；
3. 若远端有本地没有的提交（多人/多机修改）→ 拒绝写入（`OUT_OF_SYNC`），提示先 `git pull`；
4. 只有"干净且与远端一致"时才允许写 wiki。

这与 ADR 0006 的幂等恢复互补：**恢复处理"自己崩了"，守卫处理"别人改了"**。

### D41 · 审核通过浏览器访问服务器

- 审核台跑在服务器上，本地用浏览器访问（HTTPS + 登录保护）；
- 本地不运行服务进程，避免出现第二个写者；
- 需要内网访问时可用 SSH 隧道。

## 部署拓扑（目标）

```
本地 Mac                          VPS（systemd）
┌─────────────┐                  ┌──────────────────────────────┐
│ raw 采集      │──push──────────▶│ bare: raw.git                 │
│ git pull     │◀──pull──────────│ bare: vault.git               │
│ Obsidian 阅读 │                  │ clone: /srv/secondbrain/vault │
│ 浏览器审查    │──HTTPS─────────▶│ server (审核台 + API)          │
│              │                  │ state.db（不同步）             │
└─────────────┘                  └──────────────┬───────────────┘
                                                │ 每日 mirror
                                                ▼
                                     GitHub 私有仓库（异地备份）
```

## 未决 / 后续

1. P7.1：accept 前同步守卫（`fetch` + `OUT_OF_SYNC`）；
2. P7.2：bare 仓库初始化、systemd 单元、每日 mirror 与状态库备份脚本；
3. 服务器访问控制（HTTPS、Basic Auth 或 Tailscale）；
4. 本地仓库"只读"的强制手段（文件权限或 pre-push hook），当前靠约定。
