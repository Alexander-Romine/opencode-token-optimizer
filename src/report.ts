/**
 * Human readable efficiency report, surfaced through RPC in the TUI.
 *
 * Combines our own counters with OpenCode's authoritative per-session token and
 * cost totals, so the report separates "what the model really billed" from
 * "what this plugin removed".
 */
import type { SessionMetrics } from "./meter"
import type { Options } from "./options"
import type { SessionSnapshot, TokenUsage } from "./state"
import type { RamCacheStats } from "./tools"

export interface ReportRow {
  session: SessionSnapshot
  metrics?: SessionMetrics
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length)
}

function padStart(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value
}

function compactID(sessionID: string): string {
  return sessionID.length <= 12 ? sessionID : `${sessionID.slice(0, 9)}...`
}

function tokens(n: number | undefined): string {
  if (!n) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function estimateTokens(chars: number, charsPerToken: number): number {
  return charsPerToken > 0 ? Math.ceil(chars / charsPerToken) : 0
}

export function buildReport(
  options: Options,
  nativeDetail: string,
  rows: ReportRow[],
  cache?: RamCacheStats,
): string {
  const sorted = [...rows].sort((a, b) => (b.metrics?.updatedAt ?? 0) - (a.metrics?.updatedAt ?? 0))

  const totals = sorted.reduce(
    (acc, row) => {
      const usage = row.session.tokens
      if (usage) {
        acc.input += usage.input
        acc.output += usage.output
        acc.cacheRead += usage.cache.read
        acc.cacheWrite += usage.cache.write
      }
      acc.cost += row.session.cost ?? 0
      if (row.metrics) {
        acc.requests += row.metrics.requests
        acc.toolCalls += row.metrics.toolCalls
        acc.charsIn += row.metrics.toolCharsIn
        acc.saved += row.metrics.toolCharsSaved
        acc.dedupe += row.metrics.dedupeHits
        acc.compactions += row.metrics.compactions
        acc.rotations += row.metrics.rotations
      }
      return acc
    },
    {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      requests: 0,
      toolCalls: 0,
      charsIn: 0,
      saved: 0,
      dedupe: 0,
      compactions: 0,
      rotations: 0,
    },
  )

  const savedTokens = estimateTokens(totals.saved, options.charsPerToken)
  const cachedShare =
    totals.input + totals.cacheRead > 0
      ? Math.round((totals.cacheRead / (totals.input + totals.cacheRead)) * 100)
      : 0

  const lines: string[] = [
    `token-optimizer report`,
    `implementation : ${nativeDetail}`,
    `chars/token    : ${options.charsPerToken}`,
    ``,
    `sessions       : ${sorted.length}`,
    `agent requests : ${totals.requests}`,
    `tool calls     : ${totals.toolCalls}`,
    `compactions    : ${totals.compactions}`,
    `rotations      : ${totals.rotations}`,
    ``,
    `billed input   : ${tokens(totals.input)}`,
    `billed output  : ${tokens(totals.output)}`,
    `cache read     : ${tokens(totals.cacheRead)} (${cachedShare}% of input served from cache)`,
    `cache write    : ${tokens(totals.cacheWrite)}`,
    `cost           : $${totals.cost.toFixed(4)}`,
    ``,
    `tool output    : ${totals.charsIn.toLocaleString()} chars injected`,
    `removed        : ${totals.saved.toLocaleString()} chars (~${savedTokens.toLocaleString()} tokens)`,
    `repeat withheld: ${totals.dedupe}`,
    ...(cache
      ? [
          `ram cache      : ${
            cache.enabled
              ? `${cache.hits} hit / ${cache.misses} miss` +
                (cache.hits + cache.misses > 0
                  ? ` (${Math.round((cache.hits / (cache.hits + cache.misses)) * 100)}%)`
                  : "") +
                `, ${cache.entries} entries, ${cache.chars.toLocaleString()} chars`
              : "off (options.tool.ramCache)"
          }`,
        ]
      : []),
    ``,
  ]

  if (sorted.length === 0) {
    lines.push(`No sessions recorded yet.`)
    return lines.join("\n")
  }

  const header = [
    pad("session", 13),
    pad("model", 26),
    padStart("peak", 7),
    padStart("in", 7),
    padStart("out", 7),
    padStart("cached", 8),
    padStart("cost", 9),
    padStart("saved", 8),
  ].join("  ")

  lines.push(header)
  lines.push("-".repeat(header.length))

  for (const row of sorted.slice(0, 15)) {
    const usage: TokenUsage | undefined = row.session.tokens
    const model = row.session.model
      ? `${row.session.model.providerID}/${row.session.model.id}`
      : "unknown"
    const saved = row.metrics ? `~${tokens(estimateTokens(row.metrics.toolCharsSaved, options.charsPerToken))}` : "-"
    const peak = row.metrics
      ? `~${tokens(estimateTokens(row.metrics.peakContextChars, options.charsPerToken))}`
      : "-"

    lines.push(
      [
        pad(compactID(row.session.id), 13),
        pad(model.length > 26 ? `${model.slice(0, 23)}...` : model, 26),
        padStart(peak, 7),
        padStart(tokens(usage?.input), 7),
        padStart(tokens(usage?.output), 7),
        padStart(tokens(usage?.cache.read), 8),
        padStart(row.session.cost ? `$${row.session.cost.toFixed(3)}` : "$0", 9),
        padStart(saved, 8),
      ].join("  "),
    )
  }

  if (sorted.length > 15) lines.push(`... ${sorted.length - 15} older sessions omitted`)

  return lines.join("\n")
}
