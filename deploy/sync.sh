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
