/**
 * token-optimizer - server part.
 *
 * What this plugin does, and why each piece exists:
 *
 *  * **Metering** (`context` hook)   - estimates the outgoing context on every
 *    agent-loop request by walking live objects. Cheap because reading
 *    `String.length` is O(1): the cost is proportional to the *number* of
 *    values, not to the number of bytes, so a 200k-token request costs well
 *    under a millisecond.
 *  * **Tool optimization** (`execute.after`) - dedupe, clean, truncate tool
 *    results. This is where most tokens actually go. RTK-style rules also
 *    recognise common shell commands (test runners, git, installs) and keep
 *    only their signal - summaries, failures, errors.
 *  * **Caveman** (`context`)          - optional system-prompt instruction
 *    that strips filler from prose while keeping code and errors verbatim.
 *  * **State + rotation**           - durable state file per session, and
 *    `/rotate` to start a fresh session seeded from it. Auto-rotation kicks
 *    in at `rotation.thresholdPct` of the context window (on by default;
 *    set `rotation.auto` to false to opt out).
 *  * **Routing** (`experimental.model.resolve`) - send titles, compaction
 *    summaries and one-shot generations to a cheaper model.
 *  * **Reporting** (RPC)            - surface the numbers in the TUI.
 */
import { Plugin } from "@opencode/plugin"

import { Meter, charsToTokens, estimateChars, type SessionMetrics } from "./src/meter"
import { parseOptions } from "./src/options"
import { buildReport } from "./src/report"
import { StateManager, type SessionSnapshot } from "./src/state"
import { TokenOptimizer, type PluginChange, type OptionChange } from "./src/rpc"
import { createPluginmgr, type PluginInfoLike } from "./src/pluginmgr"
import { createOptmgr } from "./src/optmgr"
import { startPanel, type Panel } from "./src/panel"
import { formatUsageWindows, updateUsage } from "./src/usage"
import { ToolOptimizer } from "./src/tools"
import { nativeAvailable, nativeDetail } from "./src/native"

interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

function parseModelRef(ref: string | undefined): ModelRef | undefined {
  if (!ref) return undefined
  const at = ref.indexOf("/")
  if (at <= 0 || at === ref.length - 1) return undefined
  return { providerID: ref.slice(0, at), id: ref.slice(at + 1) }
}

