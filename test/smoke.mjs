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
import { ToolOptimizer, transformText } from "../src/tools.ts"
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

// ---- /plugins: config directive manager ----
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createPluginmgr } from "../src/pluginmgr.ts"

const pmTmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-pm-"))
const pmGlobal = path.join(pmTmp, "global")
const pmProject = path.join(pmTmp, "project")
fs.mkdirSync(pmGlobal, { recursive: true })
fs.mkdirSync(pmProject, { recursive: true })
const gFile = path.join(pmGlobal, "opencode.json")
const pFile = path.join(pmProject, "opencode.json")
fs.writeFileSync(gFile, `${JSON.stringify({ model: "x", plugins: ["opencode-history-search"] }, null, 2)}\n`)
fs.writeFileSync(
  pFile,
  `${JSON.stringify({ plugins: [{ package: "oh-my-opencode-slim", options: { a: 1 } }], "//doc": true }, null, 2)}\n`,
)

let pmActive = [
  { id: "history-search", source: { type: "package", target: "opencode-history-search" }, features: { server: true }, state: { status: "active" } },
  { id: "oh-my-opencode-slim", source: { type: "package", target: "oh-my-opencode-slim" }, features: { tui: true }, state: { status: "active" } },
  { id: "token-optimizer", source: { type: "local", path: path.join(pmProject, "token-optimizer") }, features: { server: true, rpc: true }, state: { status: "active" } },
  { id: "opencode.provider.opencode", source: { type: "builtin" }, features: { server: true }, state: { status: "active" } },
]
const pmStore = new Map()
const pm = createPluginmgr({
  directory: pmProject,
  globalDir: pmGlobal,
  list: async () => pmActive,
  storage: { get: async (k) => pmStore.get(k), set: async (k, v) => void pmStore.set(k, v) },
})

let pmList = await pm.list()
const rowOf = (key) => pmList.rows.find((r) => r.key === key)
check("pm: rows for both config entries + runtime-only plugins", pmList.rows.length === 4, pmList.rows.map((r) => r.key).join(","))
check("pm: strict JSON config gives no warnings", pmList.warnings.length === 0, pmList.warnings.join(" | "))
check("pm: guarded builtin locked", rowOf("opencode.provider.opencode")?.locked === true)
check("pm: self locked", rowOf("token-optimizer")?.locked === true && rowOf("token-optimizer").detail.includes("installer"))
check("pm: entry rows enabled and active", rowOf("history-search")?.enabled === true && rowOf("history-search")?.status === "active")

// disable -> directive appended to the declaring file, backup, no BOM, doc keys kept
const gBefore = fs.readFileSync(gFile, "utf8")
let pmSet = await pm.set([{ key: "history-search", enabled: false }])
check("pm: disable reports no errors", pmSet.errors.length === 0, pmSet.errors.join(" | "))
check("pm: disable wrote one backup", pmSet.backups.length === 1 && fs.existsSync(pmSet.backups[0]), pmSet.backups.join(","))
const gAfter = fs.readFileSync(gFile, "utf8")
check("pm: -id appended", gAfter.includes('"-history-search"'))
check("pm: other keys and entries kept", gAfter.includes('"model": "x"'))
check("pm: no BOM on write", fs.readFileSync(gFile)[0] !== 0xef)
check("pm: returned row shows disabled", pmSet.rows.find((r) => r.key === "history-search")?.enabled === false)

// simulate the config hot-reload: the disabled plugin leaves the inventory
pmActive = pmActive.filter((p) => p.id !== "history-search")
pmList = await pm.list()
check(
  "pm: disabled row persists via id map after leaving inventory",
  rowOf("history-search")?.enabled === false && rowOf("history-search")?.status === "disabled",
  JSON.stringify(rowOf("history-search")),
)

