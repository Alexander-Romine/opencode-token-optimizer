/**
 * token-optimizer - TUI part.
 *
 * Owns everything the user actually sees:
 *   * `/tokens`  -> efficiency report dialog (fetched over RPC)
 *   * rotation notices -> toast, plus focusing the freshly created session so
 *     "new chat window" behaves like a real context switch rather than a
 *     session appearing silently in the sidebar.
 *
 * Deliberately JSX-free: no OpenTUI/Solid peer dependencies are needed because
 * the built-in toast, dialog and keymap APIs cover both jobs.
 */
import { Plugin } from "@opencode/plugin/tui"

import { TokenOptimizer, type RotatedEventData } from "./rpc"

interface RotatedEvent {
  data: RotatedEventData
}

export default Plugin.define({
  id: "token-optimizer.tui",
  setup(context) {
    const optimizer = context.client.rpc(TokenOptimizer)

    const unsubscribe = optimizer.events.on("rotated", (event) => {
      const { to, auto } = (event as unknown as RotatedEvent).data
      context.ui.toast.show({
        title: auto ? "Context rotated" : "Session rotated",
        message: `${to} - state saved, new window focused`,
        variant: "info",
      })
      // Make the rotation feel like a real context switch.
      if (context.ui.tabs.enabled()) {
        context.ui.tabs.open(to)
        context.ui.tabs.focus(to)
      }
    })

    context.keymap.layer(() => ({
      mode: "global",
      priority: 20,
      commands: [
        {
          id: "token-optimizer.report",
          title: "Token optimizer report",
          group: "Token optimizer",
          palette: true,
          slash: { name: "tokens", aliases: ["tokenstats"] },
          enabled: () => true,
          run: async () => {
            try {
              const { text } = (await optimizer.report({})) as { text: string }
              await context.ui.dialog.alert({ title: "token-optimizer", message: text })
            } catch (error) {
              context.ui.toast.show({
                title: "token-optimizer",
                message: error instanceof Error ? error.message : String(error),
                variant: "error",
              })
            }
          },
        },
        {
          id: "token-optimizer.status",
          title: "Token optimizer status",
          group: "Token optimizer",
          palette: true,
          enabled: () => true,
          run: async () => {
            try {
              const status = (await optimizer.status({})) as { native: boolean; detail: string }
              context.ui.toast.show({
                title: "token-optimizer",
                message: status.native ? "Rust native module active" : status.detail,
                variant: status.native ? "success" : "warning",
              })
            } catch (error) {
              context.ui.toast.show({
                message: error instanceof Error ? error.message : String(error),
                variant: "error",
              })
            }
          },
        },
      ],
      bindings: ["token-optimizer.report"],
    }))

    return () => unsubscribe()
  },
})
