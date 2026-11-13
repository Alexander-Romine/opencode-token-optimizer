/**
 * RTK-style command-output reduction.
 *
 * Named after rtk-ai/rtk (the "Rust Token Killer" CLI proxy): instead of
 * handing the model every line a command produced, recognise the command and
 * keep what carries signal - test summaries and failures, git state, install
 * errors - while dropping per-line noise ("Compiling …", per-test dots, help
 * text).
 *
 * Design rules, in order of importance:
 *
 *  1. **Never hide an outcome.** Failures, errors, panics and summary lines
 *     always survive; a reduction that cannot find a summary returns the input
 *     untouched rather than guess.
 *  2. **Always say what happened.** When lines are dropped, the result ends
 *     with a marker stating the original size and how to get it back.
 *  3. **Short output passes through.** Anything under `rtk.minChars` is not
 *     worth a rule (and RTK itself learned this the hard way).
 *
 * The reduced text still flows through the normal pipeline afterwards
 * (ANSI strip, blank collapse, `maxChars` truncation), so this layer only
 * ever removes lines the generic compressor would have kept.
 */
import type { RtkOptions } from "./options"

/** Line caps per rule; generous on purpose (signal first, then head+tail). */
const CAP = {
  test: 80,
  gitLog: 60,
  gitStatus: 40,
  noise: 40,
  list: 60,
  search: 100,
} as const

/** Head+tail with an explicit gap marker, mirroring the compressor's promise. */
function headTail(lines: string[], cap: number): string[] {
  if (lines.length <= cap) return lines
  const head = Math.ceil(cap / 2)
  const tail = cap - head
  const omitted = lines.length - cap
  return [
    ...lines.slice(0, head),
    `... ${omitted} lines omitted by rtk ...`,
    ...lines.slice(lines.length - tail),
  ]
}

/** Keep signal lines plus a few lines of context after each (assertion detail). */
function keepWithContext(lines: string[], signal: RegExp, context = 4): string[] {
  const keep = new Set<number>()
  for (let i = 0; i < lines.length; i++) {
    if (signal.test(lines[i] ?? "")) {
      keep.add(i)
      for (let j = i + 1; j <= i + context && j < lines.length; j++) keep.add(j)
    }
  }
  return lines.filter((_, index) => keep.has(index))
}

/* ------------------------------------------------------------------ *
 * Rules
 * ------------------------------------------------------------------ */

const TEST_CMDS =
  /\b(cargo\s+(test|nextest)|npm\s+(test|run\s+test)|npx\s+(vitest|jest|mocha)|pnpm\s+(test|run\s+test)|yarn\s+(test|run\s+test)|bun\s+(test|run\s+test)|vitest|jest|pytest|go\s+test|dotnet\s+test|phpunit|rspec|mix\s+test)\b/i

/** Summary + failure lines across cargo, jest/vitest, pytest, go test, dotnet. */
const TEST_SIGNAL =
  /test result:|tests?:\s|test suites:|panicked at|assertion|failed|passed|\berror(\[|:)|^FAIL|^ok\b|--- FAIL|^PASS|failures?:|✗|×|warning:/i

function reduceTestRun(lines: string[]): string[] | null {
  const kept = keepWithContext(lines, TEST_SIGNAL)
  // A rule that finds almost nothing is a format we do not understand:
  // returning the input is always safer than an empty summary.
  if (kept.length < 3 || kept.length >= lines.length * 0.9) return null
  return headTail(kept, CAP.test)
}

const GIT_STATUS = /\bgit\b[^|;&]*\bstatus\b/i

function reduceGitStatus(lines: string[]): string[] | null {
  const fileLine = /^\s+(modified|new file|deleted|renamed|both added|both modified|deleted by us|deleted by them|unmerged):/
  const porcelain = /^[ MADRC?!]{2} /
  const kept: string[] = []
  let files = 0
  for (const line of lines) {
    const isHeader = line.length > 0 && !/^\s/.test(line)
    const isFile = fileLine.test(line) || porcelain.test(line)
    if (isHeader) {
      kept.push(line)
    } else if (isFile) {
      files++
      if (files <= CAP.gitStatus) kept.push(line)
    }
    // "(use \"git add …\")" help lines and other indentation are dropped.
  }
  if (kept.length < 2 || kept.length >= lines.length * 0.9) return null
  if (files > CAP.gitStatus) kept.push(`... ${files - CAP.gitStatus} more files ...`)
  return kept
}

const GIT_LOG = /\bgit\b[^|;&]*\blog\b/i
const COMMIT_BLOCK = /^commit ([0-9a-f]{7,40})\b/

function reduceGitLog(lines: string[]): string[] | null {
  // Default format: blocks of "commit <hash>" + author/date + message.
  const starts: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (COMMIT_BLOCK.test(lines[i] ?? "")) starts.push(i)
  }

  if (starts.length > 0) {
    const kept: string[] = []
    for (let b = 0; b < starts.length; b++) {
      const from = starts[b] as number
      const to = b + 1 < starts.length ? (starts[b + 1] as number) : lines.length
      const hash = (COMMIT_BLOCK.exec(lines[from] as string)?.[1] ?? "").slice(0, 10)
      // First non-empty, non-metadata line of the message is the subject.
      let subject = ""
      for (let i = from + 1; i < to; i++) {
        const line = lines[i] as string
        if (/^(Author:|Date:|Merge:|\s)/.test(line) || line.trim() === "") continue
        subject = line.trim()
        break
      }
      kept.push(`${hash} ${subject}`.trim())
    }
    if (kept.length >= lines.length * 0.5) return null // already compact
    return headTail(kept, CAP.gitLog)
  }

  // --oneline (or similar): one line per commit already; only cap the tail.
  if (lines.length > CAP.gitLog && lines.every((line) => /^[0-9a-f]{7,40}\s/.test(line))) {
    return headTail(lines, CAP.gitLog)
  }
  return null
}

