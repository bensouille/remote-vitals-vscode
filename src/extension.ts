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
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as cp from "child_process";

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
    }),
    vscode.commands.registerCommand("remoteVitals.checkForUpdates", () => {
      void checkForUpdates(context, true);
    }),
    vscode.commands.registerCommand("remoteVitals.installAgent", () => {
      void installAgent(context);
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
    const cfg = vscode.workspace.getConfiguration("remoteVitals");
    const currentUrl: string = cfg.get("backendUrl") ?? "";
    const currentToken: string = cfg.get("agentToken") ?? "";

    if (!setupDone && !currentUrl) {
      // Not yet configured — offer the setup wizard
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

    // Always check agent install independently of the wizard
    // (covers: manual settings config, setupDone=true but agent missing)
    const latestUrl: string = vscode.workspace.getConfiguration("remoteVitals").get("backendUrl") ?? "";
    const latestToken: string = vscode.workspace.getConfiguration("remoteVitals").get("agentToken") ?? "";
    if (latestUrl && latestToken) {
      const AGENT_INSTALL_STAMP = `${AGENT_INSTALL_DIR};${AGENT_SERVICE}`;
      const installedStamp = context.globalState.get<string>("agentInstalledStamp") ?? "";
      if (installedStamp !== AGENT_INSTALL_STAMP) {
        try {
          await installAgent(context);
        } catch (err) {
          log.appendLine(`[agent-install] FAILED: ${err}`);
          vscode.window.showErrorMessage(
            `Remote Vitals: échec de l'installation de l'agent — ${err}. ` +
            `Vérifiez l'Output "Remote Vitals".`
          );
        }
      }
    }
  })();

  // ── Auto update check (once per day) ─────────────────────────────────────
  void checkForUpdates(context, false);
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
    // Auto-install the background agent so metrics keep flowing when VS Code is closed
    await installAgent(context, backendUrl, agentToken);
  } else {
    vscode.window.showInformationMessage(
      "Remote Vitals: configuration sauvegardée. Dashboard push désactivé (URL ou token manquant)."
    );
  }
}

// ---------------------------------------------------------------------------
// Background agent installer
// ---------------------------------------------------------------------------

const AGENT_REPO_URL = "https://raw.githubusercontent.com/bensouille/remote-vitals-vscode/main/agent";
const AGENT_INSTALL_DIR = `${os.homedir()}/.local/vitals-agent`;
const AGENT_SERVICE = "vitals-agent";

