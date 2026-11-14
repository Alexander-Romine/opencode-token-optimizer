#!/usr/bin/env node
/**
 * token-optimizer GUI installer.
 *
 * `Install.cmd` (or `node scripts/install-gui.mjs`) starts a localhost-only
 * HTTP server and opens a browser page where you check on/off each
 * optimization and each companion plugin, pick a scope, and install.
 * No PowerShell involved.
 *
 * Guarantees, same as install.ps1:
 *   - existing opencode.json is backed up (timestamped) and MERGED, never overwritten
 *   - JSONC / unparseable configs are refused with instructions (nothing written)
 *   - written as UTF-8 without BOM, 2-space indent, trailing newline
 *   - plugin options are written explicitly (rtk/caveman keys included)
 *
 * Companion plugins are third-party, all MIT. Config-level ones are merged
 * into the plugins array; Exa becomes an MCP server entry; `agents` is cloned
 * and generated locally (needs git + uv); cc-switch is a desktop app, so the
 * installer opens its releases page instead of pretending to configure it.
 *
 * Flags:
 *   --port N          fixed port (default: ephemeral)
 *   --no-open         do not open a browser (tests / headless)
 *   --project-dir D   default project directory for project scope
 */
import { spawn, spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const REPO_PKG = root.replaceAll("\\", "/")
const HTML_FILE = path.join(root, "scripts", "install-gui.html")

/* ------------------------------------------------------------------ *
 * Feature + companion definitions (source of truth for the page too:
 * the page renders these from /api/state).
 * ------------------------------------------------------------------ */

const FEATURES = [
  {
    id: "compress",
    label: "Tool-output compression",
    desc: "Strip ANSI codes, collapse blank runs, truncate huge outputs (head + tail with a gap marker).",
    default: true,
  },
  {
    id: "dedupe",
    label: "Verified dedupe",
    desc: "Collapse byte-identical repeat tool results. The hash stays over the original text, so nothing different is ever hidden.",
    default: true,
  },
  {
    id: "rotate",
    label: "Auto session rotation",
    desc: "Start a fresh session at 85% of the context window; state is saved and carried over. On by default.",
    default: true,
  },
  {
    id: "rtk",
    label: "RTK command-output reduction",
    desc: "Recognises test runs, git status/log, installs and builds; keeps summaries, failures and errors, drops the noise. Outputs under 1,200 chars pass through untouched.",
    default: true,
  },
  {
    id: "caveman",
    label: "Caveman terse responses",
    desc: "Adds a system-prompt instruction: answer first, no filler or pleasantries. Code, paths and errors stay verbatim.",
    default: false,
  },
  {
    id: "routing",
    label: "Model routing",
    desc: "Send title generation, compaction summaries and one-shot jobs to a cheaper model (you provide provider/model below).",
    default: false,
    input: "routingModel",
  },
  {
    id: "native",
    label: "Rust native accelerator",
    desc: "Build or copy the native addon (~3x faster hot path). Without it the plugin runs on a byte-identical JS fallback.",
    default: true,
  },
]

const COMPANIONS = [
  {
    id: "omos",
    pkg: "oh-my-opencode-slim",
    label: "oh-my-opencode-slim",
    desc: "Multi-agent orchestration suite: specialist agents, auto-delegation, model mixing.",
    license: "MIT",
  },
  {
    id: "history",
    pkg: "opencode-history-search",
    label: "opencode-history-search",
    desc: "Keyword, regex and fuzzy search over your OpenCode conversation history, across all projects.",
    license: "MIT",
  },
  {
    id: "quota",
    pkg: "@slkiser/opencode-quota",
    label: "opencode-quota",
    desc: "Provider quota and usage views: in-session /quota, sidebar panel, terminal view.",
    license: "MIT",
  },
  {
    id: "supermemory",
    pkg: "opencode-supermemory",
    label: "opencode-supermemory",
    desc: "Persistent cross-session memory for your agents, powered by Supermemory.",
    license: "MIT",
    note: "needs a Supermemory account",
  },
  {
    id: "gemini",
    pkg: "opencode-gemini-auth",
    label: "opencode-gemini-auth",
    desc: "Google Gemini Code Assist OAuth login for eligible organization subscriptions.",
    license: "MIT",
    note: "needs an eligible Google subscription",
  },
  {
    id: "antigravity",
    pkg: "opencode-antigravity-auth",
    label: "opencode-antigravity-auth",
    desc: "Unofficial Google Antigravity OAuth access, with account and quota menus.",
    license: "MIT",
    note: "unofficial; Google may restrict third-party clients",
  },
  {
    id: "exa",
    mcp: { name: "exa", type: "remote", url: "https://mcp.exa.ai/mcp" },
    label: "opencode-exa-search (Exa MCP)",
    desc: "Web search and page-fetch tools through Exa's hosted MCP endpoint. Works anonymously with rate limits.",
    license: "MIT",
    note: "adds mcp.servers.exa to your config",
  },
  {
    id: "agents",
    special: "agents",
    label: "agents (wshobson)",
    desc: "200+ specialist agents, 185 skills and 105 workflows, cloned and generated into your OpenCode config.",
    license: "MIT",
    note: "requires git + uv (astral.sh)",
  },
  {
    id: "ccswitch",
    special: "ccswitch",
    label: "cc-switch",
    desc: "Desktop app for managing coding-tool provider configuration. Not an opencode.json plugin: the installer opens its releases page.",
    license: "MIT",
    note: "desktop app - opens GitHub releases",
  },
]

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

class FriendlyError extends Error {}

const args = process.argv.slice(2)
function flag(name) {
  return args.includes(name)
}
function opt(name, fallback) {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const stamp = () => {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function has(cmd) {
  try {
    // Windows: npm (and friends) are .cmd shims that plain spawn cannot
    // resolve - go through cmd.exe there. Exes (git, cargo, uv) work either way.
    const r =
      process.platform === "win32"
        ? spawnSync("cmd", ["/c", cmd, "--version"], { windowsHide: true, stdio: "ignore" })
        : spawnSync(cmd, ["--version"], { windowsHide: true, stdio: "ignore" })
    return r.status === 0
  } catch {
    return false
  }
}

/** npm is a .cmd shim on Windows; route it through cmd.exe so spawn resolves it. */
function npmCmdArgs(npmArgs) {
  return process.platform === "win32" ? ["cmd", ["/c", "npm", ...npmArgs]] : ["npm", npmArgs]
}

function openBrowser(url) {
  const [cmd, cmdArgs] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]]
  try {
    const child = spawn(cmd, cmdArgs, { detached: true, stdio: "ignore", windowsHide: false })
    child.on("error", () => {})
    child.unref()
  } catch {
    /* best effort */
  }
}

/** Run a command, streaming every output line to emit(). Resolves with exit code. */
function run(cmd, cmdArgs, { cwd, env } = {}, emit) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, cmdArgs, {
        cwd,
        env: { ...process.env, ...env },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (error) {
      emit("error", `${cmd} failed to start: ${error.message}`)
      resolve(-1)
      return
    }
    let buf = ""
    const onChunk = (data) => {
      buf += data.toString("utf8")
      let i
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "")
        buf = buf.slice(i + 1)
        if (line.trim()) emit("info", line)
      }
    }
    child.stdout.on("data", onChunk)
    child.stderr.on("data", onChunk)
    child.on("error", (error) => {
      emit("error", `${cmd}: ${error.message}`)
      resolve(-1)
    })
    child.on("close", (code) => {
      if (buf.trim()) emit("info", buf.trim())
      resolve(code ?? -1)
    })
  })
}

