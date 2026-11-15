/**
 * Plugin options, read from the `options` object of the plugin's entry in
 * `opencode.json`.
 *
 * Every field is optional and every reader is tolerant: unknown shapes, snake
 * case aliases and wrong types all fall back to the default rather than
 * throwing during plugin setup.
 */

export interface RotationOptions {
  /** Create a new session automatically when the context passes the threshold. */
  auto: boolean
  /** Percentage of the model context window that triggers rotation. */
  thresholdPct: number
  /** Appended to the rotated session's title. */
  titleSuffix: string
}

export interface ToolOptions {
  /** Result budget in characters; 0 disables truncation. */
  maxChars: number
  headPct: number
  stripAnsi: boolean
  collapseBlank: boolean
  maxBlankLines: number
  trimLines: boolean
  marker?: string
  /** Only collapse a repeat when the previous result is within this many tool calls. */
  dedupeWindow: number
  /** Never dedupe results smaller than this many characters. */
  dedupeMinChars: number
  /**
   * Lossless: collapse insignificant whitespace when a whole tool result is
   * one JSON value (parse-gated; unparseable text is left untouched).
   */
  compactJson: boolean
  /** Lossless: strip markdown table alignment padding outside code fences. */
  collapseTable: boolean
  /** Lossy: elide base64 runs of >=500 chars with an honest marker. */
  scrubBase64: boolean
  /** Lossy: collapse runs of >=3 identical stack frames to one + count. */
  collapseRepeats: boolean
  /** Lossy: collapse repeated stack-trace frames (`at ...`, Python `File ...`). */
  collapseStacks: boolean
  /** Lossy: elide long unchanged runs inside unified diffs (markers kept). */
  collapseDiff: boolean
  /** Lossy: convert raw HTML pages (`<html>`/`<body>`/doctype) to text. */
  stripHtml: boolean
  /** Lossy: full timestamps (ISO-8601 / `YYYY-MM-DD HH:MM:SS`) become `<ts>`. */
  normalizeTime: boolean
  /** Lossy: the home-directory prefix becomes `~` in path references. */
  shortenPaths: boolean
  /**
   * Device-RAM LRU: memoize the RTK+transform+compress result keyed by the
   * exact original input, so repeats skip the whole pipeline. Deterministic
   * and content-addressed - never serves one result for a different input.
   */
  ramCache: boolean
  /** Char budget (keys + values) for the RAM cache; oldest entries evicted first. */
  ramCacheChars: number
  /** Tool names the compressor leaves untouched. */
  exclude: string[]
}

export interface RoutingOptions {
  /** `provider/model` used for title generation. */
  title?: string
  /** `provider/model` used for compaction summaries. */
  compaction?: string
  /** `provider/model` used for transient one-shot generations. */
  generate?: string
  /** `provider/model` per agent id, applied when no kind rule matched. */
  agents: Record<string, string>
}

export interface RtkOptions {
  /**
   * RTK-style command-output reduction: recognises common dev commands
   * (test runners, git, installs, listings) and keeps their signal -
   * summaries, failures, errors - instead of every line.
   */
  enabled: boolean
  /** Outputs under this many chars pass through untouched (short output is not worth a rule). */
  minChars: number
}

export interface CavemanOptions {
  /**
   * Caveman-style terseness: appends an instruction to the system prompt that
   * drops filler from prose while keeping code, paths and errors verbatim.
   */
  enabled: boolean
  /** Custom instruction. Empty string uses the built-in default. */
  text: string
}

export interface Options {
  enabled: boolean
  /** Characters per token used by the estimator. 4 is the usual prose/code blend. */
  charsPerToken: number
  rotation: RotationOptions
  tool: ToolOptions
  routing: RoutingOptions
  rtk: RtkOptions
  caveman: CavemanOptions
  /** Output-token cap applied to every agent-loop request. 0 leaves it alone. */
  budgetMaxTokens: number
  /** Directory, relative to the project root, that holds state files. */
  stateDir: string
  /** How often dirty metrics are flushed to plugin storage. */
  flushMs: number
  /** Maximum sessions tracked in memory before the oldest is evicted. */
  maxTrackedSessions: number
}

