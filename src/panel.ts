/**
 * In-OpenCode toggle panel served from localhost by the server part.
 *
 * Desktop's GUI half needs `@opencode/plugin/rpc` from the app, which older
 * app builds do not provide - so the plugin's day-to-day settings UI lives
 * here instead: a tiny HTTP server bound to 127.0.0.1 that serves one static
 * page and four JSON endpoints, all backed by the same optmgr/pluginmgr
 * machinery the GUI panel used (same backups, merge, JSONC guarantees).
 *
 * Open the URL in OpenCode Desktop's built-in browser (the side panel where
 * project previews open) or in any local browser.
 */
import http from "node:http"

import type { OptionsSetResult } from "./rpc"

/** First port tried; scans upward on collision. */
const DEFAULT_PORT = 47891
const PORT_SPAN = 20
/** Marker so a second plugin instance recognizes an already-running panel. */
const PANEL_MARKER = "token-optimizer-panel-v1"

export interface PanelDeps {
  /** Reads current option/companion rows. */
  getOptions: () => unknown
  /** Applies option/companion changes. */
  setOptions: (changes: Array<{ key: string; enabled: boolean }>) => OptionsSetResult
  /** Reads the whole-plugin inventory. */
  getPlugins: () => unknown
  /** Applies whole-plugin changes. */
  setPlugins: (changes: Array<{ key: string; enabled: boolean }>) => unknown
  /** The same text report `/tokens` shows in the TUI (stats section of the page). */
  getReport: () => string | Promise<string>
  /** Preferred port; 0 lets the OS pick (still 127.0.0.1 only). */
  port?: number
}

export interface Panel {
  /** The URL to open, e.g. `http://127.0.0.1:47891/`. */
  url: string
  close(): Promise<void>
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  })
  res.end(payload)
}

function readBody(req: http.IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error("request body too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

/** Probe an occupied port: is it already our panel? */
function isOurPanel(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = http.get(
      { host: "127.0.0.1", port, path: "/api/health", timeout: 800 },
      (res) => {
        let body = ""
        res.on("data", (chunk) => (body += chunk))
        res.on("end", () => resolve(body.includes(PANEL_MARKER)))
      },
    )
    probe.on("error", () => resolve(false))
    probe.on("timeout", () => {
      probe.destroy()
      resolve(false)
    })
  })
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      const address = server.address()
      if (address && typeof address === "object") resolve(address.port)
      else reject(new Error("panel: could not read bound port"))
    })
  })
}

/**
 * Starts (or joins) the panel server. Binds 127.0.0.1 only; another plugin
 * instance that finds our panel already running reuses it instead of failing.
 */
export async function startPanel(deps: PanelDeps): Promise<Panel> {
  const preferred = deps.port ?? DEFAULT_PORT

  for (let port = preferred; port < preferred + PORT_SPAN; port++) {
    if (await isOurPanel(port)) {
      return { url: `http://127.0.0.1:${port}/`, close: async () => undefined }
    }
  }

  let lastError: unknown
  for (let port = preferred; port < preferred + PORT_SPAN; port++) {
    const server = http.createServer((req, res) => {
      void handle(req, res, deps).catch((error) => {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) })
      })
    })
    try {
      const bound = await listen(server, port)
      const url = `http://127.0.0.1:${bound}/`
      return {
        url,
        close: () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections?.()
            server.close(() => resolve())
          }),
      }
    } catch (error) {
      lastError = error
      if ((error as NodeJS.ErrnoException)?.code !== "EADDRINUSE") throw error
    }
  }
  throw lastError instanceof Error ? lastError : new Error("panel: no free port")
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, deps: PanelDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1")
  const path = url.pathname
  const method = req.method ?? "GET"

  if (method === "GET" && path === "/api/health") {
    json(res, 200, { marker: PANEL_MARKER })
    return
  }

  if (method === "GET" && path === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
    res.end(PAGE)
    return
  }

  if (method === "GET" && path === "/api/report") {
    json(res, 200, { text: await deps.getReport() })
    return
  }

  if (method === "GET" && path === "/api/options") {
    json(res, 200, deps.getOptions())
    return
  }

  if (method === "POST" && path === "/api/options") {
    const body = JSON.parse(await readBody(req)) as { changes?: Array<{ key: string; enabled: boolean }> }
    json(res, 200, deps.setOptions(Array.isArray(body.changes) ? body.changes : []))
    return
  }

  if (method === "GET" && path === "/api/plugins") {
    json(res, 200, deps.getPlugins())
    return
  }

  if (method === "POST" && path === "/api/plugins") {
    const body = JSON.parse(await readBody(req)) as { changes?: Array<{ key: string; enabled: boolean }> }
    json(res, 200, deps.setPlugins(Array.isArray(body.changes) ? body.changes : []))
    return
  }

  json(res, 404, { error: "not found" })
}

