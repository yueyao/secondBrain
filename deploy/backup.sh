#!/usr/bin/env bash
# 每日备份：SQLite 快照 + wiki/raw 镜像到 GitHub 私有仓库
set -euo pipefail
DATA_DIR="${DATA_DIR:-/srv/secondbrain/state}"
VAULT_ROOT="${VAULT_ROOT:-/srv/secondbrain/vault}"
BACKUP_DIR="${BACKUP_DIR:-/srv/secondbrain/backup}"
mkdir -p "$BACKUP_DIR"

echo "[backup] state.db"
sqlite3 "$DATA_DIR/state.db" ".backup '$BACKUP_DIR/state-$(date +%F).db'"
sqlite3 "$BACKUP_DIR/state-$(date +%F).db" "PRAGMA integrity_check;"

echo "[backup] git mirrors"
git -C "$VAULT_ROOT" push --mirror "${GITHUB_VAULT_REMOTE:-github}" || true
git -C "$VAULT_ROOT/raw" push --mirror "${GITHUB_RAW_REMOTE:-github}" || true

echo "[backup] done"
