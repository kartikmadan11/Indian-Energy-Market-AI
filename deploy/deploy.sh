#!/bin/bash
set -e

# ============================================
# Makeathon-20 Deployment Script (GCP VM)
# Run ON the VM as kartik-gcp user
# ============================================

APP_DIR="/home/kartik-gcp/makeathon-20"
DEPLOY_DIR="$APP_DIR/deploy"

echo "=== 1/7 System packages ==="
sudo apt-get update -qq
sudo apt-get install -y -qq python3-venv python3-pip nginx curl

# Node.js (if not v18+)
NODE_VER=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_VER" ] || [ "$NODE_VER" -lt 18 ]; then
    echo "Installing Node.js 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y -qq nodejs
fi
echo "Node: $(node --version), npm: $(npm --version)"

echo "=== 2/7 Python venv + deps ==="
cd "$APP_DIR"
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip -q
pip install -r deploy/requirements-deploy.txt -q
echo "Python packages installed."

echo "=== 3/7 Frontend build ==="
cd "$APP_DIR/frontend"
npm install
npx next build
echo "Frontend built."

echo "=== 4/7 Update frontend API base URL ==="
# The frontend needs to call the backend via the public IP through nginx
# Since nginx proxies /api/ to backend, the frontend should use relative URLs
# Patch api.ts baseURL to use relative path (no localhost)
sed -i 's|baseURL: "http://localhost:8000/api"|baseURL: "/api"|' "$APP_DIR/frontend/src/lib/api.ts"
# Rebuild after patching
npx next build
echo "Frontend rebuilt with relative API URL."

echo "=== 5/7 nginx config ==="
sudo cp "$DEPLOY_DIR/nginx.conf" /etc/nginx/sites-available/makeathon
sudo ln -sf /etc/nginx/sites-available/makeathon /etc/nginx/sites-enabled/makeathon
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
sudo systemctl enable nginx
echo "nginx configured."

echo "=== 6/7 systemd services ==="
sudo cp "$DEPLOY_DIR/backend.service" /etc/systemd/system/makeathon-backend.service
sudo cp "$DEPLOY_DIR/frontend.service" /etc/systemd/system/makeathon-frontend.service
sudo systemctl daemon-reload
sudo systemctl enable makeathon-backend makeathon-frontend
sudo systemctl restart makeathon-backend
sudo systemctl restart makeathon-frontend
echo "Services started."

echo "=== 7/7 Verify ==="
sleep 3
echo "Backend status:"
sudo systemctl status makeathon-backend --no-pager -l | head -10
echo ""
echo "Frontend status:"
sudo systemctl status makeathon-frontend --no-pager -l | head -10
echo ""

# Get external IP
EXT_IP=$(curl -s http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip -H "Metadata-Flavor: Google" 2>/dev/null || echo "unknown")
echo ""
echo "============================================"
echo "  Deployment complete!"
echo "  App: http://$EXT_IP"
echo "  API: http://$EXT_IP/api/forecast/health"
echo "  Docs: http://$EXT_IP/docs"
echo "============================================"
