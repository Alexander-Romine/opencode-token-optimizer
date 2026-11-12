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

export class StateManager {
  constructor(
    private readonly deps: StateDeps,
    private readonly options: Options,
  ) {}

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
    // transcript is only the fallback.
    const summary = summaryOverride ?? derived

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
      summary ??
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

    return { text: lines.join("\n"), path: filePath }
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
      `Resume from the "Next move" line of the working summary.`,
      `Do not redo completed work. Re-read files from disk only when you need their current contents.`,
    ].join("\n")

    await this.deps.promptSession(created.id, prompt)

    return { sessionID: created.id, path: state.path, title }
  }
}
