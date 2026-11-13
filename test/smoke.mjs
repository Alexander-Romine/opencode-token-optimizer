/** Smoke test: native load path + native/fallback byte-for-byte agreement. */
import { api, fallbackApi, nativeAvailable, nativeDetail } from "../src/native.ts"

let failures = 0
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`)
  if (!ok) failures++
}

console.log(`native: ${nativeAvailable}  detail: ${nativeDetail}`)
check("native addon loaded", nativeAvailable === true, nativeDetail)

// compress: ANSI stripping + blank collapse + truncation
const input = "\u001b[31mred\u001b[0m\r\n\r\n\r\n\r\n" + "x".repeat(500) + " tail"
const nativeResult = api.compress(input, {
  maxChars: 100,
  headPct: 70,
  stripAnsi: true,
  collapseBlank: true,
  maxBlankLines: 1,
  trimLines: true,
})
check("ansi stripped", !nativeResult.text.includes("\u001b") && nativeResult.text.includes("red"))
check("collapsed", nativeResult.collapsed)
check("truncated", nativeResult.truncated && nativeResult.resultChars <= 100, `${nativeResult.resultChars}`)

// hash agreement across implementations
const cases = [
  [],
  ["a"],
  ["a", "b"],
  ["b", "a"],
  ["tool", "some long output ".repeat(100)],
  ["unicode", "héllo wörld 😀 日本語"],
]
for (const parts of cases) {
  const n = api.hashParts(parts)
  const j = fallbackApi.hashParts(parts)
  check(`hash match ${JSON.stringify(parts).slice(0, 40)}`, n === j && /^[0-9a-f]{16}$/.test(n), `rust=${n} js=${j}`)
}

// fingerprint agreement
const nf = api.fingerprint("/a/b.txt", 1234, 1700000000000)
const jf = fallbackApi.fingerprint("/a/b.txt", 1234, 1700000000000)
check("fingerprint match", nf === jf && /^[0-9a-f]{16}$/.test(nf), nf)

// utf8 safety at cut points
const emoji = api.compress("\u{1f600}".repeat(500), {
  maxChars: 60,
  headPct: 70,
  stripAnsi: true,
  collapseBlank: true,
  maxBlankLines: 1,
  trimLines: false,
})
check("utf8 intact", !emoji.text.includes("\ufffd") && emoji.resultChars <= 60)

// ---- RTK command-output reduction ----
import { reduceCommand } from "../src/rtk.ts"
import { ToolOptimizer } from "../src/tools.ts"
import { parseOptions } from "../src/options.ts"

const rtkDefaults = parseOptions({}).rtk

function cargoTestOutput() {
  const lines = []
  for (let i = 0; i < 300; i++) lines.push(`test tests::case_${i} ... ok`)
  lines.push("")
  lines.push("failures:")
  lines.push("")
  lines.push("---- tests::case_7 stdout ----")
  lines.push("thread 'tests::case_7' panicked at src/lib.rs:42:9:")
  lines.push("assertion `left == right` failed: expected 3, got 4")
  lines.push("")
  lines.push("failures:")
  lines.push("    tests::case_7")
  lines.push("")
  lines.push("test result: FAILED. 299 passed; 1 failed; 0 ignored; 0 measured; finished in 0.02s")
  return lines.join("\n")
}

const cargoOut = cargoTestOutput()
const cargoReduced = reduceCommand("cargo test --release", cargoOut, rtkDefaults)
check("rtk: cargo test output reduced", cargoReduced.length < cargoOut.length / 4, `${cargoOut.length} -> ${cargoReduced.length}`)
check(
  "rtk: failure signal kept",
  cargoReduced.includes("panicked at") && cargoReduced.includes("test result: FAILED"),
)
check("rtk: honest marker appended", cargoReduced.includes("[token-optimizer/rtk:"))
check("rtk: unknown command passthrough", reduceCommand("myweirdtool --flag", cargoOut, rtkDefaults) === cargoOut)
check(
  "rtk: short output passthrough",
  reduceCommand("cargo test", "test result: ok. 2 passed; 0 failed", rtkDefaults) ===
    "test result: ok. 2 passed; 0 failed",
)

const statusLines = ["On branch main", "Your branch is up to date with 'origin/main'.", "", "Changes not staged for commit:", '  (use "git add <file>..." to update what will be committed)']
for (let i = 0; i < 100; i++) statusLines.push(`\tmodified:   src/file_${i}.ts`)
statusLines.push("", "no changes added to commit (use \"git add\" and/or \"git commit -a\")")
const gitOut = statusLines.join("\n")
const gitReduced = reduceCommand("git status", gitOut, rtkDefaults)
check(
  "rtk: git status drops help text, keeps files",
  gitReduced.length < gitOut.length &&
    !gitReduced.includes('use "git add <file>..."') &&
    gitReduced.includes("modified:   src/file_0.ts") &&
    gitReduced.includes("On branch main") &&
    gitReduced.includes("more files"),
  `${gitOut.length} -> ${gitReduced.length}`,
)

const buildLines = []
for (let i = 0; i < 200; i++) buildLines.push(`   Compiling crate_${i} v0.${i}.1`)
buildLines.push("    Finished `release` profile [optimized] target(s) in 12.00s")
const buildOut = buildLines.join("\n")
const buildReduced = reduceCommand("cargo build --release", buildOut, rtkDefaults)
check(
  "rtk: build noise dropped, outcome kept",
  buildReduced.includes("Finished") &&
    buildReduced.split("Compiling").length - 1 < 10 &&
    buildReduced.includes("[token-optimizer/rtk:"),
  `${buildOut.length} -> ${buildReduced.length}`,
)

// Two DIFFERENT outputs that reduce to the same text must never dedupe:
// the hash stays over the original, so "byte-identical" remains true.
function rtkVariant(marker) {
  const lines = []
  for (let i = 0; i < 200; i++) lines.push(`test tests::case_${i} ${marker} ... ok`)
  lines.push("thread 'x' panicked at src/lib.rs:1:1:")
  lines.push("assertion failed: value mismatch")
  lines.push("test result: FAILED. 199 passed; 1 failed")
  return lines.join("\n")
}
const opt = new ToolOptimizer(parseOptions({ tool: { dedupeMinChars: 100 } }))
const first = { content: [{ type: "text", text: rtkVariant("AAA") }] }
const second = { content: [{ type: "text", text: rtkVariant("BBB") }] }
const out1 = opt.optimize("rtk-sess", "bash", first, "cargo test")
const out2 = opt.optimize("rtk-sess", "bash", second, "cargo test")
check(
  "rtk: reduced before compress (model sees less)",
  out1 !== null && out1.finalChars < out1.originalChars,
  out1 ? `${out1.originalChars} -> ${out1.finalChars}` : "no outcome",
)
check(
  "rtk: differing originals never deduped despite equal reduction",
  out2 !== null && out2.deduped === false && !second.content[0].text.includes("withheld"),
)

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
