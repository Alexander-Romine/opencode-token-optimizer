/**
 * Native binding loader.
 *
 * The hot path lives in Rust (`native/`, a Node-API cdylib). If the addon is
 * missing or fails to load we fall back to a pure-JS implementation with the
 * same contract, so the plugin degrades in speed rather than breaking.
 */
import { createRequire } from "node:module"

/** Field names are camelCase because that is what napi-rs exposes. */
export interface CompressOptions {
  maxChars: number
  headPct: number
  stripAnsi: boolean
  collapseBlank: boolean
  maxBlankLines: number
  trimLines: boolean
  marker?: string
}

export interface CompressResult {
  text: string
  originalChars: number
  resultChars: number
  truncated: boolean
  stripped: boolean
  collapsed: boolean
  trimmed: boolean
}

export interface NativeApi {
  compress(input: string, options: CompressOptions): CompressResult
  hashParts(parts: string[]): string
  fingerprint(path: string, size: number, modifiedMs: number): string
}

function pick(module: unknown, ...names: string[]): ((...args: unknown[]) => unknown) | null {
  const candidate = module as Record<string, unknown> | null | undefined
  if (!candidate) return null
  for (const name of names) {
    const value = candidate[name]
    if (typeof value === "function") return value as (...args: unknown[]) => unknown
  }
  return null
}

function load(): { api: NativeApi | null; detail: string } {
  try {
    const require = createRequire(import.meta.url)
    const addon = require("../native/token-optimizer.node")

    const compress = pick(addon, "compress", "compressText")
    const hashParts = pick(addon, "hash_parts", "hashParts")
    const fingerprint = pick(addon, "fingerprint")

    if (!compress || !hashParts || !fingerprint) {
      return { api: null, detail: "js fallback (native addon exports incomplete)" }
    }

    return {
      api: {
        compress: compress as unknown as NativeApi["compress"],
        hashParts: hashParts as unknown as NativeApi["hashParts"],
        fingerprint: fingerprint as unknown as NativeApi["fingerprint"],
      },
      detail: "rust native addon",
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { api: null, detail: `js fallback (${message})` }
  }
}

/* ------------------------------------------------------------------ *
 * Fallback implementation
 *
 * Kept deliberately simple: it only runs when the native addon cannot load.
 * It matches the Rust contract but allocates more and uses regex.
 * ------------------------------------------------------------------ */

const ANSI_RE =
  /\u001B(?:\[[0-?]*[ -~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[()*+#][0-9A-Za-z]|[0-9A-Za-z=>])/g
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g

/** Unicode code point count without materialising an array. */
function countChars(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) i++
    }
    n++
  }
  return n
}

/** Advance `index` code points from `start`, returning the code-unit offset. */
function advance(s: string, start: number, count: number): number {
  let i = start
  for (let seen = 0; seen < count && i < s.length; seen++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) i++
    }
    i++
  }
  return i
}

function cleanFallback(
  input: string,
  o: CompressOptions,
): { text: string; stripped: boolean; collapsed: boolean; trimmed: boolean } {
  let text = input
  let stripped = false
  let collapsed = false
  let trimmed = false

  if (text.includes("\r")) {
    text = text.replace(/\r\n?/g, "\n")
    stripped = true
  }

  if (o.stripAnsi) {
    const after = text.replace(ANSI_RE, "")
    if (after !== text) stripped = true
    text = after
  }

  const withoutControl = text.replace(CONTROL_RE, "")
  if (withoutControl !== text) stripped = true
  text = withoutControl

  const allowed = o.maxBlankLines + 1
  if (o.collapseBlank && allowed >= 1) {
    const after = text.replace(new RegExp(`\\n{${allowed + 1},}`, "g"), "\n".repeat(allowed))
    if (after !== text) collapsed = true
    text = after
  }

  if (o.trimLines) {
    const after = text.replace(/[ \t]+$/gm, "")
    if (after !== text) trimmed = true
    text = after
  }

  return { text, stripped, collapsed, trimmed }
}