// enable roundtrip: directive stripped everywhere, backup taken again
pmSet = await pm.set([{ key: "history-search", enabled: true }])
check("pm: enable reports no errors", pmSet.errors.length === 0, pmSet.errors.join(" | "))
check("pm: enable removes the directive", !fs.readFileSync(gFile, "utf8").includes('"-history-search"'))
check("pm: enable took a backup", pmSet.backups.length === 1)

// locked row refuses
pmSet = await pm.set([{ key: "token-optimizer", enabled: false }])
check("pm: locked row refused", pmSet.errors.length === 1 && /installer/.test(pmSet.errors[0]), pmSet.errors.join(" | "))
check("pm: locked row write made no backup", pmSet.backups.length === 0)

// hand-written orphan directive gets its own disabled row
const pObj = JSON.parse(fs.readFileSync(pFile, "utf8"))
pObj.plugins.push("-ghost.plugin")
fs.writeFileSync(pFile, `${JSON.stringify(pObj, null, 2)}\n`)
pmList = await pm.list()
const orphan = pmList.rows.find((r) => r.key === "ghost.plugin")
check("pm: orphan directive listed disabled", orphan?.enabled === false && orphan?.kind === "directive", JSON.stringify(orphan))

// storage map persists package -> id
check(
  "pm: id map persisted",
  pmStore.get("plugin-ids")?.targets?.["opencode-history-search"] === "history-search",
  JSON.stringify(pmStore.get("plugin-ids")),
)

// JSONC: listed after comment-stripping, but never writable
const pm2Dir = path.join(pmTmp, "jsonc-project")
const pm2Global = path.join(pmTmp, "empty-global")
fs.mkdirSync(pm2Dir, { recursive: true })
fs.mkdirSync(pm2Global, { recursive: true })
const jFile = path.join(pm2Dir, "opencode.json")
const jRaw = '// hand comment\n{\n  "plugins": ["some-plugin"]\n}\n'
fs.writeFileSync(jFile, jRaw)
const pm2Store = new Map([
  ["plugin-ids", { targets: { "some-plugin": "some-plugin-id" }, labels: { "some-plugin-id": "some-plugin" } }],
])
const pm2 = createPluginmgr({
  directory: pm2Dir,
  globalDir: pm2Global,
  list: async () => [],
  storage: { get: async (k) => pm2Store.get(k), set: async (k, v) => void pm2Store.set(k, v) },
})
const pm2List = await pm2.list()
check("pm: JSONC entry listed read-only", pm2List.rows.some((r) => r.key === "some-plugin-id"), JSON.stringify(pm2List.rows))
check("pm: JSONC warned", pm2List.warnings.some((w) => w.includes("JSONC")), pm2List.warnings.join(" | "))
const pm2Set = await pm2.set([{ key: "some-plugin-id", enabled: false }])
check("pm: JSONC write refused with friendly error", pm2Set.errors.length === 1 && /JSONC/.test(pm2Set.errors[0]), pm2Set.errors.join(" | "))
check("pm: JSONC file byte-unchanged", fs.readFileSync(jFile, "utf8") === jRaw)
check("pm: JSONC refusal wrote no backup", pm2Set.backups.length === 0)

