/**
 * token-optimizer - GUI part (OpenCode Desktop).
 *
 * Desktop never loads the TUI half, so this is where `/tokens` lives for the
 * app: a composer slash command that fetches the same RPC report the TUI
 * dialog shows and renders it as Markdown. Rotation notices surface as toasts.
 *
 * The bundle rules (see vite.config.ts) keep this file free of imports the
 * app does not provide: only `@opencode/plugin/gui`, `@opencode/plugin/rpc`
 * and Solid are external, so the shared `./rpc` contract is safe to import.
 */
import { Command, Plugin } from "@opencode/plugin/gui"

import { TokenOptimizer, type RotatedEventData } from "./rpc"

interface RotatedEvent {
  data: RotatedEventData
}

export default Plugin.define({
  setup(ctx) {
    const optimizer = ctx.client.rpc(TokenOptimizer)

    // Rotation notices, mirroring the TUI part's toast.
    const unsubscribe = optimizer.events.on("rotated", (event) => {
      const { to, auto } = (event as unknown as RotatedEvent).data
      ctx.toast.show({
        title: auto ? "Context rotated" : "Session rotated",
        description: `${to} - state saved, new window focused`,
        variant: "default",
      })
    })

    ctx.add(Command, () => ({
      id: "tokens",
      title: "Token optimizer report",
      description: "Show token savings, dedupe and rotation stats for this location",
      keywords: "tokens usage cost rtk caveman efficiency",
      group: "Token optimizer",
      // Makes it a real composer slash command: /tokens in Desktop.
      slash: { name: "tokens" },
      section: "prompt" as const,
      run: async () => {
        try {
          const { text } = (await optimizer.report({})) as { text: string }
          ctx.dialogs.open((dialog) => (
            <div style="display: flex; flex-direction: column; gap: 0.75rem; min-width: 32rem; max-width: 48rem;">
              <ctx.ui.Markdown text={text} />
              <button type="button" onClick={() => dialog.close()}>
                Close
              </button>
            </div>
          ))
        } catch (error) {
          ctx.toast.show({
            title: "token-optimizer",
            description: error instanceof Error ? error.message : String(error),
            variant: "error",
          })
        }
      },
    }))

    return () => unsubscribe()
  },
})
