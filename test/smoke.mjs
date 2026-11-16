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

// ---- second batch: inline JSON / markdown / URL params / logs / hunks / traces ----

const inlineOn = { ...toolDefaults, compactJsonInline: true }
const inlineJson = JSON.stringify(
  { name: "x", items: Array.from({ length: 8 }, (_, i) => ({ i, label: `item ${i}` })) },
  null,
  2,
)
const inlineProse = `Payload:\n${inlineJson}\nDone.`
const inlineOut = transformText(inlineProse, "bash", inlineOn)
check(
  "transform: inline JSON compacted in prose",
  inlineOut.startsWith('Payload:\n{"name":"x"') && !inlineOut.includes('\n  "items"') && inlineOut.endsWith("\nDone."),
  JSON.stringify(inlineOut.slice(0, 60)),
)
check("transform: inline JSON off by default", transformText(inlineProse, "bash", toolDefaults) === inlineProse)
const fencedJson = "\u0060\u0060\u0060\n" + inlineJson + "\n\u0060\u0060\u0060"
check("transform: inline JSON inside a fence untouched", transformText(fencedJson, "bash", inlineOn) === fencedJson)

const mdOn = { ...toolDefaults, minifyMarkdown: true }
const mdText = "# Title\n\n\nSome text with trailing spaces   \n\n\n\nMore"
const mdOut = transformText(mdText, "bash", mdOn)
check(
  "transform: markdown blank runs collapsed, hard break kept",
  mdOut === "# Title\n\nSome text with trailing spaces  \n\nMore",
  JSON.stringify(mdOut),
)
check("transform: markdown untouched by default", transformText(mdText, "bash", toolDefaults) === mdText)

const urlOn = { ...toolDefaults, stripUrlParams: true }
const urlText = "see https://example.com/p?utm_source=x&fbclid=1&id=42#frag and https://example.com/plain"
check(
  "transform: tracking params stripped, real params kept",
  transformText(urlText, "bash", urlOn) === "see https://example.com/p?id=42#frag and https://example.com/plain",
  transformText(urlText, "bash", urlOn),
)
check(
  "transform: tracking-only query removed whole",
  transformText("https://x.io/a?utm_campaign=spring", "bash", urlOn) === "https://x.io/a",
)
check("transform: URL params untouched by default", transformText(urlText, "bash", toolDefaults) === urlText)

const logOn = { ...toolDefaults, filterLogs: true }
const logText = [
  "2026-11-16T10:00:00.000Z DEBUG  entering loop",
  "[trace] low level detail",
  "INFO ready",
  "ERROR disk full",
  "DEBUG another debug line",
  '{"level":"debug","msg":"json noise"}',
].join("\n")
const logOut = transformText(logText, "bash", logOn)
check(
  "transform: debug/trace lines dropped, info/error kept",
  logOut ===
    "[token-optimizer: 2 debug/trace log lines removed]\nINFO ready\nERROR disk full\n[token-optimizer: 2 debug/trace log lines removed]",
  JSON.stringify(logOut),
)
check(
  "transform: prose 'Debug this' never filtered",
  transformText("Debug this later when ready", "bash", logOn) === "Debug this later when ready",
)
check("transform: logs untouched by default", transformText(logText, "bash", toolDefaults) === logText)

const hunkOn = { ...toolDefaults, trimDiffHunks: true }
const hunkHeader = ["diff --git a/f.txt b/f.txt", "--- a/f.txt", "+++ b/f.txt", "@@ -1,140 +1,140 @@"]
const bigHunk = [...hunkHeader, ...Array.from({ length: 140 }, (_, i) => ` ctx ${i}`)].join("\n")
const hunkOut = transformText(bigHunk, "bash", hunkOn)
check(
  "transform: oversized diff hunk trimmed head+tail",
  hunkOut.includes("60 hunk lines omitted") &&
    hunkOut.includes(" ctx 0\n") &&
    hunkOut.includes(" ctx 139") &&
    !hunkOut.includes(" ctx 70"),
  `${hunkOut.split("\n").length} lines`,
)
const smallHunk = [...hunkHeader, ...Array.from({ length: 10 }, (_, i) => ` ctx ${i}`)].join("\n")
check("transform: small diff hunk untouched", transformText(smallHunk, "bash", hunkOn) === smallHunk)
check("transform: hunk trim off by default", transformText(bigHunk, "bash", toolDefaults) === bigHunk)

