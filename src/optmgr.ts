/**
 * In-OpenCode options + companion toggles (Desktop `/optimize`).
 *
 * The GUI installer owns bootstrap (deps, native build, agents clone,
 * cc-switch MSI). This module owns day-to-day configuration from inside a
 * running OpenCode: feature switches, structural transforms, and the
 * config-level companion plugins - with the same guarantees as everything
 * else that writes config here:
 *
 *   - one timestamped backup per file per batch, merge never overwrite
 *   - strict JSON only: a JSONC file is read for display, never rewritten
 *     (the change fails with a hand-edit hint instead)
 *   - UTF-8 without BOM, 2-space indent, trailing newline
 *   - unknown option keys in the entry are preserved (we set, never replace)
 *   - retired companions (`RETIRED`) are stripped on every write
 *
 * Companion scope: `plugins[]` entries and the Exa MCP server live in config
 * and are fully toggleable here. `agents` (clone + uv generate) and
 * `cc-switch` (desktop MSI) are external installs - the installer's job;
 * this panel does not pretend otherwise.
 */
import path from "node:path"
import os from "node:os"

import { loadDocs, backupFile, writeFile, pickWriteDoc, type Doc } from "./pluginmgr.ts"
import { parseOptions } from "./options.ts"
import type { OptionRow, OptionsGetResult, OptionsSetResult } from "./rpc.ts"

/** Offerings the installer retires; stripped from config on every write. */
const RETIRED: ReadonlyArray<{ pkg: string; label: string }> = [
  { pkg: "opencode-supermemory", label: "opencode-supermemory" },
  { pkg: "opencode-gemini-auth", label: "opencode-gemini-auth" },
]

/** Config-level companions (same set the installer offers minus externals). */
const COMPANIONS: ReadonlyArray<{
  id: string
  label: string
  desc: string
  pkg?: string
  mcp?: { name: string; url: string }
}> = [
  {
    id: "omos",
    label: "oh-my-opencode-slim",
    desc: "Multi-agent orchestration: specialist agents, auto-delegation, model mixing.",
    pkg: "oh-my-opencode-slim",
  },
  {
    id: "history",
    label: "opencode-history-search",
    desc: "Keyword, regex and fuzzy search over all your OpenCode conversation history.",
    pkg: "opencode-history-search",
  },
  {
    id: "quota",
    label: "opencode-quota",
    desc: "Provider quota and usage views: /quota, sidebar panel, terminal view.",
    pkg: "@slkiser/opencode-quota",
  },
  {
    id: "antigravity",
    label: "opencode-antigravity-auth",
    desc: "Unofficial Google Antigravity OAuth access, with account and quota menus.",
    pkg: "opencode-antigravity-auth",
  },
  {
    id: "exa",
    label: "opencode-exa-search (Exa MCP)",
    desc: "Web search and page fetch through Exa's hosted MCP endpoint.",
    mcp: { name: "exa", url: "https://mcp.exa.ai/mcp" },
  },
]

/** Feature rows: installer FEATURES minus bootstrap-only entries. */
const FEATURES: ReadonlyArray<{ key: string; label: string; desc: string }> = [
  {
    key: "compress",
    label: "Tool-output compression & cleaning",
    desc: "Strip ANSI, collapse blank runs, truncate huge outputs (head + tail with a gap marker).",
  },
  {
    key: "dedupe",
    label: "Verified dedupe",
    desc: "Collapse byte-identical repeat tool results within the recent window (hash-verified).",
  },
  {
    key: "internChunks",
    label: "Chunk interning",
    desc: "Large blocks that already appeared in this session's recent output become a verified pointer.",
  },
  {
    key: "rotate",
    label: "Auto session rotation",
    desc: "Start a fresh session at 85% of the context window; state is saved and carried over.",
  },
  {
    key: "historyDigest",
    label: "History digest on rotate",
    desc: "Without a compaction checkpoint, rotation carries a bounded digest of the transcript instead.",
  },
  {
    key: "rtk",
    label: "RTK command-output reduction",
    desc: "Recognises test runs, git status/log, installs and builds; keeps summaries and failures.",
  },
  {
    key: "caveman",
    label: "Caveman terse responses",
    desc: "System-prompt instruction: answer first, no filler; code and errors stay verbatim.",
  },
  {
    key: "ramCache",
    label: "Device-RAM cache",
    desc: "Memoize the transform pipeline in process RAM so repeated outputs skip recomputation.",
  },
  {
    key: "downscaleImages",
    label: "Downscale PNG images",
    desc: "Shrink oversized PNGs (inline data URIs + outgoing media) to imageMaxDim; other formats pass through.",
  },
  {
    key: "pressureRouting",
    label: "Pressure-aware budgets",
    desc: "Past pressurePct of the window, tool budgets tighten automatically (smaller maxChars, earlier stubs).",
  },
]

