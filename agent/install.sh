#!/usr/bin/env bash
# install.sh — one-liner deployment for the dashboard host agent
# Usage: curl -fsSL https://raw.githubusercontent.com/bensouille/remote-vitals-vscode/main/agent/install.sh | bash -s -- --backend https://dashboard.example.com --token <TOKEN>
# Or:    ./install.sh --backend https://dashboard.example.com --token <TOKEN>
#
# Service mode (auto-detected):
#   root  → system service  /etc/systemd/system/vitals-agent.service  (recommended)
#   other → user service    ~/.config/systemd/user/vitals-agent.service + linger
# Override with --system or --user flag.
set -euo pipefail

REPO_URL="https://raw.githubusercontent.com/bensouille/remote-vitals-vscode/main/agent"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/vitals-agent}"
SERVICE_NAME="vitals-agent"

# ---------- parse args ----------
BACKEND=""
TOKEN=""
INTERVAL=60
FORCE_SYSTEM=""   # "system" | "user" | "" (auto)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backend)  BACKEND="$2";  shift 2 ;;
    --token)    TOKEN="$2";    shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --system)   FORCE_SYSTEM="system"; shift ;;
    --user)     FORCE_SYSTEM="user";   shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

[[ -z "$BACKEND" ]] && { echo "ERROR: --backend required"; exit 1; }
[[ -z "$TOKEN" ]]   && { echo "ERROR: --token required";   exit 1; }

# ---------- choose service mode ----------
if [[ -z "$FORCE_SYSTEM" ]]; then
  [[ "$(id -u)" -eq 0 ]] && SERVICE_MODE="system" || SERVICE_MODE="user"
else
  SERVICE_MODE="$FORCE_SYSTEM"
fi
echo "Service mode: $SERVICE_MODE"

# ---------- install files ----------
echo "Installing Dashboard Agent to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"

for f in agent.py requirements.txt; do
  curl -fsSL "$REPO_URL/$f" -o "$INSTALL_DIR/$f"
done

# Ensure python3-venv is available (Debian/Ubuntu)
if ! python3 -m venv --help &>/dev/null; then
  echo "python3-venv not found — installing..."
  if command -v apt-get &>/dev/null; then
    apt-get install -y python3-venv
  elif command -v dnf &>/dev/null; then
    dnf install -y python3
  elif command -v yum &>/dev/null; then
    yum install -y python3
  else
    echo "ERROR: cannot install python3-venv — install it manually and retry"; exit 1
  fi
fi

python3 -m venv "$INSTALL_DIR/venv"
"$INSTALL_DIR/venv/bin/pip" install -q -r "$INSTALL_DIR/requirements.txt"

cat > "$INSTALL_DIR/agent.yml" <<EOF
backend: ${BACKEND}
token: ${TOKEN}
interval: ${INTERVAL}
EOF

# ---------- systemd service ----------
EXEC_START="${INSTALL_DIR}/venv/bin/python ${INSTALL_DIR}/agent.py --config ${INSTALL_DIR}/agent.yml"

if [[ "$SERVICE_MODE" == "system" ]]; then
  # System-wide service — survives reboots, no linger needed, works for root
  SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Dashboard Host Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
ExecStart=${EXEC_START}
Restart=always
RestartSec=30
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now "${SERVICE_NAME}.service"
  echo "Done! System service '${SERVICE_NAME}' enabled."
  echo "Logs: journalctl -u ${SERVICE_NAME} -f"
else
  # User service — non-root hosts
  UNIT_DIR="${HOME}/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Dashboard Host Agent
After=network.target

[Service]
Type=simple
ExecStart=${EXEC_START}
Restart=always
RestartSec=30
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=default.target
EOF
  # enable-linger requires the username explicitly to survive session logout
  loginctl enable-linger "$(id -un)"
  systemctl --user daemon-reload
  systemctl --user enable --now "${SERVICE_NAME}.service"
  echo "Done! User service '${SERVICE_NAME}' enabled (linger activated)."
  echo "Logs: journalctl --user -u ${SERVICE_NAME} -f"
fi
