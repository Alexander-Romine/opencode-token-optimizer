/**
 * Tool result optimization: compression, verified dedupe, structural
 * reductions, and savings accounting.
 *
 * This is where most of the tokens actually go - tool output is typically the
 * majority of an agent's context. Transformations apply, in order:
 *
 *  1. **Dedupe (verified).** The result is hashed. If the same tool produced a
 *     byte-identical result within the last `dedupeWindow` calls, the repeat is
 *     replaced with a stub. Because the hash is computed over the freshly
 *     produced content, this can never hide a difference - it only removes a
 *     true duplicate that is still verifiably in context.
 *
 *  2. **Structural (see `transformText`).** Lossless by default: whole-JSON
 *     whitespace collapse, markdown table padding strip. Opt-in lossy: base64
 *     scrub, repeated-line collapse, stack frames, diff context, HTML pages,
 *     timestamps, home paths. Runs after RTK, before compression, and never
 *     on the `read` tool (file bytes must stay faithful for `edit`).
 *
 *  2b. **Device-RAM cache.** The full RTK+transform+compress result for a
 *     given (tool, command, exact bytes) is memoized in a bounded LRU, so a
 *     repeat skips the pipeline without ever serving a stale or foreign
 *     result - the key IS the input.
 *
 *  3. **Clean.** ANSI/control bytes stripped, CR normalized, blank runs
 *     collapsed, optional trailing-whitespace trim. Pure noise removal.
 *
 *  4. **Truncate.** Head + tail kept inside `maxChars` with a marker saying how
 *     much was dropped, so the model always knows content is missing.
 *
 * Everything hot goes through the Rust addon; see `native.ts`.
 */
// Explicit .ts extensions so Node's strip-only test runner can resolve them;
// bundler-style resolvers (OpenCode/Bun) accept them too.
import os from "node:os"
import { api } from "./native.ts"
import { compressOptions, type Options, type ToolOptions } from "./options.ts"
import { reduceCommand } from "./rtk.ts"

/** Minimum length of a base64 run the scrubber will consider. */
const BASE64_MIN = 500
/** Shortest line `collapseRepeats` touches - `}` runs and rules never collapse. */
const REPEAT_MIN_LINE = 80
/** Identical-line run length needed before collapsing (2 saves too little). */
const REPEAT_MIN_RUN = 3
/** Identical stack frames needed before collapsing (recursion, not noise). */
const STACK_MIN_RUN = 3
/** Unchanged diff lines needed before a run is collapsed. */
const DIFF_MIN_RUN = 8
/** Unchanged diff lines kept at each end of a collapsed run. */
const DIFF_KEEP = 2
/** Results smaller than this are never worth a cache slot (recompute is cheaper). */
const CACHE_MIN_CHARS = 256

/**
 * Lossless: when a whole tool result is exactly one JSON value, re-serialize
 * it without insignificant whitespace. Parse-gated in both directions: text
 * that is not one JSON document (JSONL, prose-wrapped, truncated) is untouched.
 */
function compactJson(text: string): string {
  const head = text.trimStart()
  const first = head.charAt(0)
  if (first !== "{" && first !== "[") return text
  const last = text.trimEnd().slice(-1)
  if (last !== "}" && last !== "]") return text
  try {
    const out = JSON.stringify(JSON.parse(text))
    return out !== null && out.length < text.length ? out : text
  } catch {
    return text
  }
}

/**
 * Lossless: strip alignment padding from markdown table rows so cells render
 * identically with fewer characters. Skips fenced code blocks and rows with
 * escaped pipes (splitting those would corrupt cell content).
 */