async function installAgent(
  context: vscode.ExtensionContext,
  backendUrl?: string,
  agentToken?: string
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("remoteVitals");
  const url = backendUrl ?? (cfg.get<string>("backendUrl") ?? "");
  const token = agentToken ?? (cfg.get<string>("agentToken") ?? "");

  if (!url || !token) {
    vscode.window.showErrorMessage(
      "Remote Vitals: backendUrl et agentToken doivent être configurés avant d'installer l'agent."
    );
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Remote Vitals: installation de l'agent de fond…",
      cancellable: false,
    },
    async (progress) => {
      const xdgRuntimeDir = `/run/user/${process.getuid?.() ?? 0}`;
      const run = (cmd: string): Promise<string> =>
        new Promise((resolve, reject) =>
          cp.exec(
            cmd,
            { env: { ...process.env, XDG_RUNTIME_DIR: xdgRuntimeDir } },
            (err, stdout, stderr) => {
              if (err) { reject(new Error(stderr || err.message)); } else { resolve(stdout.trim()); }
            }
          )
        );

      progress.report({ message: "Téléchargement des fichiers…" });
      await run(`mkdir -p "${AGENT_INSTALL_DIR}"`);
      for (const f of ["agent.py", "requirements.txt"]) {
        await run(`curl -fsSL "${AGENT_REPO_URL}/${f}" -o "${AGENT_INSTALL_DIR}/${f}"`);
      }

      progress.report({ message: "Création de l'environnement Python…" });
      await run(`python3 -m venv "${AGENT_INSTALL_DIR}/venv"`);
      await run(`"${AGENT_INSTALL_DIR}/venv/bin/pip" install -q -r "${AGENT_INSTALL_DIR}/requirements.txt"`);

      progress.report({ message: "Écriture de la configuration…" });
      const yml = [
        `backend: ${url}`,
        `token: ${token}`,
        `interval: 60`,
        `no_report_sessions: true`,
      ].join("\n") + "\n";
      fs.writeFileSync(path.join(AGENT_INSTALL_DIR, "agent.yml"), yml, "utf-8");

      progress.report({ message: "Configuration du service systemd…" });
      const unitDir = path.join(os.homedir(), ".config", "systemd", "user");
      await run(`mkdir -p "${unitDir}"`);
      const unit = [
        "[Unit]",
        "Description=Remote Vitals Host Agent",
        "After=network.target",
        "",
        "[Service]",
        "Type=simple",
        `ExecStart=${AGENT_INSTALL_DIR}/venv/bin/python ${AGENT_INSTALL_DIR}/agent.py --config ${AGENT_INSTALL_DIR}/agent.yml`,
        "Restart=always",
        "RestartSec=30",
        "Environment=PYTHONUNBUFFERED=1",
        "",
        "[Install]",
        "WantedBy=default.target",
      ].join("\n") + "\n";
      fs.writeFileSync(path.join(unitDir, `${AGENT_SERVICE}.service`), unit, "utf-8");

      progress.report({ message: "Activation du service…" });
      await run("loginctl enable-linger");
      await run("systemctl --user daemon-reload");
      await run(`systemctl --user enable --now "${AGENT_SERVICE}"`);

      log.appendLine("[agent-install] done");
    }
  );

  await context.globalState.update("agentInstalledStamp", `${AGENT_INSTALL_DIR};${AGENT_SERVICE}`);
  await context.globalState.update("agentInstalled", true); // legacy compat
  vscode.window.showInformationMessage(
    "Remote Vitals: agent de fond installé et démarré. Les métriques seront envoyées même quand VS Code est fermé."
  );
}

// ---------------------------------------------------------------------------
// Auto-update — checks GitHub releases, downloads and installs new VSIX
// ---------------------------------------------------------------------------

const GITHUB_RELEASES_URL =
  "https://api.github.com/repos/bensouille/remote-vitals-vscode/releases/latest";

function httpsGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const options = new URL(url);
    https.get(
      {
        hostname: options.hostname,
        path: options.pathname + options.search,
        headers: {
          "User-Agent": "remote-vitals-vscode",
          "Accept": "application/vnd.github+json",
        },
      },
      (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          resolve(httpsGet(res.headers.location!));
          return;
        }
        if (res.statusCode === 403 || res.statusCode === 429) {
          reject(new Error(`GitHub API rate limit (HTTP ${res.statusCode})`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        res.on("error", reject);
      }
    ).on("error", reject);
  });
}

function httpsDownload(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const follow = (u: string) => {
      const parsed = new URL(u);
      const mod = parsed.protocol === "https:" ? https : http;
      mod.get(
        { hostname: parsed.hostname, port: parsed.port || (parsed.protocol === "https:" ? 443 : 80), path: parsed.pathname + parsed.search, headers: { "User-Agent": "remote-vitals-vscode" } },
        (res) => {
          if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
            follow(res.headers.location);
            return;
          }
          const out = fs.createWriteStream(dest);
          res.pipe(out);
          out.on("finish", () => resolve());
          out.on("error", reject);
        }
      ).on("error", reject);
    };
    follow(url);
  });
}

function semverGt(a: string, b: string): boolean {
  const parse = (s: string) => s.replace(/^v/, "").split(".").map(Number);
  const [a1, a2, a3] = parse(a);
  const [b1, b2, b3] = parse(b);
  if (a1 !== b1) { return a1 > b1; }
  if (a2 !== b2) { return a2 > b2; }
  return a3 > b3;
}

