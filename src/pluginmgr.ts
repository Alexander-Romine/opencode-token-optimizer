/**
 * Whole-plugin inventory and on/off toggling (`/plugins`).
 *
 * OpenCode switches a plugin off by appending a `"-<id>"` string to some
 * config document's `plugins` array. The supervisor matches that selector
 * against the *resolved* plugin id (not the package name), a guarded set of
 * built-ins ignores it, and operations from every config document merge in
 * priority order (global lowest, nearest project file highest) - so:
 *
 *   1. rows join config add entries (`{ package }` objects and plain strings),
 *      `ctx.plugin.list()` (what runs or failed right now), and leftover
 *      `"-<id>"` directives (plugins switched off earlier);
 *   2. a package/path -> id map in plugin storage keeps rows associated
 *      across restarts after a plugin left the running inventory;
 *   3. a disable appends `-<id>` at the end of the highest-priority writable
 *      document at or above the declaring file (so a later add cannot
 *      re-enable it); an enable strips every matching directive from every
 *      writable document.
 *
 * Writes keep the installer's guarantees: one timestamped backup per file per
 * batch, strict-JSON round-trip (2-space indent, trailing newline), UTF-8
 * without BOM. A file with real comments (JSONC) is parsed for display after
 * stripping comments, but never rewritten - edits against it fail with a
 * friendly error instead.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { PluginChange, PluginRow, PluginsListResult, PluginsSetResult } from "./rpc"

/** One plugin as `ctx.plugin.list()` reports it (structurally typed). */
export interface PluginInfoLike {
  id?: string
  source: { type: string; target?: string; path?: string }
  features: Record<string, unknown>
  state: { status: string; error?: string }
}

/** Minimal storage surface (matches the server context's `ctx.storage`). */
export interface StorageLike {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

export interface PluginmgrOptions {
  /** Project location directory (where a fallback config would be created). */
  directory: string
  /** Global config directory; defaults to `~/.config/opencode`. */
  globalDir?: string
  /** Current plugin inventory (`ctx.plugin.list()` wrapped to return the array). */
  list(): Promise<PluginInfoLike[]>
  storage: StorageLike
}

/** Built-ins the supervisor refuses to remove (`PluginInternal.guarded`). */
const GUARDED = new Set(["opencode.config.policy", "opencode.provider.opencode"])

/** Plugin storage key for the package/path -> id map. */
const STORAGE_KEY = "plugin-ids"

interface Stored {
  targets: Record<string, string>
  labels: Record<string, string>
}

interface Doc {
  path: string
  /** Index in the candidate list: higher wins (later overrides earlier). */
  priority: number
  exists: boolean
  parsed: Record<string, unknown> | null
  writable: boolean
}

interface AddEntry {
  target: string
  raw: string
  doc: Doc
}

interface Removal {
  target: string
  doc: Doc
}

interface RowMeta {
  /** Config documents that declare this plugin (for write targeting). */
  entryPaths: string[]
  /** Directive strings whose removal re-enables this row. */
  needles: string[]
}

type InternalRow = PluginRow & { meta: RowMeta }

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** Path identity for matching: separators unified, case-folded on Windows. */
function norm(p: string): string {
  const s = p.replaceAll("\\", "/")
  return process.platform === "win32" ? s.toLowerCase() : s
}

/** Strips `//` and `/* *\/` comments outside strings (display-only for JSONC). */
function stripComments(raw: string): string {
  let out = ""
  let inString = false
  let escape = false
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charAt(i)
    if (inString) {
      out += c
      if (escape) escape = false
      else if (c === "\\") escape = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      continue
    }
    if (c === "/" && raw.charAt(i + 1) === "/") {
      while (i < raw.length && raw.charAt(i) !== "\n" && raw.charAt(i) !== "\r") i++
      continue
    }
    if (c === "/" && raw.charAt(i + 1) === "*") {
      i += 2
      while (i < raw.length && !(raw.charAt(i) === "*" && raw.charAt(i + 1) === "/")) i++
      i += 1 // loop increment moves past the closing slash
      continue
    }
    out += c
  }
  return out
}

/** Parses a strict JSON object; empty input counts as `{}`. */
function parseStrict(raw: string): Record<string, unknown> | null {
  const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  if (body.trim() === "") return {}
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    /* fall through */
  }
  return null
}

/** Parses after stripping comments: JSONC becomes readable (never writable). */
function parseLenient(raw: string): Record<string, unknown> | null {
  const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  return parseStrict(stripComments(body))
}