const tracesOn = { ...toolDefaults, collapseTraces: true }
const frames = Array.from({ length: 15 }, (_, i) => `    at fn${i} (app.js:${i + 1}:1)`)
const traceText = frames.join("\n")
const traceOut = transformText(traceText, "bash", tracesOn)
check(
  "transform: long stack trace trimmed with count",
  traceOut.split("\n").length === 9 &&
    traceOut.includes("7 more stack frames omitted") &&
    traceOut.startsWith(frames[0]) &&
    !traceOut.includes(frames[12]),
  JSON.stringify(traceOut.split("\n").slice(-2)),
)
check(
  "transform: short stack trace untouched",
  transformText(frames.slice(0, 5).join("\n"), "bash", tracesOn) === frames.slice(0, 5).join("\n"),
)
check("transform: trace trim off by default", transformText(traceText, "bash", toolDefaults) === traceText)

const uriPayload = "QUJD".repeat(200)
const uriText = `data:image/png;base64,${uriPayload} end`
check(
  "transform: declared data-URI payload elided",
  transformText(uriText, "bash", scrubOn) === "[token-optimizer: image/png payload of 800 chars elided] end",
  transformText(uriText, "bash", scrubOn),
)
const hexRun = "a1".repeat(400)
check(
  "transform: long hex runs with letters elided",
  transformText(hexRun, "bash", scrubOn) === "[token-optimizer: hex blob of 800 chars elided]",
  transformText(hexRun, "bash", scrubOn).slice(0, 60),
)
check("transform: pure-digit runs never hex-scrubbed", transformText("1".repeat(800), "bash", scrubOn) === "1".repeat(800))

// ---- image: PNG downscaling (pure JS codec) ----

import { deflateSync } from "node:zlib"
import { downscalePng, downscaleRequestImages } from "../src/image.ts"