/* ------------------------------------------------------------------ *
 * Config merge (mirror of install.ps1 semantics, plus companions)
 * ------------------------------------------------------------------ */

function configPathIn(dir) {
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const candidate = path.join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return path.join(dir, "opencode.json")
}

function readConfig(file) {
  if (!existsSync(file)) return {}
  let raw = readFileSync(file, "utf8")
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1) // tolerate a BOM on read
  if (raw.trim() === "") return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new FriendlyError(`${file} does not contain a JSON object - refusing to modify it.`)
    }
    return parsed
  } catch (error) {
    if (error instanceof FriendlyError) throw error
    const looksJsonc = /\/\/|\/\*|\*\//.test(raw)
    const entry = JSON.stringify(
      { package: REPO_PKG, options: buildOptions({ compress: true, dedupe: true, rotate: true, rtk: true }, "") },
      null,
      2,
    )
    throw new FriendlyError(
      `Could not parse ${file} as JSON${looksJsonc ? " - it contains comments (JSONC)" : ` (${error.message})`}. ` +
        `Nothing was written. Fix the file by hand and add this entry:\n${entry}`,
    )
  }
}

function backupConfig(file) {
  const backup = `${file}.bak-${stamp()}`
  copyFileSync(file, backup)
  return backup
}

function writeConfig(file, config) {
  mkdirSync(path.dirname(file), { recursive: true })
  // Node writes utf8 without a BOM; 2-space indent + trailing newline.
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8")
}