// ---- conflict detection ----
const pm3Dir = path.join(pmTmp, "conflict-project")
const pm3Global = path.join(pmTmp, "conflict-global")
fs.mkdirSync(pm3Dir, { recursive: true })
fs.mkdirSync(pm3Global, { recursive: true })
const gFile3 = path.join(pm3Global, "opencode.json")
const pFile3 = path.join(pm3Dir, "opencode.json")
fs.writeFileSync(
  gFile3,
  `${JSON.stringify({ plugins: ["/x/global-copy", "opencode-gemini-auth", "opencode-supermemory"] }, null, 2)}\n`,
)
fs.writeFileSync(
  pFile3,
  `${JSON.stringify({ plugins: ["./proj-copy", "opencode-antigravity-auth", "oh-my-opencode-slim"] }, null, 2)}\n`,
)
let pm3Active = [
  { id: "token-optimizer", source: { type: "local", path: "/x/global-copy" }, features: { server: true }, state: { status: "active" } },
  { id: "opencode-gemini-auth", source: { type: "package", target: "opencode-gemini-auth" }, features: { server: true }, state: { status: "active" } },
  { id: "opencode-antigravity-auth", source: { type: "package", target: "opencode-antigravity-auth" }, features: { server: true }, state: { status: "active" } },
  { id: "opencode-supermemory", source: { type: "package", target: "opencode-supermemory" }, features: { server: true }, state: { status: "active" } },
  { id: "oh-my-opencode-slim", source: { type: "package", target: "oh-my-opencode-slim" }, features: { tui: true }, state: { status: "active" } },
]
const pm3Store = new Map([
  [
    "plugin-ids",
    {
      targets: { "/x/global-copy": "token-optimizer", [path.join(pm3Dir, "proj-copy")]: "token-optimizer" },
      labels: { "token-optimizer": "/x/global-copy" },
    },
  ],
])
const pm3 = createPluginmgr({
  directory: pm3Dir,
  globalDir: pm3Global,
  list: async () => pm3Active,
  storage: { get: async (k) => pm3Store.get(k), set: async (k, v) => void pm3Store.set(k, v) },
})
let pm3List = await pm3.list()
const row3 = (key) => pm3List.rows.find((r) => r.key === key)

check("conflict: every row carries a conflict field", pm3List.rows.every((r) => typeof r.conflict === "string"))
check(
  "conflict: duplicate id from two distinct paths flagged",
  /duplicate id "token-optimizer"/.test(row3("token-optimizer")?.conflict ?? "") &&
    (row3("token-optimizer")?.conflict ?? "").includes("2 paths"),
  row3("token-optimizer")?.conflict,
)
check(
  "conflict: gemini-auth vs antigravity-auth flagged (both sides)",
  (row3("opencode-gemini-auth")?.conflict ?? "").includes("conflicts with opencode-antigravity-auth") &&
    (row3("opencode-antigravity-auth")?.conflict ?? "").includes("conflicts with opencode-gemini-auth"),
  `${row3("opencode-gemini-auth")?.conflict} | ${row3("opencode-antigravity-auth")?.conflict}`,
)
check("conflict: supermemory alone not flagged", row3("opencode-supermemory")?.conflict === "", row3("opencode-supermemory")?.conflict)
check(
  "conflict: oh-my-opencode-slim never matches oh-my-opencode",
  row3("oh-my-opencode-slim")?.conflict === "",
  row3("oh-my-opencode-slim")?.conflict,
)

// the same package declared in two files is one target - not a duplicate id
const pObj3 = JSON.parse(fs.readFileSync(pFile3, "utf8"))
pObj3.plugins.push("opencode-gemini-auth")
fs.writeFileSync(pFile3, `${JSON.stringify(pObj3, null, 2)}\n`)
pm3List = await pm3.list()
check(
  "conflict: same target twice is not a duplicate-id conflict",
  !(row3("opencode-gemini-auth")?.conflict ?? "").includes("duplicate id"),
  row3("opencode-gemini-auth")?.conflict,
)

// a disabled partner suppresses the pair note
pm3Active = pm3Active.filter((p) => p.id !== "opencode-antigravity-auth")
const pObj3b = JSON.parse(fs.readFileSync(pFile3, "utf8"))
pObj3b.plugins.push("-opencode-antigravity-auth")
fs.writeFileSync(pFile3, `${JSON.stringify(pObj3b, null, 2)}\n`)
pm3List = await pm3.list()
check(
  "conflict: disabled partner suppresses pair note",
  row3("opencode-antigravity-auth")?.enabled === false && row3("opencode-gemini-auth")?.conflict === "",
  `antigravity=${JSON.stringify(row3("opencode-antigravity-auth")?.enabled)} gemini=${JSON.stringify(row3("opencode-gemini-auth")?.conflict)}`,
)

