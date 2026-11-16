/**
 * PNG downscaling for `tool.downscaleImages` (opt-in).
 *
 * Two entry points, one codec:
 *
 *  * **Tool text** - `data:image/png;base64,...` URIs inside tool results are
 *    decoded, shrunk to `imageMaxDim` on their longer edge and re-encoded, so
 *    an inline screenshot costs a fraction of the tokens it used to. This is
 *    the soft alternative to `scrubBase64`: the image survives, smaller.
 *
 *  * **Outgoing requests** - base64/bytes `media` parts whose payload is a PNG
 *    are swapped for the downscaled bytes (vision tokens scale with pixels).
 *    The transform is deterministic, so the request prefix stays byte-stable
 *    across turns and prompt caching still works after the first request.
 *
 * Deliberately **PNG-only and pure JS** (node:zlib):
 *
 *  - a real image codec in Rust would end the addon's "zero dependencies
 *    beyond the napi glue" rule and force a prebuilt rebuild for a feature
 *    that runs once per image, not per byte - it is not the hot path;
 *  - JPEG/WebP decode has no honest JS fallback, so those payloads pass
 *    through untouched (never corrupted, never half-processed);
 *  - every path is gated on the PNG magic bytes, so base64 that merely looks
 *    like a PNG is never re-encoded.
 *
 * A `null` return always means "leave the original alone".
 */
import { deflateSync, inflateSync } from "node:zlib"

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** Guard rails against pathological dimensions (and the memory they imply). */
const MAX_DIMENSION = 16_384
const MAX_PIXELS = 40_000_000
/** Base64 prefix of the 8-byte PNG signature - cheap reject before decoding. */
const PNG_B64_PREFIX = "iVBORw0KGgo"
/** Memoized decode+resize results, keyed by the exact input (never fuzzy). */
const MEMO_PER_DIM = 24

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function readU32(b: Uint8Array, at: number): number {
  return (((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0)
}

function writeU32(b: Uint8Array, at: number, value: number): void {
  b[at] = (value >>> 24) & 0xff
  b[at + 1] = (value >>> 16) & 0xff
  b[at + 2] = (value >>> 8) & 0xff
  b[at + 3] = value & 0xff
}

function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_MAGIC[i]) return false
  return true
}

interface DecodedPng {
  width: number
  height: number
  /** RGBA8, 4 bytes per pixel, row-major. */
  rgba: Uint8Array
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/**
 * Decode a PNG to RGBA8. Only 8-bit non-interlaced images (colour types
 * 0/2/3/4/6) are supported - anything else returns `null` and the caller
 * leaves the original untouched.
 */
function decodePng(bytes: Uint8Array): DecodedPng | null {
  if (!isPng(bytes)) return null

  let at = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  let palette: Uint8Array | null = null
  const idat: Buffer[] = []

  while (at + 8 <= bytes.length) {
    const len = readU32(bytes, at)
    const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!)
    const dataStart = at + 8
    const dataEnd = dataStart + len
    if (dataEnd + 4 > bytes.length) return null // truncated chunk stream

    if (type === "IHDR") {
      if (len < 13) return null
      width = readU32(bytes, dataStart)
      height = readU32(bytes, dataStart + 4)
      bitDepth = bytes[dataStart + 8]!
      colorType = bytes[dataStart + 9]!
      interlace = bytes[dataStart + 12]!
    } else if (type === "PLTE") {
      palette = bytes.slice(dataStart, dataEnd)
    } else if (type === "IDAT") {
      idat.push(Buffer.from(bytes.subarray(dataStart, dataEnd)))
    } else if (type === "IEND") {
      break
    }
    at = dataEnd + 4
  }