function normPath(p) {
  return String(p).replaceAll("\\", "/")
}

function entryPackage(entry) {
  if (typeof entry === "string") return entry
  if (entry && typeof entry === "object" && typeof entry.package === "string") return entry.package
  return null
}

/**
 * Overlay the installer's explicit values onto the existing options, keeping
 * any keys the installer doesn't manage (including "//..." doc keys users
 * write inside their config). Known keys always get the checkbox value.
 */
function mergeOptions(existing, fresh) {
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return fresh
  const out = { ...existing }
  for (const [key, value] of Object.entries(fresh)) {
    const prev = out[key]
    const nestedObjects =
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      prev &&
      typeof prev === "object" &&
      !Array.isArray(prev)
    out[key] = nestedObjects ? mergeOptions(prev, value) : value
  }
  return out
}

/** Insert or update the token-optimizer entry without ever duplicating it. */
function mergeTokenOptimizer(config, options) {
  const plugins = Array.isArray(config.plugins) ? config.plugins : []
  let index = plugins.findIndex((e) => entryPackage(e) && normPath(entryPackage(e)) === REPO_PKG)
  let action = "registered"
  let keptPath = REPO_PKG
  if (index >= 0) {
    action = "updated"
  } else {
    // Same plugin registered from a different path (e.g. ./plugins/token-optimizer):
    // keep that path so the user's layout is untouched, but refresh its options.
    index = plugins.findIndex((e) => (entryPackage(e) || "").includes("token-optimizer"))
    if (index >= 0) {
      keptPath = entryPackage(plugins[index])
      action = "updated (kept your existing path)"
    }
  }
  const existing = index >= 0 && plugins[index] && typeof plugins[index] === "object" ? plugins[index] : null
  const entry = existing
    ? { ...existing, package: keptPath, options: mergeOptions(existing.options, options) }
    : { package: keptPath, options }
  if (index >= 0) plugins[index] = entry
  else plugins.push(entry)
  config.plugins = plugins
  return { action, keptPath }
}

function mergeCompanion(config, pkg) {
  const plugins = Array.isArray(config.plugins) ? config.plugins : []
  if (plugins.some((e) => entryPackage(e) === pkg)) return false
  plugins.push(pkg)
  config.plugins = plugins
  return true
}

function mergeExa(config) {
  if (!config.mcp || typeof config.mcp !== "object" || Array.isArray(config.mcp)) config.mcp = {}
  if (!config.mcp.servers || typeof config.mcp.servers !== "object" || Array.isArray(config.mcp.servers)) {
    config.mcp.servers = {}
  }
  if (config.mcp.servers.exa) return false
  config.mcp.servers.exa = { type: "remote", url: "https://mcp.exa.ai/mcp" }
  return true
}

/** Explicit options for every feature flag - mirrors install.ps1 defaults. */
function buildOptions(features, routingModel) {
  const compress = features.compress !== false
  const model = String(routingModel || "").trim()
  return {
    enabled: true,
    charsPerToken: 4,
    tool: compress
      ? {
          maxChars: 24000,
          headPct: 70,
          stripAnsi: true,
          collapseBlank: true,
          maxBlankLines: 1,
          trimLines: false,
          dedupeWindow: features.dedupe === false ? 0 : 4,
          dedupeMinChars: 1500,
          compactJson: true,
          collapseTable: true,
          scrubBase64: false,
          collapseRepeats: false,
          exclude: ["write", "edit", "apply_patch"],
        }
      : {
          maxChars: 0,
          headPct: 70,
          stripAnsi: false,
          collapseBlank: false,
          maxBlankLines: 1,
          trimLines: false,
          dedupeWindow: features.dedupe === false ? 0 : 4,
          dedupeMinChars: 1500,
          compactJson: false,
          collapseTable: false,
          scrubBase64: false,
          collapseRepeats: false,
          exclude: ["write", "edit", "apply_patch"],
        },
    rotation: {
      auto: features.rotate !== false,
      thresholdPct: 85,
      titleSuffix: " (rotated)",
    },
    routing: {
      title: model,
      compaction: model,
      generate: model,
      agents: {},
    },
    rtk: { enabled: features.rtk !== false, minChars: 1200 },
    caveman: { enabled: features.caveman === true, text: "" },
    budgetMaxTokens: 0,
    stateDir: ".opencode/token-optimizer/state",
  }
}

