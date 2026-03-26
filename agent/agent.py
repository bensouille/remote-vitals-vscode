#!/usr/bin/env python3
"""
Dashboard Host Agent
====================
Lightweight agent that runs on each remote host and reports:
  - CPU / RAM / Disk usage
  - Running VS Code sessions (workspace path + VS Code remote URL)
  - Uptime, OS info

Usage:
  python agent.py --backend https://dashboard.example.com \\
                  --token  <AGENT_TOKEN> \\
                  [--interval 60]

Or via config file (agent.yml):
  python agent.py --config agent.yml

Security:
  - Token is sent via X-Agent-Token header (never in URL)
  - HTTPS recommended for production (--backend must be https://)
  - Token should be 32+ random bytes (openssl rand -hex 32)
"""
from __future__ import annotations

import argparse
import os
import platform
import re
import socket
import time
from pathlib import Path
from typing import Any

import psutil
import requests
import yaml

DEFAULT_INTERVAL = 60
CHECKIN_PATH = "/api/v1/hosts/checkin"


# ---------------------------------------------------------------------------
# VS Code session detection
# ---------------------------------------------------------------------------

def _detect_vscode_sessions(hostname: str) -> list[dict[str, str]]:
    """
    Scan running processes for VS Code / code-server instances and extract
    the workspace folder. Returns a list of {repo, vscode_url} dicts.
    """
    sessions: list[dict[str, str]] = []
    seen_repos: set[str] = set()

    try:
        for proc in psutil.process_iter(["pid", "name", "cmdline"]):
            try:
                name = proc.info.get("name", "") or ""
                cmdline = proc.info.get("cmdline") or []

                is_vscode = any(
                    kw in name.lower()
                    for kw in ("code", "code-server", "code-oss")
                )
                if not is_vscode:
                    # Also detect via cmdline
                    cmd_str = " ".join(cmdline)
                    if not any(kw in cmd_str for kw in ("/usr/bin/code", "code-server", ".vscode-server")):
                        continue

                # Extract workspace folder from cmdline
                workspace: str | None = None
                remote_authority: str | None = None  # e.g. "user@my-server"
                for i, arg in enumerate(cmdline):
                    # VS Code passes workspace as last positional arg or --folder-uri
                    if arg == "--folder-uri" and i + 1 < len(cmdline):
                        folder_uri = cmdline[i + 1]
                        # URI looks like "vscode-remote://ssh-remote+user@my-server/home/user/myproject"
                        # Extract the SSH authority (user@host) and the path separately
                        m = re.match(r"vscode-remote://ssh-remote\+([^/]+)(/.*)$", folder_uri)
                        if m:
                            remote_authority = m.group(1)   # "user@my-server"
                            workspace = m.group(2)          # "/home/user/myproject"
                        else:
                            # Fallback: just extract path
                            m2 = re.search(r"/([^\s]+)$", folder_uri)
                            if m2:
                                workspace = "/" + m2.group(1)
                        break
                    if arg == "--extensionHostId":
                        # skip internal workers
                        workspace = None
                        break

                if workspace is None:
                    # Heuristic: last arg that looks like an absolute path
                    for arg in reversed(cmdline):
                        if arg.startswith("/") and Path(arg).exists():
                            workspace = arg
                            break

                if workspace and workspace not in seen_repos:
                    seen_repos.add(workspace)
                    # Use the extracted SSH authority if available (e.g. "user@my-server"),
                    # otherwise fall back to the bare hostname.  The authority must match
                    # exactly what VS Code uses to hash the workspace storage identity.
                    remote = remote_authority or hostname
                    from urllib.parse import quote
                    vscode_url = (
                        f"vscode://remote.session-reporter/open"
                        f"?remote={quote(remote, safe='')}"
                        f"&folder={quote(workspace, safe='')}"
                    )
                    sessions.append({"repo": workspace, "vscode_url": vscode_url})
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
    except Exception:
        pass

    return sessions


# ---------------------------------------------------------------------------
# Metrics collection
# ---------------------------------------------------------------------------

def _collect_metrics(report_sessions: bool = True) -> dict[str, Any]:
    cpu = psutil.cpu_percent(interval=1)
    ram = psutil.virtual_memory().percent
    disk = psutil.disk_usage("/").percent
    uptime = time.time() - psutil.boot_time()
    os_info = f"{platform.system()} {platform.release()}"
    hostname = socket.gethostname()

    sessions = _detect_vscode_sessions(hostname) if report_sessions else []

    return {
        "hostname": hostname,
        "cpu_percent": cpu,
        "ram_percent": ram,
        "disk_percent": disk,
        "uptime_seconds": uptime,
        "os_info": os_info,
        "vscode_sessions": sessions,
    }


# ---------------------------------------------------------------------------
# Check-in
# ---------------------------------------------------------------------------

def checkin(backend: str, token: str, session: requests.Session, verify_ssl: bool, report_sessions: bool = True) -> None:
    metrics = _collect_metrics(report_sessions)
    url = backend.rstrip("/") + CHECKIN_PATH
    try:
        resp = session.post(
            url,
            json=metrics,
            headers={"X-Agent-Token": token},
            timeout=15,
            verify=verify_ssl,
        )
        if resp.status_code != 200:
            print(f"[agent] WARN checkin returned {resp.status_code}: {resp.text[:200]}")
        else:
            print(f"[agent] OK — CPU {metrics['cpu_percent']}% "
                  f"RAM {metrics['ram_percent']}% "
                  f"sessions={len(metrics['vscode_sessions'])}")
    except requests.RequestException as exc:
        print(f"[agent] ERROR — {exc}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Dashboard host agent")
    p.add_argument("--backend", help="Dashboard backend URL (https://...)")
    p.add_argument("--token", help="Agent token (X-Agent-Token)")
    p.add_argument("--interval", type=int, default=DEFAULT_INTERVAL,
                   help=f"Check-in interval in seconds (default: {DEFAULT_INTERVAL})")
    p.add_argument("--config", help="Path to YAML config file")
    p.add_argument("--no-verify-ssl", action="store_true",
                   help="Disable SSL certificate verification (dev only)")
    p.add_argument("--no-report-sessions", action="store_true",
                   help="Do not include VS Code sessions in checkin (use when session-reporter extension is installed)")
    return p.parse_args()


def load_config(path: str) -> dict:
    with open(path) as f:
        return yaml.safe_load(f) or {}


def main() -> None:
    args = parse_args()

    cfg: dict[str, Any] = {}
    if args.config:
        cfg = load_config(args.config)

    backend: str = args.backend or cfg.get("backend") or os.environ.get("DASHBOARD_BACKEND", "")
    token: str = args.token or cfg.get("token") or os.environ.get("AGENT_TOKEN", "")
    interval: int = args.interval or cfg.get("interval", DEFAULT_INTERVAL)
    verify_ssl: bool = not (args.no_verify_ssl or cfg.get("no_verify_ssl", False))
    report_sessions: bool = not (args.no_report_sessions or cfg.get("no_report_sessions", False))

    if not backend:
        raise SystemExit("ERROR: --backend is required")
    if not token:
        raise SystemExit("ERROR: --token is required")
    if not backend.startswith("https://") and verify_ssl:
        print("WARN: backend is not HTTPS — use --no-verify-ssl only for local dev")

    session = requests.Session()
    print(f"[agent] Starting — backend={backend} interval={interval}s")

    while True:
        checkin(backend, token, session, verify_ssl, report_sessions)
        time.sleep(interval)


if __name__ == "__main__":
    main()
