#!/usr/bin/env bash
# ============================================================
# Bootstrap script — transitions an existing v3.1 install to
# the v3.2 "in-app updater" model.
#
# Run this ONCE on the server. It will:
#   1. Clone the GitHub repo to /opt/pos-stock-system
#   2. Sync the latest code into /opt/everton-stock (running install)
#   3. Set up sudo + deploy key so future updates are 1-click
#
# Usage: sudo bash bootstrap-updater.sh
# ============================================================

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "❌ Must be run as root. Try: sudo bash $0"
  exit 1
fi

REPO_URL="git@github.com:marsh4200/pos-stock-system.git"
REPO_DIR="/opt/pos-stock-system"
INSTALL_DIR="/opt/everton-stock"
SERVICE_USER="everton"
EVERTON_HOME="/var/lib/everton"
KEY_PATH="$EVERTON_HOME/.ssh/pos_stock_deploy"
SERVICE="everton-stock"

echo "==> Bootstrapping in-app updater on existing v3.1 install"
echo

# 0. Sanity
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "❌ Service user '$SERVICE_USER' missing. Is the app installed?"
  exit 1
fi
if [ ! -d "$INSTALL_DIR" ]; then
  echo "❌ Install dir $INSTALL_DIR missing. Is the app installed?"
  exit 1
fi

# 1. SSH directory for the service user
mkdir -p "$EVERTON_HOME/.ssh"
chown -R "$SERVICE_USER:$SERVICE_USER" "$EVERTON_HOME"
chmod 700 "$EVERTON_HOME/.ssh"

# 2. Generate deploy key
if [ ! -f "$KEY_PATH" ]; then
  echo "==> Generating SSH deploy key for $SERVICE_USER..."
  sudo -u "$SERVICE_USER" ssh-keygen -t ed25519 -C "everton-updater" -f "$KEY_PATH" -N ""
else
  echo "==> Deploy key already exists at $KEY_PATH"
fi

# 3. SSH config
SSH_CONFIG="$EVERTON_HOME/.ssh/config"
if ! grep -q "Host github.com" "$SSH_CONFIG" 2>/dev/null; then
  cat >> "$SSH_CONFIG" <<EOF

Host github.com
  HostName github.com
  User git
  IdentityFile $KEY_PATH
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
EOF
  chown "$SERVICE_USER:$SERVICE_USER" "$SSH_CONFIG"
  chmod 600 "$SSH_CONFIG"
fi

# 4. Show the key and pause
echo
echo "============================================================"
echo " 🔑 ADD THIS DEPLOY KEY TO GITHUB:"
echo "============================================================"
echo
cat "$KEY_PATH.pub"
echo
echo "============================================================"
echo " 1. Go to: https://github.com/marsh4200/pos-stock-system/settings/keys"
echo " 2. Click 'Add deploy key'"
echo " 3. Title: 'Server updater'"
echo " 4. Paste the key above"
echo " 5. CHECK 'Allow write access'"
echo " 6. Click 'Add key'"
echo "============================================================"
echo
read -rp "Press Enter once added..."

# 5. Test SSH
echo "==> Testing GitHub SSH access..."
sudo -u "$SERVICE_USER" ssh -T -o StrictHostKeyChecking=accept-new git@github.com 2>&1 | head -3 || true
echo

# 6. Clone the repo
if [ -d "$REPO_DIR/.git" ]; then
  echo "==> Repo already cloned, fetching..."
  sudo -u "$SERVICE_USER" git -C "$REPO_DIR" fetch origin main
  sudo -u "$SERVICE_USER" git -C "$REPO_DIR" reset --hard origin/main
else
  echo "==> Cloning repo..."
  rm -rf "$REPO_DIR"
  mkdir -p "$REPO_DIR"
  chown "$SERVICE_USER:$SERVICE_USER" "$REPO_DIR"
  sudo -u "$SERVICE_USER" git clone "$REPO_URL" "$REPO_DIR"
fi

chmod +x "$REPO_DIR/scripts/"*.sh

# 7. Sudoers for the updater
echo "==> Configuring sudo permissions..."
SUDOERS_FILE="/etc/sudoers.d/everton-updater"
cat > "$SUDOERS_FILE" <<EOF
$SERVICE_USER ALL=(root) NOPASSWD: $REPO_DIR/scripts/updater.sh
$SERVICE_USER ALL=(root) NOPASSWD: $REPO_DIR/scripts/rollback.sh
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/git -C $REPO_DIR fetch origin main
EOF
chmod 440 "$SUDOERS_FILE"
visudo -c -f "$SUDOERS_FILE" >/dev/null

# 8. Sync latest code into /opt/everton-stock NOW (this is the actual v3.1 -> v3.2 upgrade)
echo "==> Syncing v3.2 code from repo into running install..."
systemctl stop "$SERVICE" || true

# Backup DB
if [ -f "$INSTALL_DIR/data/everton.db" ]; then
  STAMP=$(date +%Y%m%d-%H%M%S)
  mkdir -p "$INSTALL_DIR/data/backups"
  cp "$INSTALL_DIR/data/everton.db" "$INSTALL_DIR/data/backups/pre-bootstrap-$STAMP.db"
  echo "  ✓ DB backed up to pre-bootstrap-$STAMP.db"
fi

rsync -a --delete --exclude='node_modules' --exclude='dist' --exclude='.git' --exclude='data' \
  "$REPO_DIR/server/" "$INSTALL_DIR/server/"
rsync -a --delete --exclude='node_modules' --exclude='dist' --exclude='.git' \
  "$REPO_DIR/client/" "$INSTALL_DIR/client/"
cp "$REPO_DIR/VERSION" "$INSTALL_DIR/VERSION"
cp "$REPO_DIR/CHANGELOG.md" "$INSTALL_DIR/CHANGELOG.md"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/server" "$INSTALL_DIR/client" "$INSTALL_DIR/VERSION" "$INSTALL_DIR/CHANGELOG.md"

# 9. Install deps + build
echo "==> Installing server deps..."
sudo -u "$SERVICE_USER" bash -c "cd '$INSTALL_DIR/server' && npm install --omit=dev"
echo "==> Building frontend (may take ~30s)..."
sudo -u "$SERVICE_USER" bash -c "cd '$INSTALL_DIR/client' && npm install && npm run build"

# 10. Start
systemctl start "$SERVICE"
sleep 2
if systemctl is-active --quiet "$SERVICE"; then
  echo "==> ✅ Service is running"
else
  echo "❌ Service didn't start. Check: journalctl -u $SERVICE -n 50"
  exit 1
fi

VERSION=$(cat "$INSTALL_DIR/VERSION")
echo
echo "============================================================"
echo " 🎉 Bootstrap complete! Now on v$VERSION"
echo "============================================================"
echo " Future updates: just log into the app -> Settings -> Updates"
echo "============================================================"