function collapseTable(text: string): string {
  const lines = text.split("\n")
  let fence = false
  let changed = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      fence = !fence
      continue
    }
    if (fence || !trimmed.startsWith("|") || !trimmed.endsWith("|")) continue
    if (line.includes("\\|")) continue
    const lead = line.slice(0, line.length - line.trimStart().length)
    const cells = trimmed.split("|")
    if (cells.length < 3 || !cells.some((cell) => cell.trim() !== "")) continue
    const next = lead + cells.map((cell) => cell.trim()).join("|")
    if (next.length < line.length) {
      lines[i] = next
      changed = true
    }
  }
  return changed ? lines.join("\n") : text
}

/**
 * Lossy (opt-in): elide base64 blobs with an honest marker. Requires a
 * base64-only signal (+, / or padding) inside the run so long hex/word
 * strings are never touched.
 */
function scrubBase64(text: string): string {
  const pattern = new RegExp(`[A-Za-z0-9+/]{${BASE64_MIN},}={0,2}`, "g")
  return text.replace(pattern, (run) =>
    /[+/=]/.test(run) ? `[token-optimizer: base64 blob of ${run.length} chars elided]` : run,
  )
}

/**
 * Lossy (opt-in): collapse runs of identical long lines to the first line
 * plus a count marker. The length gate keeps structural noise (`}`, `---`)
 * in logs and file listings untouched.
 */
function collapseRepeats(text: string): string {
  const lines = text.split("\n")
  const out: string[] = []
  let changed = false
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!
    let j = i + 1
    if (line.trim().length >= REPEAT_MIN_LINE) {
      while (j < lines.length && lines[j] === line) j++
    }
    if (j - i >= REPEAT_MIN_RUN) {
      out.push(line, `[token-optimizer: ${j - i - 1} more identical lines omitted]`)
      changed = true
      i = j
    } else {
      out.push(line)
      i++
    }
  }
  return changed ? out.join("\n") : text
}

/** Node/Java stack frames and Python `File "..."` lines. */
const STACK_FRAME = /^\s+(?:at\s+\S.*|File\s+".*",\s+line\s+\d+.*)$/

/**
 * Lossy (opt-in): collapse runs of >=3 byte-identical stack frames to the
 * first frame plus a count - recursion dumps lose their repetition, never a
 * unique frame. Gated on frame shape so ordinary log lines are untouched.
 */
function collapseStacks(text: string): string {
  const lines = text.split("\n")
  const out: string[] = []
  let changed = false
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!
    if (STACK_FRAME.test(line)) {
      let j = i + 1
      while (j < lines.length && lines[j] === line) j++
      if (j - i >= STACK_MIN_RUN) {
        out.push(line, `[token-optimizer: ${j - i - 1} more identical stack frames omitted]`)
        changed = true
        i = j
        continue
      }
    }
    out.push(line)
    i++
  }
  return changed ? out.join("\n") : text
}

/** A real unified diff has hunk headers plus a file header of some shape. */
const DIFF_HUNK = /^@@ -\d/m
const DIFF_GIT = /^diff --git /m
const DIFF_TRAD = /^--- /m
const DIFF_TRAD_PLUS = /^\+\+\+ /m

/**
 * Lossy (opt-in): collapse long runs of unchanged context lines inside
 * unified diffs to two lines each side plus an honest marker - the same
 * trade GitHub's own diff view makes. Added/removed/hunk/file lines are
 * never touched, and text that only looks diff-ish is left alone.
 */
function collapseDiff(text: string): string {
  if (!DIFF_HUNK.test(text)) return text
  if (!DIFF_GIT.test(text) && !(DIFF_TRAD.test(text) && DIFF_TRAD_PLUS.test(text))) return text

  const lines = text.split("\n")
  const out: string[] = []
  let context: string[] = []
  let inHunk = false
  let changed = false

  const flush = () => {
    if (context.length === 0) return
    if (inHunk && context.length >= DIFF_MIN_RUN) {
      const omitted = context.length - DIFF_KEEP * 2
      if (omitted > 0) {
        out.push(
          ...context.slice(0, DIFF_KEEP),
          `[token-optimizer: ${omitted} unchanged lines omitted]`,
          ...context.slice(-DIFF_KEEP),
        )
        changed = true
        context = []
        return
      }
    }
    out.push(...context)
    context = []
  }

  for (const line of lines) {
    if (line.startsWith("@@")) {
      flush()
      inHunk = true
      out.push(line)
      continue
    }
    if (line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      flush()
      inHunk = false
      out.push(line)
      continue
    }
    if (inHunk && (line.startsWith(" ") || line === "")) {
      context.push(line)
      continue
    }
    flush()
    out.push(line)
  }
  flush()
  return changed ? out.join("\n") : text
}