const NOISE_CMDS =
  /\b(npm|pnpm|yarn|bun)\s+(install|ci|i|add|update|audit)|\bcargo\s+(build|check|clippy|fetch|run)|\bnpm\s+run\s+build\b|\btsc\b/i

const NOISE_SIGNAL =
  /error|ERR!|warn(ing)?|Finished|added \d|done in|packages? in|vulnerabilit|deprecated|Built in|failed|found \d/i

function reduceNoise(lines: string[]): string[] | null {
  // Installs/builds: keep signal lines and the tail (the outcome is last).
  const keep = new Set<number>()
  for (let i = 0; i < lines.length; i++) {
    if (NOISE_SIGNAL.test(lines[i] ?? "")) keep.add(i)
  }
  for (let i = Math.max(0, lines.length - 8); i < lines.length; i++) keep.add(i)
  const kept = lines.filter((_, index) => keep.has(index))
  if (kept.length < 3 || kept.length >= lines.length * 0.85) return null
  return headTail(kept, CAP.noise)
}

const LIST_CMDS = /^(ls|dir|gci|get-childitem|tree)$/i
const SEARCH_CMDS = /^(grep|rg|findstr|select-string)$/i

function firstWord(command: string): string {
  const token = command.trim().split(/\s+/)[0] ?? ""
  return token.replace(/.*[\\/]/, "").replace(/["']/g, "").toLowerCase()
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

const KIND_LABEL: Record<string, string> = {
  "test run": "test run",
  "git status": "git status",
  "git log": "git log",
  "install/build": "install/build",
  "listing": "directory listing",
  search: "search",
}

/**
 * Reduce `text` when `command` is one of the recognised forms.
 * Returns the input unchanged when no rule applies, the output is short, or
 * the rule cannot find its signal (never guesses).
 */
export function reduceCommand(command: string, text: string, options: RtkOptions): string {
  if (!options.enabled || text.length < options.minChars) return text

  const lines = text.split("\n")
  let reduced: string[] | null = null
  let kind: string | null = null

  if (TEST_CMDS.test(command)) {
    kind = "test run"
    reduced = reduceTestRun(lines)
  } else if (GIT_STATUS.test(command)) {
    kind = "git status"
    reduced = reduceGitStatus(lines)
  } else if (GIT_LOG.test(command)) {
    kind = "git log"
    reduced = reduceGitLog(lines)
  } else if (NOISE_CMDS.test(command)) {
    kind = "install/build"
    reduced = reduceNoise(lines)
  } else {
    const word = firstWord(command)
    if (LIST_CMDS.test(word)) {
      kind = "listing"
      reduced = headTail(lines, CAP.list)
      if (reduced === lines) reduced = null // short list: nothing to do
    } else if (SEARCH_CMDS.test(word)) {
      kind = "search"
      reduced = headTail(lines, CAP.search)
      if (reduced === lines) reduced = null
    }
  }

  if (!reduced || !kind || reduced.length >= lines.length) return text

  const pct = Math.round((1 - reduced.length / lines.length) * 100)
  const marker =
    `[token-optimizer/rtk: ${KIND_LABEL[kind]} output reduced ${lines.length} -> ` +
    `${reduced.length} lines (-${pct}%); summaries, failures and errors kept. ` +
    `Disable options.rtk for the full output.]`
  return `${reduced.join("\n")}\n${marker}`
}
