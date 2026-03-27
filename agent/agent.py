#!/usr/bin/env python3
"""
Dashboard Host Agent
====================
Lightweight agent that runs on each remote host and reports:
  - CPU / RAM / Disk usage
  - Uptime, OS info

Note: VS Code session reporting is handled exclusively by the
session-reporter VS Code extension — NOT by this agent.

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
import socket
import time
from typing import Any

import psutil
import requests
import yaml

DEFAULT_INTERVAL = 60
CHECKIN_PATH = "/api/v1/hosts/checkin"


# ---------------------------------------------------------------------------
# Metrics collection
# ---------------------------------------------------------------------------

def _collect_metrics() -> dict[str, Any]:
    cpu = psutil.cpu_percent(interval=1, percpu=False)
    cpu_per_core: list[float] = psutil.cpu_percent(interval=0, percpu=True)  # type: ignore[assignment]
    mem = psutil.virtual_memory()
    swap = psutil.swap_memory()
    ram = mem.percent
    disk = psutil.disk_usage("/").percent
    uptime = time.time() - psutil.boot_time()
    os_info = f"{platform.system()} {platform.release()}"
    hostname = socket.gethostname()
    load1, load5, load15 = os.getloadavg() if hasattr(os, "getloadavg") else (0.0, 0.0, 0.0)

    # CPU model
    cpu_model = "unknown"
    cpu_cores = psutil.cpu_count(logical=True) or 1
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if line.startswith("model name"):
                    cpu_model = line.split(":", 1)[1].strip()
                    break
    except OSError:
        pass

    # IP addresses (physical interfaces only)
    _VIRTUAL_PREFIXES = ("docker", "br-", "veth", "virbr", "tun", "tap", "vmnet", "vboxnet", "dummy", "vnet", "lxc", "lxd", "wg", "ham", "lo")
    ips: list[dict[str, str]] = []
    try:
        for iface, addrs in psutil.net_if_addrs().items():
            if iface.lower().startswith(_VIRTUAL_PREFIXES):
                continue
            for a in addrs:
                if a.family in (2, 10) and a.address and not a.address.startswith("127."):  # AF_INET / AF_INET6
                    ips.append({"iface": iface, "ip": a.address, "family": "IPv4" if a.family == 2 else "IPv6"})
    except Exception:
        pass

    # Disks
    skip_fstypes = {
        "tmpfs", "devtmpfs", "sysfs", "proc", "devpts", "cgroup", "cgroup2",
        "pstore", "configfs", "debugfs", "hugetlbfs", "mqueue", "tracefs",
        "securityfs", "fusectl", "bpf", "overlay", "nsfs",
    }
    seen_devices: set[str] = set()
    disks: list[dict[str, Any]] = []
    for part in psutil.disk_partitions(all=False):
        if part.fstype in skip_fstypes:
            continue
        if part.device.startswith("/dev/loop"):
            continue
        if part.device in seen_devices:
            continue
        seen_devices.add(part.device)
        try:
            usage = psutil.disk_usage(part.mountpoint)
            entry: dict[str, Any] = {
                "mountpoint": part.mountpoint,
                "device": part.device,
                "fstype": part.fstype,
                "total_kb": usage.total // 1024,
                "used_kb": usage.used // 1024,
                "avail_kb": usage.free // 1024,
                "usage_percent": usage.percent,
            }
            # Inodes via os.statvfs
            try:
                st = os.statvfs(part.mountpoint)
                if st.f_files > 0:
                    entry["inodes_total"] = st.f_files
                    entry["inodes_used"] = st.f_files - st.f_ffree
                    entry["inodes_free"] = st.f_ffree
                    entry["inodes_percent"] = round((st.f_files - st.f_ffree) / st.f_files * 100, 1)
            except OSError:
                pass
            disks.append(entry)
        except (PermissionError, OSError):
            continue

    # Network
    net: list[dict[str, Any]] = []
    net_io = psutil.net_io_counters(pernic=True)
    for iface, counters in net_io.items():
        if iface == "lo":
            continue
        net.append({
            "name": iface,
            "rx_bytes": counters.bytes_recv,
            "tx_bytes": counters.bytes_sent,
            "rx_rate": 0,
            "tx_rate": 0,
        })

    return {
        "hostname": hostname,
        "cpu_percent": cpu,
        "ram_percent": ram,
        "disk_percent": disk,
        "uptime_seconds": uptime,
        "os_info": os_info,
        "vscode_sessions": [],
        "disks": disks,
        "net": net,
        "mem_total_kb": mem.total // 1024,
        "mem_used_kb": mem.used // 1024,
        "cpu_model": cpu_model,
        "cpu_cores": cpu_cores,
        "cpu_core_usage_json": __import__("json").dumps(cpu_per_core),
        "load_avg_json": __import__("json").dumps([load1, load5, load15]),
        "swap_total_kb": swap.total // 1024,
        "swap_used_kb": swap.used // 1024,
        "ips_json": __import__("json").dumps(ips),
    }


# ---------------------------------------------------------------------------
# Check-in
# ---------------------------------------------------------------------------

def checkin(backend: str, token: str, session: requests.Session, verify_ssl: bool) -> None:
    metrics = _collect_metrics()
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
                  f"RAM {metrics['ram_percent']}%")
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

    if not backend:
        raise SystemExit("ERROR: --backend is required")
    if not token:
        raise SystemExit("ERROR: --token is required")
    if not backend.startswith("https://") and verify_ssl:
        print("WARN: backend is not HTTPS — use --no-verify-ssl only for local dev")

    session = requests.Session()
    print(f"[agent] Starting — backend={backend} interval={interval}s")

    while True:
        checkin(backend, token, session, verify_ssl)
        time.sleep(interval)


if __name__ == "__main__":
    main()
