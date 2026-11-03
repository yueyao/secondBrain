#!/usr/bin/env bash
# 拉取远端最新 raw/wiki（只 fast-forward，冲突则失败并写日志）
set -euo pipefail
VAULT_ROOT="${VAULT_ROOT:-/srv/secondbrain/vault}"
for repo in "$VAULT_ROOT" "$VAULT_ROOT/raw"; do
  if [ -d "$repo/.git" ]; then
    echo "[sync] $(date -Is) pull $repo"
    git -C "$repo" pull --ff-only
  fi
done

# 服务器是 wiki 的唯一写者：把本地提交推回 GitHub 备份（失败不阻断 pull，可稍后在运维页重试）
if [ -d "$VAULT_ROOT/.git" ]; then
  echo "[sync] $(date -Is) push $VAULT_ROOT"
  git -C "$VAULT_ROOT" push origin HEAD 2>&1 || echo "[sync] push failed（检查 deploy key 是否有 write 权限）"
fi
