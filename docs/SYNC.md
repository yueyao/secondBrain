# 多端同步操作手册

> 对应 ADR 0007。核心规则：**服务端是唯一写者；raw 本地→服务器；wiki 服务器→本地；状态库只存服务器。**

## 1. 角色

| 角色 | 机器 | 能做什么 | 不能做什么 |
|---|---|---|---|
| 采集端 | 本地 Mac | 写 `raw/`、push、pull wiki 阅读 | 改 wiki、跑服务 |
| 服务端 | VPS / 常驻机器 | 写 wiki、处理队列、审核台、状态库 | 改 raw |
| 镜像 | GitHub 私有仓库 | 异地备份 | 不直接作为工作区 |

## 2. 首次部署（P7.2 脚本化）

```bash
# 服务器上：bare 仓库
git init --bare /srv/git/secondbrain-vault.git
git init --bare /srv/git/secondbrain-raw.git

# 服务器上：工作区
git clone /srv/git/secondbrain-vault.git /srv/secondbrain/vault
git clone /srv/git/secondbrain-raw.git  /srv/secondbrain/vault/raw

# 状态库目录（不同步）
mkdir -p /srv/secondbrain/state
# systemd 启动：DATA_DIR=/srv/secondbrain
```

```bash
# 本地：把已有提交推到 bare 仓库
git remote add vps ssh://user@vps/srv/git/secondbrain-vault.git
git push vps main
git -C raw remote add vps ssh://user@vps/srv/git/secondbrain-raw.git
git -C raw push vps main
```

## 3. 日常流程

### 3.1 本地采集 → 服务器

```bash
# 本地（采集完成后）
git -C raw add -A && git -C raw commit -m "raw: +N articles" && git -C raw push vps main
```

服务器定时任务（每 15 分钟）：

```bash
cd /srv/secondbrain/vault/raw && git pull --ff-only
# 然后调用 ingestAndTriage（或由服务端定时任务触发）
```

### 3.2 服务器处理 → 人工审核

- 服务器 digest 后，草稿在状态库；
- 浏览器打开 `https://<server>/` → 审核；
- accept 时服务端自动：`git fetch` → 检查干净/一致 → 写 wiki → commit → push。

### 3.3 服务器 → 本地阅读

```bash
# 本地
cd /Users/dynamic/workspace/secondBrain && git pull --ff-only
```

## 4. 冲突与异常

| 场景 | 表现 | 处理 |
|---|---|---|
| 远端有本地没有的提交 | accept 被拒（`OUT_OF_SYNC`） | 本地先 `git pull`，解决后重试 |
| 工作区脏（崩溃残留） | 启动/accept 被拒（`DIRTY_VAULT`） | 人工 `git status` 确认后 `git checkout -- .` |
| 本地误改 wiki | push 被拒或服务器 fetch 后拒绝写入 | 撤销本地改动（wiki 只读） |
| raw 同名文件 | git 冲突 | 保留两份或改文件名；raw 只增不改 |
| 服务器宕机 | 本地采集照常 commit/push | 恢复后服务器 pull 并补处理 |

## 5. 备份与恢复

| 内容 | 方式 | 频率 |
|---|---|---|
| wiki + raw | bare 仓库 + `git push --mirror` 到 GitHub 私有仓库 | 每日 |
| 状态库 | `sqlite3 state.db ".backup /backup/state-$(date).db"` | 每日 |
| 恢复 wiki/raw | 从 bare 仓库或 GitHub 重新 clone | 按需 |
| 恢复状态库 | 停止服务 → 用快照覆盖 `state.db` → 启动（会跑迁移） | 按需 |
| 状态库彻底丢失 | 用 legacy import 从 wiki + 日志重建 | 按需 |

## 6. 手动同步状态库（用户保留手段）

状态库默认不同步，但可以手动迁移：

```bash
# 服务器导出
sqlite3 /srv/secondbrain/state/state.db ".backup /tmp/state.db"
scp /tmp/state.db user@new-host:/srv/secondbrain/state/state.db

# 校验（一致性检查 + 关键表行数）
sqlite3 /srv/secondbrain/state/state.db "PRAGMA integrity_check; SELECT COUNT(*) FROM raw_item;"
```

注意：迁移前后**只能有一个服务实例**运行（单写者）。

## 7. 实现状态

accept 守卫已生效：`commitApproved` 会先 `git fetch`，若远端领先本地则抛 `OUT_OF_SYNC` 并拒绝写入。

| 能力 | 状态 |
|---|---|
| 单写者 + 幂等恢复（ADR 0006） | ✅ 已实现 |
| accept 前同步守卫（`fetch` + `OUT_OF_SYNC`） | ✅ 已实现（P7.1） |
| bare 仓库 / systemd / mirror / 备份脚本 | ⬜ P7.2 |
| 本地 wiki 只读强制 | ⬜ 靠约定，后续可加 pre-push hook |
