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
import { downscaleDataUris } from "./image.ts"
import { api } from "./native.ts"
import { compressOptions, type Options, type RtkOptions, type ToolOptions } from "./options.ts"
import { reduceCommand } from "./rtk.ts"

/** Minimum length of a base64 run the scrubber will consider. */
const BASE64_MIN = 500
/** Minimum length of a pure-hex run the scrubber will consider (letters required). */
const HEX_MIN = 800
/** Shortest line `collapseRepeats` touches - `}` runs and rules never collapse. */
const REPEAT_MIN_LINE = 80
/** Identical-line run length needed before collapsing (2 saves too little). */
const REPEAT_MIN_RUN = 3
/** Identical stack frames needed before collapsing (recursion, not noise). */
const STACK_MIN_RUN = 3
/** Frames in one contiguous trace before `collapseTraces` trims it, and the keep. */
const TRACE_MIN_RUN = 12
const TRACE_KEEP = 8
/** Unchanged diff lines needed before a run is collapsed. */
const DIFF_MIN_RUN = 8
/** Unchanged diff lines kept at each end of a collapsed run. */
const DIFF_KEEP = 2
/** Lines inside one hunk before `trimDiffHunks` trims it, and the keeps. */
const HUNK_TRIM_CAP = 100
const HUNK_TRIM_HEAD = 60
const HUNK_TRIM_TAIL = 20
/** Smallest JSON span worth re-serializing inline. */
const INLINE_JSON_MIN = 120
/** URL query keys that are pure tracking (removing them never changes the target). */
const TRACKING_PARAM =
  /^(?:utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ytclid|twclid|_ga|vero_id|oly_anon_id|oly_enc_id|s_cid|rb_clickid|share_id|ref_src)$/i
/** Results smaller than this are never worth a cache slot (recompute is cheaper). */
const CACHE_MIN_CHARS = 256
/** How many sessions may keep an intern table / pressure reading at once. */
const MAX_INTERN_SESSIONS = 50
const MAX_INTERN_ENTRIES = 512
const MAX_PRESSURE_SESSIONS = 100

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
 * Lossless-ish (opt-in): re-serialize balanced JSON spans embedded in prose.
 * A character scanner finds outermost `{...}`/`[...]` pairs (string-aware, so
 * braces inside JSON strings never split a span); each candidate must parse as
 * one JSON value and be >=120 chars, otherwise it is left alone. Spans inside
 * fenced code blocks are skipped. JSON semantics never change - only the
 * insignificant whitespace does (same contract as `compactJson`).
 */
