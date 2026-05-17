#!/usr/bin/env bash
# ============================================================
# POS Stock System — One-Line Installer
#
# Usage on a fresh Ubuntu 22.04 / 24.04 server:
#
#   curl -sL https://raw.githubusercontent.com/marsh4200/pos-stock-system/main/install.sh | sudo bash
#
# What it does:
#   - Installs Node.js 20
#   - Creates a service user `everton`
#   - Clones the repo to /opt/pos-stock-system (public, no key needed)
#   - Builds and installs the app to /opt/everton-stock
#   - Sets up the systemd service `everton-stock`
#   - Wires up the in-app updater (one-click updates from then on)
# ============================================================
set -e

REPO_URL="${REPO_URL:-https://github.com/marsh4200/pos-stock-system.git}"
REPO_DIR="${REPO_DIR:-/opt/pos-stock-system}"
INSTALL_DIR="${INSTALL_DIR:-/opt/everton-stock}"
SERVICE_USER="${SERVICE_USER:-everton}"
APP_PORT="${APP_PORT:-3001}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}==>${NC} $1"; }
warn() { echo -e "${YELLOW}!! ${NC} $1"; }
err()  { echo -e "${RED}XX${NC} $1"; }

if [ "$(id -u)" -ne 0 ]; then
  err "This installer must run as root."
  err "Usage: curl -sL https://raw.githubusercontent.com/marsh4200/pos-stock-system/main/install.sh | sudo bash"
  exit 1
fi

echo "============================================================"
echo " POS Stock System — Installer"
echo "============================================================"
echo " Repo:        $REPO_URL"
echo " Install dir: $INSTALL_DIR"
echo " Service:     everton-stock (user: $SERVICE_USER, port $APP_PORT)"
echo "============================================================"
echo

log "Updating package lists…"
apt-get update -qq

log "Installing prerequisites (git, curl, rsync)…"
apt-get install -y -qq git curl rsync ca-certificates

log "Checking Node.js…"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 20 ]; then
  log "Installing Node.js 20 from NodeSource…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs build-essential
else
  log "Node $(node -v) already installed."
fi

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  log "Creating service user '$SERVICE_USER'…"
  useradd --system --create-home --home-dir "/home/$SERVICE_USER" --shell /bin/bash "$SERVICE_USER"
fi

if [ -d "$REPO_DIR/.git" ]; then
  log "Repo already exists at $REPO_DIR, pulling latest…"
  cd "$REPO_DIR"
  sudo -u "$SERVICE_USER" git fetch origin main
  sudo -u "$SERVICE_USER" git reset --hard origin/main
else
  log "Cloning repo to $REPO_DIR…"
  rm -rf "$REPO_DIR"
  mkdir -p "$REPO_DIR"
  chown "$SERVICE_USER:$SERVICE_USER" "$REPO_DIR"
  sudo -u "$SERVICE_USER" git clone "$REPO_URL" "$REPO_DIR"
fi

log "Syncing source to $INSTALL_DIR…"
mkdir -p "$INSTALL_DIR"
rsync -a --exclude='.git' --exclude='node_modules' --exclude='dist' --exclude='data' \
  "$REPO_DIR/server" "$REPO_DIR/client" "$INSTALL_DIR/"
[ -f "$REPO_DIR/VERSION" ] && cp "$REPO_DIR/VERSION" "$INSTALL_DIR/VERSION"
[ -f "$REPO_DIR/CHANGELOG.md" ] && cp "$REPO_DIR/CHANGELOG.md" "$INSTALL_DIR/CHANGELOG.md"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

log "Installing server dependencies…"
sudo -u "$SERVICE_USER" bash -c "cd '$INSTALL_DIR/server' && npm install --omit=dev"

log "Building frontend (takes ~30s)…"
sudo -u "$SERVICE_USER" bash -c "cd '$INSTALL_DIR/client' && npm install && npm run build"

chmod +x "$REPO_DIR/scripts/"*.sh 2>/dev/null || true

log "Configuring sudo for in-app updates…"
cat > /etc/sudoers.d/everton-updater <<EOF
$SERVICE_USER ALL=(root) NOPASSWD: $REPO_DIR/scripts/updater.sh
$SERVICE_USER ALL=(root) NOPASSWD: $REPO_DIR/scripts/rollback.sh
EOF
chmod 440 /etc/sudoers.d/everton-updater
visudo -c -f /etc/sudoers.d/everton-updater >/dev/null

log "Creating systemd service…"
tee /etc/systemd/system/everton-stock.service > /dev/null <<EOF
[Unit]
Description=POS Stock Management
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR/server
Environment="NODE_ENV=production"
Environment="PORT=$APP_PORT"
Environment="DATA_DIR=$INSTALL_DIR/data"
Environment="REPO_DIR=$REPO_DIR"
Environment="INSTALL_DIR=$INSTALL_DIR"
ExecStart=/usr/bin/node $INSTALL_DIR/server/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable everton-stock
systemctl restart everton-stock

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  log "Opening firewall port $APP_PORT…"
  ufw allow $APP_PORT/tcp >/dev/null
fi

sleep 2

echo
echo "============================================================"
log "Install complete!"
echo "============================================================"
systemctl status everton-stock --no-pager -l | head -n 10 || true
echo
IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "your-server-ip")
VERSION=$(cat "$INSTALL_DIR/VERSION" 2>/dev/null || echo "unknown")
echo " Version installed: v$VERSION"
echo
echo " Open in browser:"
echo "   http://$IP:$APP_PORT"
echo
echo " First-time setup: visit the URL above and create an admin account."
echo " Future updates: log into the app → Settings → Updates → Update Now."
echo "============================================================"
