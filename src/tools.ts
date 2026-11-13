/**
 * Tool result optimization: compression, verified dedupe, and savings accounting.
 *
 * This is where most of the tokens actually go - tool output is typically the
 * majority of an agent's context. Three transformations apply, in order:
 *
 *  1. **Dedupe (verified).** The result is hashed. If the same tool produced a
 *     byte-identical result within the last `dedupeWindow` calls, the repeat is
 *     replaced with a stub. Because the hash is computed over the freshly
 *     produced content, this can never hide a difference - it only removes a
 *     true duplicate that is still verifiably in context.
 *
 *  2. **Clean.** ANSI/control bytes stripped, CR normalized, blank runs
 *     collapsed, optional trailing-whitespace trim. Pure noise removal.
 *
 *  3. **Truncate.** Head + tail kept inside `maxChars` with a marker saying how
 *     much was dropped, so the model always knows content is missing.
 *
 * Everything hot goes through the Rust addon; see `native.ts`.
 */
// Explicit .ts extensions so Node's strip-only test runner can resolve them;
// bundler-style resolvers (OpenCode/Bun) accept them too.
import { api } from "./native.ts"
import { compressOptions, type Options } from "./options.ts"
import { reduceCommand } from "./rtk.ts"

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
        // RTK reduces only what the model actually receives. The dedupe hash
        // above stays over the original, so a "byte-identical" claim can never
        // be satisfied by two different outputs that reduce to the same text.
        command && this.options.rtk.enabled
          ? reduceCommand(command, original, this.options.rtk)
          : original,
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