function resolveTarget(target: string, doc: Doc): string {
  if (target.startsWith("file://")) {
    try {
      return fileURLToPath(target)
    } catch {
      return target
    }
  }
  if (target.startsWith("./") || target.startsWith("../")) return path.resolve(path.dirname(doc.path), target)
  return target
}

function targetOf(plugin: PluginInfoLike): string | undefined {
  if (plugin.source.type === "package" && plugin.source.target) return plugin.source.target
  if (plugin.source.type === "local" && plugin.source.path) return plugin.source.path
  return undefined
}

function kindOf(plugin: PluginInfoLike): PluginRow["kind"] {
  const type = plugin.source.type
  if (type === "package" || type === "local" || type === "builtin" || type === "sdk") return type
  return "package"
}

function partsOf(plugin: PluginInfoLike): string[] {
  return ["server", "tui", "rpc", "gui"].filter((part) => plugin.features[part] === true)
}

/** This plugin locks itself: the manager lives inside token-optimizer. */
function isSelf(id: string, target: string): boolean {
  if (id === "token-optimizer") return true
  return target.toLowerCase().includes("token-optimizer")
}

/* ------------------------------------------------------------------ *
 * Config discovery
 * ------------------------------------------------------------------ */

/** Candidate config paths, ordered lowest -> highest priority, deduped. */
function candidates(dir: string, globalDir: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (p: string) => {
    const resolved = path.resolve(p)
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved
    if (seen.has(key)) return
    seen.add(key)
    out.push(resolved)
  }
  // Global first: it is always overridden by project files.
  push(path.join(globalDir, "opencode.json"))
  push(path.join(globalDir, "opencode.jsonc"))
  // Walk from the filesystem root down to the location so the nearest file wins.
  const dirs: string[] = []
  let current = path.resolve(dir)
  for (;;) {
    dirs.unshift(current)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  for (const d of dirs) {
    push(path.join(d, "opencode.json"))
    push(path.join(d, "opencode.jsonc"))
    push(path.join(d, ".opencode", "opencode.json"))
    push(path.join(d, ".opencode", "opencode.jsonc"))
  }
  return out
}

function loadDocs(dir: string, globalDir: string): { docs: Doc[]; warnings: string[]; files: string[] } {
  const docs: Doc[] = []
  const warnings: string[] = []
  const files: string[] = []
  const paths = candidates(dir, globalDir)
  for (let priority = 0; priority < paths.length; priority++) {
    const file = paths[priority]!
    let raw: string
    try {
      if (!fs.existsSync(file)) continue
      raw = fs.readFileSync(file, "utf8")
    } catch (error) {
      warnings.push(`${file}: unreadable (${msg(error)})`)
      continue
    }
    files.push(file)
    const strict = parseStrict(raw)
    if (strict) {
      docs.push({ path: file, priority, exists: true, parsed: strict, writable: true })
      continue
    }
    const lenient = parseLenient(raw)
    if (lenient) {
      docs.push({ path: file, priority, exists: true, parsed: lenient, writable: false })
      warnings.push(`${file}: comments (JSONC) - listed read-only, edits refused`)
      continue
    }
    docs.push({ path: file, priority, exists: true, parsed: null, writable: false })
    warnings.push(`${file}: not valid JSON - skipped`)
  }
  return { docs, warnings, files }
}

/* ------------------------------------------------------------------ *
 * Storage (package/path -> id map)
 * ------------------------------------------------------------------ */

function strMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (typeof val === "string") out[key] = val
    }
  }
  return out
}

function readStored(value: unknown): Stored {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    return { targets: strMap(obj.targets), labels: strMap(obj.labels) }
  }
  return { targets: {}, labels: {} }
}

/* ------------------------------------------------------------------ *
 * Row building
 * ------------------------------------------------------------------ */

function collectEntries(docs: Doc[]): { adds: AddEntry[]; removals: Removal[] } {
  const adds: AddEntry[] = []
  const removals: Removal[] = []
  for (const doc of docs) {
    if (!doc.parsed) continue
    const arr = doc.parsed.plugins
    if (!Array.isArray(arr)) continue
    for (const item of arr) {
      if (typeof item === "string") {
        if (item.startsWith("-")) {
          if (item.length > 1) removals.push({ target: item.slice(1), doc })
        } else if (item) {
          adds.push({ target: resolveTarget(item, doc), raw: item, doc })
        }
      } else if (item && typeof item === "object") {
        const pkg = (item as { package?: unknown }).package
        if (typeof pkg === "string" && pkg) adds.push({ target: resolveTarget(pkg, doc), raw: pkg, doc })
      }
    }
  }
  return { adds, removals }
}

