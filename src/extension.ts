/**
 * Remote Vitals — VS Code Extension
 *
 * extensionKind: workspace  →  runs on the REMOTE host when connected via
 * VS Code Remote SSH.  Reads /proc directly, no agent install required.
 *
 * Provides a live metrics panel (CPU / RAM / Disk / Network) inside VS Code.
 * For persistent reporting to a dashboard backend, use agent/agent.py instead.
 *
 * Commands:
 *   remoteVitals.showPanel   — open the metrics WebView panel
 *   remoteVitals.refresh     — force immediate refresh
 */

import * as vscode from "vscode";
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

