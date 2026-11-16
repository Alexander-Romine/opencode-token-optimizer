/**
 * Durable session state + rotation ("new chat window") support.
 *
 * The idea: a conversation is expensive to carry but cheap to summarise. When
 * a session gets too large we write its state to disk and start a *fresh*
 * session seeded only with that state. Recovering a detail from disk is cheap;
 * keeping it resident for twenty more turns is not.
 *
 * The state file is deliberately the same structured document OpenCode's
 * compaction already produces (objective, decisions, completed work, next
 * move, files), so a rotation from a compacted session hands over the richest
 * possible seed.
 */
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import type { Options } from "./options"
import type { SessionMetrics } from "./meter"

export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface SessionSnapshot {
  id: string
  title?: string
  agent?: string
  model?: { providerID: string; id: string; variant?: string }
  cost?: number
  tokens?: TokenUsage
}

export interface StateDeps {
  /** Project root; state files are written beneath it. */
  readonly directory: string
  getSession(sessionID: string): Promise<SessionSnapshot>
  /** Full message history for the session. */
  getContext(sessionID: string): Promise<readonly unknown[]>
  createSession(input: { title: string; agent?: string; model?: SessionSnapshot["model"] }): Promise<{ id: string }>
  promptSession(sessionID: string, text: string): Promise<void>
}

export interface CapturedState {
  text: string
  path: string
  /** True when the working summary fell back to the transcript digest. */
  usedDigest: boolean
}

function readSummary(message: unknown): string | undefined {
  const candidate = message as { type?: string; status?: string; summary?: unknown } | null
  if (
    candidate &&
    candidate.type === "compaction" &&
    candidate.status === "completed" &&
    typeof candidate.summary === "string" &&
    candidate.summary.trim().length > 0
  ) {
    return candidate.summary
  }
  return undefined
}

function formatUsage(tokens: TokenUsage | undefined): string {
  if (!tokens) return "not recorded"
  const parts = [
    `in ${tokens.input.toLocaleString()}`,
    `out ${tokens.output.toLocaleString()}`,
    `cache-read ${tokens.cache.read.toLocaleString()}`,
    `cache-write ${tokens.cache.write.toLocaleString()}`,
  ]
  return parts.join(" · ")
}

function formatMetrics(metrics: SessionMetrics | undefined, charsPerToken: number): string {
  if (!metrics) return "- no metrics recorded yet"
  const peak = Math.ceil(metrics.peakContextChars / charsPerToken)
  const saved = Math.ceil(metrics.toolCharsSaved / charsPerToken)
  const lines = [
    `- requests ${metrics.requests} · tool calls ${metrics.toolCalls} · compactions ${metrics.compactions} · rotations ${metrics.rotations}`,
    `- peak context ~${peak.toLocaleString()} tokens`,
    `- tool output ${metrics.toolCharsIn.toLocaleString()} chars in → ${(
      metrics.toolCharsIn - metrics.toolCharsSaved
    ).toLocaleString()} chars out (saved ~${saved.toLocaleString()} tokens)`,
    `- repeat results withheld ${metrics.dedupeHits}`,
  ]
  return lines.join("\n")
}

/** One transcript entry clipped for the digest (role prefix included later). */
const DIGEST_ENTRY_CHARS = 240
/** How many tool names the digest tally lists. */
const DIGEST_TALLY = 8

/**
 * Bounded digest of the raw transcript, used when the session has no
 * compaction checkpoint yet: newest-first walk until `budget` chars are
 * spent, each text entry clipped to ~240 chars, plus a tally of the most
 * used tools. Entries print chronologically (the walk collects them in
 * reverse). Returns `undefined` when there is nothing worth carrying.
 */
function buildDigest(messages: readonly unknown[], budget: number): string | undefined {
  if (budget <= 0) return undefined
  const entries: string[] = []
  const tools = new Map<string, number>()
  let used = 0

  for (let i = messages.length - 1; i >= 0 && used < budget; i--) {
    const message = messages[i] as { type?: string; content?: unknown } | null
    if (!message || (message.type !== "user" && message.type !== "assistant")) continue
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      const candidate = part as { type?: string; text?: string; tool?: string } | null
      if (!candidate) continue
      if (candidate.type === "tool" && typeof candidate.tool === "string") {
        tools.set(candidate.tool, (tools.get(candidate.tool) ?? 0) + 1)
        continue
      }
      if (candidate.type !== "text" || typeof candidate.text !== "string") continue
      const clean = candidate.text.replace(/\s+/g, " ").trim()
      if (!clean) continue
      const clipped = clean.length > DIGEST_ENTRY_CHARS ? `${clean.slice(0, DIGEST_ENTRY_CHARS - 1)}…` : clean
      const line = `${message.type === "user" ? "user" : "assistant"}: ${clipped}`
      entries.push(line)
      used += line.length
      if (used >= budget) break
    }
  }

  if (entries.length === 0 && tools.size === 0) return undefined
  entries.reverse() // walk was newest-first; the digest reads chronologically

  const lines: string[] = []
  if (tools.size > 0) {
    const tally = [...tools.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, DIGEST_TALLY)
      .map(([name, count]) => `${name} ×${count}`)
    lines.push(`Tools used most: ${tally.join(" · ")}`, ``)
  }
  lines.push(...entries)
  const digest = lines.join("\n")
  return digest.length > budget ? `${digest.slice(0, budget - 1)}…` : digest
}

