/**
 * Rolling daily token-usage ledger: "today" and "last 7 days".
 *
 * OpenCode's session snapshots carry only *cumulative* token totals - they
 * cannot be split per day after the fact. So the ledger stores the last-seen
 * totals per session and attributes only what grew since then to the current
 * day's bucket. A session seen for the first time sets its baseline without
 * counting (history never lands in "today"). Buckets older than 8 days are
 * pruned; the week window sums the newest 7 calendar days including today.
 *
 * Read-modify-write is serialized through a promise chain so concurrent
 * panel requests cannot double-count a delta.
 */
import type { StorageLike } from "./meter"
import type { SessionSnapshot } from "./state"

const STATE_KEY = "usage/v1"
const BUDGET_KEY = "usage/budget"
const KEEP_DAYS = 8
const WEEK_DAYS = 7
/** Daily budget used until the user sets their own (tokens). */
export const DEFAULT_BUDGET = 250_000

interface Totals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

interface UsageState {
  /** Day bucket (local YYYY-MM-DD) -> cumulative totals observed that day. */
  days: Record<string, Totals>
  /** Last-seen cumulative totals per session id. */
  baselines: Record<string, Totals>
}

export interface WindowTotals extends Totals {
  /** input + output + cache read + cache write. */
  tokens: number
}

export interface UsageWindows {
  today: WindowTotals
  week: WindowTotals
}

/** What the localhost page renders: text lines + donut numbers. */
export interface UsageSnapshot {
  text: string
  today: WindowTotals
  week: WindowTotals
  /** User-set daily token budget (donut denominator). */
  budget: number
}

/** The daily budget; missing/invalid storage falls back to the default. */
export async function getBudget(storage: StorageLike): Promise<number> {
  try {
    const raw = await storage.get(BUDGET_KEY)
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 1000 && n <= 100_000_000) return Math.floor(n)
  } catch {
    // Fall through to the default.
  }
  return DEFAULT_BUDGET
}

/** Validates and stores the daily budget; rejects nonsense values. */
export async function setBudget(storage: StorageLike, value: unknown): Promise<number> {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n < 1000 || n > 100_000_000) {
    throw new Error("daily budget must be 1,000 - 100,000,000 tokens")
  }
  await storage.set(BUDGET_KEY, n)
  return n
}

function emptyTotals(): Totals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

function dayKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

function shiftDays(days: number): Date {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date
}

function isTotals(value: unknown): value is Totals {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as Totals).input === "number" &&
    typeof (value as Totals).output === "number"
  )
}

function isState(value: unknown): value is UsageState {
  if (!value || typeof value !== "object") return false
  const state = value as UsageState
  if (!state.days || typeof state.days !== "object" || !state.baselines || typeof state.baselines !== "object") {
    return false
  }
  for (const totals of Object.values(state.days)) if (!isTotals(totals)) return false
  for (const totals of Object.values(state.baselines)) if (!isTotals(totals)) return false
  return true
}

function snapshotTotals(session: SessionSnapshot): Totals | null {
  const tokens = session.tokens
  if (!tokens) return null
  return {
    input: Math.max(0, tokens.input || 0),
    output: Math.max(0, tokens.output || 0),
    cacheRead: Math.max(0, tokens.cache?.read || 0),
    cacheWrite: Math.max(0, tokens.cache?.write || 0),
  }
}

function add(target: Totals, delta: Totals): void {
  target.input += delta.input
  target.output += delta.output
  target.cacheRead += delta.cacheRead
  target.cacheWrite += delta.cacheWrite
}

function toWindow(totals: Totals): WindowTotals {
  return {
    ...totals,
    tokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
  }
}

async function load(storage: StorageLike): Promise<UsageState> {
  try {
    const raw = await storage.get(STATE_KEY)
    if (isState(raw)) return raw
  } catch {
    // Fall through to a fresh ledger.
  }
  return { days: {}, baselines: {} }
}

async function compute(storage: StorageLike, sessions: SessionSnapshot[]): Promise<UsageWindows> {
  const state = await load(storage)
  const today = dayKey(new Date())
  let dirty = false

  for (const session of sessions) {
    const current = snapshotTotals(session)
    if (!current) continue
    const baseline = state.baselines[session.id]

    if (!baseline) {
      // First sighting: remember the total, count nothing - old history
      // must not land in "today".
      state.baselines[session.id] = current
      dirty = true
      continue
    }

    const shrunk =
      current.input < baseline.input ||
      current.output < baseline.output ||
      current.cacheRead < baseline.cacheRead ||
      current.cacheWrite < baseline.cacheWrite
    if (shrunk) {
      // Totals went backwards (reset/recreated session): re-baseline silently.
      state.baselines[session.id] = current
      dirty = true
      continue
    }

    const delta: Totals = {
      input: current.input - baseline.input,
      output: current.output - baseline.output,
      cacheRead: current.cacheRead - baseline.cacheRead,
      cacheWrite: current.cacheWrite - baseline.cacheWrite,
    }
    if (delta.input + delta.output + delta.cacheRead + delta.cacheWrite === 0) continue

    const bucket = state.days[today] ?? emptyTotals()
    add(bucket, delta)
    state.days[today] = bucket
    state.baselines[session.id] = current
    dirty = true
  }

  // Prune buckets outside the rolling window (keep one extra day of slack).
  const cutoff = dayKey(shiftDays(-(KEEP_DAYS - 1)))
  for (const key of Object.keys(state.days)) {
    if (key < cutoff) {
      delete state.days[key]
      dirty = true
    }
  }

  if (dirty) await storage.set(STATE_KEY, state)

  const todayTotals = state.days[today] ?? emptyTotals()
  const weekStart = dayKey(shiftDays(-(WEEK_DAYS - 1)))
  const weekTotals = emptyTotals()
  for (const [key, bucket] of Object.entries(state.days)) {
    if (key >= weekStart && key <= today) add(weekTotals, bucket)
  }

  return { today: toWindow(todayTotals), week: toWindow(weekTotals) }
}

let chain: Promise<unknown> = Promise.resolve()

/** Serialized read-modify-write of the ledger; returns the current windows. */
export function updateUsage(storage: StorageLike, sessions: SessionSnapshot[]): Promise<UsageWindows> {
  const run = chain.then(() => compute(storage, sessions))
  chain = run.catch(() => undefined)
  return run
}

function fmt(n: number): string {
  return n.toLocaleString("en-US")
}

/** The two-line text the localhost page shows under "Usage". */
export function formatUsageWindows(w: UsageWindows): string {
  const line = (label: string, t: WindowTotals): string =>
    `${label.padEnd(11)}: ${fmt(t.tokens)} tokens  (in ${fmt(t.input)} · out ${fmt(t.output)} · cached ${fmt(
      t.cacheRead + t.cacheWrite,
    )})`
  return [line("today", w.today), line(`last ${WEEK_DAYS} days`, w.week)].join("\n")
}
