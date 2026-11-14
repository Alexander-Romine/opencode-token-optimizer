/**
 * RPC contract shared by the server part (implements) and the TUI part (calls).
 *
 * Kept in its own module so the TUI can import the contract without loading the
 * server implementation. Schemas are annotated with the portable JSON-Schema
 * variants so `Rpc.define` infers the literal definition rather than widening
 * to its `Definition` constraint (which would silently degrade the generated
 * client to `Record<string, ...>` and make every method optional).
 */
import { Rpc } from "@opencode/plugin/rpc"

const reportInput: Rpc.PortableValueSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
}

const reportOutput: Rpc.PortableValueSchema = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
}

const sessionInput: Rpc.PortableValueSchema = {
  type: "object",
  properties: { sessionID: { type: "string" } },
  required: ["sessionID"],
  additionalProperties: false,
}

const stateOutput: Rpc.PortableValueSchema = {
  type: "object",
  properties: { text: { type: "string" }, path: { type: "string" } },
  required: ["text", "path"],
  additionalProperties: false,
}

const rotateOutput: Rpc.PortableValueSchema = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    path: { type: "string" },
    title: { type: "string" },
  },
  required: ["sessionID", "path", "title"],
  additionalProperties: false,
}

const statusInput: Rpc.PortableValueSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
}

const statusOutput: Rpc.PortableValueSchema = {
  type: "object",
  properties: {
    native: { type: "boolean" },
    detail: { type: "string" },
  },
  required: ["native", "detail"],
  additionalProperties: false,
}

/** One row of the `/plugins` panel: a whole plugin and its on/off state. */
export interface PluginRow {
  /** Stable identity: the resolved plugin id when known, else the config target. */
  key: string
  /** Display name: the declared package/path, or the id. */
  label: string
  /** Resolved plugin id (empty string when the plugin never loaded here). */
  id: string
  /** Where the plugin comes from: `package` | `local` | `builtin` | `sdk` | `directive`. */
  kind: string
  /** Config file that declares it (or holds its disable directive); empty when built in. */
  file: string
  /** Whether the plugin is switched on. */
  enabled: boolean
  /** Parts the package ships: any of `server`, `tui`, `rpc`, `gui`. */
  parts: string[]
  /** Runtime state: `active` | `failed` | `disabled` | `unknown`. */
  status: string
  /** Guarded (built into OpenCode) or self: cannot be toggled from here. */
  locked: boolean
  /** Failure text or lock reason; empty when none. */
  detail: string
  /**
   * Documented conflict with another installed plugin (duplicate id from two
   * config targets, or a known package clash); empty when none.
   */
  conflict: string
}

/** One pending toggle in a `/plugins` batch. */
export interface PluginChange {
  key: string
  enabled: boolean
}

/** Result of `pluginsList`. */
export interface PluginsListResult {
  rows: PluginRow[]
  /** Config files that could not be listed normally (JSONC, invalid JSON). */
  warnings: string[]
  /** Every config file considered, in priority order. */
  files: string[]
}

/** Result of `pluginsSet`. */
export interface PluginsSetResult extends PluginsListResult {
  /** Timestamped backups written for this batch (one per file changed). */
  backups: string[]
  /** Per-row failures; changes not mentioned here were applied. */
  errors: string[]
}

const pluginRowSchema: Rpc.PortableValueSchema = {
  type: "object",
  properties: {
    key: { type: "string" },
    label: { type: "string" },
    id: { type: "string" },
    kind: { type: "string" },
    file: { type: "string" },
    enabled: { type: "boolean" },
    parts: { type: "array", items: { type: "string" } },
    status: { type: "string" },
    locked: { type: "boolean" },
    detail: { type: "string" },
    conflict: { type: "string" },
  },
  required: ["key", "label", "id", "kind", "file", "enabled", "parts", "status", "locked", "detail", "conflict"],
  additionalProperties: false,
}

const stringListSchema: Rpc.PortableValueSchema = {
  type: "array",
  items: { type: "string" },
}

const pluginsListOutput: Rpc.PortableValueSchema = {
  type: "object",
  properties: { rows: { type: "array", items: pluginRowSchema }, warnings: stringListSchema, files: stringListSchema },
  required: ["rows", "warnings", "files"],
  additionalProperties: false,
}

const pluginsSetInput: Rpc.PortableValueSchema = {
  type: "object",
  properties: {
    changes: {
      type: "array",
      items: {
        type: "object",
        properties: { key: { type: "string" }, enabled: { type: "boolean" } },
        required: ["key", "enabled"],
        additionalProperties: false,
      },
    },
  },
  required: ["changes"],
  additionalProperties: false,
}

const pluginsSetOutput: Rpc.PortableValueSchema = {
  type: "object",
  properties: {
    rows: { type: "array", items: pluginRowSchema },
    warnings: stringListSchema,
    files: stringListSchema,
    backups: stringListSchema,
    errors: stringListSchema,
  },
  required: ["rows", "warnings", "files", "backups", "errors"],
  additionalProperties: false,
}

const rotatedSchema: Rpc.PortableEventDefinition["schema"] = {
  type: "object",
  properties: {
    from: { type: "string" },
    to: { type: "string" },
    path: { type: "string" },
    auto: { type: "boolean" },
  },
  required: ["from", "to", "path", "auto"],
  additionalProperties: false,
}

const compactedSchema: Rpc.PortableEventDefinition["schema"] = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    summaryChars: { type: "number" },
  },
  required: ["sessionID", "summaryChars"],
  additionalProperties: false,
}

export const TokenOptimizer = Rpc.define({
  id: "token-optimizer",
  methods: {
    /** Aggregate token/efficiency report across sessions for this location. */
    report: { input: reportInput, output: reportOutput },
    /** Force a structured state capture for one session. */
    state: { input: sessionInput, output: stateOutput },
    /** Start a fresh session seeded from the current one's structured state. */
    rotate: { input: sessionInput, output: rotateOutput },
    /** Whether the Rust native module is in use. */
    status: { input: statusInput, output: statusOutput },
    /** Whole-plugin inventory for the Desktop `/plugins` panel. */
    pluginsList: { input: statusInput, output: pluginsListOutput },
    /** Apply a batch of plugin toggles; one backup per config file changed. */
    pluginsSet: { input: pluginsSetInput, output: pluginsSetOutput },
  },
  events: {
    /** Fired after a rotation so the TUI can focus the new session. */
    rotated: { schema: rotatedSchema },
    /** Fired after a compaction so the TUI can show a one-line notice. */
    compacted: { schema: compactedSchema },
  },
})

/** Payload of the `rotated` event, for consumers that need it concretely. */
export interface RotatedEventData {
  from: string
  to: string
  path: string
  auto: boolean
}

/** Payload of the `compacted` event. */
export interface CompactedEventData {
  sessionID: string
  summaryChars: number
}
