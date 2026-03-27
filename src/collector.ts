/**
 * MetricsCollector — reads system metrics directly from Linux /proc
 * No external agent or SSH required; runs on the remote host as a
 * VS Code Workspace extension.
 */

import * as fs from "fs";
import * as os from "os";
import { execSync } from "child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CpuStats {
  /** Overall CPU usage percentage (0–100) */
  usagePercent: number;
  /** Per-core usage percentages */
  coreUsage: number[];
}

export interface MemStats {
  totalKb: number;
  availableKb: number;
  usedKb: number;
  /** Usage 0–100 */
  usagePercent: number;
  swapTotalKb: number;
  swapUsedKb: number;
  swapPercent: number;
}

export interface DiskPartition {
  mountpoint: string;
  device: string;
  fstype: string;
  totalKb: number;
  usedKb: number;
  availKb: number;
  /** Usage 0–100 */
  usagePercent: number;
  inodesTotal?: number;
  inodesUsed?: number;
  inodesFree?: number;
  inodesPercent?: number;
}

export interface NetInterface {
  name: string;
  rxBytes: number;
  txBytes: number;
  /** Bytes/s since last sample */
  rxRate: number;
  txRate: number;
}

export interface IpAddress {
  iface: string;
  ip: string;
  family: 'IPv4' | 'IPv6';
}

export interface HostInfo {
  hostname: string;
  platform: string;
  kernelRelease: string;
  uptimeSeconds: number;
  loadAvg1: number;
  loadAvg5: number;
  loadAvg15: number;
  cpuModelName: string;
  cpuCores: number;
}

export interface AllMetrics {
  timestamp: number;
  host: HostInfo;
  cpu: CpuStats;
  mem: MemStats;
  disks: DiskPartition[];
  net: NetInterface[];
  ips: IpAddress[];
}

// ---------------------------------------------------------------------------
// CPU helpers — uses two samples to compute delta
// ---------------------------------------------------------------------------

interface RawCpuLine {
  label: string;
  user: number;
  nice: number;
  system: number;
  idle: number;
  iowait: number;
  irq: number;
  softirq: number;
  total: number;
  active: number;
}