function buildRows(
  docs: Doc[],
  active: PluginInfoLike[],
  stored: Stored,
  forcedDisable: Set<string> = new Set(),
): InternalRow[] {
  const { adds, removals } = collectEntries(docs)
  const removalSet = new Set(removals.map((r) => r.target))

  const byId = new Map<string, PluginInfoLike>()
  const byTarget = new Map<string, PluginInfoLike>()
  for (const plugin of active) {
    if (plugin.id) byId.set(plugin.id, plugin)
    const target = targetOf(plugin)
    if (target) byTarget.set(norm(target), plugin)
  }

  const idFor = (target: string): string | undefined => {
    const hit = byTarget.get(norm(target))
    if (hit?.id) return hit.id
    for (const [key, id] of Object.entries(stored.targets)) {
      if (norm(key) === norm(target)) return id
    }
    // A hand-written `-<id>` can be tied back through the remembered label.
    const nt = norm(target)
    for (const r of removals) {
      const label = stored.labels[r.target]
      if (label && norm(label) === nt) return r.target
    }
    return undefined
  }

  const rows = new Map<string, InternalRow>()

  // 1. Config add entries.
  for (const add of adds) {
    const id = idFor(add.target) ?? ""
    const key = id || norm(add.target)
    const existing = rows.get(key)
    if (existing) {
      if (!existing.meta.entryPaths.includes(add.doc.path)) existing.meta.entryPaths.push(add.doc.path)
      for (const needle of [`-${add.raw}`, `-${add.target}`]) {
        if (!existing.meta.needles.includes(needle)) existing.meta.needles.push(needle)
      }
      continue
    }
    const plugin = (id ? byId.get(id) : undefined) ?? byTarget.get(norm(add.target))
    const running = !!plugin && !forcedDisable.has(key)
    const removed = (id ? removalSet.has(id) : false) || removalSet.has(add.target)
    const failed = plugin?.state.status === "failed"
    const self = isSelf(id, add.target)
    const locked = (id && GUARDED.has(id)) || self
    const status: PluginRow["status"] = running
      ? failed
        ? "failed"
        : "active"
      : removed
        ? "disabled"
        : "unknown"
    const kind: PluginRow["kind"] = plugin
      ? kindOf(plugin)
      : path.isAbsolute(add.target) || add.target.startsWith("file:")
        ? "local"
        : "package"
    const needles = new Set<string>()
    if (id) needles.add(`-${id}`)
    needles.add(`-${add.raw}`)
    needles.add(`-${add.target}`)
    needles.delete("-")
    rows.set(key, {
      key,
      label: add.raw,
      id,
      kind,
      file: add.doc.path,
      enabled: running ? true : !removed,
      parts: plugin ? partsOf(plugin) : [],
      status,
      locked: !!locked,
      detail: self
        ? "disable it from the installer"
        : locked
          ? "built into OpenCode"
          : failed
            ? plugin?.state.error ?? ""
            : "",
      meta: { entryPaths: [add.doc.path], needles: [...needles] },
    })
  }

  // 2. Running plugins with no visible config entry (builtins, sdk, discovered dirs).
  for (const plugin of active) {
    if (!plugin.id) continue
    const existing = rows.get(plugin.id)
    if (existing) {
      if (forcedDisable.has(plugin.id)) continue
      existing.enabled = true
      existing.status = plugin.state.status === "failed" ? "failed" : "active"
      existing.parts = partsOf(plugin)
      if (plugin.state.status === "failed" && !existing.detail) existing.detail = plugin.state.error ?? ""
      continue
    }
    const target = targetOf(plugin) ?? ""
    const failed = plugin.state.status === "failed"
    const self = isSelf(plugin.id, target)
    const locked = GUARDED.has(plugin.id) || self
    rows.set(plugin.id, {
      key: plugin.id,
      label: stored.labels[plugin.id] ?? (target || plugin.id),
      id: plugin.id,
      kind: kindOf(plugin),
      file: "",
      enabled: !forcedDisable.has(plugin.id),
      parts: partsOf(plugin),
      status: forcedDisable.has(plugin.id) ? "disabled" : failed ? "failed" : "active",
      locked,
      detail: self
        ? "disable it from the installer"
        : locked
          ? "built into OpenCode"
          : failed
            ? plugin.state.error ?? ""
            : "",
      meta: { entryPaths: [], needles: [`-${plugin.id}`] },
    })
  }

  // 3. Directives that matched no row: a plugin disabled in an earlier run.
  for (const r of removals) {
    if (rows.has(r.target) || rows.has(norm(r.target))) continue
    const known = stored.labels[r.target]
    rows.set(r.target, {
      key: r.target,
      label: known ?? r.target,
      id: r.target,
      kind: "directive",
      file: r.doc.path,
      enabled: false,
      parts: [],
      status: "disabled",
      locked: GUARDED.has(r.target),
      detail: GUARDED.has(r.target) ? "built into OpenCode" : known ? "disabled - not loaded" : "no matching plugin",
      meta: { entryPaths: [], needles: [`-${r.target}`] },
    })
  }

  return [...rows.values()]
}

