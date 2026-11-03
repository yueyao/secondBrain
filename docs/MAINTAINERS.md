# 维护与所有权手册

> 目标：**换人、换机器、换 GitHub 账号之后，项目仍能完整运行与恢复。**
> 运行时只依赖「服务器 + GitHub 仓库 + 模型 API」，不依赖任何个人电脑持续在线；所有维护动作都能在运维页 `/operations` 或本文档里找到。
> 对应 ADR 0007、`docs/DEPLOY.md`、`docs/SYNC.md`。

## 1. 项目使用的 GitHub 仓库

| 仓库 | 用途 | GitHub | 服务器路径 | 鉴权方式 |
|---|---|---|---|---|
| **secondBrain**（代码） | server + worker + 全部源码/文档 | `https://github.com/yueyao/secondBrain` | `/srv/secondbrain/repo` | HTTPS（公开仓库，拉取无需凭据） |
| **secondBrain-vault**（知识库） | `wiki/`：知识节点 Markdown + git 历史 | `git@github.com:yueyao/secondBrain-vault.git` | `/srv/secondbrain/vault` | SSH Deploy Key（只读）：`~dsh/.ssh/sb_deploy` |
| **secondBrain-raw**（原文） | `raw/`：剪藏/播客/课程原文 | `git@github-raw:yueyao/secondBrain-raw.git` | `/srv/secondbrain/vault/raw` | SSH Deploy Key（只读）：`~dsh/.ssh/sb_deploy_raw` |

`~dsh/.ssh/config` 定义了 `github.com` 与 `github-raw` 两个 Host 别名，分别指向两把 deploy key。
**服务器对 vault/raw 只读**：知识库与原文的写入发生在采集端（本地），服务器只做 fast-forward 拉取；唯一例外是审核通过后写 wiki（同一仓库）。

> 运维页 `/operations` 的「GitHub 仓库与维护」区块会实时展示三个仓库的远端、分支、HEAD、工作区状态、领先/落后提交数，并提供「更新此仓库 / 全部更新 / 检查远端 / 修改远端」。

## 2. 运行时依赖清单（消失后需要重建的东西）

| 依赖 | 具体位置 | 是否可替代 |
|---|---|---|
| 云服务器 | 腾讯云 Lighthouse `lhins-iux3d3gt`（ap-singapore，43.156.253.152） | 任意 Linux + Node 22+；按 `docs/DEPLOY.md` 重建 |
| GitHub 仓库 | 上述 3 个仓库（代码可 public，vault/raw 必须 private） | 可迁移到新账号/组织/自建 Git（运维页改远端即可） |
| 模型 API Key | `/etc/secondbrain/secondbrain.env`（权限 600）的 `MODEL_API_KEY` | DeepSeek 或其他 OpenAI 兼容端点，改 env + 重启 |
| 状态库 | `/srv/secondbrain/state/state.db`（不同步，服务器唯一写者） | 从每日备份恢复 |
| 本机（Mac/Obsidian） | 仅用于采集、阅读与审核，可替换为任意设备 | 不需要持续在线 |

**结论**：没有任何一步依赖"某个人的电脑在跑"。把服务器实例、3 个仓库、API key 三者交接出去，项目即可完整延续。

## 3. 日常维护

### 3.1 更新代码

1. 本地：`pnpm run check` 五项全绿 → 按 `AGENTS.md` 提交并 push 到 GitHub；
2. 服务器：运维页 → GitHub 仓库 → 代码仓库 →「更新此仓库」（等价的 `git -C /srv/secondbrain/repo pull --ff-only`）；
3. **重启服务**（代码更新后必须）：
   ```bash
   sudo systemctl restart secondbrain-server secondbrain-worker
   ```
   只改 worker 时可只重启 worker；
4. 验证：`/api/health` 200、`/operations` 页面正常、worker 心跳恢复。

### 3.2 更新知识库 / 原文

- 采集端 push 到 GitHub 后，`secondbrain-sync.timer` 每 15 分钟自动 `pull --ff-only`（vault 与 raw 各一次）；
- 也可以在运维页逐仓库点「更新此仓库」「全部更新」；
- 运维页「检查远端」会执行 fetch，显示领先/落后；vault 落后时审核台的 accept 会因 `OUT_OF_SYNC` 被拒（安全设计）。

### 3.3 状态库备份与恢复

| 备份来源 | 位置 | 频率 |
|---|---|---|
| systemd timer | `/srv/secondbrain/backup/state-YYYY-MM-DD.db` | 每日 03:17 |
| 运维页「立即备份状态库」 | `<DATA_DIR>/backup/`（`/srv/secondbrain/state/backup/`） | 手动 |