const DEFAULT: Options = {
  enabled: true,
  charsPerToken: 4,
  rotation: {
    auto: true,
    thresholdPct: 85,
    titleSuffix: " (rotated)",
  },
  tool: {
    maxChars: 24_000,
    headPct: 70,
    stripAnsi: true,
    collapseBlank: true,
    maxBlankLines: 1,
    trimLines: false,
    dedupeWindow: 4,
    dedupeMinChars: 1_500,
    compactJson: true,
    collapseTable: true,
    scrubBase64: false,
    collapseRepeats: false,
    collapseStacks: false,
    collapseDiff: false,
    stripHtml: false,
    normalizeTime: false,
    shortenPaths: false,
    ramCache: true,
    ramCacheChars: 2_000_000,
    exclude: ["write", "edit", "apply_patch"],
  },
  routing: { agents: {} },
  rtk: { enabled: true, minChars: 1_200 },
  caveman: { enabled: false, text: "" },
  budgetMaxTokens: 0,
  stateDir: ".opencode/token-optimizer/state",
  flushMs: 4_000,
  maxTrackedSessions: 200,
}

type Raw = Record<string, unknown>

function object(value: unknown): Raw | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : undefined
}

/** Reads `a.b` or `a_b` so hand-written config in either style works. */
function read(source: Raw, key: string, alias?: string): unknown {
  if (key in source) return source[key]
  if (alias && alias in source) return source[alias]
  return undefined
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function stringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  return value.filter((entry): entry is string => typeof entry === "string")
}