  if (width <= 0 || height <= 0 || idat.length === 0) return null
  if (bitDepth !== 8 || interlace !== 0) return null
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) return null

  const channels =
    colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0
  if (channels === 0) return null
  if (colorType === 3 && (!palette || palette.length === 0)) return null

  const stride = width * channels
  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(idat))
  } catch {
    return null
  }
  if (raw.length < (stride + 1) * height) return null

  // Unfilter in place into one flat buffer (filters 0-4, per PNG spec).
  const flat = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    const inStart = y * (stride + 1) + 1
    const outStart = y * stride
    const prevStart = outStart - stride
    for (let i = 0; i < stride; i++) {
      const x = raw[inStart + i]!
      const left = i >= channels ? flat[outStart + i - channels]! : 0
      const up = y > 0 ? flat[prevStart + i]! : 0
      const upLeft = y > 0 && i >= channels ? flat[prevStart + i - channels]! : 0
      let value: number
      switch (filter) {
        case 0:
          value = x
          break
        case 1:
          value = x + left
          break
        case 2:
          value = x + up
          break
        case 3:
          value = x + ((left + up) >> 1)
          break
        case 4:
          value = x + paeth(left, up, upLeft)
          break
        default:
          return null // unknown filter byte
      }
      flat[outStart + i] = value & 0xff
    }
  }

  // Expand to RGBA8.
  const rgba = new Uint8Array(width * height * 4)
  const pixels = width * height
  if (colorType === 6) {
    rgba.set(flat.subarray(0, pixels * 4))
  } else if (colorType === 2) {
    for (let p = 0; p < pixels; p++) {
      rgba[p * 4] = flat[p * 3]!
      rgba[p * 4 + 1] = flat[p * 3 + 1]!
      rgba[p * 4 + 2] = flat[p * 3 + 2]!
      rgba[p * 4 + 3] = 255
    }
  } else if (colorType === 0) {
    for (let p = 0; p < pixels; p++) {
      const v = flat[p]!
      rgba[p * 4] = v
      rgba[p * 4 + 1] = v
      rgba[p * 4 + 2] = v
      rgba[p * 4 + 3] = 255
    }
  } else if (colorType === 4) {
    for (let p = 0; p < pixels; p++) {
      const v = flat[p * 2]!
      rgba[p * 4] = v
      rgba[p * 4 + 1] = v
      rgba[p * 4 + 2] = v
      rgba[p * 4 + 3] = flat[p * 2 + 1]!
    }
  } else {
    // palette (colorType 3)
    for (let p = 0; p < pixels; p++) {
      const idx = flat[p]! * 3
      if (idx + 2 < palette!.length) {
        rgba[p * 4] = palette![idx]!
        rgba[p * 4 + 1] = palette![idx + 1]!
        rgba[p * 4 + 2] = palette![idx + 2]!
      }
      rgba[p * 4 + 3] = 255
    }
  }

  return { width, height, rgba }
}

