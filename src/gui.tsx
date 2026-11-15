/**
 * token-optimizer - GUI part (OpenCode Desktop).
 *
 * Desktop never loads the TUI half, so this is where `/tokens` lives for the
 * app: a composer slash command that fetches the same RPC report the TUI
 * dialog shows and renders it as Markdown. Rotation notices surface as toasts.
 *
 * `/plugins` is the whole-plugin panel: a checkbox list backed by the
 * `pluginsList`/`pluginsSet` RPC methods, which edit opencode.json (`-<id>`
 * directives) with the installer's backup/merge guarantees. Config changes
 * hot-reload, so the panel refetches a couple of seconds after Apply instead
 * of asking for a restart.
 *
 * The bundle rules (see vite.config.ts) keep this file free of imports the
 * app does not provide: only `@opencode/plugin/gui`, `@opencode/plugin/rpc`
 * and Solid are external, so the shared `./rpc` contract is safe to import.
 */
import { createSignal, For, Show } from "solid-js"
import { Command, Plugin } from "@opencode/plugin/gui"

import {
  TokenOptimizer,
  type OptionChange,
  type OptionRow,
  type OptionsGetResult,
  type OptionsSetResult,
  type PluginChange,
  type PluginRow,
  type PluginsListResult,
  type PluginsSetResult,
  type RotatedEventData,
} from "./rpc"

interface RotatedEvent {
  data: RotatedEventData
}

/** Last two path segments, so long config paths stay readable in a row. */
function shortPath(file: string): string {
  return file.split(/[\\/]/).slice(-2).join("/")
}