function parseProcStat(): RawCpuLine[] {
  const content = fs.readFileSync("/proc/stat", "utf-8");
  const lines: RawCpuLine[] = [];

  for (const line of content.split("\n")) {
    if (!line.startsWith("cpu")) { break; }
    const parts = line.split(/\s+/);
    const label = parts[0];
    const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0] = parts
      .slice(1, 8)
      .map(Number);
    const total = user + nice + system + idle + iowait + irq + softirq;
    const active = total - idle - iowait;
    lines.push({ label, user, nice, system, idle, iowait, irq, softirq, total, active });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// MetricsCollector
// ---------------------------------------------------------------------------

export class MetricsCollector {
  private prevCpuSample: RawCpuLine[] = [];
  private prevNetSample: Map<string, { rx: number; tx: number; ts: number }> = new Map();

  // ── CPU ───────────────────────────────────────────────────────────────────

  collectCpu(): CpuStats {
    const current = parseProcStat();
    const result: CpuStats = { usagePercent: 0, coreUsage: [] };

    if (this.prevCpuSample.length === 0) {
      // First call — no delta yet; return zeros
      this.prevCpuSample = current;
      return result;
    }

    for (let i = 0; i < current.length; i++) {
      const prev = this.prevCpuSample[i];
      if (!prev) { continue; }

      const deltaTotal = current[i].total - prev.total;
      const deltaActive = current[i].active - prev.active;
      const pct = deltaTotal > 0 ? Math.round((deltaActive / deltaTotal) * 1000) / 10 : 0;

      if (i === 0) {
        result.usagePercent = pct;
      } else {
        result.coreUsage.push(pct);
      }
    }

    this.prevCpuSample = current;
    return result;
  }

  // ── Memory ────────────────────────────────────────────────────────────────

  collectMem(): MemStats {
    const content = fs.readFileSync("/proc/meminfo", "utf-8");
    const map: Record<string, number> = {};

    for (const line of content.split("\n")) {
      const m = line.match(/^(\w+):\s+(\d+)/);
      if (m) { map[m[1]] = parseInt(m[2], 10); }
    }

    const total = map["MemTotal"] ?? 0;
    const available = map["MemAvailable"] ?? 0;
    const used = total - available;
    const swapTotal = map["SwapTotal"] ?? 0;
    const swapFree = map["SwapFree"] ?? 0;
    const swapUsed = swapTotal - swapFree;

    return {
      totalKb: total,
      availableKb: available,
      usedKb: used,
      usagePercent: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
      swapTotalKb: swapTotal,
      swapUsedKb: swapUsed,
      swapPercent: swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 1000) / 10 : 0,
    };
  }

  // ── Disk ──────────────────────────────────────────────────────────────────

  collectDisks(): DiskPartition[] {
    const partitions: DiskPartition[] = [];

    const skipTypes = new Set([
      "tmpfs", "devtmpfs", "sysfs", "proc", "devpts", "cgroup",
      "cgroup2", "pstore", "configfs", "debugfs", "hugetlbfs",
      "mqueue", "tracefs", "securityfs", "fusectl", "bpf",
      "overlay", "nsfs",
    ]);

    // Try GNU `df -Tk` (Filesystem Type 1K-blocks Used Available Use% Mounted)
    // Fall back to POSIX `df -Pk` (no Type column) for BusyBox / Alpine / old coreutils.
    let raw = "";
    let hasType = true;
    try {
      raw = execSync("df -Tk 2>/dev/null", { timeout: 5000, encoding: "utf-8" });
    } catch {
      try {
        raw = execSync("df -Pk 2>/dev/null", { timeout: 5000, encoding: "utf-8" });
        hasType = false;
      } catch {
        return partitions; // df not available at all
      }
    }

    for (const line of raw.split("\n").slice(1)) {
      if (!line.trim()) { continue; }
      const cols = line.trim().split(/\s+/);

      let device: string, fstype: string, sizeKb: string, usedKb: string, availKb: string, pctStr: string, mountpoint: string;
      if (hasType) {
        // 7 cols: Filesystem Type 1K-blocks Used Available Use% Mounted
        if (cols.length < 7) { continue; }
        [device, fstype, sizeKb, usedKb, availKb, pctStr, mountpoint] = cols as [string, string, string, string, string, string, string];
        if (skipTypes.has(fstype)) { continue; }
      } else {
        // 6 cols: Filesystem 1K-blocks Used Available Use% Mounted
        if (cols.length < 6) { continue; }
        [device, sizeKb, usedKb, availKb, pctStr, mountpoint] = cols as [string, string, string, string, string, string];
        fstype = "unknown";
        // Without fstype, keep only real block devices
        if (!device.startsWith("/dev/")) { continue; }
      }

      if (device.startsWith("/dev/loop")) { continue; }

      const usagePct = parseInt(pctStr, 10);
      partitions.push({
        mountpoint,
        device,
        fstype,
        totalKb: parseInt(sizeKb, 10),
        usedKb: parseInt(usedKb, 10),
        availKb: parseInt(availKb, 10),
        usagePercent: isNaN(usagePct) ? 0 : usagePct,
      });
    }

    // Enrich with inode usage via df -i
    try {
      const rawI = execSync("df -Pki 2>/dev/null", { timeout: 5000, encoding: "utf-8" });
      for (const line of rawI.split("\n").slice(1)) {
        if (!line.trim()) { continue; }
        const cols = line.trim().split(/\s+/);
        // Filesystem Inodes IUsed IFree IUse% Mounted
        if (cols.length < 6) { continue; }
        const mnt = cols[cols.length - 1];
        const part = partitions.find((p) => p.mountpoint === mnt);
        if (!part) { continue; }
        const inodesTotal = parseInt(cols[1], 10);
        const inodesUsed = parseInt(cols[2], 10);
        const inodesFree = parseInt(cols[3], 10);
        const inodesPct = parseInt(cols[4], 10);
        if (!isNaN(inodesTotal) && inodesTotal > 0) {
          part.inodesTotal = inodesTotal;
          part.inodesUsed = inodesUsed;
          part.inodesFree = inodesFree;
          part.inodesPercent = isNaN(inodesPct) ? 0 : inodesPct;
        }
      }
    } catch { /* df -i not available */ }

    return partitions;
  }

  // ── Network ───────────────────────────────────────────────────────────────

  collectNet(): NetInterface[] {
    const interfaces: NetInterface[] = [];
    try {
      const content = fs.readFileSync("/proc/net/dev", "utf-8");
      const now = Date.now();

      for (const line of content.split("\n").slice(2)) {
        if (!line.trim()) { continue; }
        const m = line.match(/^\s*(\S+):\s+([\d\s]+)$/);
        if (!m) { continue; }

        const name = m[1];
        if (name === "lo") { continue; } // skip loopback

        const fields = m[2].trim().split(/\s+/).map(Number);
        const rxBytes = fields[0];
        const txBytes = fields[8];

        const prev = this.prevNetSample.get(name);
        let rxRate = 0;
        let txRate = 0;

        if (prev) {
          const dtMs = now - prev.ts;
          if (dtMs > 0) {
            rxRate = Math.round(((rxBytes - prev.rx) / dtMs) * 1000);
            txRate = Math.round(((txBytes - prev.tx) / dtMs) * 1000);
          }
        }

        this.prevNetSample.set(name, { rx: rxBytes, tx: txBytes, ts: now });
        interfaces.push({ name, rxBytes, txBytes, rxRate, txRate });
      }
    } catch {
      // /proc/net/dev not available
    }
    return interfaces;
  }

  // ── Host info ─────────────────────────────────────────────────────────────

  collectHost(): HostInfo {
    let kernelRelease = "unknown";
    try {
      kernelRelease = execSync("uname -r", { timeout: 3000, encoding: "utf-8" }).trim();
    } catch { /* ignore */ }

    let cpuModelName = "unknown";
    let cpuCores = os.cpus().length;
    try {
      const cpuinfo = fs.readFileSync("/proc/cpuinfo", "utf-8");
      const modelLineMatch = cpuinfo.match(/^model name\s*:\s*(.+)$/m);
      if (modelLineMatch) { cpuModelName = modelLineMatch[1].trim(); }
      const coreCount = (cpuinfo.match(/^processor\s*:/gm) ?? []).length;
      if (coreCount > 0) { cpuCores = coreCount; }
    } catch { /* ignore */ }

    let loadAvg1 = 0, loadAvg5 = 0, loadAvg15 = 0;
    try {
      const loadLine = fs.readFileSync("/proc/loadavg", "utf-8");
      const parts = loadLine.trim().split(/\s+/);
      loadAvg1 = parseFloat(parts[0]);
      loadAvg5 = parseFloat(parts[1]);
      loadAvg15 = parseFloat(parts[2]);
    } catch { /* ignore */ }

    let uptimeSeconds = os.uptime();
    try {
      const uptimeLine = fs.readFileSync("/proc/uptime", "utf-8");
      uptimeSeconds = parseFloat(uptimeLine.split(" ")[0]);
    } catch { /* ignore */ }

    return {
      hostname: os.hostname(),
      platform: os.platform(),
      kernelRelease,
      uptimeSeconds,
      loadAvg1,
      loadAvg5,
      loadAvg15,
      cpuModelName,
      cpuCores,
    };
  }

  // ── IP addresses ─────────────────────────────────────────────────────────

  collectIps(): IpAddress[] {
    const VIRTUAL_PREFIXES = ['docker', 'br-', 'veth', 'virbr', 'tun', 'tap', 'vmnet', 'vboxnet', 'dummy', 'vnet', 'lxc', 'lxd', 'wg', 'ham'];
    const result: IpAddress[] = [];
    const ifaces = os.networkInterfaces();
    for (const [name, addrs] of Object.entries(ifaces)) {
      if (!addrs) { continue; }
      if (VIRTUAL_PREFIXES.some(p => name.toLowerCase().startsWith(p))) { continue; }
      for (const a of addrs) {
        if (a.internal) { continue; }
        result.push({
          iface: name,
          ip: a.address,
          family: a.family as 'IPv4' | 'IPv6',
        });
      }
    }
    return result;
  }

  // ── Collect all ───────────────────────────────────────────────────────────

  collectAll(): AllMetrics {
    return {
      timestamp: Date.now(),
      host: this.collectHost(),
      cpu: this.collectCpu(),
      mem: this.collectMem(),
      disks: this.collectDisks(),
      net: this.collectNet(),
      ips: this.collectIps(),
    };
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers (shared between extension and webview message)
// ---------------------------------------------------------------------------

export function formatBytes(kb: number, decimals = 1): string {
  if (kb < 1024) { return `${kb} KB`; }
  if (kb < 1024 * 1024) { return `${(kb / 1024).toFixed(decimals)} MB`; }
  return `${(kb / 1024 / 1024).toFixed(decimals)} GB`;
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) { parts.push(`${d}d`); }
  if (h > 0) { parts.push(`${h}h`); }
  parts.push(`${m}m`);
  return parts.join(" ");
}

export function formatNetRate(bytesPerSec: number): string {
  if (bytesPerSec < 1024) { return `${bytesPerSec} B/s`; }
  if (bytesPerSec < 1024 * 1024) { return `${(bytesPerSec / 1024).toFixed(1)} KB/s`; }
  return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`; 
}