/** Box resample: every target pixel is the average of its source rectangle. */
function resample(img: DecodedPng, tw: number, th: number): Uint8Array {
  if (tw === img.width && th === img.height) return img.rgba
  const { width: w, height: h, rgba } = img
  const acc = new Float64Array(tw * th * 4)
  const count = new Float64Array(tw * th)
  for (let y = 0; y < h; y++) {
    const ty = Math.min(th - 1, ((y * th) / h) | 0)
    for (let x = 0; x < w; x++) {
      const tx = Math.min(tw - 1, ((x * tw) / w) | 0)
      const si = (y * w + x) * 4
      const di = (ty * tw + tx) * 4
      acc[di] = acc[di]! + rgba[si]!
      acc[di + 1] = acc[di + 1]! + rgba[si + 1]!
      acc[di + 2] = acc[di + 2]! + rgba[si + 2]!
      acc[di + 3] = acc[di + 3]! + rgba[si + 3]!
      count[ty * tw + tx] = count[ty * tw + tx]! + 1
    }
  }
  const out = new Uint8Array(tw * th * 4)
  for (let p = 0; p < tw * th; p++) {
    const n = count[p]! || 1
    out[p * 4] = Math.round(acc[p * 4]! / n)
    out[p * 4 + 1] = Math.round(acc[p * 4 + 1]! / n)
    out[p * 4 + 2] = Math.round(acc[p * 4 + 2]! / n)
    out[p * 4 + 3] = Math.round(acc[p * 4 + 3]! / n)
  }
  return out
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length)
  writeU32(out, 0, data.length)
  out.write(type, 4, "ascii")
  out.set(data, 8)
  writeU32(out, 8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none - simplicity over density
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  writeU32(ihdr, 0, width)
  writeU32(ihdr, 4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type RGBA
  const head = Buffer.from(PNG_MAGIC)
  return Buffer.concat([head, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", new Uint8Array(0))])
}

export interface DownscaledPng {
  bytes: Uint8Array
  width: number
  height: number
}

/**
 * Shrink a PNG to at most `maxDim` on its longer edge.
 * Returns `null` when the payload is not a PNG, cannot be decoded, is already
 * small enough, or the re-encode would not be strictly smaller.
 */
export function downscalePng(bytes: Uint8Array, maxDim: number): DownscaledPng | null {
  if (maxDim < 16 || !isPng(bytes)) return null
  const img = decodePng(bytes)
  if (!img) return null
  const longEdge = Math.max(img.width, img.height)
  if (longEdge <= maxDim) return null
  const scale = maxDim / longEdge
  const tw = Math.max(1, Math.round(img.width * scale))
  const th = Math.max(1, Math.round(img.height * scale))
  const resized = resample(img, tw, th)
  const encoded = encodePng(tw, th, resized)
  if (encoded.length >= bytes.length) return null // never trade bytes for pixels
  return { bytes: encoded, width: tw, height: th }
}

/** Per-`maxDim` memo of exact-input results (input string is the key itself). */
const base64Memo = new Map<number, Map<string, DownscaledPng>>()

function memoizedBase64(b64: string, maxDim: number): DownscaledPng | null {
  let bucket = base64Memo.get(maxDim)
  if (!bucket) {
    bucket = new Map()
    base64Memo.set(maxDim, bucket)
  }
  const hit = bucket.get(b64)
  if (hit !== undefined) {
    bucket.delete(b64) // refresh recency
    bucket.set(b64, hit)
    return hit
  }
  let result: DownscaledPng | null = null
  if (b64.startsWith(PNG_B64_PREFIX)) {
    const bytes = Buffer.from(b64, "base64")
    result = downscalePng(bytes, maxDim)
  }
  if (result) {
    while (bucket.size >= MEMO_PER_DIM) {
      const oldest = bucket.keys().next().value
      if (oldest === undefined) break
      bucket.delete(oldest)
    }
    bucket.set(b64, result)
  }
  return result
}

/** Memo for `bytes` sources: keyed by the exact array object, then by `maxDim`. */
const bytesMemo = new WeakMap<Uint8Array, Map<number, DownscaledPng | null>>()

function memoizedBytes(bytes: Uint8Array, maxDim: number): DownscaledPng | null {
  let bucket = bytesMemo.get(bytes)
  if (!bucket) {
    bucket = new Map()
    bytesMemo.set(bytes, bucket)
  }
  const hit = bucket.get(maxDim)
  if (hit !== undefined) return hit
  const result = downscalePng(bytes, maxDim)
  bucket.set(maxDim, result)
  return result
}

/** Inline `data:image/png;base64,...` URIs inside tool text. */
export function downscaleDataUris(text: string, maxDim: number): string {
  if (!text.includes("data:image/png")) return text
  return text.replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/g, (match) => {
    const comma = match.indexOf(",")
    const out = memoizedBase64(match.slice(comma + 1), maxDim)
    return out ? `data:image/png;base64,${Buffer.from(out.bytes).toString("base64")}` : match
  })
}

interface MediaSourceLike {
  type?: unknown
  data?: unknown
  mediaType?: unknown
}

interface MediaPartLike {
  source?: unknown
  info?: unknown
}

/**
 * Downscale image media parts in an outgoing request's messages, in place.
 * Handles `{role, content:[{type:"media", media:{source}}]}` and tolerates
 * `parts` arrays; non-PNG / url / ref sources pass through untouched.
 * Returns how many parts were replaced (for tests and diagnostics).
 */
export function downscaleRequestImages(messages: unknown, maxDim: number): number {
  if (!Array.isArray(messages) || maxDim < 16) return 0
  let changed = 0
  for (const message of messages) {
    if (!message || typeof message !== "object") continue
    const bag = message as { content?: unknown; parts?: unknown }
    const content = Array.isArray(bag.content) ? bag.content : Array.isArray(bag.parts) ? bag.parts : null
    if (!content) continue
    for (const part of content) {
      try {
        if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "media") continue
        const media = (part as { media?: MediaPartLike }).media
        const source = media?.source as MediaSourceLike | undefined
        if (!source || typeof source !== "object") continue
        const mediaType = typeof source.mediaType === "string" ? source.mediaType : ""
        if (mediaType && !mediaType.startsWith("image/png")) continue

        if (source.type === "base64" && typeof source.data === "string") {
          const out = memoizedBase64(source.data, maxDim)
          if (out) {
            source.data = Buffer.from(out.bytes).toString("base64")
            changed++
            noteInfo(media!, out)
          }
        } else if (source.type === "bytes" && source.data instanceof Uint8Array) {
          const out = memoizedBytes(source.data, maxDim)
          if (out) {
            source.data = out.bytes instanceof Uint8Array ? new Uint8Array(out.bytes) : out.bytes
            changed++
            noteInfo(media!, out)
          }
        }
      } catch {
        // A malformed part must never break the request - skip it.
      }
    }
  }
  return changed
}

function noteInfo(media: MediaPartLike, out: DownscaledPng): void {
  const info = media.info && typeof media.info === "object" ? (media.info as Record<string, unknown>) : {}
  media.info = { ...info, width: out.width, height: out.height }
}