fs.rmSync(pmTmp, { recursive: true, force: true })

// ---- structural transforms (compactJson / collapseTable / scrubBase64 / collapseRepeats) ----
const toolDefaults = parseOptions({}).tool

const jsonPretty = '{\n  "a": 1,\n  "b": [1, 2, 3]\n}\n'
check(
  "transform: compactJson drops insignificant whitespace",
  transformText(jsonPretty, "bash", toolDefaults) === '{"a":1,"b":[1,2,3]}',
  JSON.stringify(transformText(jsonPretty, "bash", toolDefaults)),
)
check("transform: JSONL left untouched", transformText('{"a": 1}\n{"b": 2}', "bash", toolDefaults) === '{"a": 1}\n{"b": 2}')
check("transform: prose-wrapped JSON left untouched", transformText('Result: {"a": 1}', "bash", toolDefaults) === 'Result: {"a": 1}')
check("transform: read tool output byte-faithful", transformText(jsonPretty, "read", toolDefaults) === jsonPretty)

const table = "| Name | V |\n| ---- | - |\n| x    | 1 |\n"
const tableOut = transformText(table, "bash", toolDefaults)
check("transform: table padding stripped", tableOut === "|Name|V|\n|----|-|\n|x|1|\n", JSON.stringify(tableOut))

const fenced = "```\n| a | b |\n```\n| c | d |"
const fencedOut = transformText(fenced, "bash", toolDefaults)
check(
  "transform: table inside code fence untouched, outside collapsed",
  fencedOut.includes("| a | b |") && fencedOut.endsWith("|c|d|"),
  JSON.stringify(fencedOut),
)

const escaped = "| a \\| b |"
check("transform: escaped-pipe row untouched", transformText(escaped, "bash", toolDefaults) === escaped)

const blob = `${"QUJD".repeat(150)}=`
const scrubOn = { ...toolDefaults, scrubBase64: true }
check("transform: base64 scrub off by default", transformText(blob, "bash", toolDefaults) === blob)
const scrubOut = transformText(blob, "bash", scrubOn)
check("transform: base64 scrub elides >=500-char blobs", scrubOut === "[token-optimizer: base64 blob of 601 chars elided]", scrubOut)
check("transform: hex-only runs never scrubbed", transformText("0".repeat(600), "bash", scrubOn) === "0".repeat(600))

const repeatsOn = { ...toolDefaults, collapseRepeats: true }
const boom = `ERROR: module failed while loading: ${"x".repeat(60)}`
const logsOut = transformText([boom, boom, boom, "done"].join("\n"), "bash", repeatsOn)
check(
  "transform: identical long lines collapsed with count",
  logsOut.split(boom).length - 1 === 1 && logsOut.includes("2 more identical lines omitted"),
  JSON.stringify(logsOut),
)
check("transform: short repeated lines untouched", transformText("}\n}\n}", "bash", repeatsOn) === "}\n}\n}")
check("transform: run of two not collapsed", transformText(`${boom}\n${boom}`, "bash", repeatsOn) === `${boom}\n${boom}`)

check(
  "transform: snake_case option aliases parse",
  parseOptions({ tool: { compact_json: false, scrub_base64: true } }).tool.compactJson === false &&
    parseOptions({ tool: { scrub_base64: true } }).tool.scrubBase64 === true,
)

// through optimize(): JSON compacted before compress, read untouched, dedupe
// hash still over the original bytes (whitespace variants never dedupe).
const jOpt = new ToolOptimizer(parseOptions({ tool: { dedupeWindow: 0 } }))
const jRes = { content: [{ type: "text", text: '{\n  "ok": true\n}' }] }
const jOut = jOpt.optimize("json-sess", "bash", jRes)
check("transform: optimize() compacts JSON tool output", jOut !== null && jRes.content[0].text === '{"ok":true}', JSON.stringify(jRes.content[0]?.text))
const rRes = { content: [{ type: "text", text: '{\n  "read": true\n}' }] }
jOpt.optimize("json-sess", "read", rRes)
check("transform: optimize() leaves read tool byte-faithful", rRes.content[0].text === '{\n  "read": true\n}', JSON.stringify(rRes.content[0].text))

