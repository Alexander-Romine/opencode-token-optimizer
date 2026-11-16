/**
 * VS Code-style plugin lookup for the localhost panel.
 *
 * Queries npm's public search API restricted to the `opencode-plugin`
 * keyword (the ecosystem's convention - OpenDock, Mercato and friends all
 * index the same tag), so no API key and no third-party catalog service is
 * involved. Results are mapped down to name/description/date and cached
 * briefly in memory: the panel auto-refreshes, the registry must not be
 * hammered.
 */

export interface DiscoverResult {
  /** npm package name; feeds `pluginmgr.add()` directly. */
  name: string
  description: string
  /** ISO date of the latest publish, if npm reported one. */
  date?: string
}

interface NpmSearchEntry {
  package?: { name?: string; description?: string; date?: string }
}

const SEARCH_URL = "https://registry.npmjs.org/-/v1/search"
const MAX_RESULTS = 15
const TIMEOUT_MS = 6_000
const CACHE_TTL_MS = 60_000

const cache = new Map<string, { at: number; results: DiscoverResult[] }>()

/** Searches npm for OpenCode plugins; empty query lists the ecosystem's popular ones. */
export async function searchPlugins(query: string): Promise<DiscoverResult[]> {
  const q = query.trim().slice(0, 60)
  const key = q.toLowerCase()

  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.results

  const text = q ? `keywords:opencode-plugin ${q}` : "keywords:opencode-plugin"
  const url = `${SEARCH_URL}?text=${encodeURIComponent(text)}&size=${MAX_RESULTS}`

  let payload: { objects?: NpmSearchEntry[] }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new Error(`registry responded ${res.status}`)
    payload = (await res.json()) as { objects?: NpmSearchEntry[] }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`plugin lookup failed (${detail}) - is this machine online?`)
  }

  const results: DiscoverResult[] = []
  for (const entry of payload.objects ?? []) {
    const pkg = entry.package
    if (!pkg?.name) continue
    const item: DiscoverResult = { name: pkg.name, description: pkg.description ?? "" }
    if (pkg.date) item.date = pkg.date
    results.push(item)
    if (results.length >= MAX_RESULTS) break
  }

  cache.set(key, { at: Date.now(), results })
  // Bound the cache so long sessions cannot accumulate entries forever.
  if (cache.size > 32) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return results
}