function rowDescription(row: PluginRow): string {
  return [row.kind, row.status, row.file ? shortPath(row.file) : "", row.detail, row.conflict].filter(Boolean).join(" · ")
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

    /* ---------------------------------------------------------------- *
     * /plugins - whole-plugin on/off panel
     * ---------------------------------------------------------------- */

    ctx.add(Command, () => ({
      id: "plugins",
      title: "Manage plugins",
      description: "Turn whole plugins on or off (edits opencode.json with backups)",
      keywords: "plugins enable disable toggle switch extensions manager",
      group: "Token optimizer",
      slash: { name: "plugins" },
      section: "prompt" as const,
      run: async () => {
        const [rows, setRows] = createSignal<PluginRow[]>([])
        const [original, setOriginal] = createSignal<Record<string, boolean>>({})
        const [warnings, setWarnings] = createSignal<string[]>([])
        const [busy, setBusy] = createSignal(false)
        const [loading, setLoading] = createSignal(true)
        const [loadError, setLoadError] = createSignal("")

        const accept = (result: PluginsListResult) => {
          setRows(result.rows)
          setOriginal(Object.fromEntries(result.rows.map((row) => [row.key, row.enabled])))
          setWarnings(result.warnings)
        }

        const pending = () =>
          rows().filter((row) => !row.locked && row.enabled !== (original()[row.key] ?? row.enabled))

        const sorted = () =>
          [...rows()].sort((a, b) =>
            a.file === b.file ? a.label.localeCompare(b.label) : a.file.localeCompare(b.file),
          )

        const toggle = (key: string, enabled: boolean) => {
          const row = rows().find((candidate) => candidate.key === key)
          // Turning a conflicted plugin back on warns immediately; the Apply
          // toast re-checks against the config that was actually written.
          if (enabled && row?.conflict) {
            ctx.toast.show({
              title: "Plugin conflict",
              description: `${row.label}: ${row.conflict}`,
              variant: "error",
            })
          }
          setRows((current) => current.map((candidate) => (candidate.key === key ? { ...candidate, enabled } : candidate)))
        }

        const refresh = async () => {
          accept((await optimizer.pluginsList({})) as PluginsListResult)
        }

        const apply = async () => {
          const changes: PluginChange[] = pending().map((row) => ({ key: row.key, enabled: row.enabled }))
          if (!changes.length || busy()) return
          setBusy(true)
          try {
            const result = (await optimizer.pluginsSet({ changes })) as PluginsSetResult
            accept(result)
            const conflicted = result.rows.filter((row) => row.enabled && row.conflict)
            if (result.errors.length) {
              ctx.toast.show({
                title: "Plugins",
                description: result.errors.slice(0, 3).join(" · "),
                variant: "error",
              })
            } else if (conflicted.length) {
              ctx.toast.show({
                title: "Plugins - conflict",
                description:
                  `${changes.length} change(s) applied` +
                  (result.backups.length ? ` · backup: ${result.backups.map((file) => shortPath(file)).join(", ")}` : "") +
                  ` · ${conflicted.slice(0, 2).map((row) => `${row.label}: ${row.conflict}`).join(" · ")}`,
                variant: "error",
              })
            } else {
              const backups = result.backups.map((file) => shortPath(file))
              ctx.toast.show({
                title: "Plugins",
                description:
                  `${changes.length} change(s) applied` + (backups.length ? ` · backup: ${backups.join(", ")}` : ""),
                variant: "success",
              })
            }
            // Config hot-reload activates a second or two behind the write;
            // re-read once so statuses (active/disabled) settle.
            setTimeout(() => void refresh().catch(() => undefined), 2500)
          } catch (error) {
            ctx.toast.show({
              title: "Plugins",
              description: error instanceof Error ? error.message : String(error),
              variant: "error",
            })
          } finally {
            setBusy(false)
          }
        }

        ctx.dialogs.open((dialog) => (
          <ctx.ui.Dialog
            title="Plugins"
            description="Switch whole plugins on or off. Each apply writes opencode.json with a timestamped backup."
            size="large"
            footer={
              <>
                <ctx.ui.Button variant="ghost" onClick={() => dialog.close()}>
                  Close
                </ctx.ui.Button>
                <ctx.ui.Button variant="contrast" busy={busy()} disabled={busy() || pending().length === 0} onClick={() => void apply()}>
                  {pending().length > 0 ? `Apply (${pending().length})` : "Apply"}
                </ctx.ui.Button>
              </>
            }
          >
            <Show
              when={!loading()}
              fallback={
                <div style="display: flex; justify-content: center; padding: 2rem 0;">
                  <ctx.ui.Loader />
                </div>
              }
            >
              <Show
                when={!loadError()}
                fallback={<div style="padding: 0.5rem 0; color: var(--op-content-dim);">{loadError()}</div>}
              >
                <ctx.ui.SettingsSection
                  title="Installed"
                  footer={warnings().length > 0 ? warnings().join("\n") : undefined}
                >
                  <For each={sorted()}>
                    {(row) => (
                      <ctx.ui.SettingsRow title={row.label} description={rowDescription(row)}>
                        <ctx.ui.Switch
                          label={`Enable ${row.label}`}
                          hideLabel
                          checked={row.enabled}
                          disabled={row.locked}
                          onChange={(enabled) => toggle(row.key, enabled)}
                        />
                      </ctx.ui.SettingsRow>
                    )}
                  </For>
                </ctx.ui.SettingsSection>
              </Show>
            </Show>
          </ctx.ui.Dialog>
        ))

        try {
          await refresh()
        } catch (error) {
          setLoadError(error instanceof Error ? error.message : String(error))
        } finally {
          setLoading(false)
        }
      },
    }))

    /* ---------------------------------------------------------------- *
     * /optimize - feature / transform / companion toggles
     *
     * The in-OpenCode half of the installer's checkbox page: same backup-
     * guaranteed config writes, no separate window. External installs
     * (agents clone, cc-switch MSI) stay with Install.cmd.
     * ---------------------------------------------------------------- */

    ctx.add(Command, () => ({
      id: "optimize",
      title: "Token optimizer settings",
      description: "Toggle optimizations, transforms and companion plugins (edits opencode.json with backups)",
      keywords: "optimize settings options transforms cache rtk caveman companions toggle config install",
      group: "Token optimizer",
      slash: { name: "optimize" },
      section: "prompt" as const,
      run: async () => {
        const [rows, setRows] = createSignal<OptionRow[]>([])
        const [original, setOriginal] = createSignal<Record<string, boolean>>({})
        const [warnings, setWarnings] = createSignal<string[]>([])
        const [file, setFile] = createSignal("")
        const [busy, setBusy] = createSignal(false)
        const [loading, setLoading] = createSignal(true)
        const [loadError, setLoadError] = createSignal("")

        const accept = (result: OptionsGetResult) => {
          setRows(result.rows)
          setOriginal(Object.fromEntries(result.rows.map((row) => [row.key, row.enabled])))
          setWarnings(result.warnings)
          setFile(result.file)
        }

        const pending = () => rows().filter((row) => row.enabled !== (original()[row.key] ?? row.enabled))
        const section = (name: OptionRow["section"]) => rows().filter((row) => row.section === name)

        const toggle = (key: string, enabled: boolean) => {
          setRows((current) => current.map((row) => (row.key === key ? { ...row, enabled } : row)))
        }

        const refresh = async () => {
          accept((await optimizer.optionsGet({})) as OptionsGetResult)
        }

        const apply = async () => {
          const changes: OptionChange[] = pending().map((row) => ({ key: row.key, enabled: row.enabled }))
          if (!changes.length || busy()) return
          setBusy(true)
          try {
            const result = (await optimizer.optionsSet({ changes })) as OptionsSetResult
            accept(result)
            if (result.errors.length) {
              ctx.toast.show({
                title: "Optimizations",
                description: result.errors.slice(0, 3).join(" · "),
                variant: "error",
              })
            } else {
              const backups = result.backups.map((path) => shortPath(path))
              ctx.toast.show({
                title: "Optimizations",
                description:
                  `${changes.length} change(s) applied` +
                  (backups.length ? ` · backup: ${backups.join(", ")}` : "") +
                  (result.warnings.length ? ` · ${result.warnings.length} warning(s)` : ""),
                variant: "success",
              })
            }
            // Config hot-reload picks the new options up a second or two later.
            setTimeout(() => void refresh().catch(() => undefined), 2500)
          } catch (error) {
            ctx.toast.show({
              title: "Optimizations",
              description: error instanceof Error ? error.message : String(error),
              variant: "error",
            })
          } finally {
            setBusy(false)
          }
        }

        const renderSection = (name: OptionRow["section"], title: string, footer?: string) => (
          <ctx.ui.SettingsSection title={title} footer={footer}>
            <For each={section(name)}>
              {(row) => (
                <ctx.ui.SettingsRow title={row.label} description={row.desc}>
                  <ctx.ui.Switch
                    label={`Enable ${row.label}`}
                    hideLabel
                    checked={row.enabled}
                    onChange={(enabled) => toggle(row.key, enabled)}
                  />
                </ctx.ui.SettingsRow>
              )}
            </For>
          </ctx.ui.SettingsSection>
        )

        ctx.dialogs.open((dialog) => (
          <ctx.ui.Dialog
            title="Token optimizer"
            description={
              "Toggle optimizations and companions. Each apply writes opencode.json with a timestamped backup." +
              (file() ? ` Editing: ${shortPath(file())}` : "")
            }
            size="large"
            footer={
              <>
                <ctx.ui.Button variant="ghost" onClick={() => dialog.close()}>
                  Close
                </ctx.ui.Button>
                <ctx.ui.Button variant="contrast" busy={busy()} disabled={busy() || pending().length === 0} onClick={() => void apply()}>
                  {pending().length > 0 ? `Apply (${pending().length})` : "Apply"}
                </ctx.ui.Button>
              </>
            }
          >
            <Show
              when={!loading()}
              fallback={
                <div style="display: flex; justify-content: center; padding: 2rem 0;">
                  <ctx.ui.Loader />
                </div>
              }
            >
              <Show
                when={!loadError()}
                fallback={<div style="padding: 0.5rem 0; color: var(--op-content-dim);">{loadError()}</div>}
              >
                {renderSection("feature", "Optimizations", warnings().length > 0 ? warnings().join("\n") : undefined)}
                {renderSection("transform", "Structural transforms", "Lossy transforms leave an honest marker in the output.")}
                {renderSection(
                  "companion",
                  "Companion plugins",
                  "agents and cc-switch are external installs - run Install.cmd for those.",
                )}
              </Show>
            </Show>
          </ctx.ui.Dialog>
        ))

        try {
          await refresh()
        } catch (error) {
          setLoadError(error instanceof Error ? error.message : String(error))
        } finally {
          setLoading(false)
        }
      },
    }))

    return () => unsubscribe()
  },
})