const hOpt = new ToolOptimizer(parseOptions({ tool: { dedupeMinChars: 5 } }))
const h1 = { content: [{ type: "text", text: '{\n  "a": 1\n}' }] }
const h2 = { content: [{ type: "text", text: '{"a":1}' }] }
hOpt.optimize("h-sess", "bash", h1)
const hOut2 = hOpt.optimize("h-sess", "bash", h2)
check(
  "transform: different JSON originals never deduped despite equal compaction",
  hOut2 !== null && hOut2.deduped === false && !h2.content[0].text.includes("withheld"),
)
const h3 = { content: [{ type: "text", text: '{\n  "a": 1\n}' }] }
const hOut3 = hOpt.optimize("h-sess", "bash", h3)
check("transform: byte-identical JSON still deduped", hOut3 !== null && hOut3.deduped === true)

// ---- opt-in transforms (shortenPaths / normalizeTime / stacks / diff / html) ----

const home = os.homedir()
const homeFile = `${home}\\Documents\\file.txt`
const pathsOn = { ...toolDefaults, shortenPaths: true }
const shortOut = transformText(`reading ${homeFile} now`, "bash", pathsOn)
check(
  "transform: home path shortened when opted in",
  shortOut === "reading ~\\Documents\\file.txt now",
  JSON.stringify(shortOut),
)
check(
  "transform: home path untouched by default",
  transformText(`reading ${homeFile}`, "bash", toolDefaults).includes(home),
)

const timeOn = { ...toolDefaults, normalizeTime: true }
const timed = "start 2026-11-13T09:13:12.483Z end\nat 2026-11-13 09:13:12.500 done\ndate 2026-11-13 alone"
const timeOut = transformText(timed, "bash", timeOn)
check(
  "transform: full timestamps normalized to <ts>",
  timeOut.includes("start <ts> end") && timeOut.includes("at <ts> done"),
  JSON.stringify(timeOut),
)
check("transform: bare dates untouched", timeOut.includes("date 2026-11-13 alone"))
check("transform: timestamps untouched by default", transformText(timed, "bash", toolDefaults).includes("2026-11-13T09:13:12.483Z"))

const stacksOn = { ...toolDefaults, collapseStacks: true }
const frame = "    at run (app.js:10:5)"
const trace = [frame, frame, frame, "    at main (app.js:1:1)"].join("\n")
const stackOut = transformText(trace, "bash", stacksOn)
check(
  "transform: repeated stack frames collapsed with count",
  stackOut.split(frame).length - 1 === 1 && stackOut.includes("2 more identical stack frames omitted"),
  JSON.stringify(stackOut),
)
check("transform: stack collapse off by default", transformText(trace, "bash", toolDefaults) === trace)

const diffOn = { ...toolDefaults, collapseDiff: true }
const diffCtx = Array.from({ length: 12 }, (_, i) => ` ctx line ${i}`)
const diffText = [
  "diff --git a/f.txt b/f.txt",
  "--- a/f.txt",
  "+++ b/f.txt",
  "@@ -1,15 +1,15 @@",
  ...diffCtx,
  "-old",
  "+new",
  ...diffCtx.slice(0, 4),
].join("\n")
const diffOut = transformText(diffText, "bash", diffOn)
check(
  "transform: long diff context runs collapsed, changes kept",
  diffOut.includes("8 unchanged lines omitted") && diffOut.includes("-old") && diffOut.includes("+new"),
  JSON.stringify(diffOut),
)
check(
  "transform: non-diff text untouched by collapseDiff",
  transformText("@@ not really a diff", "bash", diffOn) === "@@ not really a diff",
)
check("transform: diff untouched by default", transformText(diffText, "bash", toolDefaults) === diffText)