/* ------------------------------------------------------------------ *
 * External companions
 * ------------------------------------------------------------------ */

const AGENTS_DIR = path.join(os.homedir(), ".local", "share", "opencode", "ext", "wshobson-agents")
const AGENTS_URL = "https://github.com/wshobson/agents.git"
const AGENTS_MANUAL = [
  "Manual install for wshobson/agents:",
  "  git clone --depth 1 https://github.com/wshobson/agents.git " + AGENTS_DIR,
  "  cd " + AGENTS_DIR,
  "  uv run --project plugins/plugin-eval python tools/generate.py --harness opencode --all --prune",
  "  uv run --project plugins/plugin-eval python tools/install_opencode.py install",
]

async function installAgents(emit) {
  if (!has("git")) {
    emit("error", "git was not found on PATH - cannot clone wshobson/agents.")
    for (const line of AGENTS_MANUAL) emit("info", line)
    return false
  }
  if (!has("uv")) {
    emit("error", "uv was not found on PATH - wshobson/agents generates its artifacts with uv.")
    emit("info", "Install uv from https://astral.sh/uv then re-run, or do it manually:")
    for (const line of AGENTS_MANUAL) emit("info", line)
    return false
  }

  if (existsSync(path.join(AGENTS_DIR, ".git"))) {
    emit("info", "updating existing clone of wshobson/agents ...")
    const code = await run("git", ["-C", AGENTS_DIR, "pull", "--ff-only"], {}, emit)
    if (code !== 0) {
      emit("error", "git pull failed - keeping the existing clone.")
      return false
    }
  } else {
    emit("info", "cloning wshobson/agents (shallow) ...")
    mkdirSync(path.dirname(AGENTS_DIR), { recursive: true })
    const code = await run("git", ["clone", "--depth", "1", AGENTS_URL, AGENTS_DIR], {}, emit)
    if (code !== 0) {
      emit("error", "git clone failed - skipping the agents install.")
      return false
    }
  }

  emit("info", "generating OpenCode artifacts (first run downloads Python deps via uv) ...")
  let code = await run(
    "uv",
    ["run", "--project", "plugins/plugin-eval", "python", "tools/generate.py", "--harness", "opencode", "--all", "--prune"],
    { cwd: AGENTS_DIR },
    emit,
  )
  if (code !== 0) {
    emit("error", "artifact generation failed - see output above.")
    for (const line of AGENTS_MANUAL) emit("info", line)
    return false
  }

  emit("info", "linking agents, skills and commands into your OpenCode config ...")
  code = await run(
    "uv",
    ["run", "--project", "plugins/plugin-eval", "python", "tools/install_opencode.py", "install"],
    { cwd: AGENTS_DIR },
    emit,
  )
  if (code !== 0) {
    emit("error", "linking failed - see output above.")
    for (const line of AGENTS_MANUAL) emit("info", line)
    return false
  }
  emit("ok", "agents (wshobson) installed")
  return true
}

/* ------------------------------------------------------------------ *
 * Install flow
 * ------------------------------------------------------------------ */

