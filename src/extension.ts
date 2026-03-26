/**
 * Remote Vitals — VS Code Extension
 *
 * extensionKind: workspace  →  runs on the REMOTE host when connected via
 * VS Code Remote SSH.  Reads /proc directly, no agent install required.
 *
 * Commands:
 *   remoteVitals.showPanel   — open the metrics WebView panel
 *   remoteVitals.refresh     — force immediate refresh
 *
 * Optional: pushes metrics to the dashboard backend (same API as agent.py)
 * if remoteVitals.pushToDashboard is enabled.
 */

import * as vscode from "vscode";
import * as https from "https";
import * as http from "http";
import * as crypto from "crypto";

import { MetricsCollector, AllMetrics } from "./collector";
import { getWebviewHtml } from "./webview";

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

let panel: vscode.WebviewPanel | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
const collector = new MetricsCollector();
let log: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  log = vscode.window.createOutputChannel("Remote Vitals");
  context.subscriptions.push(log);
  log.appendLine("[Remote Vitals] activated");

  // ── Status bar item ───────────────────────────────────────────────────────
  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    90
  );
  statusItem.command = "remoteVitals.showPanel";
  statusItem.tooltip = "Open Remote Vitals panel";
  statusItem.show();
  context.subscriptions.push(statusItem);

  // ── Commands ──────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("remoteVitals.showPanel", () => {
      openOrRevealPanel(context);
    }),
    vscode.commands.registerCommand("remoteVitals.refresh", () => {
      doRefresh(statusItem);
    })
  );

  // ── Initial collection & status bar ──────────────────────────────────────
  doRefresh(statusItem);

  // ── Auto-refresh timer ────────────────────────────────────────────────────
  startTimer(statusItem);

  // Restart timer if config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("remoteVitals.refreshInterval")) {
        startTimer(statusItem);
      }
    })
  );
}

export function deactivate(): void {
  stopTimer();
}

// ---------------------------------------------------------------------------
// Panel management
// ---------------------------------------------------------------------------

function openOrRevealPanel(context: vscode.ExtensionContext): void {
  if (panel) {
    panel.reveal();
    return;
  }

  panel = vscode.window.createWebviewPanel(
    "remoteVitals",
    "Remote Vitals",
    vscode.ViewColumn.Two,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    }
  );

  const nonce = crypto.randomBytes(16).toString("hex");
  panel.webview.html = getWebviewHtml(nonce, panel.webview.cspSource);

  // Handle messages sent back from the webview
  panel.webview.onDidReceiveMessage((msg) => {
    if (msg.command === "refresh") {
      vscode.commands.executeCommand("remoteVitals.refresh");
    }
  });

  panel.onDidDispose(() => {
    panel = undefined;
  });

  // Send current metrics if already available
  void pushToPanel();
}

async function pushToPanel(): Promise<void> {
  if (!panel) { return; }
  try {
    const metrics = collector.collectAll();
    panel.webview.postMessage({ command: "update", metrics });
  } catch (err) {
    log.appendLine(`[pushToPanel] error: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Refresh cycle
// ---------------------------------------------------------------------------

function doRefresh(statusItem: vscode.StatusBarItem): void {
  try {
    const metrics = collector.collectAll();
    updateStatusBar(statusItem, metrics);
    if (panel) {
      panel.webview.postMessage({ command: "update", metrics });
    }
    maybePushToDashboard(metrics);
  } catch (err) {
    log.appendLine(`[doRefresh] collection error: ${err}`);
    statusItem.text = "$(pulse) Metrics error";
  }
}

function updateStatusBar(
  item: vscode.StatusBarItem,
  metrics: AllMetrics
): void {
  const cpu = metrics.cpu.usagePercent.toFixed(0);
  const memPct = metrics.mem.usagePercent.toFixed(0);
  item.text = `$(pulse) CPU ${cpu}%  RAM ${memPct}%`;
}

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------

function startTimer(statusItem: vscode.StatusBarItem): void {
  stopTimer();
  const cfg = vscode.workspace.getConfiguration("remoteVitals");
  const intervalSec: number = cfg.get("refreshInterval") ?? 5;
  refreshTimer = setInterval(() => doRefresh(statusItem), intervalSec * 1000);
  log.appendLine(`[timer] refresh every ${intervalSec}s`);
}

function stopTimer(): void {
  if (refreshTimer !== undefined) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}

// ---------------------------------------------------------------------------
// Optional: push to dashboard backend (same checkin route as agent.py)
// ---------------------------------------------------------------------------

function maybePushToDashboard(metrics: AllMetrics): void {
  const cfg = vscode.workspace.getConfiguration("remoteVitals");
  if (!cfg.get<boolean>("pushToDashboard")) { return; }

  const backendUrl: string = cfg.get("backendUrl") ?? "";
  const token: string = cfg.get("agentToken") ?? "";

  if (!backendUrl || !token) { return; }

  const payload = buildCheckinPayload(metrics);
  postJson(backendUrl, "/api/v1/hosts/checkin", token, payload);
}

function buildCheckinPayload(m: AllMetrics): object {
  return {
    hostname: m.host.hostname,
    cpu_percent: m.cpu.usagePercent,
    ram_percent: m.mem.usagePercent,
    ram_used_mb: Math.round(m.mem.usedKb / 1024),
    ram_total_mb: Math.round(m.mem.totalKb / 1024),
    disk_percent: m.disks[0]?.usagePercent ?? 0,
    disk_used_gb: m.disks[0] ? +(m.disks[0].usedKb / 1024 / 1024).toFixed(2) : 0,
    disk_total_gb: m.disks[0] ? +(m.disks[0].totalKb / 1024 / 1024).toFixed(2) : 0,
    uptime_seconds: Math.round(m.host.uptimeSeconds),
    os_info: `${m.host.platform} ${m.host.kernelRelease}`,
    sessions: [],
  };
}

function postJson(
  baseUrl: string,
  path: string,
  token: string,
  body: object
): void {
  try {
    const url = new URL(path, baseUrl);
    const data = Buffer.from(JSON.stringify(body), "utf-8");
    const isHttps = url.protocol === "https:";
    const options: http.RequestOptions = {
      method: "POST",
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": data.length,
        "X-Agent-Token": token,
      },
    };

    const req = (isHttps ? https : http).request(options, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        log.appendLine(`[dashboard push] HTTP ${res.statusCode}`);
      }
    });
    req.on("error", (err) => log.appendLine(`[dashboard push] error: ${err.message}`));
    req.write(data);
    req.end();
  } catch (err) {
    log.appendLine(`[dashboard push] failed: ${err}`);
  }
}
