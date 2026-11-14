#!/usr/bin/env node
/**
 * End-to-end test of the GUI installer's companion add/remove semantics.
 *
 * Starts the real installer server (--no-open, fixed port), POSTs an install
 * against a throwaway project config pre-seeded with retired companions,
 * a versioned companion, the managed Exa MCP entry and custom keys, then
 * asserts exactly what was removed, kept and backed up.
 *
 * Run:  node scripts/e2e-install-test.mjs
 */
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
let failures = 0
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`)
  if (!ok) failures++
}

const dir = mkdtempSync(path.join(os.tmpdir(), "tokenopt-e2e-"))
const cfg = path.join(dir, "opencode.json")
writeFileSync(
  cfg,
  `{
  "plugins": [
    "opencode-supermemory",
    "opencode-gemini-auth@latest",
    "opencode-history-search@1.5.1",
    "./plugins/token-optimizer"
  ],
  "mcp": { "servers": { "exa": { "type": "remote", "url": "https://mcp.exa.ai/mcp" } } },
  "custom": { "keep": true }
}
`,
  "utf8",
)

const port = 18917
const server = spawn(
  process.execPath,
  [path.join(root, "scripts", "install-gui.mjs"), "--no-open", "--port", String(port), "--project-dir", dir],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
)
let serverLog = ""
server.stdout.on("data", (d) => (serverLog += d))
server.stderr.on("data", (d) => (serverLog += d))

const base = `http://127.0.0.1:${port}`
let ready = false
for (let i = 0; i < 80 && !ready; i++) {
  try {
    const res = await fetch(`${base}/api/state`)
    if (res.ok) ready = true
  } catch {
    /* not up yet */
  }
  if (!ready) await new Promise((r) => setTimeout(r, 250))
}
check("installer server started", ready, serverLog.slice(-300))

let text = ""
let doneOk = false
if (ready) {
  try {
    const res = await fetch(`${base}/api/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "project",
        projectDir: dir,
        features: { native: false, compress: true, dedupe: true, rotate: true, rtk: true, caveman: false, routing: false },
        routingModel: "",
        companions: { omos: false, history: false, quota: false, antigravity: false, exa: false, agents: false, ccswitch: false },
      }),
    })
    text = await res.text()
    const events = text
      .trim()
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
    const done = events.find((e) => e.t === "done")
    doneOk = Boolean(done && done.ok)
  } catch (error) {
    check("install POST completed", false, error.message)
  }
}

const msgs = text
  .trim()
  .split("\n")
  .map((line) => {
    try {
      const e = JSON.parse(line)
      return e.t === "log" ? String(e.msg) : null
    } catch {
      return null
    }
  })
  .filter(Boolean)
const has = (needle) => msgs.some((m) => m.includes(needle))

check("install reported ok (smoke inside it passed)", doneOk)
check("unchecked companion removed", has("- opencode-history-search (was unchecked"), msgs.filter((m) => m.startsWith("- ")).join(" | "))
check("version-suffix package also removed", has("opencode-gemini-auth (retired"))
check("retired supermemory stripped", has("opencode-supermemory (retired"))
check("managed Exa MCP removed", has("opencode-exa-search (Exa MCP) (was unchecked"))
check("cc-switch not-installed path is a no-op", has("cc-switch: not installed"))
check("nothing was added", !msgs.some((m) => m.startsWith("+ ")), msgs.filter((m) => m.startsWith("+ ")).join(" | "))
check("summary counts 4 removals", has("Install complete (- 4 removed)"), msgs.filter((m) => m.startsWith("Install complete")).join(""))

const written = readFileSync(cfg, "utf8")
const parsed = JSON.parse(written)
check("custom key kept", parsed.custom && parsed.custom.keep === true)
check("token-optimizer entry kept at user path", Array.isArray(parsed.plugins) && parsed.plugins.length === 1 && parsed.plugins[0].package === "./plugins/token-optimizer", JSON.stringify(parsed.plugins))
check("installer options include transform defaults", parsed.plugins[0].options.tool.compactJson === true && parsed.plugins[0].options.tool.scrubBase64 === false, JSON.stringify(parsed.plugins[0].options.tool))
check("mcp.servers.exa gone", !parsed.mcp || !parsed.mcp.servers || !parsed.mcp.servers.exa)
const backups = readdirSync(dir).filter((f) => f.includes(".bak-"))
check("timestamped backup written", backups.length === 1, backups.join(","))
check("no BOM", readFileSync(cfg)[0] !== 0xef)

try {
  await fetch(`${base}/api/shutdown`)
} catch {
  /* ignore */
}
await new Promise((r) => setTimeout(r, 400))
if (!server.killed) server.kill()
rmSync(dir, { recursive: true, force: true })

console.log(failures === 0 ? "\ne2e: all checks passed" : `\ne2e: ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