async function install(body, emit) {
  const scope = body.scope === "project" ? "project" : "global"
  const features = body.features || {}
  const companions = body.companions || {}
  const routingModel = body.routingModel || ""
  const projectDir = body.projectDir || process.cwd()

  // ---- 1. config first: fastest feedback, and JSONC refusal happens before any work
  const dir = scope === "global" ? path.join(os.homedir(), ".config", "opencode") : projectDir
  const file = configPathIn(dir)
  emit("info", `scope: ${scope === "global" ? "global (every project)" : `project (${projectDir})`}`)
  emit("info", `config: ${file}`)

  const existed = existsSync(file)
  const config = readConfig(file) // throws FriendlyError on JSONC / bad JSON
  let backupPath = null
  if (existed) {
    backupPath = backupConfig(file)
    emit("ok", `backed up existing config -> ${backupPath}`)
  } else {
    emit("info", "no existing config - creating a new one")
  }

  const options = buildOptions(features, routingModel)
  const merged = mergeTokenOptimizer(config, options)
  emit("ok", `token-optimizer ${merged.action} (package: ${merged.keptPath})`)
  if (features.routing && !routingModel.trim()) {
    emit("warn", "Model routing is checked but no provider/model was given - routing left empty (no-op).")
  }
  if (features.routing && routingModel.trim()) {
    emit("info", `routing titles/compaction/one-shots -> ${routingModel.trim()}`)
  }

  let added = 0
  for (const c of COMPANIONS) {
    if (!companions[c.id]) continue
    if (c.pkg) {
      if (mergeCompanion(config, c.pkg)) {
        emit("ok", `+ ${c.label}`)
        added++
      } else {
        emit("info", `= ${c.label} already in your plugins list`)
      }
    } else if (c.mcp) {
      if (mergeExa(config)) {
        emit("ok", `+ ${c.label} -> mcp.servers.${c.mcp.name}`)
        added++
      } else {
        emit("info", "= Exa MCP already configured")
      }
    }
  }

  writeConfig(file, config)
  emit("ok", `wrote ${file} (UTF-8, no BOM, merged - nothing else touched)`)

  // ---- 2. dependencies (needed for the native addon, GUI bundle and smoke test)
  const nodeModules = path.join(root, "node_modules")
  const vitePresent = existsSync(path.join(nodeModules, "vite", "package.json"))
  if (!existsSync(nodeModules) || !vitePresent) {
    emit("info", "installing npm dependencies (first run also builds the native addon + GUI bundle) ...")
    const env = features.native === false ? { TOKEN_OPTIMIZER_SKIP_NATIVE: "1" } : {}
    const [npmCmd, npmArgs] = npmCmdArgs(["install", "--no-fund", "--no-audit"])
    const code = await run(npmCmd, npmArgs, { cwd: root, env }, emit)
    if (code !== 0) {
      emit("error", "npm install failed - the config is registered but the plugin cannot build.")
      return false
    }
    emit("ok", "dependencies ready")
  } else {
    emit("info", "dependencies already installed")
  }

  // ---- 3. native addon + GUI bundle (setup-native.mjs does both, never fails the install)
  const addon = existsSync(path.join(root, "native", "token-optimizer.node"))
  if (features.native === false) {
    emit(
      addon ? "info" : "warn",
      addon
        ? "native addon: unchecked, but a build already exists - it will still be used"
        : "native addon: skipped - JS fallback will be used (same results, ~3x slower)",
    )
    // still run setup so the GUI bundle step happens (it skips the native part)
    await run(process.execPath, [path.join(root, "scripts", "setup-native.mjs")], {
      cwd: root,
      env: { TOKEN_OPTIMIZER_SKIP_NATIVE: "1" },
    }, emit)
  } else {
    emit("info", "native addon: ensuring it is built")
    await run(process.execPath, [path.join(root, "scripts", "setup-native.mjs")], { cwd: root }, emit)
    const built = existsSync(path.join(root, "native", "token-optimizer.node"))
    emit(built ? "ok" : "warn", built ? "native addon ready" : "native addon unavailable - JS fallback will be used")
  }
  const gui = existsSync(path.join(root, "dist", "gui-experimental.cjs"))
  emit(
    gui ? "ok" : "warn",
    gui
      ? "GUI bundle ready (Desktop /tokens available after an OpenCode restart)"
      : "GUI bundle missing - Desktop /tokens unavailable (TUI /tokens still works)",
  )

  // ---- 4. external companions
  if (companions.agents) await installAgents(emit)
  if (companions.ccswitch) {
    emit("info", "cc-switch is a desktop app, not an opencode.json plugin - opening its releases page.")
    emit("info", "Download the installer from https://github.com/farion1231/cc-switch/releases")
    openBrowser("https://github.com/farion1231/cc-switch/releases")
  }

  // ---- 5. smoke test: prove the plugin actually works before you open OpenCode
  emit("info", "running smoke test ...")
  const smokeCode = await run(process.execPath, ["test/smoke.mjs"], { cwd: root }, emit)
  if (smokeCode !== 0) {
    emit("error", "SMOKE TEST FAILED - the plugin may not work correctly.")
    return false
  }
  emit("ok", "smoke test passed")

  emit("info", "")
  emit("ok", `Install complete${added ? ` (+ ${added} companion plugin${added > 1 ? "s" : ""})` : ""}.`)
  emit("info", scope === "global" ? "Restart OpenCode - the plugin loads for every project." : "Start OpenCode from that project directory.")
  emit("info", "In OpenCode Desktop or the TUI run /tokens for the efficiency report.")
  emit("info", "Auto-rotation is ON at 85% of the context window (options.rotation.auto to change).")
  if (backupPath) emit("info", `Config backup: ${backupPath}`)
  return true
}

/* ------------------------------------------------------------------ *
 * HTTP server
 * ------------------------------------------------------------------ */