function pngCrc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, "ascii"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(pngCrc32(body))
  return Buffer.concat([len, body, crc])
}
function makePng(w, h) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const stride = w * 4
  const raw = Buffer.alloc((stride + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0
    for (let x = 0; x < w; x++) {
      const o = y * (stride + 1) + 1 + x * 4
      raw[o] = (x * 37 + y * 11) & 0xff
      raw[o + 1] = (x * 5 + y * 29) & 0xff
      raw[o + 2] = ((x ^ y) * 13) & 0xff
      raw[o + 3] = 255
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

const bigPng = makePng(96, 96)
const smallPng = downscalePng(new Uint8Array(bigPng), 24)
check(
  "image: PNG shrunk to imageMaxDim",
  smallPng !== null && smallPng.width === 24 && smallPng.height === 24 && smallPng.bytes.length < bigPng.length,
  smallPng ? `${bigPng.length} -> ${smallPng.bytes.length} bytes` : "null",
)
check("image: non-PNG payload passes through", downscalePng(new Uint8Array([1, 2, 3, 4]), 24) === null)
check("image: already-small PNG passes through", downscalePng(new Uint8Array(bigPng), 4096) === null)

const bigB64 = bigPng.toString("base64")
const imgOn = { ...toolDefaults, downscaleImages: true, imageMaxDim: 24 }
const imgText = `screenshot: data:image/png;base64,${bigB64} end`
const imgOut = transformText(imgText, "bash", imgOn)
check(
  "image: inline data URI downscaled in tool text",
  imgOut.length < imgText.length / 2 &&
    imgOut.startsWith("screenshot: data:image/png;base64,iVBORw0KGgo") &&
    imgOut.endsWith(" end"),
  `${imgText.length} -> ${imgOut.length}`,
)
check("image: downscaling off by default", transformText(imgText, "bash", toolDefaults) === imgText)

const mediaMsgs = [
  {
    role: "user",
    content: [
      { type: "media", media: { source: { type: "base64", data: bigB64, mediaType: "image/png" }, info: {} } },
    ],
  },
  {
    role: "user",
    content: [
      { type: "media", media: { source: { type: "base64", data: bigB64, mediaType: "image/jpeg" }, info: {} } },
    ],
  },
]
const changedParts = downscaleRequestImages(mediaMsgs, 24)
check(
  "image: outgoing PNG media part downscaled, JPEG untouched",
  changedParts === 1 &&
    mediaMsgs[0].content[0].media.source.data.length < bigB64.length &&
    mediaMsgs[0].content[0].media.info.width === 24 &&
    mediaMsgs[1].content[0].media.source.data === bigB64,
  `${changedParts} changed`,
)

// ---- chunk interning ----

const internOpt = new ToolOptimizer(parseOptions({ tool: { dedupeWindow: 0, internMinChars: 100, ramCache: false } }))
const chunk = `chunk payload ${"x".repeat(160)}`
const i1 = { content: [{ type: "text", text: `${chunk}\n\nfirst tail` }] }
internOpt.optimize("intern-sess", "bash", i1)
check("intern: first sighting keeps the block", i1.content[0].text.includes(chunk))
const i2 = { content: [{ type: "text", text: `${chunk}\n\nsecond tail` }] }
const i2Out = internOpt.optimize("intern-sess", "bash", i2)
check(
  "intern: repeated block becomes a hash-verified pointer",
  i2Out !== null && i2.content[0].text.includes("byte-identical block") && !i2.content[0].text.includes(chunk),
  JSON.stringify(i2.content[0].text.slice(0, 80)),
)
const r1 = { content: [{ type: "text", text: `${chunk}\n\nread A` }] }
const r2 = { content: [{ type: "text", text: `${chunk}\n\nread B` }] }
internOpt.optimize("intern-sess", "read", r1)
internOpt.optimize("intern-sess", "read", r2)
check("intern: read output never interned", r2.content[0].text.includes(chunk))

// ---- pressure-aware budgets ----

const pressureOpt = new ToolOptimizer(
  parseOptions({
    tool: { pressureRouting: true, pressurePct: 75, pressureScale: 0.5, dedupeMinChars: 1500, ramCache: false },
  }),
)
const thousand = "p".repeat(1000)
pressureOpt.optimize("p-sess", "bash", { content: [{ type: "text", text: `${thousand} one` }] })
pressureOpt.setPressure("p-sess", 50)
const relaxedOut = pressureOpt.optimize("p-sess", "bash", { content: [{ type: "text", text: `${thousand} one` }] })
check("pressure: relaxed session keeps the normal dedupe threshold", relaxedOut !== null && relaxedOut.deduped === false)
pressureOpt.setPressure("p-sess", 80)
const tightOut = pressureOpt.optimize("p-sess", "bash", { content: [{ type: "text", text: `${thousand} one` }] })
check("pressure: tight session stubs repeats earlier", tightOut !== null && tightOut.deduped === true)

const tierOpt = new ToolOptimizer(
  parseOptions({ tool: { pressureRouting: true, pressurePct: 75, pressureScale: 0.5, dedupeWindow: 0, ramCache: true } }),
)
const tierText = `{"k":"${"z".repeat(400)}"}`
tierOpt.setPressure("t-sess", 90)
tierOpt.optimize("t-sess", "bash", { content: [{ type: "text", text: tierText }] })
const tierMisses1 = tierOpt.cacheStats().misses
tierOpt.setPressure("t-sess", 10)
tierOpt.optimize("t-sess", "bash", { content: [{ type: "text", text: tierText }] })
const tierMisses2 = tierOpt.cacheStats().misses
check("pressure: cache key separates pressure tiers", tierMisses1 === 1 && tierMisses2 === 2, `${tierMisses1} -> ${tierMisses2}`)

// ---- rotation: history digest fallback ----

import { StateManager } from "../src/state.ts"

const digestDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-digest-"))
let prompted = ""
const digestMessages = [
  { type: "user", content: [{ type: "text", text: "fix the flaky test in CI" }] },
  {
    type: "assistant",
    content: [{ type: "text", text: "Reproduced the failure and patched the retry path." }, { type: "tool", tool: "bash" }],
  },
]
const digestDeps = {
  directory: digestDir,
  getSession: async () => ({ id: "s1", title: "Digest", agent: "build", model: { providerID: "p", id: "m" } }),
  getContext: async () => digestMessages,
  createSession: async () => ({ id: "s2" }),
  promptSession: async (_id, text) => {
    prompted = text
  },
}
const digestMgr = new StateManager(digestDeps, parseOptions({}))
const digestCap = await digestMgr.capture("s1")
check(
  "digest: capture falls back to a transcript digest",
  digestCap.usedDigest === true &&
    digestCap.text.includes("fix the flaky test") &&
    digestCap.text.includes("Tools used most: bash"),
  JSON.stringify(digestCap.text.slice(-120)),
)
await digestMgr.rotate("s1")
check("digest: rotate prompt resumes from the digest", prompted.includes("Resume from the history digest above."))
const digestOffMgr = new StateManager(digestDeps, parseOptions({ state: { digestChars: 0 } }))
const digestOffCap = await digestOffMgr.capture("s1")
check(
  "digest: disabled falls back to the placeholder",
  digestOffCap.usedDigest === false && digestOffCap.text.includes("No compaction checkpoint yet"),
)
fs.rmSync(digestDir, { recursive: true, force: true })

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

check(
  "optmgr: second-batch feature rows present and defaulted",
  omRow("internChunks")?.enabled === true &&
    omRow("historyDigest")?.enabled === true &&
    omRow("downscaleImages")?.enabled === false &&
    omRow("pressureRouting")?.enabled === false,
)
check(
  "optmgr: second-batch transform rows present",
  ["compactJsonInline", "minifyMarkdown", "stripUrlParams", "filterLogs", "trimDiffHunks", "collapseTraces"].every(
    (key) => omRow(key)?.section === "transform" && omRow(key)?.enabled === false,
  ),
)

const omSet = om.set([
  { key: "rtk", enabled: false },
  { key: "ramCache", enabled: true },
  { key: "scrubBase64", enabled: true },
  { key: "historyDigest", enabled: false },
  { key: "filterLogs", enabled: true },
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
check(
  "optmgr: history digest writes state.digestChars, filterLogs writes tool.filterLogs",
  omEntry.options.state?.digestChars === 0 && omEntry.options.tool.filterLogs === true,
  JSON.stringify({ state: omEntry.options.state, filterLogs: omEntry.options.tool.filterLogs }),
)

fs.rmSync(omDir, { recursive: true, force: true })

// ---- localhost toggle panel (server part serves it; no GUI needed) ----

import { startPanel } from "../src/panel.ts"

const panelDeps = {
  getOptions: () => ({ rows: [{ key: "rtk", label: "RTK", desc: "d", section: "feature", enabled: true }], file: "", warnings: [] }),
  setOptions: (changes) => ({ rows: [], file: "", warnings: [], backups: [], errors: [], changes }),
  getPlugins: () => ({ rows: [], warnings: [], files: [] }),
  setPlugins: (changes) => ({ rows: [], warnings: [], files: [], backups: [], errors: [], changes }),
  addPackages: (packages) => ({ added: packages, skipped: [], errors: [], backups: [], file: "C:/cfg/opencode.json" }),
  discover: (q) => [{ name: `opencode-${q || "all"}`, description: "demo plugin", date: "2026-01-01" }],
  getUsage: () => ({
    text: "today     : 42 tokens\nlast 7 days: 42 tokens",
    today: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, tokens: 42 },
    week: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, tokens: 42 },
    budget: 250_000,
  }),
  setBudget: (budget) => {
    if (!Number.isFinite(budget) || budget < 1000) throw new Error("daily budget must be 1,000 - 100,000,000 tokens")
    return { budget }
  },
}
const panel = await startPanel({ ...panelDeps, port: 0 })
const pageText = await (await fetch(panel.url)).text()
check("panel: serves the toggle page", pageText.includes("token-optimizer"))
check(
  "panel: section renames (token optimizations, external plugins)",
  pageText.includes('feature: "Token optimizations"') && pageText.includes('companion: "External plugins"'),
)
check(
  "panel: external-plugin rows render a trash remove button",
  pageText.includes('row.section === "companion" && row.enabled') &&
    pageText.includes('button[data-del]') &&
    pageText.includes("removeCompanion"),
)
check(
  "panel: health marker answers",
  (await (await fetch(`${panel.url}api/health`)).json()).marker === "token-optimizer-panel-v1",
)
const pUsage = await (await fetch(`${panel.url}api/usage`)).json()
check(
  "panel: usage endpoint is structured (text + donut numbers)",
  pUsage.text.includes("today") && pUsage.text.includes("last 7 days") && pUsage.today.tokens === 42 && pUsage.budget === 250_000,
  JSON.stringify(pUsage),
)
const pBudgetOk = await (
  await fetch(`${panel.url}api/budget`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ budget: 500_000 }),
  })
).json()
check("panel: budget POST accepts a sane value", pBudgetOk.budget === 500_000, JSON.stringify(pBudgetOk))
const pBudgetBad = await fetch(`${panel.url}api/budget`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ budget: 5 }),
})
check("panel: budget POST rejects nonsense with 400", pBudgetBad.status === 400, String(pBudgetBad.status))
const pDiscover = await (await fetch(`${panel.url}api/discover?q=memory`)).json()
check("panel: discover returns lookup results", pDiscover.results?.[0]?.name === "opencode-memory", JSON.stringify(pDiscover))
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
const pAdd = await (
  await fetch(`${panel.url}api/plugins`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ add: ["opencode-fresh-thing"] }),
  })
).json()
check("panel: plugins POST {add} runs the add pipeline", pAdd.added?.[0] === "opencode-fresh-thing" && pAdd.file, JSON.stringify(pAdd))
await panel.close()
const afterClose = await fetch(panel.url).catch(() => null)
check("panel: close stops the server", afterClose === null)

