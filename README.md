# token-optimizer

A token-efficiency plugin for OpenCode: smaller tool outputs, RTK-style command-output reduction, verified dedupe, lossless JSON/table transforms, terse responses, and one-key session rotation so agentic sessions cost less and run longer.

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

**Double-click `Install.cmd`** - it opens a **GUI installer in your browser** (a localhost page, no PowerShell involved):

1. Pick a scope: **global** (every project) or **one project folder**.
2. Check/uncheck each optimization: compression, dedupe, auto-rotation, RTK, caveman, model routing, native addon.
3. Optionally check **companion plugins** (see below) - third-party plugins like `oh-my-opencode-slim`, history search, quota, Exa search, Antigravity auth, the agents collection, and cc-switch. Checked = added, **unchecked = removed**: installed companions start checked, so unchecking one strips it from that config (timestamped backup first). Custom entries are safe - a hand-modified Exa MCP URL is never removed, and cc-switch (a desktop app) is really installed from its Windows MSI with one UAC prompt, or uninstalled when unchecked.
4. Press **Install** - progress streams live; it backs up and merges your `opencode.json`, installs deps, builds the native addon + GUI bundle, and runs the smoke test.

The page shows what's already installed and refuses to touch a config it can't parse (JSONC/comments) - it tells you exactly what to add by hand instead. `Uninstall.cmd` reverses the registration.

**Or one command** - scriptable, same merge guarantees:

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

