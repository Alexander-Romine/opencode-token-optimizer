/**
 * token-optimizer - GUI part (OpenCode Desktop).
 *
 * One command, no dialogs: `/tokens` opens the localhost panel (statistics +
 * all toggles, served by the server part) in the session's side browser pane
 * - the same pane project previews use - via the app's `Browser` contract.
 * If the pane is unavailable, a toast prints the URL instead.
 *
 * Rotation notices surface as toasts. The bundle rules (see vite.config.ts)
 * keep this file free of imports the app does not provide: only
 * `@opencode/plugin/gui`, `@opencode/plugin/gui/browser`, `@opencode/plugin/rpc`
 * and Solid are external, so the shared `./rpc` contract is safe to import.
 *
 * On app builds whose GUI SDK predates `@opencode/plugin/rpc`, this bundle
 * fails at load and no commands register; the localhost URL still works in
 * any browser (the TUI `/tokens` report prints it).
 */
import { Command, Plugin } from "@opencode/plugin/gui"
import { Browser } from "@opencode/plugin/gui/browser"

import { TokenOptimizer, type RotatedEventData } from "./rpc"

interface RotatedEvent {
  data: RotatedEventData
}

export default Plugin.define({
  setup(ctx) {
    try {
      return setupBody(ctx)
    } catch (error) {
      console.error("[token-optimizer] gui setup failed:", error)
      console.error(
        "[token-optimizer] ctx keys:", Object.keys(ctx).join(","),
        "| typeof ctx.client:", typeof ctx.client,
        "| typeof ctx.client.rpc:", typeof (ctx.client as { rpc?: unknown })?.rpc,
        "| typeof ctx.add:", typeof ctx.add,
        "| typeof ctx.toast:", typeof ctx.toast,
        "| typeof ctx.use:", typeof ctx.use,
      )
      throw error
    }
  },
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- app-provided context; exact type needs the app's SetupContext generic
function setupBody(ctx: any) {
    const optimizer = ctx.client.rpc(TokenOptimizer)
    const browser = ctx.use(Browser)

    // Rotation notices, mirroring the TUI part's toast.
    const unsubscribe = optimizer.events.on("rotated", (event: unknown) => {
      const { to, auto } = (event as unknown as RotatedEvent).data
      ctx.toast.show({
        title: auto ? "Context rotated" : "Session rotated",
        description: `${to} - state saved, new window focused`,
        variant: "default",
      })
    })

    ctx.add(Command, () => {
      const live = browser()
      const session = ctx.sessions.current()
      return {
        id: "tokens",
        title: "Token optimizer panel",
        description: "Open token usage statistics and all toggles in the side browser",
        keywords: "tokens usage cost rtk caveman efficiency settings toggle statistics report",
        group: "Token optimizer",
        // Makes it a real composer slash command: /tokens in Desktop.
        slash: { name: "tokens" },
        section: "prompt" as const,
        run: async () => {
          try {
            // Same side browser pane project previews use.
            if (live.status === "active" && session) {
              const { url } = (await optimizer.panelUrl({})) as { url: string }
              const target = url || "http://127.0.0.1:47891/"
              if (live.value.canOpen(session, target)) {
                live.value.open(session, target)
                return
              }
            }
            ctx.toast.show({
              title: "token-optimizer",
              description: "No browser pane on this session - open http://127.0.0.1:47891/ in a browser",
              variant: "default",
            })
          } catch (error) {
            ctx.toast.show({
              title: "token-optimizer",
              description: error instanceof Error ? error.message : String(error),
              variant: "error",
            })
          }
        },
      }
    })

    return () => unsubscribe()
}
