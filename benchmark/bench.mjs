/**
 * Benchmark for the token-optimizer compression/dedupe path.
 *
 * Generates representative agent-tool outputs (source reads, JSON dumps,
 * ANSI build logs, diffs, tables), runs them through the real plugin
 * compressor with the plugin's default options, and reports:
 *   - char reduction per sample (what the model no longer has to read)
 *   - meaningful-content retention (how much real information survived)
 *   - structural transforms (compactJson/collapseTable/scrub/collapseRepeats)
 *   - native vs fallback throughput
 *   - dedupe stub size vs repeat size
 *   - metering walk cost on a large request
 *
 * Run:  node benchmark/bench.mjs
 */
import { api, fallbackApi, nativeAvailable, nativeDetail } from "../src/native.ts"
import { transformText, ToolOptimizer } from "../src/tools.ts"
import { parseOptions } from "../src/options.ts"
import os from "node:os"

// Mirror of meter.ts estimateChars (inlined: Node strip-only mode cannot
// parse meter.ts's parameter properties). Walking live objects, O(values).
function estimateChars(system, messages, tools) {
  let total = 0
  const stack = [system, messages, tools]
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
      for (const key in value) {
        total += key.length + 1
        stack.push(value[key])
      }
    }
  }
  return total
}

const DEFAULTS = {
  maxChars: 24000, // plugin default tool.maxChars
  headPct: 70,
  stripAnsi: true,
  collapseBlank: true,
  maxBlankLines: 1,
  trimLines: false,
}

/* ------------------------------------------------------------------ *
 * Sample generators (seeded, so the README numbers are reproducible)
 * ------------------------------------------------------------------ */

let seed = 0x2f6e2b1
function rnd() {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  return ((seed >>> 0) % 10000) / 10000
}
function pick(list) {
  return list[Math.floor(rnd() * list.length) % list.length]
}

const WORDS = ["token", "session", "context", "buffer", "cache", "rotate", "compress", "dedupe", "meter", "window", "flush", "prompt", "output", "result", "state", "agent"]

function sourceFile(target) {
  const lines = []
  let i = 0
  while (lines.join("\n").length < target) {
    lines.push(
      `export function ${pick(WORDS)}${i}(input: string, depth = ${i % 7}): number {`,
      `  // ${pick(WORDS)} the ${pick(WORDS)} without extra allocation`,
      `  const ${pick(WORDS)} = input.length + depth * ${i % 13}`,
      `  return ${pick(WORDS)} > ${i % 97} ? ${pick(WORDS)} : 0`,
      `}`,
      ``,
    )
    i++
  }
  return lines.join("\n")
}

function jsonDump(target) {
  const rows = []
  let i = 0
  while (JSON.stringify(rows).length < target) {
    rows.push({
      id: `ses_${i.toString(16).padStart(8, "0")}`,
      title: `${pick(WORDS)} ${pick(WORDS)} ${i}`,
      tokens: { input: Math.floor(rnd() * 900000), output: Math.floor(rnd() * 40000) },
      cache: { read: Math.floor(rnd() * 500000), write: Math.floor(rnd() * 20000) },
      cost: Number((rnd() * 4).toFixed(4)),
      tags: [pick(WORDS), pick(WORDS)],
    })
    i++
  }
  return JSON.stringify(rows, null, 2)
}

function ansiLog(target) {
  const out = []
  let i = 0
  while (out.join("\n").length < target) {
    const level = i % 5
    if (level === 0) out.push(`\u001b[32m  finished\u001b[0m   ${pick(WORDS)}_step_${i} in ${(rnd() * 900 + 50).toFixed(0)}ms   `)
    else if (level === 1) out.push(`\u001b[33m  warning\u001b[0m   unused ${pick(WORDS)} at line ${i}  `)
    else if (level === 2) out.push(`\u001b[31m   error\u001b[0m   ${pick(WORDS)} mismatch: expected ${i % 41}, got ${i % 17}`)
    else if (level === 3) out.push(``) // blank runs
    else out.push(`\u001b[90m       .\u001b[0m ${pick(WORDS)} ${pick(WORDS)} ${pick(WORDS)} ${pick(WORDS)}`)
    if (i % 11 === 0) out.push(``, ``) // extra blank run
    i++
  }
  return out.join("\n")
}