function toPublic(row: InternalRow): PluginRow {
  return {
    key: row.key,
    label: row.label,
    id: row.id,
    kind: row.kind,
    file: row.file,
    enabled: row.enabled,
    parts: row.parts,
    status: row.status,
    locked: row.locked,
    detail: row.detail,
  }
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

function isWithin(file: string, dir: string): boolean {
  const rel = path.relative(dir, file)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

/**
 * The document a disable directive goes into.
 *
 * With a declaring file: the highest-priority one (the directive lands at the
 * end of its own `plugins` array, so it beats every add below it). If that
 * file is JSONC, only a writable file ranked above it can still win.
 * Without one (builtin, sdk, discovered dir): the project config, else the
 * global config, else any writable config.
 */
function pickWriteDoc(docs: Doc[], entryPaths: string[], directory: string, globalDir: string): Doc | null {
  if (entryPaths.length > 0) {
    let top: Doc | null = null
    for (const entry of entryPaths) {
      const doc = docs.find((d) => d.path === entry)
      if (doc && (!top || doc.priority > top.priority)) top = doc
    }
    if (!top) return null
    if (top.writable) return top
    let best: Doc | null = null
    for (const doc of docs) {
      if (!doc.writable || doc.priority <= top.priority) continue
      if (!best || doc.priority > best.priority) best = doc
    }
    return best
  }
  const pick = (test: (doc: Doc) => boolean): Doc | null => {
    let best: Doc | null = null
    for (const doc of docs) {
      if (!doc.writable || !test(doc)) continue
      if (!best || doc.priority > best.priority) best = doc
    }
    return best
  }
  return pick((doc) => isWithin(doc.path, directory)) ?? pick((doc) => isWithin(doc.path, globalDir)) ?? pick(() => true)
}

function ensurePlugins(doc: Doc): unknown[] | null {
  if (!doc.parsed) return null
  const arr = doc.parsed.plugins
  if (arr === undefined) {
    doc.parsed.plugins = []
    return doc.parsed.plugins as unknown[]
  }
  return Array.isArray(arr) ? arr : null
}

function backupFile(file: string): string {
  const backup = `${file}.bak-${stamp()}`
  fs.copyFileSync(file, backup)
  return backup
}

function writeFile(file: string, parsed: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // Node writes utf8 without a BOM; 2-space indent + trailing newline.
  fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8")
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

export function createPluginmgr(options: PluginmgrOptions) {
  const globalDir = options.globalDir ?? path.join(os.homedir(), ".config", "opencode")
  const storageKey = STORAGE_KEY

  async function safeList(): Promise<{ active: PluginInfoLike[]; warning?: string }> {
    try {
      const active = await options.list()
      return { active: Array.isArray(active) ? active : [] }
    } catch (error) {
      return { active: [], warning: `plugin inventory unavailable (${msg(error)})` }
    }
  }

  async function readStoredMap(): Promise<Stored> {
    try {
      return readStored(await options.storage.get(storageKey))
    } catch {
      return { targets: {}, labels: {} }
    }
  }

  /** Remembers package/path -> id so disabled plugins stay recognizable. */
  async function persist(active: PluginInfoLike[], stored: Stored): Promise<void> {
    const next: Stored = { targets: { ...stored.targets }, labels: { ...stored.labels } }
    for (const plugin of active) {
      if (!plugin.id) continue
      const target = targetOf(plugin)
      if (target) {
        next.targets[target] = plugin.id
        next.labels[plugin.id] = target
      } else if (!(plugin.id in next.labels)) {
        next.labels[plugin.id] = plugin.id
      }
    }
    if (JSON.stringify(next) !== JSON.stringify(stored)) {
      try {
        await options.storage.set(storageKey, next)
      } catch {
        /* storage is a cache; losing it only degrades labels */
      }
    }
  }

  async function list(): Promise<PluginsListResult> {
    const { docs, warnings, files } = loadDocs(options.directory, globalDir)
    const { active, warning } = await safeList()
    if (warning) warnings.push(warning)
    const stored = await readStoredMap()
    const rows = buildRows(docs, active, stored)
    await persist(active, stored)
    return { rows: rows.map(toPublic), warnings, files }
  }

  async function set(changes: PluginChange[]): Promise<PluginsSetResult> {
    const { docs, warnings, files } = loadDocs(options.directory, globalDir)
    const { active, warning } = await safeList()
    if (warning) warnings.push(warning)
    const stored = await readStoredMap()
    const rows = buildRows(docs, active, stored)
    const byKey = new Map(rows.map((row) => [row.key, row]))
    const errors: string[] = []
    const backups: string[] = []
    const dirty = new Set<string>()
    const disabledNow = new Set<string>()

    for (const change of changes) {
      const row = byKey.get(change.key)
      if (!row) {
        errors.push(`unknown plugin: ${change.key}`)
        continue
      }
      if (row.locked) {
        errors.push(`${row.label}: ${row.detail || "cannot be toggled"}`)
        continue
      }
      if (row.enabled === change.enabled) continue

      if (!change.enabled) {
        if (!row.id) {
          errors.push(
            `${row.label}: plugin id unknown (it has never loaded in this location); add "-<id>" to the config by hand`,
          )
          continue
        }
        let doc = pickWriteDoc(docs, row.meta.entryPaths, options.directory, globalDir)
        if (!doc) {
          if (row.meta.entryPaths.length > 0) {
            errors.push(
              `${row.label}: declared in a commented (JSONC) config that cannot be edited; add "-${row.id}" there by hand`,
            )
            continue
          }
          // Nothing editable exists yet: create a project config for it.
          const created = path.join(options.directory, "opencode.json")
          if (docs.some((d) => d.path === created)) {
            errors.push(`${row.label}: ${created} exists but cannot be edited (JSONC); add "-${row.id}" there by hand`)
            continue
          }
          doc = { path: created, priority: Number.MAX_SAFE_INTEGER, exists: false, parsed: {}, writable: true }
          docs.push(doc)
        }
        const before = JSON.stringify(doc.parsed)
        const arr = ensurePlugins(doc)
        if (!arr) {
          errors.push(`${doc.path}: "plugins" is not an array - fix it by hand`)
          continue
        }
        const directive = `-${row.id}`
        doc.parsed!.plugins = [...arr.filter((item) => item !== directive), directive]
        if (JSON.stringify(doc.parsed) !== before) dirty.add(doc.path)
        disabledNow.add(row.key)
      } else {
        const needles = new Set(row.meta.needles)
        if (row.id) needles.add(`-${row.id}`)
        let removed = 0
        const blocked: string[] = []
        for (const doc of docs) {
          if (!doc.parsed) continue
          const arr = doc.parsed.plugins
          if (!Array.isArray(arr)) continue
          const kept = arr.filter((item) => !(typeof item === "string" && needles.has(item)))
          if (kept.length === arr.length) continue
          if (!doc.writable) {
            blocked.push(doc.path)
            continue
          }
          const before = JSON.stringify(doc.parsed)
          doc.parsed.plugins = kept
          if (JSON.stringify(doc.parsed) !== before) dirty.add(doc.path)
          removed += arr.length - kept.length
        }
        if (blocked.length) {
          errors.push(
            `${row.label}: still disabled by commented config (${blocked.join(", ")}); remove the directive there by hand`,
          )
        } else if (removed === 0) {
          errors.push(`${row.label}: no disable directive found in any editable config`)
        }
      }
    }

    for (const file of dirty) {
      const doc = docs.find((d) => d.path === file)
      if (!doc || !doc.parsed) continue
      try {
        if (doc.exists) backups.push(backupFile(doc.path))
        writeFile(doc.path, doc.parsed)
      } catch (error) {
        errors.push(`${doc.path}: write failed (${msg(error)})`)
      }
    }

    // Rows reflect the directives just written; freshly disabled plugins may
    // still appear in the (stale) inventory until the config hot-reloads.
    const finalRows = buildRows(docs, active, stored, disabledNow)
    await persist(active, stored)
    return { rows: finalRows.map(toPublic), warnings, files, backups, errors }
  }

  return { list, set }
}