/** Structural transform rows (`tool.*`), lossless first then lossy opt-ins. */
const TRANSFORMS: ReadonlyArray<{ key: string; label: string; desc: string }> = [
  { key: "compactJson", label: "Compact JSON", desc: "Lossless: re-serialize one-value JSON results without whitespace." },
  { key: "compactJsonInline", label: "Compact inline JSON", desc: "Lossless: balanced JSON spans embedded in prose get the same re-serialization." },
  { key: "collapseTable", label: "Collapse tables", desc: "Lossless: strip markdown table alignment padding outside code fences." },
  { key: "minifyMarkdown", label: "Minify markdown", desc: "Lossless: collapse blank-line runs and trailing whitespace (hard breaks kept)." },
  { key: "scrubBase64", label: "Scrub base64/hex", desc: "Lossy: elide declared data-URI payloads, >=500-char base64 and >=800-char hex blobs." },
  { key: "collapseRepeats", label: "Collapse repeated lines", desc: "Lossy: runs of >=3 identical long lines become one line + count." },
  { key: "collapseStacks", label: "Collapse stack frames", desc: "Lossy: repeated identical stack-trace frames become one + count." },
  { key: "collapseTraces", label: "Trim long stack traces", desc: "Lossy: traces of >=12 frames keep the first 8 plus a count marker." },
  { key: "collapseDiff", label: "Collapse diff context", desc: "Lossy: long unchanged runs in unified diffs become a marker." },
  { key: "trimDiffHunks", label: "Trim diff hunks", desc: "Lossy: hunks over 100 lines keep head 60 + tail 20 with an omission marker." },
  { key: "filterLogs", label: "Filter debug logs", desc: "Lossy: DEBUG/TRACE/VERBOSE lines collapse to one count marker per run." },
  { key: "stripUrlParams", label: "Strip URL tracking params", desc: "Lossy: utm_*/fbclid/... query params drop from URLs; path and fragment stay." },
  { key: "stripHtml", label: "HTML to text", desc: "Lossy: raw HTML pages become text (JSX/source never touched)." },
  { key: "normalizeTime", label: "Normalize timestamps", desc: "Lossy: full timestamps become <ts>; line order keeps chronology." },
  { key: "shortenPaths", label: "Shorten home paths", desc: "Lossy: this machine's home directory prefix becomes ~." },
]

export interface OptmgrOptions {
  /** Project location directory (config discovery walks up from here). */
  directory: string
  /** Global config directory; defaults to `~/.config/opencode`. */
  globalDir?: string
}

function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Base package name: strips a `@version` suffix, keeps scoped shape. */
function basePackage(entry: unknown): string | null {
  let p: string | null = null
  if (typeof entry === "string") p = entry
  else if (entry && typeof entry === "object" && typeof (entry as { package?: unknown }).package === "string") {
    p = (entry as { package: string }).package
  }
  if (!p) return null
  if (p.startsWith("@")) {
    const at = p.indexOf("@", 1)
    return at > 0 ? p.slice(0, at) : p
  }
  const at = p.indexOf("@")
  return at > 0 ? p.slice(0, at) : p
}

function isSelfEntry(entry: unknown): boolean {
  const p = basePackage(entry)
  return p !== null && p.toLowerCase().includes("token-optimizer")
}

/** The highest-priority document that declares the token-optimizer entry. */
function findSelfDoc(docs: Doc[]): Doc | null {
  let best: Doc | null = null
  for (const doc of docs) {
    if (!doc.parsed || !Array.isArray(doc.parsed.plugins)) continue
    if (!doc.parsed.plugins.some(isSelfEntry)) continue
    if (!best || doc.priority > best.priority) best = doc
  }
  return best
}

function entryOptions(doc: Doc | null): Record<string, unknown> {
  if (!doc?.parsed || !Array.isArray(doc.parsed.plugins)) return {}
  const entry = doc.parsed.plugins.find(isSelfEntry)
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const opts = (entry as { options?: unknown }).options
    if (opts && typeof opts === "object" && !Array.isArray(opts)) return opts as Record<string, unknown>
  }
  return {}
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** Installed-anywhere check across every loaded document. */
function companionInstalled(docs: Doc[], companion: (typeof COMPANIONS)[number]): boolean {
  for (const doc of docs) {
    const plugins = doc.parsed?.plugins
    if (Array.isArray(plugins) && companion.pkg && plugins.some((e) => basePackage(e) === companion.pkg)) return true
    if (companion.mcp) {
      const servers = asObject(asObject(doc.parsed?.mcp)?.servers)
      if (servers && servers[companion.mcp.name]) return true
    }
  }
  return false
}