// ---- rolling usage ledger (today / last 7 days) ----

import { updateUsage, formatUsageWindows, getBudget, setBudget, DEFAULT_BUDGET } from "../src/usage.ts"

const usageMem = new Map()
const usageStorage = {
  get: async (key) => usageMem.get(key),
  set: async (key, value) => void usageMem.set(key, value),
  scan: async () => ({ entries: [] }),
}
const snap = (input, output, read, write) => [{ id: "s1", tokens: { input, output, cache: { read, write } } }]
let win = await updateUsage(usageStorage, snap(100, 50, 10, 5))
check("usage: first sighting counts nothing", win.today.tokens === 0 && win.week.tokens === 0)
win = await updateUsage(usageStorage, snap(130, 60, 20, 5))
check("usage: growth lands in today + week", win.today.tokens === 50 && win.week.tokens === 50)
win = await updateUsage(usageStorage, snap(130, 60, 20, 5))
check("usage: no growth counts nothing", win.today.tokens === 50)
const usageText = formatUsageWindows(win)
check(
  "usage: formatted as two labeled lines",
  usageText.includes("today") && usageText.includes("last 7 days") && usageText.split("\n").length === 2,
)

// ---- daily budget (donut denominator) ----

check("budget: unset falls back to the default", (await getBudget(usageStorage)) === DEFAULT_BUDGET)
check("budget: set + read roundtrip", (await setBudget(usageStorage, 500_000)) === 500_000 && (await getBudget(usageStorage)) === 500_000)
let budgetRejected = false
try {
  await setBudget(usageStorage, 10)
} catch {
  budgetRejected = true
}
check("budget: nonsense value rejected", budgetRejected && (await getBudget(usageStorage)) === 500_000)

