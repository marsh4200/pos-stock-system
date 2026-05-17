#!/usr/bin/env bash
# ============================================================
# One-time setup for in-app updates.
# Generates a deploy key for the 'everton' service user,
# prompts to add it to GitHub, then clones the repo.
# ============================================================

set -euo pipefail

REPO_URL="${REPO_URL:-git@github.com:marsh4200/pos-stock-system.git}"
REPO_DIR="/opt/pos-stock-system"
INSTALL_DIR="/opt/everton-stock"
SERVICE_USER="everton"
EVERTON_HOME="/var/lib/everton"
KEY_PATH="$EVERTON_HOME/.ssh/pos_stock_deploy"

echo "==> POS Stock System: in-app updater setup"
echo

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "❌ Service user '$SERVICE_USER' doesn't exist. Run install.sh first."
  exit 1
fi
mkdir -p "$EVERTON_HOME/.ssh"
chown -R "$SERVICE_USER:$SERVICE_USER" "$EVERTON_HOME"
chmod 700 "$EVERTON_HOME/.ssh"

if [ ! -f "$KEY_PATH" ]; then
  echo "==> Generating SSH deploy key for $SERVICE_USER..."
  sudo -u "$SERVICE_USER" ssh-keygen -t ed25519 -C "everton-updater" -f "$KEY_PATH" -N ""
else
  echo "==> Deploy key already exists at $KEY_PATH"
fi

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

echo
echo "============================================================"
echo " 🔑 ADD THIS DEPLOY KEY TO GITHUB"
echo "============================================================"
echo
cat "$KEY_PATH.pub"
echo
echo "============================================================"
echo " 1. Go to: https://github.com/marsh4200/pos-stock-system/settings/keys"
echo " 2. Click 'Add deploy key'"
echo " 3. Title: 'Server updater'"
echo " 4. Paste the key above into 'Key'"
echo " 5. CHECK 'Allow write access'"
echo " 6. Click 'Add key'"
echo "============================================================"
echo
read -rp "Press Enter once you've added the key to GitHub..."

echo "==> Testing GitHub SSH access..."
sudo -u "$SERVICE_USER" ssh -T -o StrictHostKeyChecking=accept-new git@github.com 2>&1 | head -3 || true
echo

if [ -d "$REPO_DIR/.git" ]; then
  echo "==> Repo already cloned, fetching latest..."
  sudo -u "$SERVICE_USER" git -C "$REPO_DIR" fetch origin main
  sudo -u "$SERVICE_USER" git -C "$REPO_DIR" reset --hard origin/main
else
  echo "==> Cloning repo into $REPO_DIR..."
  rm -rf "$REPO_DIR"
  mkdir -p "$REPO_DIR"
  chown "$SERVICE_USER:$SERVICE_USER" "$REPO_DIR"
  sudo -u "$SERVICE_USER" git clone "$REPO_URL" "$REPO_DIR"
fi

chmod +x "$REPO_DIR/scripts/"*.sh

echo "==> Configuring sudo permissions for the updater..."
SUDOERS_FILE="/etc/sudoers.d/everton-updater"
cat > "$SUDOERS_FILE" <<EOF
# Allow $SERVICE_USER to run the updater and rollback scripts as root.
$SERVICE_USER ALL=(root) NOPASSWD: $REPO_DIR/scripts/updater.sh
$SERVICE_USER ALL=(root) NOPASSWD: $REPO_DIR/scripts/rollback.sh
EOF
chmod 440 "$SUDOERS_FILE"
visudo -c -f "$SUDOERS_FILE" >/dev/null

cp "$REPO_DIR/VERSION" "$INSTALL_DIR/VERSION"
cp "$REPO_DIR/CHANGELOG.md" "$INSTALL_DIR/CHANGELOG.md"
chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/VERSION" "$INSTALL_DIR/CHANGELOG.md"

echo "==> Restarting service..."
systemctl restart everton-stock || true
sleep 2

echo
echo "============================================================"
echo " ✅ Setup complete!"
echo "============================================================"
echo " The 'Updates' section in Settings is now live."
echo " Log into the app -> Settings -> scroll to 'Updates'"
echo "============================================================"
