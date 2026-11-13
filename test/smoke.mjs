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

fs.rmSync(pmTmp, { recursive: true, force: true })

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