/** The one-page toggle UI. No build step: plain HTML + one script. */
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>token-optimizer</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #101014; --panel: #17171c; --line: #2a2a33; --text: #e6e6ea;
    --dim: #8b8b96; --accent: #6ea8fe; --ok: #3fb950; --err: #f85149;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1rem 4rem; background: var(--bg); color: var(--text);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin: 0 0 0.25rem; }
  .sub { color: var(--dim); margin: 0 0 1.5rem; font-size: 13px; word-break: break-all; }
  section {
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    padding: 0.75rem 1rem; margin-bottom: 1rem;
  }
  section h2 {
    font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--dim); margin: 0.25rem 0 0.5rem;
  }
  .row {
    display: flex; align-items: center; gap: 1rem; padding: 0.55rem 0;
    border-top: 1px solid var(--line);
  }
  .row:first-of-type { border-top: 0; }
  .row .txt { flex: 1; min-width: 0; }
  .row .label { font-weight: 600; }
  .row .desc { color: var(--dim); font-size: 12.5px; margin-top: 2px; }
  .row .desc .warn { color: var(--err); }
  .sw { position: relative; width: 40px; height: 22px; flex: none; }
  .sw input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
  .sw span {
    position: absolute; inset: 0; background: #3a3a44; border-radius: 999px;
    transition: background 0.15s;
  }
  .sw span::after {
    content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px;
    background: #fff; border-radius: 50%; transition: transform 0.15s;
  }
  .sw input:checked + span { background: var(--accent); }
  .sw input:checked + span::after { transform: translateX(18px); }
  .sw input:disabled + span { opacity: 0.4; }
  footer {
    position: fixed; left: 0; right: 0; bottom: 0; background: var(--panel);
    border-top: 1px solid var(--line); padding: 0.75rem 1rem;
  }
  footer .bar { max-width: 760px; margin: 0 auto; display: flex; align-items: center; gap: 1rem; }
  #status { flex: 1; color: var(--dim); font-size: 13px; min-height: 1.2em; }
  #status.ok { color: var(--ok); }
  #status.err { color: var(--err); }
  button {
    background: var(--accent); color: #0b0b0f; border: 0; border-radius: 8px;
    padding: 0.55rem 1.1rem; font-weight: 700; font-size: 14px; cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  .empty { color: var(--dim); padding: 0.4rem 0; }
  #stats {
    margin: 0; padding: 0.5rem 0.6rem; background: #101014; border: 1px solid var(--line);
    border-radius: 8px; white-space: pre-wrap; word-break: break-word;
    font: 12px/1.5 ui-monospace, "Cascadia Code", Consolas, monospace;
    max-height: 24rem; overflow: auto;
  }
</style>
</head>
<body>
<main>
  <h1>token-optimizer</h1>
  <p class="sub" id="file">loading…</p>
  <section>
    <h2>Statistics</h2>
    <pre id="stats">loading…</pre>
  </section>
  <div id="sections"></div>
</main>
<footer>
  <div class="bar">
    <span id="status"></span>
    <button id="apply" disabled>Apply</button>
  </div>
</footer>
<script>
"use strict";
const SECTIONS = {
  feature: "Optimizations",
  transform: "Structural transforms",
  companion: "Companion plugins",
  plugin: "Installed plugins",
};
let current = new Map();   // key -> row
let original = new Map();  // key -> enabled (last applied)

