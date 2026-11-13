# token-optimizer

A token-efficiency plugin for OpenCode: smaller tool outputs, verified dedupe, and one-key session rotation so agentic sessions cost less and run longer.

**Download:** [Releases page](../../releases)

What `/tokens` shows you (real output from the report code):

```text
token-optimizer report
implementation : rust native addon
chars/token    : 4

sessions       : 3
agent requests : 80
tool calls     : 112
compactions    : 2
rotations      : 1

billed input   : 513.2k
billed output  : 51.4k
cache read     : 4.79M (90% of input served from cache)
cache write    : 138.2k
cost           : $0.5019

tool output    : 1,149,991 chars injected
removed        : 354,052 chars (~88,513 tokens)
repeat withheld: 9

session        model                          peak       in      out    cached       cost     saved
---------------------------------------------------------------------------------------------------
ses_9f2c1...   topai/qwen3.8-max           ~178.1k   412.3k    38.1k     3.98M     $0.413    ~78.2k
ses_31ba8...   topai/deepseek-v4.1-fla...   ~75.3k    96.8k    12.4k    811.2k     $0.089    ~10.3k
ses_77d0c...   topai/glm-5.3-flash               -     4118      892         0     $0.000         -
```

## Install

**Prerequisites:** [OpenCode](https://opencode.ai), [Node.js](https://nodejs.org) 18+. [Rust](https://rustup.rs) is optional (a prebuilt addon ships with the repo; without either, the JS fallback runs).

**Double-click `Install.cmd`** - it asks whether to register globally (recommended) or for this folder only, then installs deps, sets up the native addon, registers the plugin and runs the smoke test. The window waits for a key so you can read the result. `Uninstall.cmd` reverses it the same way.

**Or one command** - same thing from a terminal:

```powershell
.\install.ps1            # registers for this project
.\install.ps1 -Global    # registers for every project (~/.config/opencode)
```

The installer backs up any existing `opencode.json` before merging - it never overwrites your providers, MCP servers or other plugins. To remove:

```powershell
.\uninstall.ps1          # or -Global
```

**Manual install:**

```powershell
npm install               # postinstall builds the addon, or copies the prebuilt, or falls back to JS
```

Then add this to your `opencode.json` (or `~/.config/opencode/opencode.json`), pointing `package` at this folder:

```jsonc
{
  "plugins": [
    {
      "package": "C:/path/to/opencode-token-optimizer",
      "options": {
        "enabled": true,
        "rotation": { "auto": true },   // fresh session at 85% of context; false to disable
        "tool": { "maxChars": 24000, "dedupeWindow": 4 }
      }
    }
  ]
}
```

Restart OpenCode, then run **`/tokens`** in the TUI for the efficiency report and **`/rotate`** to start a fresh seeded session.

## Build

Requires Node.js 18+; Rust for the native addon.

```sh
npm install               # also runs scripts/setup-native.mjs (build or prebuilt)
npm run typecheck
npm run build:native      # explicit rebuild of the Rust addon
npm run test:native       # 8 Rust unit tests
node test/smoke.mjs       # native load + Rust/JS byte-for-byte agreement
node benchmark/bench.mjs  # reproduce the numbers below
```

## Performance

All numbers measured on Windows x64 with `node benchmark/bench.mjs` using the plugin's default options (`maxChars: 24000`, `headPct: 70`, ANSI strip + blank collapse on, trim off). "Content kept" = meaningful characters (whitespace/ANSI excluded) that survived.

**Typical agent tool outputs** (the sizes that show up in normal turns):

| Output | In | Out | Cut | Content kept |
| --- | ---: | ---: | ---: | ---: |
| grep/search results | 4,287 | 4,287 | 0% | 100% |
| file read | 9,180 | 9,180 | 0% | 100% |
| column table | 12,026 | 12,026 | 0% | 100% |
| unified diff | 6,001 | 6,001 | 0% | 100% |
| ANSI build log | 25,002 | 20,468 | 18.1% | 100% |
| pretty JSON (crosses budget) | 32,407 | 24,000 | 25.9% | 74.1% |
| **suite total** | **88,903** | **75,962** | **14.6%** | **90.5%** |

Clean outputs under the budget are returned **byte-identical** (verified in the suite). The only lossless-but-smaller case is noise: ANSI color codes, control bytes, CRLF, blank runs - stripped with **100% of real content kept**.

**Oversized reads** (what blows up a context window):

| Output | In | Out | Cut | Content kept |
| --- | ---: | ---: | ---: | ---: |
| source file read | 300,083 | 24,000 | 92.0% | 8.0% |
| pretty JSON dump | 515,826 | 24,000 | 95.3% | 4.6% |
| ANSI build log | 200,024 | 24,000 | 88.0% | 14.6% |
| unified diff | 150,015 | 24,000 | 84.0% | 15.9% |
| **suite total** | **1,165,948** | **96,000** | **91.8%** | **8.8%** |

Every result over 24,000 chars is capped to head (70%) + tail (30%) with an explicit marker - `... 491,826 chars omitted ...` - so the model always knows content is missing and can re-read with a different argument.

**Repeats:** a byte-identical re-read of a 60,008-char result becomes a **189-char stub** (318x smaller) that names what was withheld and why it's safe. Only true duplicates within the last 4 tool calls are ever replaced - a real difference can never be hidden, because the hash is computed over the freshly produced content.

**Worked example** - one session that reads four large files (the oversized suite) plus a normal turn's worth of typical outputs: tool output drops from **1,254,851 chars to 171,962 chars (-86%)**, and every under-budget result arrives intact. Since this context is re-sent on every subsequent request (even cache hits are billed), the saving compounds for the rest of the session. How much total token spend you save depends on how much of your context is tool output - in agentic coding it's usually the majority.

**Cost of the savings** (the honest part):

- **Under the budget: zero quality loss.** Byte-identical for clean text; noise-only removal (ANSI/whitespace) for logs. Measured 100% content kept.
- **Over the budget: the middle of that one result is dropped.** You keep the head and tail, the model is told exactly how much is missing, and one extra re-read recovers it - bounded and cheaper than carrying the full file forever.
- **Dedupe: only verifiably identical repeats.** The stub states the size, age and hash verification; the model can always force a re-read.
- Nothing else is touched: your messages, reasoning, and non-excluded tool results pass through unmodified. `write`/`edit`/`apply_patch` results are never compressed.

**Runtime overhead** (paid by the plugin, not your tokens):

| Metric | Measured |
| --- | --- |
| Compression throughput | 73-143 MB/s native / 22-58 MB/s JS fallback |
| Native addon size | 246 KB on disk, loaded in-process |
| Metering a ~58,000-token request | 0.04-0.13 ms |
| Extra processes | none (in-process Node-API addon) |

## Features

- Tool output is cleaned and capped in Rust: ANSI/control stripping, CRLF normalization, blank-run collapse, head+tail truncation with an explicit omission marker
- Byte-identical repeat results are replaced with a verified stub (per-session, window of 4, configurable)
- `/rotate` writes a structured state file and starts a fresh session seeded from it; auto-rotation at 85% of the context window is **on by default** (`rotation.auto`), re-arming only after the pressure drops so it can never loop
- `/tokens` shows billed input/output/cache/cost per session vs. what the plugin removed
- Context metering on every request by walking live objects - no serialization, ~0.1 ms
- Route title generation, compaction summaries and one-shot generations to a cheaper model (same provider)
- Optional output-token budget (`budgetMaxTokens`) pinned to every agent-loop request
- Pure-JS fallback with byte-identical hashing if the native addon can't load - degrades in speed, never in correctness
- Bounded memory: per-session dedupe rings (max 50 sessions), LRU metrics eviction, debounced storage writes

## Tech Stack

- [Rust](https://www.rust.org/) via [napi-rs](https://napi.rs/) - zero dependencies beyond the napi glue, hand-rolled parsers, fat LTO, symbols stripped
- [TypeScript](https://www.typescriptlang.org/) on [@opencode/plugin](https://www.npmjs.com/package/@opencode/plugin)
- No runtime npm dependencies beyond the OpenCode plugin SDK

## License

[MIT](LICENSE)
