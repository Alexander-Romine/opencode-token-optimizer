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
 *     scrub, repeated-line collapse. Runs after RTK, before compression, and
 *     never on the `read` tool (file bytes must stay faithful for `edit`).
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
import { api } from "./native.ts"
import { compressOptions, type Options, type ToolOptions } from "./options.ts"
import { reduceCommand } from "./rtk.ts"

/** Minimum length of a base64 run the scrubber will consider. */
const BASE64_MIN = 500
/** Shortest line `collapseRepeats` touches - `}` runs and rules never collapse. */
const REPEAT_MIN_LINE = 80
/** Identical-line run length needed before collapsing (2 saves too little). */
const REPEAT_MIN_RUN = 3

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
  if (opts.collapseRepeats) out = collapseRepeats(out)
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

export class ToolOptimizer {
  /**
   * Recent results, keyed by session. Scoping matters: a stub claims the
   * content "is still in context", which is only true for the session that
   * produced it.
   */
  private readonly rings = new Map<string, RingEntry[]>()
  private readonly seq = new Map<string, number>()

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
      item.text = compressed.text
      finalChars += compressed.text.length
      if (compressed.truncated) anyTruncated = true
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
  }
}
