#!/usr/bin/env bash
# install.sh — one-liner deployment for the dashboard host agent
# Usage: curl -fsSL https://raw.githubusercontent.com/your-username/remote-vitals-vscode/main/agent/install.sh | bash
# Or:    ./install.sh --backend https://dashboard.example.com --token <TOKEN>
set -euo pipefail

REPO_URL="https://raw.githubusercontent.com/your-username/remote-vitals-vscode/main/agent"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/dashboard-agent}"
SERVICE_NAME="dashboard-agent"

# ---------- parse args ----------
BACKEND=""
TOKEN=""
INTERVAL=60

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backend) BACKEND="$2"; shift 2 ;;
    --token)   TOKEN="$2";   shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

[[ -z "$BACKEND" ]] && { echo "ERROR: --backend required"; exit 1; }
[[ -z "$TOKEN" ]]   && { echo "ERROR: --token required";   exit 1; }

# ---------- install ----------
echo "Installing Dashboard Agent to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"

# Download agent files
for f in agent.py requirements.txt; do
  curl -fsSL "$REPO_URL/$f" -o "$INSTALL_DIR/$f"
done

# Python venv
python3 -m venv "$INSTALL_DIR/venv"
"$INSTALL_DIR/venv/bin/pip" install -q -r "$INSTALL_DIR/requirements.txt"

# Write config
cat > "$INSTALL_DIR/agent.yml" <<EOF
backend: ${BACKEND}
token: ${TOKEN}
interval: ${INTERVAL}
EOF

# systemd user service
UNIT_DIR="${HOME}/.config/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Dashboard Host Agent
After=network.target

[Service]
Type=simple
ExecStart=${INSTALL_DIR}/venv/bin/python ${INSTALL_DIR}/agent.py --config ${INSTALL_DIR}/agent.yml
Restart=always
RestartSec=30
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "${SERVICE_NAME}.service"

echo "Done! Agent running as systemd user service '${SERVICE_NAME}'."
echo "Logs: journalctl --user -u ${SERVICE_NAME} -f"
