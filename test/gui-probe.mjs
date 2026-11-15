/**
 * Headless probe for the GUI bundle: runs its default export's setup against
 * a stub ctx, exactly like the Desktop app would, and prints the real stack
 * when the setup throws (renderer.log only shows "TypeError: e is not a
 * function" with no stack).
 */
import { createRequire } from "node:module"
import Module from "node:module"

// The Desktop app provides these modules to the bundle; Node cannot resolve
// them. Intercept them before requiring the bundle.
const provided = new Map([
  [
    "@opencode/plugin/gui",
    {
      Plugin: {
        define: (definition) => definition,
      },
      Command: { __registry: "Command" },
      Panel: { __registry: "Panel" },
      SettingsPage: { __registry: "SettingsPage" },
      Slot: { __registry: "Slot" },
      Style: { __registry: "Style" },
      Theme: { __registry: "Theme" },
    },
  ],
  ["@opencode/plugin/rpc", { Rpc: { define: (contract) => contract } }],
  ["solid-js", { createSignal: () => [() => undefined, () => {}], For: () => null, Show: () => null }],
  [
    "solid-js/web",
    new Proxy({}, {
      get: (_target, prop) => {
        if (prop === "__esModule") return true
        return () => undefined
      },
    }),
  ],
  ["solid-js/store", {}],
])

const realLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  if (provided.has(request)) return provided.get(request)
  return realLoad.call(this, request, parent, isMain)
}

const require2 = createRequire(new URL("../dist/", import.meta.url))
const bundle = require2("./gui-experimental.cjs")
const definition = bundle.default ?? bundle

const registered = []
const ctx = {
  id: "token-optimizer",
  client: {
    rpc: () => ({
      events: { on: (name, handler) => () => {} },
      report: async () => ({ text: "ok" }),
    }),
  },
  add: (registry, factory) => registered.push({ registry, factory }),
  toast: { show: () => {} },
  dialogs: { open: () => {} },
  ui: {},
  t: (key) => key,
}

try {
  definition.setup(ctx)
  console.log(`setup OK; ${registered.length} command(s) registered`)
  for (const entry of registered) {
    const spec = entry.factory()
    console.log(`- ${spec.id}: ${spec.title}`)
  }
} catch (error) {
  console.error("setup FAILED:", error.stack || error)
  process.exit(1)
}