function unifiedDiff(target) {
  const out = [`--- a/src/${pick(WORDS)}.ts`, `+++ b/src/${pick(WORDS)}.ts`, `@@ -1,8 +1,9 @@`]
  let i = 0
  while (out.join("\n").length < target) {
    const r = rnd()
    if (r < 0.34) out.push(`-  const ${pick(WORDS)} = ${i} // removed`)
    else if (r < 0.67) out.push(`+  const ${pick(WORDS)} = ${i + 1} // added`)
    else out.push(`   ${pick(WORDS)}_${i}(${pick(WORDS)}, ${pick(WORDS)})`)
    i++
  }
  return out.join("\n")
}

function table(target) {
  const out = []
  let i = 0
  while (out.join("\n").length < target) {
    out.push(
      `${String(i).padStart(6)}  ${pick(WORDS).padEnd(14)}  ${pick(WORDS).padEnd(18)}  ${(rnd() * 1000).toFixed(2).padStart(9)}   `,
    )
    i++
  }
  return out.join("\n")
}

function cleanSourceSmall() {
  return sourceFile(9000) // under the 24k budget: should be lossless
}

function markdownTable(target) {
  const out = ["| ID | Name | Status | Latency (ms) | Notes |", "| --- | --- | --- | --- | --- |"]
  let i = 0
  while (out.join("\n").length < target) {
    out.push(
      `| ${String(i).padStart(5)} | ${pick(WORDS).padEnd(14)} | ${pick(WORDS).padEnd(10)} | ${(rnd() * 1000).toFixed(2).padStart(9)} | ${pick(WORDS)} ${pick(WORDS)} |`,
    )
    i++
  }
  return out.join("\n")
}

function base64Blob(target) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  let out = ""
  while (out.length < target) out += alphabet[Math.floor(rnd() * alphabet.length) % alphabet.length]
  return `${out}=` // padding guarantees the base64-only signal the scrubber requires
}

function repeatedLog(target) {
  const out = []
  let i = 0
  while (out.join("\n").length < target) {
    if (i % 25 === 0) out.push(`INFO  checkpoint ${i} written to disk in ${(rnd() * 90 + 10).toFixed(1)}ms`)
    else out.push("WARN  retrying request after upstream timeout (attempt 3/5): connection reset by peer, backing off 2000ms")
    i++
  }
  return out.join("\n")
}

/** Typical sizes an agent actually produces within a turn. */
function typicalSuite() {
  return [
    ["grep/search results (~4k)", sourceFile(4_200)],
    ["file read (~9k)", sourceFile(9_100)],
    ["column table (~12k)", table(12_000)],
    ["pretty JSON (~20k)", jsonDump(20_000)],
    ["ANSI log near budget (~25k)", ansiLog(25_000)],
    ["diff (~6k)", unifiedDiff(6_000)],
  ]
}

/** Pathological reads that blow past any reasonable budget. */
function oversizedSuite() {
  return [
    ["source file read (300k)", sourceFile(300_000)],
    ["pretty JSON dump (320k)", jsonDump(320_000)],
    ["ANSI build log (200k)", ansiLog(200_000)],
    ["unified diff (150k)", unifiedDiff(150_000)],
  ]
}

/* ------------------------------------------------------------------ *
 * Measurement helpers
 * ------------------------------------------------------------------ */

