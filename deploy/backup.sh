#!/usr/bin/env bash
# 每日备份：SQLite 快照（git 本身已经推到 GitHub，无需再次 mirror）
# 如需额外镜像，设置 MIRROR_VAULT_REMOTE / MIRROR_RAW_REMOTE（需可写凭据）
set -euo pipefail
DATA_DIR="${DATA_DIR:-/srv/secondbrain/state}"
VAULT_ROOT="${VAULT_ROOT:-/srv/secondbrain/vault}"
BACKUP_DIR="${BACKUP_DIR:-/srv/secondbrain/backup}"
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%F)"
echo "[backup] state.db → $BACKUP_DIR/state-$STAMP.db"
sqlite3 "$DATA_DIR/state.db" ".backup '$BACKUP_DIR/state-$STAMP.db'"
sqlite3 "$BACKUP_DIR/state-$STAMP.db" "PRAGMA integrity_check;"

if [ -n "${MIRROR_VAULT_REMOTE:-}" ]; then
  echo "[backup] mirror vault → $MIRROR_VAULT_REMOTE"
  git -C "$VAULT_ROOT" push --mirror "$MIRROR_VAULT_REMOTE" || true
fi
if [ -n "${MIRROR_RAW_REMOTE:-}" ]; then
  echo "[backup] mirror raw → $MIRROR_RAW_REMOTE"
  git -C "$VAULT_ROOT/raw" push --mirror "$MIRROR_RAW_REMOTE" || true
fi

echo "[backup] done"
