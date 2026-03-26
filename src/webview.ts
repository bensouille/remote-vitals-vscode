/**
 * WebView HTML generator for the Host Metrics panel.
 * Returns a full HTML document that receives AllMetrics via postMessage.
 */

import type { AllMetrics } from "./collector";

export function getWebviewHtml(nonce: string, cspSource: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Host Metrics</title>
  <style nonce="${nonce}">
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-editor-foreground, #d4d4d4);
      --card-bg: var(--vscode-sideBar-background, #252526);
      --border: var(--vscode-widget-border, #3c3c3c);
      --accent: var(--vscode-focusBorder, #007acc);
      --green: #4ec94e;
      --yellow: #e5c07b;
      --orange: #d19a66;
      --red: #e06c75;
      --muted: var(--vscode-descriptionForeground, #858585);
      --font: var(--vscode-font-family, 'Segoe UI', sans-serif);
      --mono: var(--vscode-editor-font-family, 'Courier New', monospace);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--font);
      font-size: 13px;
      background: var(--bg);
      color: var(--fg);
      padding: 12px;
      line-height: 1.45;
    }

    header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 14px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--border);
    }
    header h1 {
      font-size: 15px;
      font-weight: 600;
    }
    header small {
      color: var(--muted);
      font-size: 11px;
    }
    #refresh-btn {
      margin-left: auto;
      background: none;
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--fg);
      cursor: pointer;
      padding: 3px 8px;
      font-size: 12px;
    }
    #refresh-btn:hover { border-color: var(--accent); color: var(--accent); }

    section { margin-bottom: 14px; }
    .section-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--muted);
      margin-bottom: 6px;
    }

    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 12px;
    }
    .card + .card { margin-top: 6px; }

    /* ── Loading ── */
    #loading {
      text-align: center;
      padding: 40px 0;
      color: var(--muted);
    }
    #content { display: none; }

    /* ── Host info strip ── */
    .host-strip {
      display: flex;
      flex-wrap: wrap;
      gap: 12px 20px;
    }
    .kv { display: flex; flex-direction: column; }
    .kv-label { font-size: 10px; color: var(--muted); text-transform: uppercase; }
    .kv-value { font-size: 13px; font-family: var(--mono); }

    /* ── Gauge bar ── */
    .gauge-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 4px 0;
    }
    .gauge-label {
      width: 48px;
      font-size: 11px;
      color: var(--muted);
      flex-shrink: 0;
    }
    .gauge-track {
      flex: 1;
      height: 8px;
      background: var(--border);
      border-radius: 4px;
      overflow: hidden;
    }
    .gauge-fill {
      height: 100%;
      border-radius: 4px;
      transition: width 0.4s ease;
    }
    .gauge-pct {
      width: 38px;
      text-align: right;
      font-family: var(--mono);
      font-size: 12px;
    }

    /* ── CPU cores mini grid ── */
    .cores-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 8px;
    }
    .core-cell {
      width: 36px;
      text-align: center;
      font-size: 10px;
      font-family: var(--mono);
      padding: 3px 2px;
      border-radius: 3px;
      border: 1px solid var(--border);
      background: var(--bg);
    }

    /* ── Disk table ── */
    .disk-item {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 2px 8px;
      align-items: center;
      padding: 6px 0;
      border-bottom: 1px solid var(--border);
    }
    .disk-item:last-child { border-bottom: none; padding-bottom: 0; }
    .disk-mount { font-family: var(--mono); font-size: 12px; }
    .disk-size { font-size: 11px; color: var(--muted); text-align: right; }
    .disk-bar { grid-column: 1 / -1; }

    /* ── Net ── */
    .net-row {
      display: grid;
      grid-template-columns: 80px 1fr 1fr;
      gap: 4px;
      padding: 4px 0;
      border-bottom: 1px solid var(--border);
      align-items: center;
    }
    .net-row:last-child { border-bottom: none; }
    .net-iface { font-family: var(--mono); font-size: 12px; }
    .net-rate { font-size: 11px; text-align: right; }

    /* ── Colour helpers ── */
    .c-green  { color: var(--green); }
    .c-yellow { color: var(--yellow); }
    .c-orange { color: var(--orange); }
    .c-red    { color: var(--red); }

    .ts { font-size: 10px; color: var(--muted); text-align: right; margin-top: 4px; }
  </style>