/** Full timestamps only - bare dates and version numbers are never touched. */
const TS_ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?/g
const TS_SPACE = /\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,9})?\b/g

/**
 * Lossy (opt-in): full timestamps become `<ts>`. Line order still carries
 * chronology, and the placeholder is visible, so nothing hides what changed.
 */
function normalizeTime(text: string): string {
  return text.replace(TS_ISO, "<ts>").replace(TS_SPACE, "<ts>")
}

/**
 * Lossy (opt-in): replace this machine's home-directory prefix with `~` in
 * path references (both separator styles). Only whole `home + separator`
 * prefixes match, so `C:\Users\cosmi2` and lookalikes are never rewritten.
 */
function shortenPaths(text: string): string {
  let home = ""
  try {
    home = os.homedir()
  } catch {
    return text
  }
  if (!home || home.length < 4) return text
  let out = text
  const bases = new Set([home, home.replace(/\\/g, "/"), home.replace(/\//g, "\\")])
  for (const base of bases) {
    const root = base.replace(/[/\\]+$/, "")
    if (root.length < 4) continue
    for (const sep of ["\\", "/"]) {
      const from = root + sep
      if (out.includes(from)) out = out.split(from).join(`~${sep}`)
    }
  }
  return out
}

/** Real pages carry html/body/doctype - JSX and source code do not. */
const HTML_SIGNAL = /<!doctype\s+html|<html[\s>]|<body[\s>]/i

/**
 * Lossy (opt-in): convert a raw HTML page to its text. Only fires when the
 * output looks like a page (doctype/`<html>`/`<body>`), so JSX, component
 * source and error messages containing markup pass through untouched.
 */
function stripHtml(text: string): string {
  if (!HTML_SIGNAL.test(text)) return text
  let out = text
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
  out = out.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
  out = out.replace(/<!--[\s\S]*?-->/g, "")
  out = out.replace(/<br\s*\/?>/gi, "\n")
  out = out.replace(/<\/(?:p|div|li|tr|h[1-6]|section|article|main|nav|header|footer)\s*>/gi, "\n")
  out = out.replace(/<[^>]+>/g, " ")
  out = out
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
  out = out.replace(/[ \t]{2,}/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n")
  return out
}

/**
 * Structural reductions for one text item, applied after RTK and before
 * compression. `read` is skipped: file contents must reach the model
 * byte-faithful so `edit` oldString matching still works against them.
 */
export function transformText(text: string, tool: string, opts: ToolOptions): string {
  if (tool === "read") return text
  let out = text
  if (opts.compactJson) out = compactJson(out)
  if (opts.collapseTable) out = collapseTable(out)
  if (opts.collapseDiff) out = collapseDiff(out)
  if (opts.collapseStacks) out = collapseStacks(out)
  if (opts.collapseRepeats) out = collapseRepeats(out)
  if (opts.normalizeTime) out = normalizeTime(out)
  if (opts.shortenPaths) out = shortenPaths(out)
  if (opts.stripHtml) out = stripHtml(out)
  if (opts.scrubBase64) out = scrubBase64(out)
  return out
}

export interface ToolCallOutcome {
  /** Characters the tool produced before any optimization. */
  originalChars: number
  /** Characters actually handed to the model. */
  finalChars: number
  deduped: boolean
  truncated: boolean
}

interface RingEntry {
  tool: string
  hash: string
  chars: number
  /** Global tool-call ordinal, used to phrase the stub. */
  seq: number
  /** True when this entry's own content was withheld - never match those. */
  stubbed: boolean
}

function isTextItem(item: unknown): item is { type: "text"; text: string } {
  return (
    !!item &&
    typeof item === "object" &&
    (item as { type?: unknown }).type === "text" &&
    typeof (item as { text?: unknown }).text === "string"
  )
}

/** How many sessions may have a remembered ring at once. */
const MAX_RING_SESSIONS = 50

/** One memoized pipeline result (RTK + transforms + compress). */
interface CacheEntry {
  text: string
  truncated: boolean
}

/** Live counters surfaced in the `/tokens` report. */
export interface RamCacheStats {
  enabled: boolean
  hits: number
  misses: number
  entries: number
  /** Current key+value char footprint, bounded by `tool.ramCacheChars`. */
  chars: number
}

export class ToolOptimizer {
  /**
   * Recent results, keyed by session. Scoping matters: a stub claims the
   * content "is still in context", which is only true for the session that
   * produced it.
   */
  private readonly rings = new Map<string, RingEntry[]>()
  private readonly seq = new Map<string, number>()

  /**
   * Device-RAM LRU: content-addressed by (tool, command, exact original), so
   * a hit is always the correct result for that input. Map iteration order is
   * insertion order - re-insert on hit, evict from the front, which is LRU.
   */
  private readonly cache = new Map<string, CacheEntry>()
  private cacheChars = 0
  private cacheHits = 0
  private cacheMisses = 0

  private readonly options: Options

  // Plain field instead of a parameter property: Node's type-stripping mode
  // (used by the .mjs tests) cannot parse `constructor(private ...)`.
  constructor(options: Options) {
    this.options = options
  }

  private get window(): number {
    return this.options.tool.dedupeWindow
  }

  private excluded(tool: string): boolean {
    return this.options.tool.exclude.includes(tool)
  }

  private cacheGet(key: string): CacheEntry | undefined {
    const hit = this.cache.get(key)
    if (!hit) {
      this.cacheMisses++
      return undefined
    }
    this.cache.delete(key) // re-insert: Map preserves insertion order = recency
    this.cache.set(key, hit)
    this.cacheHits++
    return hit
  }

  private cachePut(key: string, entry: CacheEntry): void {
    const budget = this.options.tool.ramCacheChars
    const size = key.length + entry.text.length
    if (budget <= 0 || size > budget) return // one oversized entry would evict everything
    while (this.cacheChars + size > budget && this.cache.size > 0) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      const victim = this.cache.get(oldest)
      this.cacheChars -= oldest.length + (victim?.text.length ?? 0)
      this.cache.delete(oldest)
    }
    this.cache.set(key, entry)
    this.cacheChars += size
  }

  /** Cache counters for the `/tokens` report. */
  cacheStats(): RamCacheStats {
    return {
      enabled: this.options.tool.ramCache,
      hits: this.cacheHits,
      misses: this.cacheMisses,
      entries: this.cache.size,
      chars: this.cacheChars,
    }
  }

  private ringFor(sessionID: string): RingEntry[] {
    let ring = this.rings.get(sessionID)
    if (ring) {
      // Refresh recency so a steady stream of sessions cannot grow the map.
      this.rings.delete(sessionID)
      this.rings.set(sessionID, ring)
      return ring
    }
    ring = []
    if (this.rings.size >= MAX_RING_SESSIONS) {
      const oldest = this.rings.keys().next().value
      if (oldest !== undefined) this.rings.delete(oldest)
    }
    this.rings.set(sessionID, ring)
    return ring
  }

  /**
   * Rewrite `result.content` in place. Returns `null` when the tool is excluded
   * or the result has no text payload. `command` is the shell command for
   * shell-like tools (from the tool input); when RTK recognises it, the output
   * is reduced to its signal before compression.
   */
  optimize(sessionID: string, tool: string, result: unknown, command?: string): ToolCallOutcome | null {
    const payload = result as { content?: unknown } | null | undefined
    if (!payload || !Array.isArray(payload.content)) return null
    if (this.excluded(tool)) return null

    const compressOpts = compressOptions(this.options.tool)
    const entries = payload.content.filter(isTextItem)
    if (entries.length === 0) return null

    // Without a session we cannot scope the ring, so dedupe is off: the stub
    // would claim the content "is still in context" with nothing to back it.
    const window = sessionID ? this.window : 0

    const nextSeq = (this.seq.get(sessionID) ?? 0) + 1
    this.seq.set(sessionID, nextSeq)
    const callSeq = nextSeq

    let originalChars = 0
    let finalChars = 0
    let anyDeduped = false
    let anyTruncated = false

    // Look back only at results produced before this call.
    const previous = window > 0 ? [...this.ringFor(sessionID)] : []
    const newRing: RingEntry[] = []

    for (const item of entries) {
      const original = item.text
      originalChars += original.length

      const hash = api.hashParts([tool, original])
      const match =
        original.length >= this.options.tool.dedupeMinChars
          ? previous.find((entry) => entry.tool === tool && entry.hash === hash && !entry.stubbed)
          : undefined

      if (match) {
        const callsBack = Math.max(1, callSeq - match.seq)
        item.text =
          `[token-optimizer] ${match.chars} chars withheld: byte-identical ` +
          `${tool} output from ${callsBack} call${callsBack === 1 ? "" : "s"} ago ` +
          `(verified by content hash), and it is still in context. ` +
          `Use a different argument if you need it re-read.`
        finalChars += item.text.length
        anyDeduped = true
        newRing.push({ tool, hash, chars: match.chars, seq: callSeq, stubbed: true })
        continue
      }

      // Device-RAM cache: same (tool, command, exact bytes) in, same result
      // out - a hit skips RTK + transforms + compress entirely. Small inputs
      // are not worth a slot; the dedupe ring above still owns stubs.
      const cacheKey =
        this.options.tool.ramCache && original.length >= CACHE_MIN_CHARS
          ? `${tool}\u001f${command ?? ""}\u001f${original}`
          : null
      let hit: CacheEntry | null = null
      if (cacheKey !== null) hit = this.cacheGet(cacheKey) ?? null

      if (!hit) {
        const compressed = api.compress(
          // RTK and the structural transforms reduce only what the model
          // actually receives. The dedupe hash above stays over the original,
          // so a "byte-identical" claim can never be satisfied by two different
          // outputs that reduce to the same text.
          transformText(
            command && this.options.rtk.enabled
              ? reduceCommand(command, original, this.options.rtk)
              : original,
            tool,
            this.options.tool,
          ),
          compressOpts,
        )
        hit = { text: compressed.text, truncated: compressed.truncated }
        if (cacheKey !== null) this.cachePut(cacheKey, hit)
      }

      item.text = hit.text
      finalChars += hit.text.length
      if (hit.truncated) anyTruncated = true
      newRing.push({ tool, hash, chars: original.length, seq: callSeq, stubbed: false })
    }

    // Keep the most recent results only, so memory stays O(window).
    const ring = this.ringFor(sessionID)
    ring.push(...newRing)
    if (ring.length > Math.max(1, this.window)) ring.splice(0, ring.length - Math.max(1, this.window))

    return {
      originalChars,
      finalChars,
      deduped: anyDeduped,
      truncated: anyTruncated,
    }
  }

  /** Forget a session's remembered results. */
  reset(sessionID: string): void {
    this.rings.delete(sessionID)
    this.seq.delete(sessionID)
  }

  /** Forget every session (used on plugin unload). */
  resetAll(): void {
    this.rings.clear()
    this.seq.clear()
    this.cache.clear()
    this.cacheChars = 0
  }
}
