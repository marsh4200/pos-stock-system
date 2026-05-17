#!/usr/bin/env bash
# ============================================================
# In-App Updater for POS Stock System
# Invoked via 'sudo updater.sh' by the running service.
# Runs as root (needed for systemctl + writes to /opt/everton-stock).
# Git operations are done as the 'everton' user (deploy key lives there).
# Logs to /opt/everton-stock/data/updater.log for the UI to tail.
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
fail() { say "❌ FAILED: $1"; set_state "failed"; exit 1; }

mkdir -p "$DATA_DIR"
echo "===== Update started $(date) =====" > "$LOG_FILE"
chown "$SERVICE_USER:$SERVICE_USER" "$LOG_FILE"
set_state "running"

[ -d "$REPO_DIR" ] || fail "Repo not found at $REPO_DIR. Run setup-git.sh first."

# 1. Backup DB
say "Step 1/6: Backing up database..."
if [ -f "$DATA_DIR/everton.db" ]; then
  STAMP=$(date +%Y%m%d-%H%M%S)
  mkdir -p "$DATA_DIR/backups"
  cp "$DATA_DIR/everton.db" "$DATA_DIR/backups/pre-update-$STAMP.db" || fail "DB backup failed"
  say "  ✓ Backup: pre-update-$STAMP.db"
else
  say "  (no existing DB; skipping)"
fi

# 2. Record current SHA
say "Step 2/6: Recording current version for rollback..."
CURRENT_SHA=$(sudo -u "$SERVICE_USER" git -C "$REPO_DIR" rev-parse HEAD)
echo "$CURRENT_SHA" > "$PREVIOUS_SHA_FILE"
chown "$SERVICE_USER:$SERVICE_USER" "$PREVIOUS_SHA_FILE"
say "  ✓ Previous SHA: ${CURRENT_SHA:0:8}"

# 3. Pull latest (as everton, since deploy key lives there)
say "Step 3/6: Pulling latest code from GitHub..."
sudo -u "$SERVICE_USER" git -C "$REPO_DIR" fetch origin main 2>&1 | tee -a "$LOG_FILE" || fail "git fetch failed"
sudo -u "$SERVICE_USER" git -C "$REPO_DIR" reset --hard origin/main 2>&1 | tee -a "$LOG_FILE" || fail "git reset failed"
NEW_SHA=$(sudo -u "$SERVICE_USER" git -C "$REPO_DIR" rev-parse HEAD)
say "  ✓ New SHA: ${NEW_SHA:0:8}"

if [ "$CURRENT_SHA" = "$NEW_SHA" ]; then
  say "Already on latest version, nothing to do."
  set_state "idle"
  exit 0
fi

# 4. Sync files
say "Step 4/6: Syncing files to install directory..."
rsync -a --delete --exclude='node_modules' --exclude='dist' --exclude='.git' --exclude='data' \
  "$REPO_DIR/server/" "$INSTALL_DIR/server/" 2>&1 | tee -a "$LOG_FILE"
rsync -a --delete --exclude='node_modules' --exclude='dist' --exclude='.git' \
  "$REPO_DIR/client/" "$INSTALL_DIR/client/" 2>&1 | tee -a "$LOG_FILE"
cp "$REPO_DIR/VERSION" "$INSTALL_DIR/VERSION"
cp "$REPO_DIR/CHANGELOG.md" "$INSTALL_DIR/CHANGELOG.md"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/server" "$INSTALL_DIR/client" "$INSTALL_DIR/VERSION" "$INSTALL_DIR/CHANGELOG.md"
say "  ✓ Files synced"

# 5. Install deps + build
say "Step 5/6: Installing dependencies and building frontend..."
sudo -u "$SERVICE_USER" bash -c "cd '$INSTALL_DIR/server' && npm install --omit=dev" 2>&1 | tee -a "$LOG_FILE" || fail "server npm install failed"
sudo -u "$SERVICE_USER" bash -c "cd '$INSTALL_DIR/client' && npm install && npm run build" 2>&1 | tee -a "$LOG_FILE" || fail "client build failed"
say "  ✓ Build complete"

# 6. Restart
say "Step 6/6: Restarting service..."
systemctl restart "$SERVICE" || fail "systemctl restart failed"
sleep 3
if systemctl is-active --quiet "$SERVICE"; then
  say "  ✓ Service is running"
else
  fail "Service failed to start - run: journalctl -u $SERVICE -n 50"
fi

NEW_VERSION=$(cat "$INSTALL_DIR/VERSION" 2>/dev/null || echo "unknown")
say "✅ Update complete! Now on v$NEW_VERSION"
set_state "done"
exit 0