function truncateFallback(text: string, o: CompressOptions): { text: string; truncated: boolean } {
  const max = o.maxChars
  if (max <= 0) return { text, truncated: false }

  const total = countChars(text)
  if (total <= max) return { text, truncated: false }

  const template = o.marker ?? "\n\u2026 {{n}} chars omitted \u2026\n"
  const render = (n: number) => template.replaceAll("{{n}}", String(n))

  let removed = Math.max(0, total - max)
  let marker = render(removed)
  let budget = Math.max(0, max - countChars(marker))
  const recomputed = Math.max(0, total - budget)
  if (recomputed !== removed) {
    removed = recomputed
    marker = render(removed)
    budget = Math.max(0, max - countChars(marker))
  }

  const headChars = Math.floor((budget * Math.min(100, o.headPct)) / 100)
  const tailChars = budget - headChars

  const headEnd = advance(text, 0, headChars)
  const tailStart = advance(text, 0, Math.max(0, total - tailChars))
  const result = text.slice(0, headEnd) + marker + text.slice(tailStart)

  // Belt and braces: never return more characters than the caller asked for.
  const capped = countChars(result) > max ? result.slice(0, advance(result, 0, max)) : result
  return { text: capped, truncated: true }
}

const encoder = new TextEncoder()

/** FNV-1a 64 + avalanche, byte-for-byte identical to the Rust version. */
function fnv1a(parts: string[]): string {
  const OFFSET = 0xcbf29ce484222325n
  const PRIME = 0x100000001b3n
  const MASK = 0xffffffffffffffffn

  let h = OFFSET
  const mix = (byte: number) => {
    h = (h ^ BigInt(byte)) & MASK
    h = (h * PRIME) & MASK
  }

  parts.forEach((part, index) => {
    if (index > 0) mix(0x1f)
    const bytes = encoder.encode(part)
    for (let i = 0; i < bytes.length; i++) mix(bytes[i]!)
  })

  h ^= h >> 33n
  h = (h * 0xff51afd7ed558ccdn) & MASK
  h ^= h >> 33n
  h = (h * 0xc4ceb9fe1a85ec53n) & MASK
  h ^= h >> 33n
  return h.toString(16).padStart(16, "0")
}

/**
 * Mirrors the Rust `fingerprint`: path bytes, then the raw little-endian
 * bytes of the two f64 bit patterns (not their decimal strings).
 */
function fingerprintJs(path: string, size: number, modifiedMs: number): string {
  const OFFSET = 0xcbf29ce484222325n
  const PRIME = 0x100000001b3n
  const MASK = 0xffffffffffffffffn

  let h = OFFSET
  const mix = (byte: number) => {
    h = (h ^ BigInt(byte)) & MASK
    h = (h * PRIME) & MASK
  }
  const mixU64 = (v: bigint) => {
    for (let shift = 0n; shift < 64n; shift += 8n) mix(Number((v >> shift) & 0xffn))
  }
  const f64Bits = (value: number): bigint => {
    const buf = new ArrayBuffer(8)
    new DataView(buf).setFloat64(0, value, true) // little-endian, like Rust to_le_bytes
    return new DataView(buf).getBigUint64(0, true)
  }

  const bytes = encoder.encode(path)
  for (let i = 0; i < bytes.length; i++) mix(bytes[i]!)
  mixU64(f64Bits(size))
  mixU64(f64Bits(modifiedMs))

  h ^= h >> 33n
  h = (h * 0xff51afd7ed558ccdn) & MASK
  h ^= h >> 33n
  h = (h * 0xc4ceb9fe1a85ec53n) & MASK
  h ^= h >> 33n
  return h.toString(16).padStart(16, "0")
}

const JS_FALLBACK: NativeApi = {
  compress(input, options) {
    const originalChars = countChars(input)
    const cleaned = cleanFallback(input, options)
    const cut = truncateFallback(cleaned.text, options)
    return {
      text: cut.text,
      originalChars,
      resultChars: countChars(cut.text),
      truncated: cut.truncated,
      stripped: cleaned.stripped,
      collapsed: cleaned.collapsed,
      trimmed: cleaned.trimmed,
    }
  },
  hashParts: fnv1a,
  fingerprint(path, size, modifiedMs) {
    return fingerprintJs(path, size, modifiedMs)
  },
}

const loaded = load()

/** Implementation in use: native when available, otherwise the JS fallback. */
export const api: NativeApi = loaded.api ?? JS_FALLBACK
/** The pure-JS implementation, always available (used to cross-check hashes). */
export const fallbackApi: NativeApi = JS_FALLBACK
/** Whether the Rust implementation is actually in use. */
export const nativeAvailable = loaded.api !== null
/** Human readable description of which implementation is running. */
export const nativeDetail = loaded.detail