/** Characters that carry actual information (whitespace and ANSI excluded). */
function meaningful(text) {
  return text
    .replace(/\u001b(?:\[[0-?]*[ -~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[()*+#][0-9A-Za-z]|[0-9A-Za-z=>])/g, "")
    .replace(/\s+/g, "").length
}

function pct(before, after) {
  return before === 0 ? 0 : ((before - after) / before) * 100
}

function time(fn, iterations) {
  fn() // warm
  const start = process.hrtime.bigint()
  for (let i = 0; i < iterations; i++) fn()
  const ns = Number(process.hrtime.bigint() - start)
  return ns / iterations / 1e6 // ms per op
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

const suites = [
  ["TYPICAL agent tool outputs (sizes seen in normal turns)", typicalSuite()],
  ["OVERSIZED reads (blow past the 24k budget)", oversizedSuite()],
]

console.log(`native: ${nativeAvailable} (${nativeDetail})`)
console.log(`defaults: maxChars=${DEFAULTS.maxChars} headPct=${DEFAULTS.headPct} stripAnsi=${DEFAULTS.stripAnsi} collapseBlank=${DEFAULTS.maxBlankLines}blank trimLines=${DEFAULTS.trimLines}\n`)

function runSuite(name, samples) {
  console.log(`\n== ${name} ==`)
  console.log("sample".padEnd(46) + "in".padStart(9) + "out".padStart(9) + "cut%".padStart(8) + "kept%".padStart(8) + "  notes")
  console.log("-".repeat(92))

  let totalIn = 0
  let totalOut = 0
  let totalMeaningfulIn = 0
  let totalMeaningfulOut = 0
  let truncatedCount = 0

  for (const [label, input] of samples) {
    const r = api.compress(input, DEFAULTS)
    const mIn = meaningful(input)
    const mOut = meaningful(r.text)
    const kept = mIn === 0 ? 100 : (mOut / mIn) * 100
    const notes = []
    if (r.truncated) {
      truncatedCount++
      notes.push(`head+tail, ${r.originalChars - r.resultChars} chars marked omitted`)
    } else notes.push("no truncation")
    if (r.stripped) notes.push("ansi/control stripped")
    if (r.collapsed) notes.push("blank runs collapsed")

    console.log(
      label.padEnd(46) +
        String(r.originalChars).padStart(9) +
        String(r.resultChars).padStart(9) +
        pct(r.originalChars, r.resultChars).toFixed(1).padStart(8) +
        kept.toFixed(1).padStart(8) +
        "  " + notes.join("; "),
    )

    totalIn += r.originalChars
    totalOut += r.resultChars
    totalMeaningfulIn += mIn
    totalMeaningfulOut += mOut
  }

  console.log("-".repeat(92))
  console.log(
    "SUITE TOTAL".padEnd(46) +
      String(totalIn).padStart(9) +
      String(totalOut).padStart(9) +
      pct(totalIn, totalOut).toFixed(1).padStart(8) +
      ((totalMeaningfulOut / totalMeaningfulIn) * 100).toFixed(1).padStart(8) +
      `  ${truncatedCount}/${samples.length} truncated`,
  )
  return { totalIn, totalOut, kept: (totalMeaningfulOut / totalMeaningfulIn) * 100, truncatedCount, n: samples.length }
}

const typical = runSuite(suites[0][0], suites[0][1])
const oversized = runSuite(suites[1][0], suites[1][1])

/* Lossless check on a typical under-budget read */
const small = suites[0][1][1][1]
const smallResult = api.compress(small, DEFAULTS)
const lossless = smallResult.text === small
console.log(`\ntypical 9k file read returned byte-identical: ${lossless ? "yes (zero information loss)" : "no"}`)

/* ------------------------------------------------------------------ *
 * Structural transforms (transformText: after RTK, before compress)
 * ------------------------------------------------------------------ */

const toolDefaults = parseOptions({}).tool

console.log(`\n== STRUCTURAL TRANSFORMS (TS side, before api.compress) ==`)
console.log("sample".padEnd(46) + "in".padStart(9) + "out".padStart(9) + "cut%".padStart(8) + "kept%".padStart(8) + "  notes")
console.log("-".repeat(92))

function transformRow(label, input, tool, opts, note) {
  const out = transformText(input, tool, opts)
  const mIn = meaningful(input)
  const mOut = meaningful(out)
  const kept = mIn === 0 ? 100 : (mOut / mIn) * 100
  console.log(
    label.padEnd(46) +
      String(input.length).padStart(9) +
      String(out.length).padStart(9) +
      pct(input.length, out.length).toFixed(1).padStart(8) +
      kept.toFixed(1).padStart(8) +
      "  " + note,
  )
  return { in: input.length, out: out.length, kept }
}

transformRow("markdown table (collapseTable, lossless)", markdownTable(12_000), "bash", toolDefaults, "padding stripped, rendering identical")
transformRow("pretty JSON (compactJson, lossless)", jsonDump(20_000), "bash", toolDefaults, "re-serialized, parse-gated")
transformRow("file read via read tool (skipped)", sourceFile(9_000), "read", toolDefaults, "byte-faithful for edit oldString")
transformRow("source file via bash (nothing fires)", sourceFile(9_000), "bash", toolDefaults, "not JSON/table - untouched")
transformRow("base64 blob (scrubBase64, lossy)", base64Blob(6_000), "bash", { ...toolDefaults, scrubBase64: true }, "opt-in; marker says what was dropped")
transformRow("repeated log lines (collapseRepeats, lossy)", repeatedLog(12_000), "bash", { ...toolDefaults, collapseRepeats: true }, "opt-in; runs of >=3 identical long lines")

/* Opt-in transforms: realistic samples built on the spot. */
function htmlPage(target) {
  const parts = ["<!doctype html><html><head><title>Bench</title><style>body{color:red}</style></head><body>"]
  let i = 0
  while (parts.join("").length < target) {
    parts.push(`<div class="row${i}"><h2>Section ${i}</h2><p>${pick(WORDS)} ${pick(WORDS)} ${pick(WORDS)} content</p></div>`)
    i++
  }
  parts.push(`<script>console.log("noise ${i}")</script></body></html>`)
  return parts.join("\n")
}
function diffWithLongContext(target) {
  const out = ["diff --git a/src/main.rs b/src/main.rs", "--- a/src/main.rs", "+++ b/src/main.rs", "@@ -1,40 +1,40 @@"]
  let i = 0
  while (out.join("\n").length < target) {
    if (i % 10 === 7) out.push("-    let old = compute(input);")
    else if (i % 10 === 8) out.push("+    let new = compute_fast(input);")
    else out.push(`     let ${pick(WORDS)}${i} = ${i} + ${pick(WORDS)}.len();`)
    i++
  }
  return out.join("\n")
}
function timestampLog(target) {
  const out = []
  let i = 0
  while (out.join("\n").length < target) {
    out.push(`2026-11-13T09:${String(i % 60).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}.${String(i % 1000).padStart(3, "0")}Z INFO ${pick(WORDS)} worker-${i % 4} handled ${pick(WORDS)} request`)
    i++
  }
  return out.join("\n")
}
function stackTrace(target) {
  const out = ["Error: benchmark failure", "    at handler (src/app.js:42:11)"]
  while (out.join("\n").length < target) {
    for (let k = 0; k < 6; k++) out.push("    at recurse (src/depth.js:10:5)")
    out.push("    at handler (src/app.js:43:9)")
  }
  out.push("    at main (src/index.js:5:1)")
  return out.join("\n")
}
function pathHeavyLog(target) {
  const home = (() => {
    try {
      return os.homedir()
    } catch {
      return "/home/user"
    }
  })()
  const out = []
  let i = 0
  while (out.join("\n").length < target) {
    out.push(`[${i}] compiling ${home}/src/module-${i}.ts -> ${home}/dist/module-${i}.js`)
    i++
  }
  return out.join("\n")
}

transformRow("html page (stripHtml, lossy)", htmlPage(12_000), "bash", { ...toolDefaults, stripHtml: true }, "opt-in; page gate, JSX untouched")
transformRow("unified diff (collapseDiff, lossy)", diffWithLongContext(14_000), "bash", { ...toolDefaults, collapseDiff: true }, "opt-in; changes kept, context marked")
transformRow("timestamped log (normalizeTime, lossy)", timestampLog(12_000), "bash", { ...toolDefaults, normalizeTime: true }, "opt-in; full timestamps -> <ts>")
transformRow("stack trace (collapseStacks, lossy)", stackTrace(10_000), "bash", { ...toolDefaults, collapseStacks: true }, "opt-in; identical frames -> one + count")
transformRow("path-heavy log (shortenPaths, lossy)", pathHeavyLog(10_000), "bash", { ...toolDefaults, shortenPaths: true }, "opt-in; home prefix -> ~")

/* ------------------------------------------------------------------ *
 * Device-RAM cache: repeat optimize() with and without memoization
 * ------------------------------------------------------------------ */

const cacheSample = sourceFile(100_000)
const mkResult = () => ({ content: [{ type: "text", text: cacheSample }] })
const cached = new ToolOptimizer(parseOptions({ tool: { ramCache: true, dedupeWindow: 0 } }))
cached.optimize("bench", "bash", mkResult()) // populate
const hitMs = time(() => cached.optimize("bench", "bash", mkResult()), 50)
const uncached = new ToolOptimizer(parseOptions({ tool: { ramCache: false, dedupeWindow: 0 } }))
const missMs = time(() => uncached.optimize("bench", "bash", mkResult()), 50)
const stats = cached.cacheStats()
console.log(
  `\nram cache: repeat optimize() of a ${cacheSample.length}-char result: ` +
    `${missMs.toFixed(2)} ms (full pipeline) -> ${hitMs.toFixed(2)} ms (hit) ` +
    `(${(missMs / Math.max(hitMs, 0.001)).toFixed(0)}x); ` +
    `stats ${stats.hits} hit / ${stats.misses} miss, ${stats.entries} entries, ${stats.chars.toLocaleString()} chars`,
)

/* ------------------------------------------------------------------ *
 * Dedupe: identical repeated read
 * ------------------------------------------------------------------ */

const bigRead = sourceFile(60_000)
const stub = `[token-optimizer] ${bigRead.length} chars withheld: byte-identical source output from 1 call ago (verified by content hash), and it is still in context. Use a different argument if you need it re-read.`
console.log(`\ndedupe: repeat of a ${bigRead.length}-char identical result -> ${stub.length} chars (${(bigRead.length / stub.length).toFixed(0)}x smaller on the repeat)`)
console.log(`        savings apply only to verified byte-identical repeats; real differences are never hidden.`)

/* ------------------------------------------------------------------ *
 * Throughput
 * ------------------------------------------------------------------ */

const mbSample = sourceFile(1_000_000)
const nativeMs = time(() => api.compress(mbSample, DEFAULTS), 20)
const fallbackMs = time(() => fallbackApi.compress(mbSample, DEFAULTS), 5)
console.log(`\nthroughput: native ${(mbSample.length / 1e6 / (nativeMs / 1000)).toFixed(0)} MB/s (${nativeMs.toFixed(2)} ms/MB), fallback ${(mbSample.length / 1e6 / (fallbackMs / 1000)).toFixed(0)} MB/s (${fallbackMs.toFixed(2)} ms/MB)`)

/* ------------------------------------------------------------------ *
 * Metering cost on a large request
 * ------------------------------------------------------------------ */

const fakeMessages = []
for (let i = 0; i < 400; i++) {
  fakeMessages.push({ role: i % 2 ? "user" : "assistant", content: [{ type: "text", text: `message ${i} ` + "lorem ipsum ".repeat(40) }] })
}
const fakeTools = Array.from({ length: 40 }, (_, i) => ({ name: `tool_${i}`, description: "does a thing ".repeat(20), parameters: { type: "object", properties: { a: { type: "string" } } } }))
const chars = estimateChars("You are an agent. ".repeat(500), fakeMessages, fakeTools)
const meterMs = time(() => estimateChars("You are an agent. ".repeat(500), fakeMessages, fakeTools), 200)
console.log(`metering: ~${Math.ceil(chars / 4).toLocaleString()}-token request measured in ${meterMs.toFixed(3)} ms (${(chars / 1e6).toFixed(2)} MB walked)`)