function summarizeConfig(file) {
  try {
    const config = readConfig(file)
    const plugins = Array.isArray(config.plugins) ? config.plugins : []
    const pkgs = plugins.map(entryPackage).filter(Boolean)
    const ours = plugins.find((e) => (entryPackage(e) || "").includes("token-optimizer"))
    const opts = ours && typeof ours === "object" ? ours.options || {} : {}
    return {
      exists: existsSync(file),
      plugins: pkgs,
      tokenOptimizer: {
        present: Boolean(ours),
        path: ours ? entryPackage(ours) : null,
        rtk: Boolean(opts.rtk && opts.rtk.enabled !== false),
        caveman: Boolean(opts.caveman && opts.caveman.enabled),
        rotate: opts.rotation ? opts.rotation.auto !== false : null,
        compress: opts.tool ? (opts.tool.maxChars || 0) > 0 : null,
        dedupe: opts.tool ? (opts.tool.dedupeWindow || 0) > 0 : null,
        routingModel: opts.routing ? opts.routing.compaction || "" : "",
      },
      exa: Boolean(config.mcp && config.mcp.servers && config.mcp.servers.exa),
    }
  } catch (error) {
    return { exists: existsSync(file), parseError: error.message, plugins: [], tokenOptimizer: { present: false }, exa: false }
  }
}

function state() {
  const globalFile = configPathIn(path.join(os.homedir(), ".config", "opencode"))
  const projectDir = opt("--project-dir", process.cwd())
  const projectFile = configPathIn(projectDir)
  return {
    root,
    repoPkg: REPO_PKG,
    globalFile,
    projectFile,
    projectDir,
    global: summarizeConfig(globalFile),
    project: summarizeConfig(projectFile),
    features: FEATURES,
    companions: COMPANIONS,
    checks: {
      node: process.version,
      npm: has("npm"),
      cargo: has("cargo"),
      git: has("git"),
      uv: has("uv"),
      addon: existsSync(path.join(root, "native", "token-optimizer.node")),
      guiBundle: existsSync(path.join(root, "dist", "gui-experimental.cjs")),
      nodeModules: existsSync(path.join(root, "node_modules")),
    },
  }
}

let installing = false
let idleTimer = null

function armIdle(timeoutMs = 15 * 60 * 1000) {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (!installing) {
      console.log("[installer] no activity for 15 minutes - exiting.")
      process.exit(0)
    } else {
      armIdle(timeoutMs)
    }
  }, timeoutMs)
}

async function handleInstall(req, res) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1_000_000) {
      res.writeHead(413).end()
      return
    }
    chunks.push(chunk)
  }
  let body
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
  } catch {
    res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad json"}')
    return
  }

  installing = true
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
  })
  const emit = (level, msg) => {
    res.write(`${JSON.stringify({ t: "log", level, msg: String(msg) })}\n`)
  }
  let ok = false
  try {
    ok = await install(body, emit)
  } catch (error) {
    emit("error", error instanceof FriendlyError ? error.message : `unexpected error: ${error.stack || error.message}`)
  }
  res.write(`${JSON.stringify({ t: "done", ok })}\n`)
  res.end()
  installing = false
  armIdle()
}

function serve() {
  const html = readFileSync(HTML_FILE, "utf8")
  const server = http.createServer((req, res) => {
    armIdle()
    const url = new URL(req.url || "/", "http://127.0.0.1")
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      res.end(html)
      return
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
      res.end(JSON.stringify(state()))
      return
    }
    if (req.method === "POST" && url.pathname === "/api/install") {
      void handleInstall(req, res)
      return
    }
    if (req.method === "GET" && url.pathname === "/api/shutdown") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end('{"ok":true}')
      setTimeout(() => process.exit(0), 150)
      return
    }
    res.writeHead(404).end("not found")
  })

  const port = Number(opt("--port", 0))
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE" && !args.includes("--port")) {
      server.listen(0, "127.0.0.1") // fall back to an ephemeral port
    } else {
      console.error(`[installer] cannot listen: ${error.message}`)
      process.exit(1)
    }
  })
  server.listen(port, "127.0.0.1", () => {
    const actual = server.address().port
    const url = `http://127.0.0.1:${actual}/`
    console.log("")
    console.log("  token-optimizer - GUI installer")
    console.log(`  open: ${url}`)
    console.log("  close the browser tab (or the button) to exit.")
    console.log("")
    if (!flag("--no-open")) openBrowser(url)
    armIdle()
  })
}

serve()