async function checkForUpdates(
  context: vscode.ExtensionContext,
  manual: boolean
): Promise<void> {
  // Rate-limit: once per 6 hours (unless manual)
  if (!manual) {
    const lastCheck = context.globalState.get<number>("lastUpdateCheck") ?? 0;
    if (Date.now() - lastCheck < 6 * 60 * 60 * 1000) { return; }
  } else {
    // Manual check: reset rate-limit so next automatic check also fires
    await context.globalState.update("lastUpdateCheck", 0);
  }

  try {
    log.appendLine("[update] checking GitHub releases…");
    const body = await httpsGet(GITHUB_RELEASES_URL);
    const release = JSON.parse(body) as { tag_name?: string; assets?: { name: string; browser_download_url: string }[] };
    const latest = release.tag_name;
    if (!latest) {
      log.appendLine(`[update] unexpected GitHub response (no tag_name): ${body.slice(0, 300)}`);
      if (manual) {
        vscode.window.showErrorMessage(`Remote Vitals: réponse GitHub inattendue — voir Output > Remote Vitals`);
      }
      return;
    }
    // API responded successfully — update rate-limit timestamp
    await context.globalState.update("lastUpdateCheck", Date.now());
    const current: string = context.extension.packageJSON.version as string;

    if (!semverGt(latest, `v${current}`)) {
      log.appendLine(`[update] up to date (${current})`);
      if (manual) {
        vscode.window.showInformationMessage(`Remote Vitals est à jour (v${current})`);
      }
      return;
    }

    const asset = (release.assets ?? []).find((a) => a.name.endsWith(".vsix"));
    if (!asset) {
      log.appendLine("[update] no VSIX asset found");
      return;
    }

    const choice = await vscode.window.showInformationMessage(
      `Remote Vitals: nouvelle version disponible (${latest}). Mettre à jour ?`,
      "Mettre à jour",
      "Plus tard"
    );
    if (choice !== "Mettre à jour") { return; }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Remote Vitals: téléchargement ${latest}…`, cancellable: false },
      async () => {
        const vsixPath = path.join(os.tmpdir(), asset.name);
        await httpsDownload(asset.browser_download_url, vsixPath);
        log.appendLine(`[update] downloaded to ${vsixPath}, installing…`);
        await new Promise<void>((resolve, reject) => {
          cp.exec(`code --install-extension "${vsixPath}"`, (err, stdout) => {
            if (err) { reject(err); } else { log.appendLine(`[update] ${stdout.trim()}`); resolve(); }
          });
        });
        fs.unlink(vsixPath, () => {});
      }
    );

    const reload = await vscode.window.showInformationMessage(
      `Remote Vitals ${latest} installé. Recharger la fenêtre ?`,
      "Recharger"
    );
    if (reload === "Recharger") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  } catch (err) {
    log.appendLine(`[update] error: ${err}`);
    if (manual) {
      vscode.window.showErrorMessage(`Remote Vitals: erreur lors de la vérification des mises à jour — ${err}`);
    }
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
    vscode_sessions: [],
    mem_total_kb: metrics.mem.totalKb,
    mem_used_kb: metrics.mem.usedKb,
    cpu_model: metrics.host.cpuModelName,
    cpu_cores: metrics.host.cpuCores,
    cpu_core_usage_json: JSON.stringify(metrics.cpu.coreUsage),
    load_avg_json: JSON.stringify([metrics.host.loadAvg1, metrics.host.loadAvg5, metrics.host.loadAvg15]),
    swap_total_kb: metrics.mem.swapTotalKb,
    swap_used_kb: metrics.mem.swapUsedKb,
    ips_json: JSON.stringify(metrics.ips),
    disks: metrics.disks.map((d) => ({
      mountpoint: d.mountpoint,
      device: d.device,
      fstype: d.fstype,
      total_kb: d.totalKb,
      used_kb: d.usedKb,
      avail_kb: d.availKb,
      usage_percent: d.usagePercent,
      inodes_total: d.inodesTotal,
      inodes_used: d.inodesUsed,
      inodes_free: d.inodesFree,
      inodes_percent: d.inodesPercent,
    })),
    net: metrics.net.map((n) => ({
      name: n.name,
      rx_bytes: n.rxBytes,
      tx_bytes: n.txBytes,
      rx_rate: n.rxRate,
      tx_rate: n.txRate,
    })),
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

