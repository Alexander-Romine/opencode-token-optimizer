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