async function getJson(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}
function postJson(path, body) {
  return getJson(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function status(msg, kind) {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.className = kind || "";
}
function pending() {
  const out = [];
  for (const [key, row] of current) {
    if (row.enabled !== (original.get(key) ?? row.enabled)) out.push({ key, enabled: row.enabled });
  }
  return out;
}
function refreshApply() {
  const n = pending().length;
  const btn = document.getElementById("apply");
  btn.disabled = n === 0;
  btn.textContent = n > 0 ? "Apply (" + n + ")" : "Apply";
}
function toggleRow(key, enabled) {
  const row = current.get(key);
  if (!row) return;
  row.enabled = enabled;
  refreshApply();
}
function rowHtml(row) {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const locked = row.locked ? " disabled" : "";
  const checked = row.enabled ? " checked" : "";
  return '<div class="row">' +
    '<div class="txt"><div class="label">' + esc(row.label) + "</div>" +
    '<div class="desc">' + esc(row.detail || row.desc || "") +
    (row.conflict ? ' <span class="warn">⚠ ' + esc(row.conflict) + "</span>" : "") +
    "</div></div>" +
    '<label class="sw"><input type="checkbox" data-key="' + esc(row.key) + '"' + checked + locked +
    '><span></span></label></div>';
}
function render() {
  const host = document.getElementById("sections");
  const groups = new Map();
  for (const row of current.values()) {
    const name = SECTIONS[row.section] || row.section || "Other";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(row);
  }
  let html = "";
  for (const [name, rows] of groups) {
    html += "<section><h2>" + name + "</h2>";
    html += rows.length ? rows.map(rowHtml).join("") : '<div class="empty">none</div>';
    html += "</section>";
  }
  host.innerHTML = html;
  host.querySelectorAll("input[type=checkbox]").forEach((el) => {
    el.addEventListener("change", () => toggleRow(el.dataset.key, el.checked));
  });
  refreshApply();
}
async function loadStats() {
  try {
    const { text } = await getJson("/api/report");
    document.getElementById("stats").textContent = text || "(no data yet)";
  } catch (error) {
    document.getElementById("stats").textContent = String(error.message || error);
  }
}
async function load() {
  try {
    const [opts, plugs] = await Promise.all([getJson("/api/options"), getJson("/api/plugins")]);
    current = new Map();
    for (const row of opts.rows || []) current.set(row.key, row);
    for (const row of plugs.rows || []) current.set(row.key, { ...row, section: row.section || "plugin" });
    original = new Map();
    for (const [key, row] of current) original.set(key, row.enabled);
    document.getElementById("file").textContent =
      (opts.file ? "config: " + opts.file : "config: not found - run Install.cmd") +
      (opts.warnings && opts.warnings.length ? " · " + opts.warnings.join(" · ") : "");
    render();
  } catch (error) {
    status(String(error.message || error), "err");
  }
}
async function apply() {
  const changes = pending();
  if (!changes.length) return;
  const btn = document.getElementById("apply");
  btn.disabled = true;
  try {
    const [oRes, pRes] = await Promise.all([
      postJson("/api/options", { changes: changes.filter((c) => !isPluginKey(c.key)) }),
      postJson("/api/plugins", { changes: changes.filter((c) => isPluginKey(c.key)) }),
    ]);
    const errors = [...(oRes.errors || []), ...(pRes.errors || [])];
    const backups = [...(oRes.backups || []), ...(pRes.backups || [])];
    if (errors.length) status(errors.slice(0, 3).join(" · "), "err");
    else status(changes.length + " change(s) applied" +
      (backups.length ? " · backup written" : ""), "ok");
    // Re-read so toggles reflect what was actually written.
    await load();
    await loadStats();
  } catch (error) {
    status(String(error.message || error), "err");
    refreshApply();
  }
}
// Plugin-inventory keys are ids like "opencode-history-search"; option keys
// are camelCase ids. Companion rows live in /api/options, plugin rows in
// /api/plugins - split by which source produced the key.
let pluginKeys = new Set();
async function loadPluginKeys() {
  const plugs = await getJson("/api/plugins");
  pluginKeys = new Set((plugs.rows || []).map((r) => r.key));
}
function isPluginKey(key) {
  return pluginKeys.has(key);
}
document.getElementById("apply").addEventListener("click", () => void apply());
(async () => {
  await loadPluginKeys();
  await Promise.all([load(), loadStats()]);
})();
</script>
</body>
</html>
`