</head>
<body>

<div id="loading">Waiting for metrics…</div>

<div id="content">
  <header>
    <span>🖥</span>
    <h1 id="hdr-hostname">Host</h1>
    <small id="hdr-kernel"></small>
    <button id="refresh-btn" onclick="vscodeApi.postMessage({ command: 'refresh' })">⟳ Refresh</button>
  </header>

  <!-- Host info -->
  <section>
    <div class="section-title">System</div>
    <div class="card">
      <div class="host-strip" id="host-strip"></div>
    </div>
  </section>

  <!-- CPU -->
  <section>
    <div class="section-title">CPU</div>
    <div class="card" id="cpu-card">
      <div class="gauge-row">
        <span class="gauge-label">Overall</span>
        <div class="gauge-track"><div class="gauge-fill" id="cpu-overall-bar"></div></div>
        <span class="gauge-pct" id="cpu-overall-pct">—</span>
      </div>
      <div class="cores-grid" id="cpu-cores"></div>
    </div>
  </section>

  <!-- Memory -->
  <section>
    <div class="section-title">Memory</div>
    <div class="card">
      <div class="gauge-row">
        <span class="gauge-label">RAM</span>
        <div class="gauge-track"><div class="gauge-fill" id="mem-bar"></div></div>
        <span class="gauge-pct" id="mem-pct">—</span>
      </div>
      <div class="gauge-row" id="swap-row">
        <span class="gauge-label">Swap</span>
        <div class="gauge-track"><div class="gauge-fill" id="swap-bar"></div></div>
        <span class="gauge-pct" id="swap-pct">—</span>
      </div>
      <div id="mem-detail" style="margin-top:6px;font-size:11px;color:var(--muted)"></div>
    </div>
  </section>

  <!-- Disks -->
  <section>
    <div class="section-title">Disks</div>
    <div class="card" id="disk-card"></div>
  </section>

  <!-- Network -->
  <section>
    <div class="section-title">Network</div>
    <div class="card" id="net-card">
      <div class="net-row" style="font-size:10px;color:var(--muted);font-weight:700;">
        <span>Interface</span><span style="text-align:right">▼ Download</span><span style="text-align:right">▲ Upload</span>
      </div>
      <div id="net-rows"></div>
    </div>
  </section>

  <div class="ts" id="ts"></div>
</div>