function buildRows(docs: Doc[], selfDoc: Doc | null): OptionRow[] {
  const eff = parseOptions(entryOptions(selfDoc))
  const rows: OptionRow[] = []

  for (const f of FEATURES) {
    let enabled: boolean
    switch (f.key) {
      case "compress":
        enabled = eff.tool.maxChars > 0
        break
      case "dedupe":
        enabled = eff.tool.dedupeWindow > 0
        break
      case "internChunks":
        enabled = eff.tool.internChunks
        break
      case "rotate":
        enabled = eff.rotation.auto
        break
      case "historyDigest":
        enabled = eff.state.digestChars > 0
        break
      case "rtk":
        enabled = eff.rtk.enabled
        break
      case "caveman":
        enabled = eff.caveman.enabled
        break
      case "ramCache":
        enabled = eff.tool.ramCache
        break
      case "downscaleImages":
        enabled = eff.tool.downscaleImages
        break
      case "pressureRouting":
        enabled = eff.tool.pressureRouting
        break
      default:
        enabled = false
    }
    rows.push({ key: f.key, label: f.label, desc: f.desc, section: "feature", enabled })
  }

  for (const t of TRANSFORMS) {
    const enabled = (eff.tool as unknown as Record<string, unknown>)[t.key] === true
    rows.push({ key: t.key, label: t.label, desc: t.desc, section: "transform", enabled })
  }

  for (const c of COMPANIONS) {
    rows.push({
      key: c.id,
      label: c.label,
      desc: c.desc,
      section: "companion",
      enabled: companionInstalled(docs, c),
    })
  }

  return rows
}

/** Applies one feature switch onto a live options object (merge, never wipe). */
function applyFeature(opts: Record<string, unknown>, key: string, enabled: boolean): void {
  const tool = asObject(opts.tool) ?? (opts.tool = {})
  const rotation = asObject(opts.rotation) ?? (opts.rotation = {})
  const rtk = asObject(opts.rtk) ?? (opts.rtk = {})
  const caveman = asObject(opts.caveman) ?? (opts.caveman = {})

  switch (key) {
    case "compress":
      tool.maxChars = enabled ? 24000 : 0
      tool.stripAnsi = enabled
      tool.collapseBlank = enabled
      break
    case "dedupe": {
      const current = typeof tool.dedupeWindow === "number" ? tool.dedupeWindow : 4
      tool.dedupeWindow = enabled ? (current > 0 ? current : 4) : 0
      break
    }
    case "internChunks":
      tool.internChunks = enabled
      break
    case "rotate":
      rotation.auto = enabled
      break
    case "historyDigest": {
      // Lazy `state`: configs written before this feature have no state key.
      const state = asObject(opts.state) ?? (opts.state = {})
      const current = typeof state.digestChars === "number" ? state.digestChars : 4000
      state.digestChars = enabled ? (current > 0 ? current : 4000) : 0
      break
    }
    case "rtk":
      rtk.enabled = enabled
      break
    case "caveman":
      caveman.enabled = enabled
      break
    case "ramCache":
      tool.ramCache = enabled
      break
    case "downscaleImages":
      tool.downscaleImages = enabled
      break
    case "pressureRouting":
      tool.pressureRouting = enabled
      break
  }
}