const htmlOn = { ...toolDefaults, stripHtml: true }
const page = "<!doctype html><html><body><h1>Title</h1><p>Hello world</p><script>var x=1;</script></body></html>"
const htmlOut = transformText(page, "bash", htmlOn)
check(
  "transform: html page stripped to text, script dropped",
  htmlOut.includes("Title") && htmlOut.includes("Hello world") && !htmlOut.includes("<p>") && !htmlOut.includes("var x"),
  JSON.stringify(htmlOut),
)
const jsx = 'const el = <div className="x">hi</div>'
check("transform: non-page markup untouched", transformText(jsx, "bash", htmlOn) === jsx)
check("transform: html untouched by default", transformText(page, "bash", toolDefaults).includes("<html"))

// ---- device-RAM cache ----

const cacheBig = `{"payload": "${"x".repeat(300)}"}`
const cOpt = new ToolOptimizer(parseOptions({ tool: { ramCache: true, dedupeWindow: 0 } }))
const c1 = { content: [{ type: "text", text: cacheBig }] }
cOpt.optimize("cache-sess", "bash", c1)
const s1 = cOpt.cacheStats()
const c2 = { content: [{ type: "text", text: cacheBig }] }
const o2 = cOpt.optimize("cache-sess", "bash", c2)
const s2 = cOpt.cacheStats()
check(
  "cache: first call misses, repeat hits",
  s1.misses === 1 && s1.hits === 0 && s2.hits === 1 && o2 !== null,
  JSON.stringify(s2),
)
check("cache: hit output identical to miss", c1.content[0].text === c2.content[0].text)

const noCache = new ToolOptimizer(parseOptions({ tool: { ramCache: false, dedupeWindow: 0 } }))
noCache.optimize("cache-off", "bash", { content: [{ type: "text", text: cacheBig }] })
noCache.optimize("cache-off", "bash", { content: [{ type: "text", text: cacheBig }] })
const offStats = noCache.cacheStats()
check("cache: disabled stays at zero hits and zero entries", offStats.enabled === false && offStats.hits === 0 && offStats.entries === 0)

cOpt.optimize("cache-sess", "bash", { content: [{ type: "text", text: "tiny" }] })
check("cache: results under 256 chars not cached", cOpt.cacheStats().entries === s2.entries)

const tinyCache = new ToolOptimizer(parseOptions({ tool: { ramCache: true, ramCacheChars: 100, dedupeWindow: 0 } }))
tinyCache.optimize("cache-tiny", "bash", { content: [{ type: "text", text: cacheBig }] })
check("cache: budget smaller than entry stores nothing", tinyCache.cacheStats().entries === 0)

// ---- /optimize: options + companions through the real config machinery ----

import { createOptmgr } from "../src/optmgr.ts"

const omDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-om-"))
const omCfg = path.join(omDir, "opencode.json")
fs.writeFileSync(
  omCfg,
  JSON.stringify(
    {
      plugins: [
        { package: "./plugins/token-optimizer", options: { tool: { compactJson: true, ramCache: false } } },
        "opencode-history-search",
        "opencode-supermemory",
        "opencode-gemini-auth@2.0.1",
      ],
      mcp: { servers: { exa: { type: "remote", url: "https://mcp.exa.ai/mcp" } } },
      custom: { keep: true },
    },
    null,
    2,
  ) + "\n",
  "utf8",
)
const om = createOptmgr({ directory: omDir, globalDir: path.join(omDir, "no-global") })

