# ADR 0008 · 服务端自动流水线

- 状态：已采纳（worker 已实现；部署脚本与 sync 守卫待落地）
- 日期：2026-11-01
- 关联：ADR 0007（部署与同步）、ADR 0006（幂等恢复）

## 背景

用户明确：**不在本地做生产**，全部在服务端自动运行，避免两端逻辑不同步。

此前只有 HTTP 审核台（有人才会动），缺少"无人值守时持续推进"的组件。

## 决策

### D45 · 双进程：server + worker

| 进程 | 职责 | 不做什么 |
|---|---|---|
| `@sb/server` | 审核台 UI / API、健康检查 | 不主动处理队列 |
| `@sb/worker` | 定时 ingest + 为 queued 条目起草 | **不自动入库**（accept 只能由人点击） |

两者共用同一个 `DATA_DIR`（SQLite WAL），单机单写者。

### D46 · tick 语义

每次 tick：

1. `ingestAndTriage`：扫描 vault 中所有新 raw（幂等，已存在的跳过）；
2. 取 `queued` 条目，最多 `WORKER_MAX_JOBS` 篇；
3. 逐篇 `draftDigest`；失败记日志、下一轮重试；
4. 输出一条 JSON 日志（ingested / drafted / failed / queueLength）。

默认 `WORKER_INTERVAL_MS=300000`（5 分钟）。串行执行，避免并发写同一 SQLite 的竞争；需要吞吐时再引入多实例 + 任务锁。

### D47 · 同步/备份交给 systemd timer

worker 不直接 `git pull/push`，避免与审核台 accept 的 git 操作竞争：

| timer | 脚本 | 频率 | 职责 |
|---|---|---|---|
| `secondbrain-sync.timer` | `deploy/sync.sh` | 15 分钟 | `git pull --ff-only`（vault + raw） |
| `secondbrain-backup.timer` | `deploy/backup.sh` | 每日 03:17 | SQLite `.backup` + `git push --mirror` 到 GitHub 私有仓库 |

### D48 · 失败处理

- worker 崩溃 → systemd 重启（`Restart=always`），启动时 `recoverPending` 自动对账；
- 单篇失败 → 日志 + 下一轮重试（不阻塞其他文章）；
- git 冲突 → sync 失败并退出，保留现场，人工处理（fail closed）。

### D49 · 可观测性

- 结构化 JSON 日志写 stdout → journald（`journalctl -u secondbrain-worker -f`）；
- 审核台 `/api/health` 与 `/usage` 提供状态与成本；
- 备份脚本输出 `PRAGMA integrity_check` 结果。

## 未决

1. **P7.1 accept 前同步守卫**（fetch + `OUT_OF_SYNC`）尚未实现；当前依赖"本地只读"约定；
2. worker 并发 >1 需要任务锁（当前串行）；
3. 审核待办通知（邮件/IM）；
4. 模型失败熔断（连续 N 篇失败暂停 tick）。