function compactJsonInline(text: string): string {
  if (!text.includes("{") && !text.includes("[")) return text

  // Collect character ranges outside fenced code blocks (fence markers stay).
  const lines = text.split("\n")
  const ranges: Array<[number, number]> = []
  let fence = false
  let offset = 0
  let openStart = -1
  for (const line of lines) {
    const trimmed = line.trim()
    const isFence = trimmed.startsWith("```") || trimmed.startsWith("~~~")
    if (isFence) {
      if (openStart >= 0) {
        ranges.push([openStart, offset])
        openStart = -1
      }
      fence = !fence
    } else if (!fence) {
      if (openStart < 0) openStart = offset
    } else if (openStart >= 0) {
      ranges.push([openStart, offset])
      openStart = -1
    }
    offset += line.length + 1
  }
  if (openStart >= 0) ranges.push([openStart, text.length])

  const edits: Array<[number, number, string]> = []
  for (const [start, end] of ranges) {
    const seg = text.slice(start, end)
    let depth = 0
    let spanStart = -1
    let inString = false
    let escaped = false
    for (let i = 0; i < seg.length; i++) {
      const ch = seg.charCodeAt(i)
      if (inString) {
        if (escaped) escaped = false
        else if (ch === 92) escaped = true // backslash
        else if (ch === 34) inString = false // quote
        continue
      }
      if (ch === 34 && depth > 0) {
        inString = true
        continue
      }
      if (ch === 123 || ch === 91) {
        // { or [
        if (depth === 0) spanStart = i
        depth++
        continue
      }
      if ((ch === 125 || ch === 93) && depth > 0) {
        // } or ]
        depth--
        if (depth === 0 && spanStart >= 0) {
          const span = seg.slice(spanStart, i + 1)
          if (span.length >= INLINE_JSON_MIN) {
            try {
              const compact = JSON.stringify(JSON.parse(span))
              if (compact !== null && compact.length < span.length) {
                edits.push([start + spanStart, start + i + 1, compact])
              }
            } catch {
              // Not one JSON document - the braces belonged to something else.
            }
          }
          spanStart = -1
        }
      }
    }
  }
  if (edits.length === 0) return text
  let out = text
  for (let i = edits.length - 1; i >= 0; i--) {
    const [from, to, value] = edits[i]!
    out = out.slice(0, from) + value + out.slice(to)
  }
  return out
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
 * Lossy (opt-in): elide declared base64 payloads and long base64/hex runs
 * with an honest marker.
 *
 *  - `data:*;base64,...` URIs are gated on the declaration itself, so pure
 *    alphanumeric payloads (most PNG data URIs) are caught too;
 *  - loose runs still require a base64-only signal (+, / or padding) so long
 *    hex/word strings are never eaten by the base64 rule;
 *  - a separate hex rule takes pure `[0-9a-f]` runs of >=800 chars that
 *    contain at least one letter (a pure-digit run - a big number - is not
 *    treated as binary).
 */
function scrubBase64(text: string): string {
  let out = text.replace(/data:([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+);base64,([A-Za-z0-9+/=]+)/gi, (match, header, payload) =>
    payload.length >= BASE64_MIN ? `[token-optimizer: ${header} payload of ${payload.length} chars elided]` : match,
  )
  out = out.replace(new RegExp(`[A-Za-z0-9+/]{${BASE64_MIN},}={0,2}`, "g"), (run) =>
    /[+/=]/.test(run) ? `[token-optimizer: base64 blob of ${run.length} chars elided]` : run,
  )
  out = out.replace(new RegExp(`[0-9a-fA-F]{${HEX_MIN},}`, "g"), (run) =>
    /[a-fA-F]/.test(run) ? `[token-optimizer: hex blob of ${run.length} chars elided]` : run,
  )
  return out
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
 * Lossy (opt-in): markdown whitespace minification. Collapses runs of blank
 * lines to one, strips trailing whitespace from lines (two trailing spaces
 * are a markdown hard break and are preserved), and trims leading/trailing
 * blank lines. Emphasis, links, fences and headings are never touched -
 * markdown treats N blank lines exactly like one.
 */
function minifyMarkdown(text: string): string {
  if (!text.includes("\n")) return text
  let out = text.replace(/[ \t]+$/gm, (run) => (run.length >= 2 ? "  " : ""))
  out = out.replace(/\n{3,}/g, "\n\n")
  out = out.replace(/^\n+/, "").replace(/\n+$/, "\n")
  return out
}

/**
 * Lossy (opt-in): trim oversized unified-diff hunks. A hunk body longer than
 * 100 lines keeps its first 60 and last 20, with an honest marker between.
 * Hunk/file headers and added/removed lines outside the trimmed window are
 * never rewritten; text that only looks diff-ish is left alone (same gate as
 * `collapseDiff`).
 */
function trimDiffHunks(text: string): string {
  if (!DIFF_HUNK.test(text)) return text
  if (!DIFF_GIT.test(text) && !(DIFF_TRAD.test(text) && DIFF_TRAD_PLUS.test(text))) return text

  const lines = text.split("\n")
  const out: string[] = []
  let body: string[] = []
  let inHunk = false
  let changed = false

  const flush = () => {
    if (body.length > HUNK_TRIM_CAP) {
      const omitted = body.length - HUNK_TRIM_HEAD - HUNK_TRIM_TAIL
      out.push(
        ...body.slice(0, HUNK_TRIM_HEAD),
        `[token-optimizer: ${omitted} hunk lines omitted]`,
        ...body.slice(-HUNK_TRIM_TAIL),
      )
      changed = true
    } else {
      out.push(...body)
    }
    body = []
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
    if (inHunk) {
      body.push(line)
      continue
    }
    out.push(line)
  }
  flush()
  return changed ? out.join("\n") : text
}

/**
 * Lossy (opt-in): trim long stack traces. A contiguous run of >=12 frame
 * lines keeps its first 8 (the frames nearest the error) plus an honest
 * marker; short traces pass through untouched. Identical-frame runs are
 * handled earlier by `collapseStacks`.
 */
function collapseTraces(text: string): string {
  if (!text.includes("\n")) return text
  const lines = text.split("\n")
  const out: string[] = []
  let frames: string[] = []
  let changed = false

  const flush = () => {
    if (frames.length >= TRACE_MIN_RUN) {
      out.push(...frames.slice(0, TRACE_KEEP), `[token-optimizer: ${frames.length - TRACE_KEEP} more stack frames omitted]`)
      changed = true
    } else {
      out.push(...frames)
    }
    frames = []
  }

  for (const line of lines) {
    if (STACK_FRAME.test(line)) {
      frames.push(line)
      continue
    }
    flush()
    out.push(line)
  }
  flush()
  return changed ? out.join("\n") : text
}

/**
 * Log noise, three accepted shapes (plus the JSON-log form below):
 *  - bracketed or colon/dash levels, any case: `[DEBUG]`, `debug:`, `TRACE -`;
 *  - bare UPPERCASE levels: `DEBUG message` (case-sensitive, so prose like
 *    "Debug this later" is never eaten);
 * each optionally preceded by up to three timestamp/bracket prefix tokens.
 */
const LOG_NOISE =
  /^\s*(?:(?:\[[^\]]{0,60}\]|(?:\d{4}-\d{2}-\d{2}[T ])?\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s*){0,3}(?:\[\s*(?:trace|debug|verbose)\s*\]|(?:trace|debug|verbose)\s*[:\-]\s)/i
const LOG_NOISE_UPPER =
  /^\s*(?:(?:\[[^\]]{0,60}\]|(?:\d{4}-\d{2}-\d{2}[T ])?\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s*){0,3}(?:TRACE|DEBUG|VERBOSE)(?::|\s|-)/
const LOG_NOISE_JSON = /^\s*\{.*"level"\s*:\s*"(?:trace|debug|verbose)"/i

/**
 * Lossy (opt-in): drop debug/trace/verbose log lines. Runs of consecutive
 * dropped lines collapse to a single honest marker, so a burst of chatter
 * costs one line instead of a hole per line. Info/warn/error lines and
 * non-log content are never touched.
 */
function filterLogs(text: string): string {
  if (!text.includes("\n")) return text
  const lines = text.split("\n")
  const out: string[] = []
  let dropped = 0
  let changed = false

  const flush = () => {
    if (dropped > 0) {
      out.push(`[token-optimizer: ${dropped} debug/trace log lines removed]`)
      dropped = 0
    }
  }

  for (const line of lines) {
    if (LOG_NOISE.test(line) || LOG_NOISE_UPPER.test(line) || LOG_NOISE_JSON.test(line)) {
      dropped++
      changed = true
      continue
    }
    flush()
    out.push(line)
  }
  flush()
  return changed ? out.join("\n") : text
}

/** URLs in text - stops at whitespace, quotes, angle brackets and backticks. */
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/g
/** Prose punctuation that commonly trails a URL and is not part of it. */
const URL_TRAILING = ".,;:!?)]}"

/**
 * Lossy (opt-in): drop tracking-only query params (`utm_*`, `fbclid`, ...)
 * from URLs. The URL path, fragment and every non-tracking param survive
 * unchanged; a URL with nothing to remove is returned byte-identical.
 */
function stripUrlParams(text: string): string {
  if (!text.includes("?")) return text
  return text.replace(URL_IN_TEXT, (match) => {
    let end = match.length
    while (end > 0 && URL_TRAILING.includes(match.charAt(end - 1))) end--
    const url = match.slice(0, end)
    const tail = match.slice(end)
    const hashAt = url.indexOf("#")
    const hash = hashAt >= 0 ? url.slice(hashAt) : ""
    const base = hashAt >= 0 ? url.slice(0, hashAt) : url
    const qAt = base.indexOf("?")
    if (qAt < 0) return match
    const query = base.slice(qAt + 1)
    if (!query) return match
    const parts = query.split("&")
    const kept = parts.filter((part) => {
      const eq = part.indexOf("=")
      const raw = eq >= 0 ? part.slice(0, eq) : part
      if (!raw) return true
      if (TRACKING_PARAM.test(raw)) return false
      try {
        return !TRACKING_PARAM.test(decodeURIComponent(raw))
      } catch {
        return true
      }
    })
    if (kept.length === parts.length) return match
    const head = base.slice(0, qAt)
    return (kept.length > 0 ? `${head}?${kept.join("&")}` : head) + hash + tail
  })
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
  if (opts.compactJsonInline) out = compactJsonInline(out)
  if (opts.collapseTable) out = collapseTable(out)
  if (opts.minifyMarkdown) out = minifyMarkdown(out)
  if (opts.collapseDiff) out = collapseDiff(out)
  if (opts.trimDiffHunks) out = trimDiffHunks(out)
  if (opts.collapseStacks) out = collapseStacks(out)
  if (opts.collapseTraces) out = collapseTraces(out)
  if (opts.collapseRepeats) out = collapseRepeats(out)
  if (opts.filterLogs) out = filterLogs(out)
  if (opts.normalizeTime) out = normalizeTime(out)
  if (opts.shortenPaths) out = shortenPaths(out)
  if (opts.stripUrlParams) out = stripUrlParams(out)
  if (opts.stripHtml) out = stripHtml(out)
  if (opts.downscaleImages) out = downscaleDataUris(out, opts.imageMaxDim)
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
   * Session-scoped interning tables: content hash of a block -> the call seq
   * that last sent it in full. Blocks are split on blank-line boundaries;
   * entries age out with the same window the dedupe ring uses.
   */
  private readonly internTables = new Map<string, Map<string, { seq: number }>>()

  /** Per-session context-fullness percentage, fed by the `context` hook. */
  private readonly pressure = new Map<string, number>()

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

  /** Feed the context-window percentage for a session (pressure routing). */
  setPressure(sessionID: string, pct: number): void {
    if (!sessionID) return
    const value = Math.max(0, Math.min(100, pct))
    this.pressure.delete(sessionID)
    if (this.pressure.size >= MAX_PRESSURE_SESSIONS) {
      const oldest = this.pressure.keys().next().value
      if (oldest !== undefined) this.pressure.delete(oldest)
    }
    this.pressure.set(sessionID, value)
  }

  /** True when pressure routing is on and this session crossed the threshold. */
  private tight(sessionID: string): boolean {
    if (!this.options.tool.pressureRouting || !sessionID) return false
    const pct = this.pressure.get(sessionID)
    return pct !== undefined && pct >= this.options.tool.pressurePct
  }

  /**
   * Tool options for this session: unchanged when relaxed, tightened when
   * under pressure (smaller `maxChars` - never raised above the configured
   * value, never below 4000 unless the config already is - and lower
   * dedupe/intern thresholds so repeats stub earlier).
   */
  private effectiveTool(sessionID: string): ToolOptions {
    const tool = this.options.tool
    if (!this.tight(sessionID)) return tool
    const scaled = Math.round(tool.maxChars * tool.pressureScale)
    return {
      ...tool,
      maxChars: Math.max(Math.min(4000, tool.maxChars), scaled),
      dedupeMinChars: Math.min(tool.dedupeMinChars, 800),
      internMinChars: Math.min(tool.internMinChars, 600),
    }
  }

  /** RTK options for this session: under pressure, reduce at half the threshold. */
  private effectiveRtk(sessionID: string): RtkOptions {
    const rtk = this.options.rtk
    if (!this.tight(sessionID)) return rtk
    return { ...rtk, minChars: Math.round(rtk.minChars * 0.5) }
  }

  /**
   * Verified chunk interning: split `text` on blank-line boundaries; any
   * block >= `minChars` whose content hash already went out in an earlier
   * call of this session becomes a pointer instead of a re-send. Blocks
   * carrying a `[token-optimizer` marker are never re-interned, `read`
   * output and stubbed results never reach here, and the marker claims
   * only what the hash proved.
   */
  private intern(sessionID: string, text: string, callSeq: number, minChars: number): string {
    if (!sessionID || minChars <= 0 || text.length < minChars) return text

    let table = this.internTables.get(sessionID)
    if (table) {
      this.internTables.delete(sessionID)
      this.internTables.set(sessionID, table) // refresh recency
    } else {
      table = new Map()
      if (this.internTables.size >= MAX_INTERN_SESSIONS) {
        const oldest = this.internTables.keys().next().value
        if (oldest !== undefined) this.internTables.delete(oldest)
      }
      this.internTables.set(sessionID, table)
    }

    // Age out blocks older than the dedupe window (same staleness contract).
    const floor = callSeq - Math.max(1, this.window)
    for (const [hash, entry] of table) {
      if (entry.seq < floor) table.delete(hash)
    }

    const parts = text.split(/(\n{2,})/)
    let changed = false
    for (let i = 0; i < parts.length; i += 2) {
      const block = parts[i]!
      if (block.length < minChars) continue
      if (block.includes("[token-optimizer")) continue
      const hash = api.hashParts([block])
      const entry = table.get(hash)
      if (entry === undefined) {
        table.set(hash, { seq: callSeq })
        while (table.size > MAX_INTERN_ENTRIES) {
          const oldest = table.keys().next().value
          if (oldest === undefined) break
          table.delete(oldest)
        }
      } else if (entry.seq < callSeq) {
        const callsBack = callSeq - entry.seq
        parts[i] =
          `[token-optimizer: ${block.length} chars omitted: byte-identical block ` +
          `from ${callsBack} call${callsBack === 1 ? "" : "s"} ago, verified by content hash]`
        changed = true
      }
    }
    return changed ? parts.join("") : text
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

    // Pressure-aware budgets: one lookup per call, applied everywhere below.
    const toolOpts = this.effectiveTool(sessionID)
    const rtkOpts = this.effectiveRtk(sessionID)
    const tight = this.tight(sessionID)

    const compressOpts = compressOptions(toolOpts)
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
        original.length >= toolOpts.dedupeMinChars
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
      // are not worth a slot; the dedupe ring above still owns stubs. The
      // key carries the pressure tier: tight budgets produce different output.
      const cacheKey =
        this.options.tool.ramCache && original.length >= CACHE_MIN_CHARS
          ? `${tight ? "1" : "0"}\u001f${tool}\u001f${command ?? ""}\u001f${original}`
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
            command && rtkOpts.enabled ? reduceCommand(command, original, rtkOpts) : original,
            tool,
            toolOpts,
          ),
          compressOpts,
        )
        hit = { text: compressed.text, truncated: compressed.truncated }
        if (cacheKey !== null) this.cachePut(cacheKey, hit)
      }

      // Chunk interning runs on the post-compress text (the cache stores the
      // pre-intern result, so a hit re-interns against the live table).
      // `read` output stays byte-faithful: never interned.
      item.text =
        toolOpts.internChunks && tool !== "read"
          ? this.intern(sessionID, hit.text, callSeq, toolOpts.internMinChars)
          : hit.text
      finalChars += item.text.length
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
    this.internTables.delete(sessionID)
    this.pressure.delete(sessionID)
  }

  /** Forget every session (used on plugin unload). */
  resetAll(): void {
    this.rings.clear()
    this.seq.clear()
    this.internTables.clear()
    this.pressure.clear()
    this.cache.clear()
    this.cacheChars = 0
  }
}