const omGet = om.get()
const omRow = (key) => omGet.rows.find((r) => r.key === key)
check("optmgr: rows cover all three sections", omGet.rows.some((r) => r.section === "feature") && omGet.rows.some((r) => r.section === "transform") && omGet.rows.some((r) => r.section === "companion"))
check("optmgr: reads existing option values", omRow("rtk")?.enabled === true && omRow("ramCache")?.enabled === false && omRow("compactJson")?.enabled === true, JSON.stringify(omGet.rows.slice(0, 3)))
check("optmgr: companion install state detected", omRow("history")?.enabled === true && omRow("exa")?.enabled === true && omRow("quota")?.enabled === false)

const omSet = om.set([
  { key: "rtk", enabled: false },
  { key: "ramCache", enabled: true },
  { key: "scrubBase64", enabled: true },
  { key: "quota", enabled: true },
  { key: "history", enabled: false },
  { key: "exa", enabled: false },
])
check("optmgr: set reports no errors", omSet.errors.length === 0, omSet.errors.join(" | "))
check("optmgr: one timestamped backup written", omSet.backups.length === 1, omSet.backups.join(","))

const omWritten = JSON.parse(fs.readFileSync(omCfg, "utf8"))
const omEntry = omWritten.plugins.find((e) => e && typeof e === "object" && String(e.package).includes("token-optimizer"))
check(
  "optmgr: feature + transform options written",
  omEntry.options.tool.rtk === undefined && omEntry.options.rtk?.enabled === false && omEntry.options.tool.ramCache === true && omEntry.options.tool.scrubBase64 === true && omEntry.options.tool.compactJson === true,
  JSON.stringify(omEntry.options),
)
check(
  "optmgr: companion add + remove applied",
  omWritten.plugins.includes("@slkiser/opencode-quota") && !omWritten.plugins.includes("opencode-history-search"),
  JSON.stringify(omWritten.plugins),
)
check("optmgr: exa removed only because URL matched", !omWritten.mcp?.servers?.exa)
check("optmgr: custom keys and retired packages handled", omWritten.custom?.keep === true && !omWritten.plugins.some((e) => String(e).includes("supermemory") || String(e).includes("gemini-auth")))
check(
  "optmgr: unknown option keys preserved",
  omEntry.options.enabled === undefined && omEntry.options.charsPerToken === undefined && typeof omEntry.options.tool === "object",
)

fs.rmSync(omDir, { recursive: true, force: true })

// ---- localhost toggle panel (server part serves it; no GUI needed) ----

import { startPanel } from "../src/panel.ts"

const panelDeps = {
  getOptions: () => ({ rows: [{ key: "rtk", label: "RTK", desc: "d", section: "feature", enabled: true }], file: "", warnings: [] }),
  setOptions: (changes) => ({ rows: [], file: "", warnings: [], backups: [], errors: [], changes }),
  getPlugins: () => ({ rows: [], warnings: [], files: [] }),
  setPlugins: (changes) => ({ rows: [], warnings: [], files: [], backups: [], errors: [], changes }),
}
const panel = await startPanel({ ...panelDeps, port: 0 })
check("panel: serves the toggle page", (await (await fetch(panel.url)).text()).includes("token-optimizer"))
check(
  "panel: health marker answers",
  (await (await fetch(`${panel.url}api/health`)).json()).marker === "token-optimizer-panel-v1",
)
const pOpts = await (await fetch(`${panel.url}api/options`)).json()
check("panel: options GET returns rows", pOpts.rows?.length === 1 && pOpts.rows[0].key === "rtk")
const pPost = await (
  await fetch(`${panel.url}api/options`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ changes: [{ key: "rtk", enabled: false }] }),
  })
).json()
check("panel: options POST applies changes", pPost.changes?.length === 1 && pPost.errors?.length === 0)
const pPlug = await (await fetch(`${panel.url}api/plugins`)).json()
check("panel: plugins GET returns rows", Array.isArray(pPlug.rows))
await panel.close()
const afterClose = await fetch(panel.url).catch(() => null)
check("panel: close stops the server", afterClose === null)

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