Restart OpenCode, then run **`/tokens`** for the efficiency report (TUI *and* Desktop - in Desktop it's in the command palette) and **`/rotate`** to start a fresh seeded session. In Desktop, **`/plugins`** opens the whole-plugin panel: checkboxes that switch any installed plugin on or off by writing `-<id>` directives into `opencode.json` - one timestamped backup per file, merge never touches anything else, JSONC files are listed but never rewritten, and config hot-reload means no restart. Rows also carry **conflict warnings** (same plugin id from two paths, or a documented package clash with both sides enabled) in their description, with a toast when you toggle or apply one - see [Plugin conflicts](#plugin-conflicts).

## Build

Requires Node.js 18+; Rust for the native addon.

```sh
npm install               # also runs scripts/setup-native.mjs (build or prebuilt)
npm run typecheck
npm run build:native      # explicit rebuild of the Rust addon
npm run build:gui         # rebuild the Desktop GUI bundle (dist/gui-experimental.cjs)
npm run test:native       # 8 Rust unit tests
node test/smoke.mjs       # native load + Rust/JS byte-for-byte agreement + RTK + /plugins + conflicts + transforms
node scripts/e2e-install-test.mjs  # companion add/remove end-to-end against a throwaway config
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

Clean outputs under the budget are returned **byte-identical** (verified in the suite). Lossless-but-smaller happens only where meaning cannot change: ANSI color codes, control bytes, CRLF, blank runs, JSON whitespace, table padding - stripped with **100% of real content kept**.

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

**RTK command-output reduction** (on by default, `rtk.enabled`) - recognises command output by its shape (test runs, `git status`/`log`, installs, builds) and keeps the summary while dropping the noise. Measured by `node test/smoke.mjs`:

| Command output | In | Out | Cut | What the model still sees |
| --- | ---: | ---: | ---: | --- |
| `cargo test` run | 8,550 | 408 | 95.2% | pass/fail counts, every failure with its message |
| `git status` | 3,010 | 1,440 | 52.2% | changed files; help text dropped |
| build with warnings | 6,242 | 439 | 93.0% | outcome, errors, warnings |
| unknown command | — | — | 0% | **passthrough, byte-identical** |

Quality rules that hold by construction:

- **Anything under `rtk.minChars` (1,200 chars) passes through untouched** - small outputs are already cheap.
- **Failures are never dropped**: a failing test's name, message and assertion diff stay in the reduced output.
- Every reduction appends an honest marker (`… reduced by token-optimizer: 8550 -> 408 chars`) so the model knows output was shortened and can re-run with narrower arguments if it needs the detail.
- Unknown formats (anything RTK doesn't recognise) return the input unchanged - it can only ever reduce output it fully understands.
- RTK runs **before** compression, so the model never sees the pre-RTK text at all.

**Structural transforms** (TypeScript side, after RTK and before compression; `tool.*` options; measured by `node benchmark/bench.mjs`):

| Sample | In | Out | Cut | Content kept | Rule |
| --- | ---: | ---: | ---: | ---: | --- |
| markdown table (`collapseTable`, **on**) | 12,030 | 7,112 | 40.9% | 100% | alignment padding stripped, rendering identical |
| pretty JSON (`compactJson`, **on**) | 32,425 | 20,064 | 38.1% | 100% | re-serialized only when the whole result parses as one JSON value |
| file read through the `read` tool | 9,004 | 9,004 | 0% | 100% | **never transformed** - bytes stay faithful for `edit` matching |
| source code via `bash` | 9,004 | 9,004 | 0% | 100% | not JSON/table - untouched |
| base64 blob (`scrubBase64`, off by default) | 6,001 | 51 | 99.2% | 0.7% | lossy: replaced with an honest length marker |
| repeated log lines (`collapseRepeats`, off by default) | 12,101 | 1,014 | 91.6% | 8.4% | lossy: runs of >=3 identical >=80-char lines -> one line + count |

Quality rules that hold by construction:

- **The two default-on rules are lossless.** JSON whitespace and table alignment padding carry no meaning; JSON must parse (JSONL, prose-wrapped or truncated text is skipped), and tables skip fenced code blocks and escaped-pipe rows so cell content can never be corrupted.
- **The two opt-in rules are lossy and say so** - the marker they leave names what was dropped (`base64 blob of 6001 chars elided`, `24 more identical lines omitted`).
- **`read` output is excluded entirely**, so what you read is byte-for-byte what `edit`'s `oldString` must match.
- Transforms run after the dedupe hash is computed over the original bytes - a whitespace-variant of the same JSON can never satisfy the "byte-identical" dedupe claim (smoke-tested).
- Runs after RTK, before `api.compress`; the Rust hot path and its byte-identical JS fallback are unchanged.

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
- **Structural transforms** (`tool.compactJson` + `tool.collapseTable` on by default, lossless; `tool.scrubBase64` + `tool.collapseRepeats` opt-in, lossy with honest markers): whole-JSON whitespace collapse and markdown table padding strip before compression; the `read` tool is never touched
- Byte-identical repeat results are replaced with a verified stub (per-session, window of 4, configurable)
- **RTK command-output reduction** (`rtk.enabled`, on by default): test runs, git status/log, installs and builds are reduced to their summaries - failures and errors always kept, outputs under 1,200 chars untouched, unknown formats passed through
- **Caveman terse responses** (`caveman.enabled`, off by default): a system-prompt instruction to answer first with no filler - code, paths and errors stay verbatim
- `/rotate` writes a structured state file and starts a fresh session seeded from it; auto-rotation at 85% of the context window is **on by default** (`rotation.auto`), re-arming only after the pressure drops so it can never loop
- `/tokens` shows billed input/output/cache/cost per session vs. what the plugin removed - works in the TUI **and** in Desktop (command palette), via the bundled GUI part
- `/plugins` (Desktop) toggles whole plugins on/off: rows join config entries, the live inventory and leftover `-<id>` directives; **conflict detection** flags a row whose plugin id is declared by two different paths and warns about documented package clashes while both sides are enabled (row description + toggle/apply toasts); built-ins and token-optimizer itself are locked, each apply backs up every file it writes, and a commented (JSONC) config is refused with a hand-edit hint instead of being rewritten
- Context metering on every request by walking live objects - no serialization, ~0.1 ms
- Route title generation, compaction summaries and one-shot generations to a cheaper model (same provider)
- Optional output-token budget (`budgetMaxTokens`) pinned to every agent-loop request
- Pure-JS fallback with byte-identical hashing if the native addon can't load - degrades in speed, never in correctness
- Bounded memory: per-session dedupe rings (max 50 sessions), LRU metrics eviction, debounced storage writes
- GUI installer with per-feature checkboxes plus optional third-party companion plugins (below)

## Companion plugins

The GUI installer can optionally add these third-party plugins (all MIT, maintained by their authors - not by this project). Check them on/off in step 3 of the installer:

| Plugin | What it does | How the installer adds it |
| --- | --- | --- |
| `oh-my-opencode-slim` | Multi-agent orchestration: specialist agents, auto-delegation, model mixing | `plugins[]` entry |
| `opencode-history-search` | Keyword/regex/fuzzy search over all your OpenCode conversation history | `plugins[]` entry |
| `opencode-quota` (`@slkiser/opencode-quota`) | Provider quota and usage views: `/quota`, sidebar panel, terminal view | `plugins[]` entry |
| `opencode-exa-search` | Web search + page fetch through Exa's hosted MCP endpoint | `mcp.servers.exa` remote entry (schema-verified) |
| `opencode-antigravity-auth` | Unofficial Google Antigravity OAuth access | `plugins[]` entry |
| `agents` (wshobson) | 200+ specialist agents, 185 skills, 105 workflows | cloned to `~/.local/share/opencode/ext/` and generated with `uv` (needs git + uv; prints manual steps if either is missing) |
| `cc-switch` | Desktop app for managing coding-tool providers across many CLIs | downloads `CC-Switch-v*-Windows.msi` from GitHub Releases and installs it silently (one UAC prompt); other platforms open the releases page |

Companions are merged into your existing `opencode.json` exactly like the main plugin: timestamped backup first, never overwritten, and checking one that's already installed is a no-op. **Unchecking works the other way**: the entry is removed from the config you're installing to (backup first), the managed Exa MCP entry is dropped only while its URL still matches what the installer writes, and unchecking cc-switch uninstalls its MSI. Two offerings were retired and are stripped automatically when found: `opencode-supermemory` (the heavier memory/search overlap - needs an external account and hooks auto-compact, while `opencode-history-search` is local and account-free) and `opencode-gemini-auth` (Google deprecated Gemini Code Assist consumer OAuth in June 2026, and antigravity-auth's own docs say to remove gemini-auth plugins).

## Plugin conflicts

`/plugins` surfaces two kinds of conflict. Both are computed from what is actually installed and documented by the plugins involved - nothing is guessed:

1. **Duplicate plugin id** - the same plugin declared by two *different* paths (for example a global entry and a project entry pointing at different copies). OpenCode's supervisor keeps the first occurrence and reports the rest as `Duplicate plugin ID: <id>`; the panel flags the row with every path it was declared by and tells you to remove one entry. The same package listed in two config files is *not* a clash - only distinct paths are.
2. **Documented package clashes** - exact package-name matches taken from the pairs' own documentation, shown only while **both** plugins are enabled:
   - `opencode-gemini-auth` + `opencode-antigravity-auth` - both handle Google OAuth; antigravity-auth's docs say to remove all gemini-auth plugins
   - `oh-my-opencode` + `opencode-antigravity-auth` - both intercept the Google auth flow
   - `opencode-supermemory` + `oh-my-opencode` - both hook auto-compact (documented in supermemory's README)

Matching is exact: `oh-my-opencode-slim` is a different package (it removed the bundled auth proxies and compact hooks) and never triggers the `oh-my-opencode` rules. Quota, history-search and supermemory-vs-rotation were checked and have no real overlap - they are not flagged.

## Tech Stack

- [Rust](https://www.rust.org/) via [napi-rs](https://napi.rs/) - zero dependencies beyond the napi glue, hand-rolled parsers, fat LTO, symbols stripped
- [TypeScript](https://www.typescriptlang.org/) on [@opencode/plugin](https://www.npmjs.com/package/@opencode/plugin)
- No runtime npm dependencies beyond the OpenCode plugin SDK

## License

[MIT](LICENSE)
