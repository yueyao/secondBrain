# 服务端部署手册

> 目标：一台 Linux 机器上无人值守运行。对应 ADR 0007 / ADR 0008。
> 前置：Node 22+、pnpm 10+、git、sqlite3；创建一个专用用户 `secondbrain`。

## 1. 目录布局

```
/srv/secondbrain/
├─ repo/                 # 代码（git clone 本项目）
├─ vault/                # 知识库工作区（git clone secondBrain-vault）
│  └─ raw/               # 嵌套仓库（git clone secondBrain-raw）
├─ state/                # DATA_DIR：state.db（不同步）
├─ backup/               # 每日 SQLite 快照
└─ logs/                 # 可选
```

## 2. 准备仓库

```bash
sudo useradd -m -s /bin/bash secondbrain
sudo mkdir -p /srv/secondbrain && sudo chown -R secondbrain: /srv/secondbrain

sudo -u secondbrain bash -c '
  cd /srv/secondbrain
  git clone https://github.com/yueyao/secondBrain.git repo
  git clone https://github.com/yueyao/secondBrain-vault.git vault
  git clone https://github.com/yueyao/secondBrain-raw.git vault/raw
  cd repo && pnpm install --frozen-lockfile
'
```

> 生产建议：本地/服务器之间用 VPS 上的 bare 仓库做主通道，GitHub 只做镜像（ADR 0007 D38）。

## 3. 环境变量

```bash
sudo mkdir -p /etc/secondbrain
sudo cp /srv/secondbrain/repo/deploy/secondbrain.env.example /etc/secondbrain/secondbrain.env
sudo chmod 600 /etc/secondbrain/secondbrain.env
sudo -u root nano /etc/secondbrain/secondbrain.env   # 填 DATA_DIR / MODEL_API_KEY 等
```

## 4. systemd

```bash
sudo cp /srv/secondbrain/repo/deploy/secondbrain-*.service /etc/systemd/system/
sudo cp /srv/secondbrain/repo/deploy/secondbrain-sync.timer /etc/systemd/system/
sudo cp /srv/secondbrain/repo/deploy/secondbrain-backup.timer /etc/systemd/system/
# 还需要两个对应的一次性 service
```

`/etc/systemd/system/secondbrain-sync.service`：

```ini
[Unit]
Description=secondBrain sync

[Service]
Type=oneshot
User=secondbrain
EnvironmentFile=/etc/secondbrain/secondbrain.env
ExecStart=/srv/secondbrain/repo/deploy/sync.sh
```

`/etc/systemd/system/secondbrain-backup.service`：

```ini
[Unit]
Description=secondBrain backup

[Service]
Type=oneshot
User=secondbrain
EnvironmentFile=/etc/secondbrain/secondbrain.env
ExecStart=/srv/secondbrain/repo/deploy/backup.sh
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now secondbrain-server secondbrain-worker
sudo systemctl enable --now secondbrain-sync.timer secondbrain-backup.timer
```

## 5. 首次导入历史状态（只写 state.db）

```bash
cd /srv/secondbrain/repo
sudo -u secondbrain bash -c '
  export $(grep -v "^#" /etc/secondbrain/secondbrain.env | xargs)
  pnpm import:apply --state "$DATA_DIR" --apply
'
```

预期：`inserted 4408`、`newItems 0`（详见 `docs/IMPORT-REPORT-2026-11-01.md`）。

## 6. 验证

```bash
curl -s localhost:8787/api/health
sudo journalctl -u secondbrain-worker -n 20 --no-pager
sudo -u secondbrain sqlite3 /srv/secondbrain/state/state.db \
  "SELECT state, COUNT(*) FROM raw_item GROUP BY state;"
```

审核台默认只绑 `127.0.0.1:8787`（无登录，不暴露公网）。本地通过 SSH 隧道访问：

```bash
ssh -N -L 8787:127.0.0.1:8787 root@<server-ip>
# 然后浏览器打开 http://127.0.0.1:8787/
```

## 7. 备份与恢复

- 每日 03:17：`state-YYYY-MM-DD.db` 快照 + integrity check；git 本身已在 GitHub，无需再 mirror（需要额外镜像时设置 `MIRROR_*_REMOTE`）；
- 恢复状态库：停两个服务 → 用快照覆盖 `state.db` → 启动（自动迁移）；
- 状态库彻底丢失：重新执行第 5 步（从 wiki + 缓存重建）。

## 8. 故障处理

| 现象 | 处理 |
|---|---|
| worker 日志 `digest_failed` | 看 model 配置/余额；下一轮自动重试 |
| sync 失败（非 fast-forward） | 人工进 `/srv/secondbrain/vault` 查看并解决冲突 |
| vault 脏（`DIRTY_VAULT`） | `git status` 确认后 `git checkout -- .` |
| 审核台启动失败（模型配置） | 检查 `MODEL_CONFIG` 路径与 `MODEL_API_KEY` |