<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();

  // ── colour for a percentage ──────────────────────────────────────────────
  function colourClass(pct) {
    if (pct < 60) return 'c-green';
    if (pct < 75) return 'c-yellow';
    if (pct < 90) return 'c-orange';
    return 'c-red';
  }
  function barColour(pct) {
    if (pct < 60) return 'var(--green)';
    if (pct < 75) return 'var(--yellow)';
    if (pct < 90) return 'var(--orange)';
    return 'var(--red)';
  }

  // ── gauge fill helper ────────────────────────────────────────────────────
  function setGauge(fillId, pct) {
    const el = document.getElementById(fillId);
    if (!el) return;
    el.style.width = Math.min(pct, 100) + '%';
    el.style.background = barColour(pct);
  }

  // ── format bytes (KB input) ──────────────────────────────────────────────
  function fmtKb(kb, dec = 1) {
    if (kb < 1024) return kb + ' KB';
    if (kb < 1024 * 1024) return (kb / 1024).toFixed(dec) + ' MB';
    return (kb / 1024 / 1024).toFixed(dec) + ' GB';
  }
  function fmtRate(bps) {
    if (bps < 1024) return bps + ' B/s';
    if (bps < 1024 * 1024) return (bps / 1024).toFixed(1) + ' KB/s';
    return (bps / 1024 / 1024).toFixed(1) + ' MB/s';
  }
  function fmtUptime(s) {
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const parts = [];
    if (d > 0) parts.push(d + 'd');
    if (h > 0) parts.push(h + 'h');
    parts.push(m + 'm');
    return parts.join(' ');
  }

  // ── render ───────────────────────────────────────────────────────────────
  function render(data) {
    document.getElementById('loading').style.display = 'none';
    document.getElementById('content').style.display = 'block';

    const { host, cpu, mem, disks, net, timestamp } = data;

    // Header
    document.getElementById('hdr-hostname').textContent = host.hostname;
    document.getElementById('hdr-kernel').textContent = host.kernelRelease;

    // Host strip
    const strip = document.getElementById('host-strip');
    strip.innerHTML = [
      kv('Uptime', fmtUptime(host.uptimeSeconds)),
      kv('Load', host.loadAvg1.toFixed(2) + ' / ' + host.loadAvg5.toFixed(2) + ' / ' + host.loadAvg15.toFixed(2)),
      kv('CPU', host.cpuCores + ' cores'),
      kv('Model', host.cpuModelName),
    ].join('');

    // CPU overall
    const cpuPct = cpu.usagePercent;
    document.getElementById('cpu-overall-pct').textContent = cpuPct.toFixed(1) + '%';
    document.getElementById('cpu-overall-pct').className = 'gauge-pct ' + colourClass(cpuPct);
    setGauge('cpu-overall-bar', cpuPct);

    // CPU cores
    const coresEl = document.getElementById('cpu-cores');
    coresEl.innerHTML = cpu.coreUsage.map((p, i) =>
      '<div class="core-cell ' + colourClass(p) + '" title="Core ' + i + '">' +
        p.toFixed(0) + '%</div>'
    ).join('');

    // Memory
    const memPct = mem.usagePercent;
    document.getElementById('mem-pct').textContent = memPct.toFixed(1) + '%';
    document.getElementById('mem-pct').className = 'gauge-pct ' + colourClass(memPct);
    setGauge('mem-bar', memPct);
    document.getElementById('mem-detail').textContent =
      fmtKb(mem.usedKb) + ' used / ' + fmtKb(mem.totalKb) + ' total  (' + fmtKb(mem.availableKb) + ' available)';

    const swapRow = document.getElementById('swap-row');
    if (mem.swapTotalKb > 0) {
      swapRow.style.display = '';
      document.getElementById('swap-pct').textContent = mem.swapPercent.toFixed(1) + '%';
      document.getElementById('swap-pct').className = 'gauge-pct ' + colourClass(mem.swapPercent);
      setGauge('swap-bar', mem.swapPercent);
    } else {
      swapRow.style.display = 'none';
    }

    // Disks
    const diskCard = document.getElementById('disk-card');
    diskCard.innerHTML = disks.map(d =>
      '<div class="disk-item">' +
        '<span class="disk-mount">' + d.mountpoint + '</span>' +
        '<span class="disk-size">' + fmtKb(d.usedKb) + ' / ' + fmtKb(d.totalKb) + '</span>' +
        '<div class="disk-bar gauge-row" style="margin:3px 0 0 0">' +
          '<div class="gauge-track" style="flex:1"><div class="gauge-fill" style="width:' + Math.min(d.usagePercent, 100) + '%;background:' + barColour(d.usagePercent) + '"></div></div>' +
          '<span class="gauge-pct ' + colourClass(d.usagePercent) + '">' + d.usagePercent + '%</span>' +
        '</div>' +
      '</div>'
    ).join('') || '<span style="color:var(--muted);font-size:12px">No disks found</span>';

    // Network
    const netRows = document.getElementById('net-rows');
    netRows.innerHTML = net.map(iface =>
      '<div class="net-row">' +
        '<span class="net-iface">' + iface.name + '</span>' +
        '<span class="net-rate c-green">' + fmtRate(iface.rxRate) + '</span>' +
        '<span class="net-rate c-yellow">' + fmtRate(iface.txRate) + '</span>' +
      '</div>'
    ).join('') || '<span style="color:var(--muted);font-size:12px">No interfaces</span>';

    // Timestamp
    document.getElementById('ts').textContent =
      'Updated ' + new Date(timestamp).toLocaleTimeString();
  }

  function kv(label, value) {
    return '<div class="kv"><span class="kv-label">' + label + '</span><span class="kv-value">' + value + '</span></div>';
  }

  // ── listen for messages from extension ───────────────────────────────────
  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.command === 'update') {
      render(msg.metrics);
    }
  });
</script>
</body>
</html>`;
}