// ---- pluginmgr.add: panel "Add plugins" ----

const addTmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-add-"))
const addGlobal = path.join(addTmp, "global")
const addProj = path.join(addTmp, "project")
fs.mkdirSync(addGlobal, { recursive: true })
fs.mkdirSync(addProj, { recursive: true })
const addFile = path.join(addGlobal, "opencode.json")
fs.writeFileSync(addFile, `${JSON.stringify({ model: "x", plugins: ["opencode-history-search"] }, null, 2)}\n`)
const addMgr = createPluginmgr({
  directory: addProj,
  globalDir: addGlobal,
  list: async () => [],
  storage: { get: async () => undefined, set: async () => {} },
})
let addRes = await addMgr.add(["opencode-history-search", "opencode-new-addon"])
check(
  "add: new package appended, declared one skipped",
  addRes.added.length === 1 && addRes.added[0] === "opencode-new-addon" &&
    addRes.skipped.includes("opencode-history-search") && addRes.errors.length === 0,
  JSON.stringify(addRes),
)
const addWritten = JSON.parse(fs.readFileSync(addFile, "utf8"))
check(
  "add: backup written, global file merged (not overwritten)",
  addRes.backups.length === 1 && fs.existsSync(addRes.backups[0]) &&
    addWritten.plugins.includes("opencode-new-addon") && addWritten.model === "x",
  JSON.stringify(addRes),
)
addRes = await addMgr.add(["opencode-new-addon"])
check("add: second add is a no-op", addRes.added.length === 0 && addRes.skipped.length === 1 && addRes.errors.length === 0, JSON.stringify(addRes))
addRes = await addMgr.add(["-bad name", "no spaces"])
check("add: invalid names rejected", addRes.errors.length === 2 && addRes.added.length === 0, addRes.errors.join(" | "))

const addFresh = createPluginmgr({
  directory: addProj,
  globalDir: path.join(addTmp, "fresh-global"),
  list: async () => [],
  storage: { get: async () => undefined, set: async () => {} },
})
addRes = await addFresh.add(["opencode-fresh"])
check(
  "add: creates the global config when none exists",
  addRes.added.length === 1 && addRes.backups.length === 0 &&
    JSON.parse(fs.readFileSync(path.join(addTmp, "fresh-global", "opencode.json"), "utf8")).plugins.includes("opencode-fresh"),
  JSON.stringify(addRes),
)
fs.rmSync(addTmp, { recursive: true, force: true })

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