export class StateManager {
  // Plain fields instead of parameter properties: Node's type-stripping mode
  // (used by the .mjs tests) cannot parse `constructor(private ...)`.
  private readonly deps: StateDeps
  private readonly options: Options

  constructor(deps: StateDeps, options: Options) {
    this.deps = deps
    this.options = options
  }

  statePath(sessionID: string): string {
    return path.join(this.deps.directory, this.options.stateDir, `${sessionID}.md`)
  }

  /** Most recent compaction summary, if the session has been compacted. */
  async latestSummary(sessionID: string): Promise<string | undefined> {
    try {
      const messages = await this.deps.getContext(sessionID)
      // The compaction checkpoint is always the newest such message, so walk
      // backwards and stop at the first hit instead of scanning the transcript.
      for (let i = messages.length - 1; i >= 0; i--) {
        const summary = readSummary(messages[i])
        if (summary) return summary
      }
    } catch {
      return undefined
    }
    return undefined
  }

  async capture(
    sessionID: string,
    metrics?: SessionMetrics,
    summaryOverride?: string,
  ): Promise<CapturedState> {
    const [session, derived] = await Promise.all([
      this.deps.getSession(sessionID),
      summaryOverride ? Promise.resolve(undefined) : this.latestSummary(sessionID),
    ])

    // The compaction event hands us the checkpoint text directly; reading the
    // transcript is only the fallback. With no checkpoint, a bounded digest of
    // the raw transcript still gives the next session something to resume from.
    const summary = summaryOverride ?? derived
    let digest: string | undefined
    if (!summary && this.options.state.digestChars > 0) {
      const messages = await this.deps.getContext(sessionID).catch(() => undefined)
      digest = buildDigest(messages ?? [], this.options.state.digestChars)
    }
    const usedDigest = !summary && digest !== undefined
    const working = summary ?? digest

    const model = session.model ? `${session.model.providerID}/${session.model.id}` : "unknown"
    const lines = [
      `# Session state`,
      ``,
      `- session: \`${session.id}\``,
      `- title: ${session.title ?? "(untitled)"}`,
      `- agent: \`${session.agent ?? "unknown"}\` · model: \`${model}\``,
      `- captured: ${new Date().toISOString()}`,
      `- usage: ${formatUsage(session.tokens)}`,
      `- cost: $${(session.cost ?? 0).toFixed(4)}`,
      ``,
      `## Working summary`,
      ``,
      working ??
        "_No compaction checkpoint yet. This session has not been compacted, so only metrics and identity are captured - compact before rotating to hand over a rich summary._",
      ``,
      `## Metrics`,
      ``,
      formatMetrics(metrics, this.options.charsPerToken),
      ``,
    ]

    const filePath = this.statePath(sessionID)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, lines.join("\n"), "utf8")

    return { text: lines.join("\n"), path: filePath, usedDigest }
  }

  /**
   * Start a fresh session seeded from this one's state.
   *
   * Returns the new session's id; the caller emits the event the TUI uses to
   * focus it.
   */
  async rotate(sessionID: string, metrics?: SessionMetrics): Promise<{ sessionID: string; path: string; title: string }> {
    const state = await this.capture(sessionID, metrics)
    const source = await this.deps.getSession(sessionID)
    const title = `${source.title ?? "Session"}${this.options.rotation.titleSuffix}`

    const created = await this.deps.createSession({
      title,
      ...(source.agent ? { agent: source.agent } : {}),
      ...(source.model ? { model: source.model } : {}),
    })

    // Seed the new session inline: carrying the state in the first message is
    // far cheaper than re-deriving it, and the file is the durable copy.
    const prompt = [
      `Continuing a rotated session so the context stays small.`,
      `Durable copy of this state: \`${state.path}\``,
      ``,
      state.text,
      ``,
      `Resume from ${state.usedDigest ? "the history digest above" : `the "Next move" line of the working summary`}.`,
      `Do not redo completed work. Re-read files from disk only when you need their current contents.`,
    ].join("\n")

    await this.deps.promptSession(created.id, prompt)

    return { sessionID: created.id, path: state.path, title }
  }
}
