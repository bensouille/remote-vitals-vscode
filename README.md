# Remote Vitals

> Live CPU / RAM / Disk / Network metrics from any remote SSH host — **no agent install required.**

A VS Code extension that works as a lightweight alternative to [Glances](https://nicolargo.github.io/glances/) for remote hosts. It runs as a `workspace` extension directly on the remote machine via VS Code Remote SSH, reading `/proc` and `df` — nothing else to deploy.

## Features

- **CPU** — overall usage % + per-core breakdown
- **RAM** — used/available/total + swap
- **Disks** — all physical partitions with usage bars
- **Network** — per-interface real-time RX/TX rates
- **Status bar** — always-visible CPU & RAM at a glance
- **Auto-refresh** — configurable interval (default 5s)
- **Optional dashboard push** — report metrics to the [dashboard](../README.md) backend (same API as `agent.py`) without installing anything extra on the host

## Requirements

- VS Code with [Remote - SSH](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh) extension
- Linux remote host (reads `/proc/stat`, `/proc/meminfo`, `/proc/net/dev`, `/proc/loadavg`)

## Usage

1. Connect to a remote host via VS Code Remote SSH
2. Open the Command Palette → **Remote Vitals: Show Panel**
3. The panel opens in a side column; the status bar shows live CPU/RAM

## Settings

| Setting | Default | Description |
|---|---|---|
| `remoteVitals.refreshInterval` | `5` | Refresh interval in seconds |
| `remoteVitals.pushToDashboard` | `false` | Push metrics to dashboard backend |
| `remoteVitals.backendUrl` | `""` | Dashboard backend URL |
| `remoteVitals.agentToken` | `""` | `AGENT_TOKEN` for the backend |

## Build & Install

```bash
npm install
npm run compile
npm run package   # produces remote-vitals-0.1.0.vsix
```

Install the `.vsix` on the remote host via:

```
Extensions: Install from VSIX...
```

or via CLI:

```bash
code --install-extension remote-vitals-0.1.0.vsix
```

## Architecture

```
src/
  extension.ts   — activation, commands, status bar, timer
  collector.ts   — reads /proc/* and df, computes deltas
  webview.ts     — self-contained HTML/CSS/JS panel
```

The extension is `extensionKind: ["workspace"]` — VS Code automatically runs it on the remote side when you're connected via SSH.