export default Plugin.define({
  id: "token-optimizer",
  async setup(ctx) {
    const options = parseOptions(ctx.options)
    if (!options.enabled) return

    const meter = new Meter(ctx.storage, options.maxTrackedSessions, options.flushMs)
    await meter.load()
    meter.start()

    const optimizer = new ToolOptimizer(options)

    const stateManager = new StateManager(
      {
        directory: ctx.location.directory,
        getSession: async (sessionID) => (await ctx.session.get({ sessionID })) as SessionSnapshot,
        getContext: async (sessionID) => ctx.session.context({ sessionID }),
        createSession: async (input) => ctx.session.create(input),
        promptSession: async (sessionID, text) => {
          await ctx.session.prompt({ sessionID, text })
        },
      },
      options,
    )

    const registrations: Array<{ dispose(): Promise<void> }> = []
    const eventLoop = new AbortController()

    /* ---------------------------------------------------------------- *
     * Model window lookup (needed for the auto-rotation threshold)
     * ---------------------------------------------------------------- */

    let modelList: Awaited<ReturnType<typeof ctx.model.list>> | null = null
    let modelListAt = 0
    const sessionModel = new Map<string, ModelRef>()
    const warnedRouting = new Set<string>()

    async function contextWindow(ref: ModelRef): Promise<number> {
      const now = Date.now()
      // Refreshed rarely: model inventories change on config edits, not per request.
      if (!modelList || now - modelListAt > 300_000) {
        modelList = await ctx.model.list()
        modelListAt = now
      }
      const info = modelList.data.find((m) => m.providerID === ref.providerID && m.id === ref.id)
      const limit = Number((info as { limit?: { context?: number } } | undefined)?.limit?.context)
      return Number.isFinite(limit) && limit > 0 ? limit : 0
    }

    /* ---------------------------------------------------------------- *
     * Rotation
     * ---------------------------------------------------------------- */

    /** Sessions already rotated at this threshold, cleared once pressure drops. */
    const rotatedAbove = new Set<string>()

    async function doRotate(sessionID: string, auto: boolean) {
      const metrics = meter.get(sessionID)
      const created = await stateManager.rotate(sessionID, metrics)
      meter.noteRotation(sessionID)
      optimizer.reset(sessionID)
      await meter.flush(true)
      await registration.events.emit("rotated", {
        from: sessionID,
        to: created.sessionID,
        path: created.path,
        auto,
      })
      return created
    }

    async function maybeRotate(sessionID: string, chars: number) {
      try {
        const ref = sessionModel.get(sessionID)
        if (!ref) return
        const window = await contextWindow(ref)
        if (!window) return

        const limit = Math.floor((window * options.rotation.thresholdPct) / 100)
        const tokens = charsToTokens(chars, options.charsPerToken)

        if (tokens >= limit) {
          // Rotate once per excursion above the threshold; re-arm only after
          // the pressure has actually dropped, so we cannot loop.
          if (rotatedAbove.has(sessionID)) return
          rotatedAbove.add(sessionID)
          await doRotate(sessionID, true)
        } else if (tokens < limit * 0.6) {
          rotatedAbove.delete(sessionID)
        }
      } catch (error) {
        console.error("[token-optimizer] auto rotation failed:", error)
      }
    }

    /* ---------------------------------------------------------------- *
     * RPC (used by the TUI part and any HTTP client)
     * ---------------------------------------------------------------- */

    async function reportText(): Promise<string> {
      const rows: Array<{ session: SessionSnapshot; metrics?: SessionMetrics }> = []
      try {
        const page = await ctx.session.list({ directory: ctx.location.directory, limit: 25 })
        const sessions = Array.isArray(page.data) ? page.data : []
        for (const session of sessions) {
          rows.push({ session: session as SessionSnapshot, metrics: meter.all().find((m) => m.sessionID === session.id) })
        }
        // Sessions we counted but that fell outside the newest page.
        const seen = new Set(rows.map((row) => row.session.id))
        for (const metrics of meter.all()) {
          if (seen.has(metrics.sessionID)) continue
          rows.push({
            session: { id: metrics.sessionID } as SessionSnapshot,
            metrics,
          })
        }
      } catch (error) {
        console.error("[token-optimizer] report failed:", error)
      }
      return buildReport(options, nativeDetail, rows, optimizer.cacheStats(), panel?.url)
    }

    /* ---------------------------------------------------------------- *
     * Plugin manager (backs the localhost panel's Installed plugins rows)
     * ---------------------------------------------------------------- */

    const pluginmgr = createPluginmgr({
      directory: ctx.location.directory,
      list: async () => {
        const page = await ctx.plugin.list()
        return page.data as PluginInfoLike[]
      },
      storage: ctx.storage,
    })

    /** Feature/transform/companion toggles for the localhost panel. */
    const optmgr = createOptmgr({ directory: ctx.location.directory })

    /* ---------------------------------------------------------------- *
     * Localhost toggle panel (Desktop's built-in browser, or any browser)
     * ---------------------------------------------------------------- */

    let panel: Panel | null = null
    try {
      panel = await startPanel({
        getOptions: () => optmgr.get(),
        setOptions: (changes) => optmgr.set(changes),
        getPlugins: () => pluginmgr.list(),
        setPlugins: (changes) => pluginmgr.set(changes),
        getUsage: async () => {
          try {
            const page = await ctx.session.list({ directory: ctx.location.directory, limit: 100 })
            const sessions = (Array.isArray(page.data) ? page.data : []) as SessionSnapshot[]
            return formatUsageWindows(await updateUsage(ctx.storage, sessions))
          } catch (error) {
            console.error("[token-optimizer] usage ledger failed:", error)
            return "usage unavailable: " + (error instanceof Error ? error.message : String(error))
          }
        },
      })
      console.log(`[token-optimizer] toggle panel: ${panel.url}`)
    } catch (error) {
      console.error("[token-optimizer] toggle panel failed:", error)
    }

    const registration = await ctx.rpc.register(TokenOptimizer, {
      report: async () => ({ text: await reportText() }),
      /** Localhost toggle panel URL for the Desktop `/tokens` browser tab. */
      panelUrl: async () => ({ url: panel?.url ?? "" }),
      status: async () => ({ native: nativeAvailable, detail: nativeDetail }),
      /** Whole-plugin inventory for the Desktop `/plugins` panel. */
      pluginsList: async () => pluginmgr.list(),
      /** Apply a batch of plugin toggles (one backup per file changed). */
      pluginsSet: async (input) =>
        pluginmgr.set(((input as { changes?: PluginChange[] }).changes ?? []) as PluginChange[]),
      /** Current feature/transform/companion switches. */
      optionsGet: async () => optmgr.get(),
      /** Apply a batch of option/companion toggles (one backup per file changed). */
      optionsSet: async (input) =>
        optmgr.set(((input as { changes?: OptionChange[] }).changes ?? []) as OptionChange[]),
      state: async (input) => {
        const { sessionID } = input as { sessionID: string }
        const captured = await stateManager.capture(sessionID, meter.get(sessionID))
        return { text: captured.text, path: captured.path }
      },
      rotate: async (input) => {
        const { sessionID } = input as { sessionID: string }
        const created = await doRotate(sessionID, false)
        return { sessionID: created.sessionID, path: created.path, title: created.title }
      },
    })
    registrations.push(registration)

    /* ---------------------------------------------------------------- *
     * Server command
     * ---------------------------------------------------------------- */

    registrations.push(
      await ctx.command.transform((editor) => {
        editor.add({
          name: "rotate",
          description: "Start a fresh session seeded from this session's state (token-optimizer)",
          execute: async ({ sessionID }) => {
            try {
              await doRotate(sessionID, false)
            } catch (error) {
              console.error("[token-optimizer] /rotate failed:", error)
            }
          },
        })
      }),
    )

    /* ---------------------------------------------------------------- *
     * Hooks
     * ---------------------------------------------------------------- */

    /* ---------------------------------------------------------------- *
     * Caveman: terseness instruction appended to the system prompt
     * ---------------------------------------------------------------- */

    const cavemanText =
      options.caveman.text.trim() ||
      "Communication style: caveman. Drop articles, filler, pleasantries, hedges " +
        "and restating the question; short sentences; answer first, details after. " +
        "Keep technical terms, identifiers, file paths, code, commands and error " +
        "messages exact and complete - never paraphrase code, diffs or quoted " +
        "output. Do not narrate what you are about to do; do it."

    function applyCaveman(system: Array<{ type: string; text: string }>): void {
      if (!options.caveman.enabled) return
      // Idempotent: the plugin can be registered twice (global + project
      // config) and one request must not collect two copies.
      if (system.some((part) => part.type === "text" && part.text === cavemanText)) return
      system.push({ type: "text", text: cavemanText } as { type: string; text: string })
    }

    if (options.budgetMaxTokens > 0 || options.rotation.auto) {
      registrations.push(
        await ctx.session.hook("context", (event) => {
          applyCaveman(event.system)
          const chars = estimateChars(event.system, event.messages, event.tools)
          meter.noteContext(event.sessionID, chars)

          if (options.budgetMaxTokens > 0) event.options.maxTokens = options.budgetMaxTokens
          if (options.rotation.auto) void maybeRotate(event.sessionID, chars)
        }),
      )
    } else {
      // Metering is still worth having even when neither feature is on.
      registrations.push(
        await ctx.session.hook("context", (event) => {
          applyCaveman(event.system)
          meter.noteContext(
            event.sessionID,
            estimateChars(event.system, event.messages, event.tools),
          )
        }),
      )
    }

    const hasRouting =
      Boolean(options.routing.title) ||
      Boolean(options.routing.compaction) ||
      Boolean(options.routing.generate) ||
      Object.keys(options.routing.agents).length > 0

    if (hasRouting) {
      registrations.push(
        await ctx.session.hook("experimental.model.resolve", (event) => {
          try {
            const kind = event.kind
            const requested =
              (kind === "title" && options.routing.title) ||
              (kind === "compaction" && options.routing.compaction) ||
              (kind === "generate" && options.routing.generate) ||
              options.routing.agents[event.agent]

            const target = parseModelRef(typeof requested === "string" ? requested : undefined)

            if (target) {
              if (target.providerID === event.model.providerID) {
                // Provider.ID / Model.ID are branded on the hook's own type.
                event.model = { providerID: target.providerID, id: target.id } as typeof event.model
              } else if (!warnedRouting.has(target.providerID)) {
                warnedRouting.add(target.providerID)
                // OpenCode rejects cross-provider model swaps, so this must warn
                // rather than silently dropping the rule.
                console.warn(
                  `[token-optimizer] routing to a different provider (${target.providerID}) is not supported; keeping ${event.model.providerID}`,
                )
              }
            }

            if (kind === "primary") {
              sessionModel.set(event.sessionID, { ...event.model })
            }
          } catch (error) {
            console.error("[token-optimizer] routing hook failed:", error)
          }
        }),
      )
    } else {
      registrations.push(
        await ctx.session.hook("experimental.model.resolve", (event) => {
          if (event.kind === "primary") sessionModel.set(event.sessionID, { ...event.model })
        }),
      )
    }

    registrations.push(
      await ctx.tool.hook("execute.after", (event) => {
        if (event.status !== "completed") return
        const sessionID = String((event as { sessionID?: unknown }).sessionID ?? "")
        // Shell-like tools carry their command in input; RTK needs it to pick
        // the right reduction rule. Anything without one passes through.
        const toolInput = (event as { input?: unknown }).input
        const command =
          toolInput && typeof toolInput === "object" && typeof (toolInput as { command?: unknown }).command === "string"
            ? (toolInput as { command: string }).command
            : undefined
        try {
          const outcome = optimizer.optimize(sessionID, event.tool, (event as { result?: unknown }).result, command)
          if (!outcome) return
          meter.noteTool(
            sessionID,
            outcome.originalChars,
            Math.max(0, outcome.originalChars - outcome.finalChars),
            outcome.deduped,
          )
        } catch (error) {
          console.error("[token-optimizer] tool optimization failed:", error)
        }
      }),
    )

    /* ---------------------------------------------------------------- *
     * Events
     * ---------------------------------------------------------------- */

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: ["session.compaction.ended"],
          signal: eventLoop.signal,
        })) {
          const data = (event as { data?: { sessionID?: unknown; text?: unknown } }).data
          const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined
          if (!sessionID) continue

          const summary = typeof data?.text === "string" ? data.text : undefined
          meter.noteCompaction(sessionID)

          // Writing the checkpoint is I/O we can do off the hot path.
          void stateManager
            .capture(sessionID, meter.get(sessionID), summary)
            .catch((error) => console.error("[token-optimizer] state capture failed:", error))
          void registration.events
            .emit("compacted", { sessionID, summaryChars: summary?.length ?? 0 })
            .catch(() => undefined)
        }
      } catch {
        // Aborted during unload - expected.
      }
    })()

    return () => {
      eventLoop.abort()
      meter.dispose()
      optimizer.resetAll()
      void panel?.close().catch(() => undefined)
      void Promise.all(
        registrations.map((entry) =>
          entry.dispose().catch(() => {
            /* unload already disposed it */
          }),
        ),
      )
    }
  },
})
