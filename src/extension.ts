/**
 * Remote Vitals — VS Code Extension
 *
 * extensionKind: workspace  →  runs on the REMOTE host when connected via
 * VS Code Remote SSH.  Reads /proc directly, no agent install required.
 *
 * Provides a live metrics panel (CPU / RAM / Disk / Network) inside VS Code.
 * Optionally reports metrics to a dashboard backend — replacing agent.py for
 * hosts where VS Code Remote SSH is already in use.
 *
 * Commands:
 *   remoteVitals.showPanel   — open the metrics WebView panel
 *   remoteVitals.refresh     — force immediate refresh
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
    }),
    vscode.commands.registerCommand("remoteVitals.configure", () => {
      void runSetupWizard(context);
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

  // Notify when backend push is misconfigured
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("remoteVitals.backendUrl") || e.affectsConfiguration("remoteVitals.agentToken")) {
        validateBackendConfig();
      }
    })
  );
  validateBackendConfig();

  // ── First-run onboarding ──────────────────────────────────────────────────
  void (async () => {
    const setupDone = context.globalState.get<boolean>("setupDone") ?? false;
    const currentUrl: string =
      vscode.workspace.getConfiguration("remoteVitals").get("backendUrl") ?? "";
    if (!setupDone && !currentUrl) {
      const choice = await vscode.window.showInformationMessage(
        "Remote Vitals: configurer le push vers votre dashboard backend?",
        "Configurer",
        "Plus tard"
      );
      if (choice === "Configurer") {
        await runSetupWizard(context);
      } else {
        await context.globalState.update("setupDone", true);
      }
    }
  })();
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
// Session collection — uses VS Code API directly (no /proc scanning needed)
// ---------------------------------------------------------------------------

interface VscodeSession {
  repo: string;
  vscode_url: string;
}

/**
 * Returns the list of open workspace folders in this VS Code window as
 * {repo, vscode_url} objects compatible with the backend HostCheckin schema.
 *
 * The vscode_url uses the session-reporter URI handler so the dashboard can
 * open the workspace in a new window:
 *   vscode://remote.session-reporter/open?remote=HOST&folder=PATH
 *
 * `remote` is resolved in this order:
 *   1. remoteVitals.sshUser + remoteVitals.hostAlias  → "user@alias"
 *   2. remoteVitals.hostAlias                          → "alias"
 *   3. system hostname                                 → fallback
 */
function collectSessions(
  cfg: vscode.WorkspaceConfiguration,
  hostname: string
): VscodeSession[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) { return []; }

  const alias: string = cfg.get("hostAlias") ?? "";
  const sshUser: string = cfg.get("sshUser") ?? "";
  const remote = alias
    ? (sshUser ? `${sshUser}@${alias}` : alias)
    : hostname;

  return folders.map((f) => {
    const folder = f.uri.fsPath;
    const vscode_url =
      `vscode://remote.session-reporter/open` +
      `?remote=${encodeURIComponent(remote)}` +
      `&folder=${encodeURIComponent(folder)}`;
    return { repo: folder, vscode_url };
  });
}

// ---------------------------------------------------------------------------
// Dashboard backend push (replaces agent.py for SSH-connected hosts)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Setup wizard — collects all settings via VS Code input boxes
// ---------------------------------------------------------------------------

async function runSetupWizard(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("remoteVitals");

  const backendUrl = await vscode.window.showInputBox({
    title: "Remote Vitals (1/4) — Backend URL",
    prompt: "URL de votre dashboard backend",
    placeHolder: "https://dashboard.example.com",
    value: cfg.get<string>("backendUrl") ?? "",
    validateInput: (v) => {
      if (!v) { return null; } // empty = disable push
      try { new URL(v); return null; } catch { return "URL invalide"; }
    },
  });
  if (backendUrl === undefined) { return; } // ESC → cancel

  const agentToken = await vscode.window.showInputBox({
    title: "Remote Vitals (2/4) — Agent Token",
    prompt: "Secret token (AGENT_TOKEN du backend). Générer: openssl rand -hex 32",
    placeHolder: "874558ee8c5b...",
    password: true,
    value: cfg.get<string>("agentToken") ?? "",
  });
  if (agentToken === undefined) { return; }

  const hostAlias = await vscode.window.showInputBox({
    title: "Remote Vitals (3/4) — Alias de l'hôte",
    prompt: "Nom d'affichage dans le dashboard (défaut: hostname système)",
    placeHolder: "MiniPC",
    value: cfg.get<string>("hostAlias") ?? "",
  });
  if (hostAlias === undefined) { return; }

  const sshUser = await vscode.window.showInputBox({
    title: "Remote Vitals (4/4) — Utilisateur SSH",
    prompt: "Utilisateur SSH pour les liens du dashboard",
    placeHolder: "root",
    value: cfg.get<string>("sshUser") ?? "",
  });
  if (sshUser === undefined) { return; }

  await cfg.update("backendUrl", backendUrl, vscode.ConfigurationTarget.Global);
  await cfg.update("agentToken", agentToken, vscode.ConfigurationTarget.Global);
  await cfg.update("hostAlias", hostAlias, vscode.ConfigurationTarget.Global);
  await cfg.update("sshUser", sshUser, vscode.ConfigurationTarget.Global);
  await context.globalState.update("setupDone", true);

  if (backendUrl && agentToken) {
    vscode.window.showInformationMessage(
      "Remote Vitals: dashboard push configuré — les métriques seront envoyées au prochain cycle."
    );
  } else {
    vscode.window.showInformationMessage(
      "Remote Vitals: configuration sauvegardée. Dashboard push désactivé (URL ou token manquant)."
    );
  }
}

function validateBackendConfig(): void {
  const cfg = vscode.workspace.getConfiguration("remoteVitals");
  const url: string = cfg.get("backendUrl") ?? "";
  const token: string = cfg.get("agentToken") ?? "";
  if ((url && !token) || (!url && token)) {
    vscode.window.showWarningMessage(
      "Remote Vitals: both 'backendUrl' and 'agentToken' must be set to enable dashboard push."
    );
  }
}

function maybePushToDashboard(metrics: AllMetrics): void {
  const cfg = vscode.workspace.getConfiguration("remoteVitals");
  const backendUrl: string = cfg.get("backendUrl") ?? "";
  const token: string = cfg.get("agentToken") ?? "";
  if (!backendUrl || !token) { return; }

  const payload: object = {
    hostname: metrics.host.hostname,
    cpu_percent: metrics.cpu.usagePercent,
    ram_percent: metrics.mem.usagePercent,
    disk_percent: metrics.disks[0]?.usagePercent ?? 0,
    uptime_seconds: Math.round(metrics.host.uptimeSeconds),
    os_info: `${metrics.host.platform} ${metrics.host.kernelRelease}`,
    vscode_sessions: collectSessions(cfg, metrics.host.hostname),
  };

  try {
    const url = new URL("/api/v1/hosts/checkin", backendUrl);
    const data = Buffer.from(JSON.stringify(payload), "utf-8");
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
        log.appendLine(`[dashboard] HTTP ${res.statusCode}`);
      }
    });
    req.on("error", (err) => log.appendLine(`[dashboard] ${err.message}`));
    req.write(data);
    req.end();
  } catch (err) {
    log.appendLine(`[dashboard] push failed: ${err}`);
  }
}