export function createOptmgr(options: OptmgrOptions) {
  const globalDir = options.globalDir ?? path.join(os.homedir(), ".config", "opencode")

  function snapshot(): { docs: Doc[]; warnings: string[]; selfDoc: Doc | null; targetFile: string } {
    const { docs, warnings } = loadDocs(options.directory, globalDir)
    const selfDoc = findSelfDoc(docs)
    const targetFile = selfDoc?.path ?? ""
    return { docs, warnings, selfDoc, targetFile }
  }

  function get(): OptionsGetResult {
    const { docs, warnings, selfDoc, targetFile } = snapshot()
    return { rows: buildRows(docs, selfDoc), file: targetFile, warnings }
  }

  function set(changes: Array<{ key: string; enabled: boolean }>): OptionsSetResult {
    const { docs, warnings, selfDoc } = snapshot()
    const errors: string[] = []
    const backups: string[] = []
    const dirty = new Set<Doc>()

    const featureKeys = new Set(FEATURES.map((f) => f.key))
    const transformKeys = new Set(TRANSFORMS.map((t) => t.key))
    const companionKeys = new Set(COMPANIONS.map((c) => c.id))

    const wantsOptions = changes.some((c) => featureKeys.has(c.key) || transformKeys.has(c.key))
    if (wantsOptions && !selfDoc) {
      errors.push("token-optimizer entry not found in any config file - run Install.cmd, then retry")
    } else if (wantsOptions && selfDoc && !selfDoc.writable) {
      errors.push(`${selfDoc.path}: commented (JSONC) config cannot be edited - change options there by hand`)
    }

    if (selfDoc && selfDoc.writable && wantsOptions) {
      const entry = (selfDoc.parsed!.plugins! as unknown[]).find(isSelfEntry)
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        errors.push("token-optimizer entry is a plain string - give it an options object by hand")
      } else {
        const before = JSON.stringify(selfDoc.parsed)
        const opts = asObject((entry as { options?: unknown }).options) ?? ((entry as { options?: unknown }).options = {})
        for (const change of changes) {
          if (featureKeys.has(change.key)) applyFeature(opts, change.key, change.enabled)
          else if (transformKeys.has(change.key)) opts.tool = { ...(asObject(opts.tool) ?? {}), [change.key]: change.enabled }
        }
        if (JSON.stringify(selfDoc.parsed) !== before) dirty.add(selfDoc)
      }
    }

    // Companion adds land in the self doc (or the best writable fallback).
    const addDoc = selfDoc?.writable ? selfDoc : pickWriteDoc(docs, [], options.directory, globalDir)
    for (const change of changes) {
      if (!companionKeys.has(change.key)) continue
      const companion = COMPANIONS.find((c) => c.id === change.key)!
      if (change.enabled) {
        if (!addDoc || !addDoc.writable) {
          errors.push(`${companion.label}: no editable config file to add it to`)
          continue
        }
        if (companion.pkg) {
          const arr = Array.isArray(addDoc.parsed!.plugins) ? (addDoc.parsed!.plugins as unknown[]) : []
          if (arr.some((e) => basePackage(e) === companion.pkg)) continue
          const before = JSON.stringify(addDoc.parsed)
          addDoc.parsed!.plugins = [...arr, companion.pkg]
          if (JSON.stringify(addDoc.parsed) !== before) dirty.add(addDoc)
        } else if (companion.mcp) {
          const before = JSON.stringify(addDoc.parsed)
          const mcp = asObject(addDoc.parsed!.mcp) ?? (addDoc.parsed!.mcp = {})
          const servers = asObject(mcp.servers) ?? (mcp.servers = {})
          if (!servers[companion.mcp.name]) servers[companion.mcp.name] = { type: "remote", url: companion.mcp.url }
          if (JSON.stringify(addDoc.parsed) !== before) dirty.add(addDoc)
        }
      } else {
        // Uncheck = remove from every writable document (JSONC blockers error).
        const blocked: string[] = []
        for (const doc of docs) {
          if (!doc.parsed) continue

          if (companion.pkg && Array.isArray(doc.parsed.plugins)) {
            const arr = doc.parsed.plugins as unknown[]
            const kept = arr.filter((e) => basePackage(e) !== companion.pkg)
            if (kept.length !== arr.length) {
              if (!doc.writable) {
                blocked.push(doc.path)
              } else {
                const before = JSON.stringify(doc.parsed)
                doc.parsed.plugins = kept
                if (JSON.stringify(doc.parsed) !== before) dirty.add(doc)
              }
            }
          }

          if (companion.mcp) {
            const mcp = asObject(doc.parsed.mcp)
            const servers = mcp ? asObject(mcp.servers) : null
            const entry = servers ? servers[companion.mcp.name] : null
            const ours =
              entry && typeof entry === "object" && !Array.isArray(entry) && (entry as { url?: unknown }).url === companion.mcp.url
            if (entry && ours) {
              if (!doc.writable) {
                blocked.push(doc.path)
              } else {
                const before = JSON.stringify(doc.parsed)
                delete servers![companion.mcp.name]
                if (JSON.stringify(doc.parsed) !== before) dirty.add(doc)
              }
            }
          }
        }
        if (blocked.length) {
          errors.push(`${companion.label}: declared in commented config (${blocked.join(", ")}); remove it there by hand`)
        }
      }
    }

    // Retired offerings are stripped on every write, checked or not.
    for (const retired of RETIRED) {
      for (const doc of docs) {
        if (!doc.writable || !Array.isArray(doc.parsed?.plugins)) continue
        const arr = doc.parsed.plugins as unknown[]
        const kept = arr.filter((e) => basePackage(e) !== retired.pkg)
        if (kept.length === arr.length) continue
        const before = JSON.stringify(doc.parsed)
        doc.parsed.plugins = kept
        if (JSON.stringify(doc.parsed) !== before) dirty.add(doc)
      }
    }

    for (const doc of dirty) {
      try {
        if (doc.exists) backups.push(backupFile(doc.path))
        writeFile(doc.path, doc.parsed!)
      } catch (error) {
        errors.push(`${doc.path}: write failed (${msg(error)})`)
      }
    }

    const after = snapshot()
    return { rows: buildRows(after.docs, after.selfDoc), file: after.targetFile, warnings: after.warnings, backups, errors }
  }

  return { get, set }
}
