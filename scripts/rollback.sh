#!/usr/bin/env bash
# ============================================================
# Rollback script — reverts to the SHA recorded by updater.sh
# ============================================================

set -euo pipefail

INSTALL_DIR="/opt/everton-stock"
REPO_DIR="/opt/pos-stock-system"
DATA_DIR="$INSTALL_DIR/data"
SERVICE="everton-stock"
SERVICE_USER="everton"
LOG_FILE="$DATA_DIR/updater.log"
STATE_FILE="$DATA_DIR/updater.state"
PREVIOUS_SHA_FILE="$DATA_DIR/previous-sha"

say() { echo "[$(date +%H:%M:%S)] $1" | tee -a "$LOG_FILE"; }
set_state() { echo "$1" > "$STATE_FILE"; chown "$SERVICE_USER:$SERVICE_USER" "$STATE_FILE"; }
fail() { say "❌ ROLLBACK FAILED: $1"; set_state "failed"; exit 1; }

mkdir -p "$DATA_DIR"
echo "===== Rollback started $(date) =====" > "$LOG_FILE"
chown "$SERVICE_USER:$SERVICE_USER" "$LOG_FILE"
set_state "rolling-back"

[ -f "$PREVIOUS_SHA_FILE" ] || fail "No previous version recorded."
TARGET_SHA=$(cat "$PREVIOUS_SHA_FILE")
[ -n "$TARGET_SHA" ] || fail "Empty previous-sha file."

say "Rolling back to ${TARGET_SHA:0:8}..."

sudo -u "$SERVICE_USER" git -C "$REPO_DIR" fetch origin main 2>&1 | tee -a "$LOG_FILE" || true
sudo -u "$SERVICE_USER" git -C "$REPO_DIR" reset --hard "$TARGET_SHA" 2>&1 | tee -a "$LOG_FILE" || fail "git reset failed"

say "Syncing files..."
rsync -a --delete --exclude=node_modules --exclude=dist --exclude=.git --exclude=data \
  "$REPO_DIR/server/" "$INSTALL_DIR/server/" 2>&1 | tee -a "$LOG_FILE"
rsync -a --delete --exclude=node_modules --exclude=dist --exclude=.git \
  "$REPO_DIR/client/" "$INSTALL_DIR/client/" 2>&1 | tee -a "$LOG_FILE"
cp "$REPO_DIR/VERSION" "$INSTALL_DIR/VERSION"
cp "$REPO_DIR/CHANGELOG.md" "$INSTALL_DIR/CHANGELOG.md"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/server" "$INSTALL_DIR/client" "$INSTALL_DIR/VERSION" "$INSTALL_DIR/CHANGELOG.md"

say "Reinstalling deps and rebuilding..."
sudo -u "$SERVICE_USER" bash -c "cd '$INSTALL_DIR/server' && npm install --omit=dev" 2>&1 | tee -a "$LOG_FILE" || fail "server npm install failed"
sudo -u "$SERVICE_USER" bash -c "cd '$INSTALL_DIR/client' && npm install && npm run build" 2>&1 | tee -a "$LOG_FILE" || fail "client build failed"

# IMPORTANT: write final state BEFORE restart, since the restart will kill us.
NEW_VERSION=$(cat "$INSTALL_DIR/VERSION" 2>/dev/null || echo "unknown")
say "✅ Rolled back to v$NEW_VERSION"
set_state "done"
say "Restarting service..."
if command -v systemd-run >/dev/null 2>&1; then
  systemd-run --scope --quiet --collect systemctl restart "$SERVICE" >/dev/null 2>&1 || systemctl restart "$SERVICE"
else
  systemctl restart "$SERVICE" || true
fi
exit 0