恢复步骤：停 `secondbrain-server`/`secondbrain-worker` → `sqlite3 <备份> "PRAGMA integrity_check;"` → 用备份替换 `state.db`（并删除 `-wal/-shm`）→ 启动服务 → 运维页核对计数。

### 3.4 发布流程

`pnpm run check`（边界/文档/类型/依赖图/测试）→ commit → push → 运维页更新代码 → 重启 → 验证。文档纪律见 `AGENTS.md`（PROGRESS 追加、ADR 编号连续、INDEX 登记）。

## 4. 迁移 / 更换 owner（不再依赖原维护者）

以"交给新 GitHub 账号 + 新服务器"为例：

1. **新建仓库**：新账号下建 3 个仓库（代码可 public；vault/raw 必须 private）。
2. **推送现有内容**：
   ```bash
   # 任意一台机器（可以从服务器 clone 一份）
   git clone --mirror https://github.com/yueyao/secondBrain.git code.git
   git -C code.git push --mirror https://github.com/<new-owner>/secondBrain.git
   # vault / raw 同理（用有读权限的 deploy key 或原账号 clone）
   ```
3. **新服务器部署**：按 `docs/DEPLOY.md` 重建目录、env、systemd；`DATA_DIR` 从备份恢复。
4. **切换远端**（无需改代码）：运维页每个仓库「修改远端」填新 URL 保存（会写 `<DATA_DIR>/repos.json` 并执行 `git remote set-url`），点「更新此仓库」验证；
   或在服务器上手动 `git -C <path> remote set-url origin <new-url>`。
5. **Deploy Key**：在新仓库 Settings → Deploy keys 添加新的只读公钥，更新 `~dsh/.ssh/config` 的 IdentityFile，`ssh -T git@github.com` / `ssh -T git@github-raw` 验证。
6. **交接 API key**：新 owner 在 `/etc/secondbrain/secondbrain.env` 填新 `MODEL_API_KEY`，重启两个服务。
7. 旧仓库保留只读镜像一个观察周期，确认新链路后再删除/归档。

> 迁移后如果代码仓库地址变了，`/operations` 页会自动显示新地址；维护文档链接也会指向新仓库（页面根据代码仓库远端推导）。

## 5. 故障排查速查

| 症状 | 先查 |
|---|---|
| 运维页某仓库「落后 N」 | 点「更新此仓库」；失败看 fetch 错误（deploy key / 网络 / 安全目录） |
| 审核 accept 报 `OUT_OF_SYNC` | vault 落后：更新仓库后重试（fail-closed 设计，不是 bug） |
| worker 停止/不写草稿 | 运维页运行状态 + worker 日志；`systemctl status secondbrain-worker`；是否触发背压或暂停 |
| 页面 502 / 打不开 | `systemctl status secondbrain-server`、`journalctl -u secondbrain-server -n 100` |
| 磁盘不足 | `/srv/secondbrain/{backup,state,vault}` 体积；清理旧备份（保留最近 30 天） |
| API key 泄漏/失效 | `/etc/secondbrain/secondbrain.env` 换 key → 重启两服务；GitHub deploy key 在仓库 Settings 轮换 |
| 状态库损坏 | 从 `/srv/secondbrain/backup/` 或 `<DATA_DIR>/backup/` 恢复 |

## 6. 关键文件位置

```
/etc/secondbrain/secondbrain.env              # DATA_DIR / VAULT_ROOT / MODEL_* / worker 参数（600）
/etc/systemd/system/secondbrain-server.service
/etc/systemd/system/secondbrain-worker.service
/etc/systemd/system/secondbrain-sync.timer    # 每 15 分钟 pull vault+raw
/etc/systemd/system/secondbrain-backup.timer  # 每日 03:17 快照 state.db
/srv/secondbrain/repo                         # 代码仓库
/srv/secondbrain/vault                        # 知识库（wiki）
/srv/secondbrain/vault/raw                    # 原文
/srv/secondbrain/state/state.db               # 状态库（唯一写者）
/srv/secondbrain/backup/                      # 每日快照（timer）
/srv/secondbrain/state/backup/                # 手动快照（运维页）
/home/dsh/.ssh/{config,sb_deploy,sb_deploy_raw}
```

## 7. 运维页入口说明

- 「GitHub 仓库与维护」：三个仓库的地址、分支、HEAD、工作区、领先/落后；逐仓库更新、全部更新、检查远端、修改远端；
- 「运维操作」：立即扫描 / 同步 / 备份，历史结果；
- 「运行状态」「生产配置」「最近事件」：worker、背压、事件流。