export function parseOptions(raw: unknown): Options {
  const root = object(raw)
  if (!root) {
    return {
      ...DEFAULT,
      rotation: { ...DEFAULT.rotation },
      tool: { ...DEFAULT.tool },
      routing: { agents: {} },
      rtk: { ...DEFAULT.rtk },
      caveman: { ...DEFAULT.caveman },
    }
  }

  const rotationRaw = object(read(root, "rotation", "session")) ?? {}
  const toolRaw = object(read(root, "tool", "tools")) ?? {}
  const routingRaw = object(read(root, "routing", "model")) ?? {}
  const stateRaw = object(read(root, "state")) ?? {}
  const rtkRaw = object(read(root, "rtk")) ?? {}
  const cavemanRaw = object(read(root, "caveman")) ?? {}

  const agentsRaw = object(read(routingRaw, "agents")) ?? {}

  const rotation: RotationOptions = {
    auto: bool(read(rotationRaw, "auto"), DEFAULT.rotation.auto),
    thresholdPct: clamp(num(read(rotationRaw, "thresholdPct", "threshold_pct"), DEFAULT.rotation.thresholdPct), 20, 99),
    titleSuffix: str(read(rotationRaw, "titleSuffix", "title_suffix")) ?? DEFAULT.rotation.titleSuffix,
  }

  const tool: ToolOptions = {
    maxChars: Math.max(0, num(read(toolRaw, "maxChars", "max_chars"), DEFAULT.tool.maxChars)),
    headPct: clamp(num(read(toolRaw, "headPct", "head_pct"), DEFAULT.tool.headPct), 0, 100),
    stripAnsi: bool(read(toolRaw, "stripAnsi", "strip_ansi"), DEFAULT.tool.stripAnsi),
    collapseBlank: bool(read(toolRaw, "collapseBlank", "collapse_blank"), DEFAULT.tool.collapseBlank),
    maxBlankLines: Math.max(0, num(read(toolRaw, "maxBlankLines", "max_blank_lines"), DEFAULT.tool.maxBlankLines)),
    trimLines: bool(read(toolRaw, "trimLines", "trim_lines"), DEFAULT.tool.trimLines),
    marker: str(read(toolRaw, "marker")),
    dedupeWindow: clamp(num(read(toolRaw, "dedupeWindow", "dedupe_window"), DEFAULT.tool.dedupeWindow), 0, 64),
    dedupeMinChars: Math.max(0, num(read(toolRaw, "dedupeMinChars", "dedupe_min_chars"), DEFAULT.tool.dedupeMinChars)),
    compactJson: bool(read(toolRaw, "compactJson", "compact_json"), DEFAULT.tool.compactJson),
    collapseTable: bool(read(toolRaw, "collapseTable", "collapse_table"), DEFAULT.tool.collapseTable),
    scrubBase64: bool(read(toolRaw, "scrubBase64", "scrub_base64"), DEFAULT.tool.scrubBase64),
    collapseRepeats: bool(read(toolRaw, "collapseRepeats", "collapse_repeats"), DEFAULT.tool.collapseRepeats),
    collapseStacks: bool(read(toolRaw, "collapseStacks", "collapse_stacks"), DEFAULT.tool.collapseStacks),
    collapseDiff: bool(read(toolRaw, "collapseDiff", "collapse_diff"), DEFAULT.tool.collapseDiff),
    stripHtml: bool(read(toolRaw, "stripHtml", "strip_html"), DEFAULT.tool.stripHtml),
    normalizeTime: bool(read(toolRaw, "normalizeTime", "normalize_time"), DEFAULT.tool.normalizeTime),
    shortenPaths: bool(read(toolRaw, "shortenPaths", "shorten_paths"), DEFAULT.tool.shortenPaths),
    ramCache: bool(read(toolRaw, "ramCache", "ram_cache"), DEFAULT.tool.ramCache),
    ramCacheChars: Math.max(0, num(read(toolRaw, "ramCacheChars", "ram_cache_chars"), DEFAULT.tool.ramCacheChars)),
    exclude: stringList(read(toolRaw, "exclude"), DEFAULT.tool.exclude),
  }

  const agents: Record<string, string> = {}
  for (const [agentID, target] of Object.entries(agentsRaw)) {
    const parsed = str(target)
    if (parsed) agents[agentID] = parsed
  }

  const routing: RoutingOptions = {
    title: str(read(routingRaw, "title")),
    compaction: str(read(routingRaw, "compaction")),
    generate: str(read(routingRaw, "generate")),
    agents,
  }

  const rtk: RtkOptions = {
    enabled: bool(read(rtkRaw, "enabled"), DEFAULT.rtk.enabled),
    minChars: Math.max(0, num(read(rtkRaw, "minChars", "min_chars"), DEFAULT.rtk.minChars)),
  }

  const caveman: CavemanOptions = {
    enabled: bool(read(cavemanRaw, "enabled"), DEFAULT.caveman.enabled),
    text: typeof read(cavemanRaw, "text") === "string" ? (read(cavemanRaw, "text") as string) : DEFAULT.caveman.text,
  }

  return {
    enabled: bool(read(root, "enabled"), DEFAULT.enabled),
    charsPerToken: clamp(num(read(root, "charsPerToken", "chars_per_token"), DEFAULT.charsPerToken), 1, 20),
    rotation,
    tool,
    routing,
    rtk,
    caveman,
    budgetMaxTokens: Math.max(0, num(read(root, "budgetMaxTokens", "budget_max_tokens"), DEFAULT.budgetMaxTokens)),
    stateDir: str(read(stateRaw, "dir", "directory")) ?? DEFAULT.stateDir,
    flushMs: clamp(num(read(root, "flushMs", "flush_ms"), DEFAULT.flushMs), 250, 300_000),
    maxTrackedSessions: clamp(
      num(read(root, "maxTrackedSessions", "max_tracked_sessions"), DEFAULT.maxTrackedSessions),
      1,
      10_000,
    ),
  }
}

export function compressOptions(tool: ToolOptions) {
  return {
    maxChars: tool.maxChars,
    headPct: tool.headPct,
    stripAnsi: tool.stripAnsi,
    collapseBlank: tool.collapseBlank,
    maxBlankLines: tool.maxBlankLines,
    trimLines: tool.trimLines,
    ...(tool.marker === undefined ? {} : { marker: tool.marker }),
  }
}
