# Remote Vitals

> Live CPU / RAM / Disk / Network metrics from any remote SSH host — **no agent install required.**

A VS Code extension that works as a lightweight alternative to [Glances](https://nicolargo.github.io/glances/) for remote hosts. It runs as a `workspace` extension directly on the remote machine via VS Code Remote SSH, reading `/proc` and `df` — nothing else to deploy.

Optionally, it can also **push metrics to a dashboard backend** at each refresh cycle, replacing `agent.py` for hosts where VS Code Remote SSH is already running.

---

## Features

- **CPU** — overall usage % + per-core breakdown
- **RAM** — used / available / total + swap
- **Disks** — all physical partitions with usage bars
- **Network** — per-interface real-time RX/TX rates
- **Status bar** — always-visible CPU & RAM at a glance
- **Auto-refresh** — configurable interval (default 5 s)
- **Dashboard push** — optional, reports metrics + open VS Code sessions to a backend

---

## Requirements

- VS Code with [Remote - SSH](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh) extension
- Linux remote host (reads `/proc/stat`, `/proc/meminfo`, `/proc/net/dev`, `/proc/cpuinfo`, `/proc/uptime`)

---

## Installation

### From VSIX (recommended)

Download the latest `.vsix` from [GitHub Releases](https://github.com/bensouille/remote-vitals-vscode/releases), then install it **on the remote host** while connected via SSH:

**Via Command Palette:**
`Ctrl+Shift+P` → `Extensions: Install from VSIX...` → select the file

**Via CLI (on the remote host):**
```bash
code --install-extension remote-vitals-0.1.0.vsix
```

> The extension is `extensionKind: ["workspace"]` — VS Code automatically runs it on the remote side when connected via SSH.

---

## First-run setup

After installation and connecting to the host, a notification appears:

> **"Remote Vitals: configurer le push vers votre dashboard backend?"**

Click **Configurer** to launch the 4-step wizard:

| Step | Value | Example |
|------|-------|---------|
| 1/4 — Backend URL | URL of your dashboard | `https://dashboard.example.com` |
| 2/4 — Agent Token | Secret shared with the backend | `874558ee8c5b...` |
| 3/4 — Host Alias | Display name in the dashboard | `my-server` |
| 4/4 — SSH User | SSH user for dashboard deep-links | `root` |

> Press **Échap** at any step to cancel without saving. Click **Plus tard** to skip (won't be asked again).

To re-open the wizard at any time:
`Ctrl+Shift+P` → **Remote Vitals: Configure Dashboard Push**

Settings are written to `~/.vscode-server/data/Machine/settings.json` (Machine scope — applies to all VS Code windows on this host).

---

## Agent Token

The token must match the `AGENT_TOKEN` environment variable on the backend server.

**Find it** in the backend `.env`:
```bash
grep AGENT_TOKEN /path/to/dashboard/backend/.env
```

**Generate a new one** (32 bytes hex):
```bash
openssl rand -hex 32
```

The token is sent as `X-Agent-Token` HTTP header on every checkin request and validated server-side.

---

## Usage

Once installed and (optionally) configured:

1. Connect to a remote host via VS Code Remote SSH
2. The status bar shows live **CPU% / RAM%** automatically
3. Open the Command Palette → **Remote Vitals: Show Panel** for the full metrics panel
4. If dashboard push is configured, metrics are sent every `refreshInterval` seconds

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `remoteVitals.refreshInterval` | `5` | Refresh interval in seconds (2–300) |
| `remoteVitals.backendUrl` | `""` | Dashboard backend URL. When set with `agentToken`, metrics are pushed at each refresh |
| `remoteVitals.agentToken` | `""` | Secret token matching `AGENT_TOKEN` on the backend |
| `remoteVitals.hostAlias` | `""` | Display name for this host in the dashboard (default: system hostname) |
| `remoteVitals.sshUser` | `""` | SSH user — combined with `hostAlias` to form `user@host` in dashboard deep-links |
| `remoteVitals.reportSessions` | `false` | Include open workspace folders in each checkin. Keep `false` (default) if `session-reporter` is installed on the host. Set to `true` only on hosts without `session-reporter` |

All settings can be set via the wizard (`remoteVitals.configure`) or manually in VS Code Settings (`Ctrl+,` → search "Remote Vitals").

> **Coexistence with session-reporter:** `remote-vitals` and [`session-reporter`](https://github.com/your-username/session-reporter-vscode) are designed to run side by side. `remote-vitals` handles system metrics (CPU / RAM / disk / uptime); `session-reporter` handles workspace session reporting. The default (`reportSessions: false`) is the right choice when both are installed. Set `reportSessions: true` only on hosts where `session-reporter` is **not** present.

---

## Backend endpoint

The extension calls `POST /api/v1/hosts/checkin` at every refresh cycle.

### Authentication

Every request includes the token in the `X-Agent-Token` header:

```
POST /api/v1/hosts/checkin
X-Agent-Token: <AGENT_TOKEN>
Content-Type: application/json
```

The backend validates it against the `AGENT_TOKEN` environment variable. A `401` response means the token is wrong or missing.

### Request body

```json
{
  "hostname": "my-server.example.com",
  "cpu_percent": 12.4,
  "ram_percent": 58.1,
  "disk_percent": 34.2,
  "uptime_seconds": 86400,
  "os_info": "Linux 6.1.0-28-amd64",
  "vscode_sessions": [
    {
      "repo": "/home/user/myproject",
      "vscode_url": "vscode://remote.session-reporter/open?remote=user%40my-server&folder=%2Fhome%2Fuser%2Fmyproject"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `hostname` | string | System hostname (or `hostAlias` if set) |
| `cpu_percent` | float | Overall CPU usage 0–100 |
| `ram_percent` | float | RAM usage 0–100 |
| `disk_percent` | float | Root partition usage 0–100 |
| `uptime_seconds` | float | Seconds since boot |
| `os_info` | string | OS + kernel string |
| `vscode_sessions` | array | Open workspace folders (empty array if none) |

### Response

```json
{ "ok": true }
```

Hosts are **auto-registered** on first checkin — no need to create them manually in the backend.

### Implementing a custom backend

Any HTTP server can receive these payloads. Minimal FastAPI example:

```python
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()
AGENT_TOKEN = "your-secret-token"

class Session(BaseModel):
    repo: str
    vscode_url: str

class Checkin(BaseModel):
    hostname: str
    cpu_percent: float
    ram_percent: float
    disk_percent: float
    uptime_seconds: float
    os_info: str
    vscode_sessions: list[Session] = []

@app.post("/api/v1/hosts/checkin")
def checkin(body: Checkin, x_agent_token: str = Header(...)):
    if x_agent_token != AGENT_TOKEN:
        raise HTTPException(status_code=401)
    # store body.hostname, body.cpu_percent, etc.
    return {"ok": True}
```

---

## Build from source

```bash
cd remote-vitals-vscode
npm install
npm run compile
npm run package   # produces remote-vitals-X.Y.Z.vsix
```

---

## Architecture

```
src/
  extension.ts   — activation, commands, status bar, timer, setup wizard, dashboard push
  collector.ts   — reads /proc/* and df, computes deltas
  webview.ts     — self-contained HTML/CSS/JS panel
```
