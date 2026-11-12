/**
 * Per-session token/efficiency accounting.
 *
 * Two design rules keep this cheap enough to run on every model request:
 *
 *  1. Context size is estimated by *walking the live objects* and summing
 *     string lengths. No serialization, no intermediate strings, no allocation
 *     beyond a small work stack - so metering never costs meaningful RAM even
 *     on a 200k-token request.
 *
 *  2. Counters live in a bounded in-memory map and are flushed to plugin
 *     storage on a slow timer, not per call. Writing to storage on every tool
 *     call would dominate the plugin's own cost.
 */

/** Storage API surface used by the meter (a subset of the plugin context). */
export interface StorageLike {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  scan(options: { prefix: string; limit?: number; after?: string }): Promise<{
    entries: ReadonlyArray<{ key: string; value: unknown }>
    next?: string
  }>
}

export interface SessionMetrics {
  sessionID: string
  /** Agent-loop requests observed. */
  requests: number
  /** Largest estimated outgoing context, in characters. */
  peakContextChars: number
  /** Most recent estimated outgoing context, in characters. */
  lastContextChars: number
  /** Tool results returned to the model. */
  toolCalls: number
  /** Characters of tool output produced. */
  toolCharsIn: number
  /** Characters removed by compression/dedupe. */
  toolCharsSaved: number
  /** Repeat results replaced with a stub. */
  dedupeHits: number
  compactions: number
  rotations: number
  firstSeen: number
  updatedAt: number
}

const KEY_PREFIX = "m/"

function blank(sessionID: string, now: number): SessionMetrics {
  return {
    sessionID,
    requests: 0,
    peakContextChars: 0,
    lastContextChars: 0,
    toolCalls: 0,
    toolCharsIn: 0,
    toolCharsSaved: 0,
    dedupeHits: 0,
    compactions: 0,
    rotations: 0,
    firstSeen: now,
    updatedAt: now,
  }
}

function isMetrics(value: unknown): value is SessionMetrics {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as SessionMetrics).sessionID === "string" &&
    typeof (value as SessionMetrics).peakContextChars === "number"
  )
}

/**
 * Sum of every string reachable from the given values, including object keys
 * (which are serialized as part of the request too).
 */
export function estimateChars(system: unknown, messages: unknown, tools: unknown): number {
  let total = 0
  const stack: unknown[] = [system, messages, tools]

  while (stack.length > 0) {
    const value = stack.pop()
    if (typeof value === "string") {
      total += value.length
      continue
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) stack.push(value[i])
      continue
    }
    if (value && typeof value === "object") {
      // `for..in` avoids the per-object key array that Object.keys allocates.
      for (const key in value as Record<string, unknown>) {
        total += key.length + 1 // + the ':' / ',' separator
        stack.push((value as Record<string, unknown>)[key])
      }
    }
  }
  return total
}

export function charsToTokens(chars: number, charsPerToken: number): number {
  if (charsPerToken <= 0) return 0
  return Math.ceil(chars / charsPerToken)
}

export class Meter {
  private readonly sessions = new Map<string, SessionMetrics>()
  private dirty = false
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly storage: StorageLike,
    private readonly maxTrackedSessions: number,
    private readonly flushMs: number,
  ) {}

  /** Rehydrate counters from storage. Safe to call once during setup. */
  async load(): Promise<void> {
    let after: string | undefined
    // Bounded pages so a large history cannot balloon memory during startup.
    do {
      const page = await this.storage.scan({
        prefix: KEY_PREFIX,
        limit: 250,
        ...(after ? { after } : {}),
      })
      for (const entry of page.entries) {
        if (!isMetrics(entry.value)) continue
        this.sessions.set(entry.value.sessionID, entry.value)
      }
      after = page.next
    } while (after)
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.flush()
    }, this.flushMs)
    // Never hold the process open just to flush metrics.
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  get(sessionID: string): SessionMetrics {
    const existing = this.sessions.get(sessionID)
    if (existing) return existing

    if (this.sessions.size >= this.maxTrackedSessions) this.evictOldest()
    const created = blank(sessionID, Date.now())
    this.sessions.set(sessionID, created)
    return created
  }

  all(): SessionMetrics[] {
    return [...this.sessions.values()]
  }

  private evictOldest(): void {
    let oldest: SessionMetrics | undefined
    for (const metrics of this.sessions.values()) {
      if (!oldest || metrics.updatedAt < oldest.updatedAt) oldest = metrics
    }
    if (oldest) this.sessions.delete(oldest.sessionID)
  }

  private mutate(sessionID: string, change: (metrics: SessionMetrics) => void): void {
    const metrics = this.get(sessionID)
    change(metrics)
    metrics.updatedAt = Date.now()
    this.dirty = true
  }

  noteContext(sessionID: string, chars: number): void {
    this.mutate(sessionID, (m) => {
      m.requests += 1
      m.lastContextChars = chars
      if (chars > m.peakContextChars) m.peakContextChars = chars
    })
  }

  noteTool(sessionID: string, inChars: number, savedChars: number, deduped: boolean): void {
    this.mutate(sessionID, (m) => {
      m.toolCalls += 1
      m.toolCharsIn += Math.max(0, inChars)
      m.toolCharsSaved += Math.max(0, savedChars)
      if (deduped) m.dedupeHits += 1
    })
  }

  noteCompaction(sessionID: string): void {
    this.mutate(sessionID, (m) => {
      m.compactions += 1
      // Context is about to shrink; clear the peak so it reflects a fresh run.
      m.peakContextChars = m.lastContextChars
    })
  }

  noteRotation(sessionID: string): void {
    this.mutate(sessionID, (m) => {
      m.rotations += 1
    })
  }

  async flush(force = false): Promise<void> {
    if (!this.dirty && !force) return
    this.dirty = false
    for (const metrics of this.sessions.values()) {
      await this.storage.set(KEY_PREFIX + metrics.sessionID, metrics)
    }
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    void this.flush(true)
  }
}
