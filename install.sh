#!/usr/bin/env bash
# ============================================================
# Everton Engineering Stock Management - Linux Installer
# Run on a fresh Ubuntu 22.04 / 24.04 server as a sudo user
# Usage: bash install.sh
# ============================================================
set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}==>${NC} $1"; }
warn() { echo -e "${YELLOW}!! ${NC} $1"; }
err()  { echo -e "${RED}XX${NC} $1"; }

INSTALL_DIR="${INSTALL_DIR:-/opt/everton-stock}"
SERVICE_USER="${SERVICE_USER:-everton}"
APP_PORT="${APP_PORT:-3001}"

if [ "$(id -u)" -eq 0 ]; then
  warn "Running as root. That's fine but a sudo user works too."
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

# Helper for running commands as the service user (works whether script runs as root or sudo)
as_service_user() {
  if [ "$(id -u)" -eq 0 ]; then
    sudo -u "$SERVICE_USER" bash -c "$1"
  else
    sudo -u "$SERVICE_USER" bash -c "$1"
  fi
}

# 1) Install Node.js 20 if not present
log "Checking Node.js…"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 20 ]; then
  log "Installing Node.js 20 from NodeSource…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO bash -
  $SUDO apt-get install -y nodejs build-essential
else
  log "Node $(node -v) already installed."
fi

# 2) Create service user
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  log "Creating service user '$SERVICE_USER'…"
  $SUDO useradd --system --create-home --shell /bin/bash "$SERVICE_USER"
fi

# 3) Copy source to install directory
log "Installing to $INSTALL_DIR…"
$SUDO mkdir -p "$INSTALL_DIR"
$SUDO cp -r ./server ./client "$INSTALL_DIR/"
[ -f ./VERSION ] && $SUDO cp ./VERSION "$INSTALL_DIR/VERSION"
[ -f ./CHANGELOG.md ] && $SUDO cp ./CHANGELOG.md "$INSTALL_DIR/CHANGELOG.md"
$SUDO chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

# 4) Install dependencies and build
log "Installing server dependencies…"
as_service_user "cd '$INSTALL_DIR/server' && npm install --omit=dev"

log "Installing client dependencies and building…"
as_service_user "cd '$INSTALL_DIR/client' && npm install && npm run build"

# 5) Create systemd service
log "Creating systemd service…"
$SUDO tee /etc/systemd/system/everton-stock.service > /dev/null <<EOF
[Unit]
Description=Everton Engineering Stock Management
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR/server
Environment="NODE_ENV=production"
Environment="PORT=$APP_PORT"
Environment="DATA_DIR=$INSTALL_DIR/data"
ExecStart=/usr/bin/node $INSTALL_DIR/server/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

$SUDO systemctl daemon-reload
$SUDO systemctl enable everton-stock
$SUDO systemctl restart everton-stock

# 6) Open firewall (optional - only if ufw is active)
if command -v ufw >/dev/null 2>&1 && $SUDO ufw status | grep -q "Status: active"; then
  log "Opening firewall port $APP_PORT…"
  $SUDO ufw allow $APP_PORT/tcp
fi

sleep 2

# 7) Status
echo ""
echo "============================================================"
log "Install complete!"
echo "============================================================"
echo ""
echo "Service status:"
$SUDO systemctl status everton-stock --no-pager -l | head -n 10 || true
echo ""

IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "your-server-ip")
echo "Open in browser:"
echo "  http://$IP:$APP_PORT"
echo ""
echo "Useful commands:"
echo "  Check logs:    sudo journalctl -u everton-stock -f"
echo "  Restart:       sudo systemctl restart everton-stock"
echo "  Stop:          sudo systemctl stop everton-stock"
echo "  Data folder:   $INSTALL_DIR/data"
echo "  Backups:       $INSTALL_DIR/data/backups"
echo ""
echo "First-time setup: open the URL above, go to Employees,"
echo "create your first employee, then go to Products."
echo "============================================================"
