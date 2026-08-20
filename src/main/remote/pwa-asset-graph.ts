/**
 * PWA asset graph for the LAN gateway.
 *
 * The phone client is a Vite code-split bundle: `remote.html` references an
 * entry chunk plus shared `app-*`/`chunk-*` modules and stylesheets that are
 * only known after a build. A naive allow-list prefix (e.g. `/assets/remote-`)
 * breaks the PWA because Vite hoists shared code into hashed chunks with
 * unrelated names.
 *
 * Instead, the gateway computes the **exact set of asset files the PWA needs**
 * at startup by parsing `remote.html` for its script/modulepreload/stylesheet
 * references and then walking the dependency arrays Vite embeds inside every JS
 * chunk (static `from` imports, dynamic `import()`, and preload dep lists).
 * Only files in that closure are ever served — the desktop app's own entry
 * (`index.html`, `index-*.js`, unrelated chunks) is never exposed.
 *
 * The same graph also classifies the closure for HTTP caching:
 *
 * - **Hashed build outputs** (every file reached from `remote.html` and its
 *   chunks) have content-derived names, so they are safe to serve with
 *   `Cache-Control: public, max-age=31536000, immutable`.
 * - **Public runtime assets** (agent icon SVGs loaded through
 *   `publicAssetUrl`) keep stable, unhashed names and are therefore mutable —
 *   they must never be cached as immutable.
 *
 * It additionally exposes the **disconnected-shell precache manifest** (the
 * initial assets `remote.html` references directly, plus the shell files) that
 * the service worker precaches, and **bundle-budget metadata** for the initial
 * remote JavaScript closure (raw + gzip) used by `scripts/check-bundle-budgets.ts`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

/**
 * Match a relative asset reference inside a chunk. Vite emits several shapes:
 * `from "./x.js"`, `import("./x.js")`, and dependency arrays like
 * `["./x.js","./x.css"]`. The `./` prefix disambiguates real asset references
 * from incidental strings such as `".css"` or `".js"`.
 */
const ASSET_REFERENCE = /\.\/([A-Za-z0-9._-]+\.(?:js|mjs|css))/g

/**
 * Match only **static** import references inside a chunk — `from "./x.js"` and
 * bare side-effect `import "./x.js"`. Dynamic `import("./x.js")` and the
 * modulepreload dependency arrays Vite emits for lazy chunks (`["./x.js"]`) are
 * deliberately excluded because they load on interaction, not on first paint.
 * The `from`/`import` keyword disambiguates a real eager edge from incidental
 * strings inside the dep-array or a dynamic import.
 */
const STATIC_IMPORT_REFERENCE = /(?:from|import)\s*["']\.\/([A-Za-z0-9._-]+\.(?:js|mjs))["']/g

/**
 * Runtime-resolved public assets the shared renderer components fetch directly
 * (never via a static import), so they are invisible to the chunk-walk above.
 * The agent icon SVGs are loaded by `AgentIcon` from `publicAssetUrl`; the
 * phone reuses those components (ThreadView, ThreadRow), so the gateway must
 * serve them too. The set is a fixed public directory — no desktop assets leak.
 */
async function collectPublicAssetDir(staticRoot: string, relativeDir: string): Promise<string[]> {
  const dir = join(staticRoot, relativeDir)
  if (!existsSync(dir)) return []
  const entries = await readdir(dir, { withFileTypes: true })
  const paths: string[] = []
  for (const entry of entries) {
    // Skip macOS/editor metadata (`.DS_Store`, hidden files) — never served.
    if (entry.name.startsWith('.')) continue
    const relative = `${relativeDir}/${entry.name}`
    if (entry.isDirectory()) {
      paths.push(...(await collectPublicAssetDir(staticRoot, relative)))
    } else if (entry.isFile()) {
      paths.push(`/assets/${relative.replace(/^assets\//, '')}`)
    }
  }
  return paths
}

/**
 * Collect the assets `remote.html` references directly. These form the
 * disconnected shell: the entry chunk, its modulepreload deps, and stylesheets
 * are what a phone needs to paint the pairing screen before any code-split
 * feature loads. Files that do not exist on disk are skipped.
 */
async function collectInitialAssetRefs(staticRoot: string): Promise<string[]> {
  const assetsDir = join(staticRoot, 'assets')
  let html: string
  try {
    html = await readFile(join(staticRoot, 'remote.html'), 'utf8')
  } catch {
    return []
  }
  const refs: string[] = []
  for (const match of html.matchAll(/\.\/assets\/([^"')\s]+)/g)) {
    const name = match[1]
    const path = `/assets/${name}`
    if (!refs.includes(path) && existsSync(join(assetsDir, name))) refs.push(path)
  }
  return refs.sort()
}

/** Per-chunk raw + gzip byte sizes of the initial remote JavaScript closure. */
export interface PwaBudgetChunk {
  url: string
  rawBytes: number
  gzipBytes: number
}

/** Aggregate bundle-budget metadata for the initial remote JavaScript. */
export interface PwaBundleBudget {
  initialJsRawBytes: number
  initialJsGzipBytes: number
  maxInitialChunkGzipBytes: number
  chunks: PwaBudgetChunk[]
}

/** The full cache-classified view of the PWA asset graph. */
export interface PwaAssetGraph {
  /** Full transitive closure — the serving allow-list. */
  closure: ReadonlySet<string>
  /** Hashed build outputs — safe to cache immutable. */
  immutable: ReadonlySet<string>
  /** Public, unhashed runtime assets — never cached as immutable. */
  mutable: ReadonlySet<string>
  /** Disconnected-shell precache manifest (absolute paths). */
  precache: string[]
  /** Bundle-budget metadata for the initial remote JS closure. */
  budget: PwaBundleBudget
}

/**
 * Compute the set of `/assets/...` paths the PWA references, transitively.
 *
 * Starts from every asset mentioned in `remote.html`, then follows the
 * dependency references inside each JS chunk until the closure is stable.
 * Only files that actually exist under `assets/` are kept — a root-level file
 * such as `service-worker.js` referenced by the PWA entry is served via the
 * static allow-list, never the asset closure.
 * Returns asset paths only (never the HTML shell).
 */
export async function computePwaAssetClosure(staticRoot: string): Promise<Set<string>> {
  const allowed = new Set<string>()
  const assetsDir = join(staticRoot, 'assets')
  let html: string
  try {
    html = await readFile(join(staticRoot, 'remote.html'), 'utf8')
  } catch {
    return allowed
  }

  const queue: string[] = []
  for (const match of html.matchAll(/\.\/assets\/([^"')\s]+)/g)) {
    const name = match[1]
    const path = `/assets/${name}`
    if (!allowed.has(path) && existsSync(join(assetsDir, name))) {
      allowed.add(path)
      queue.push(path)
    }
  }

  // Public agent icons the shared components load at runtime.
  for (const path of await collectPublicAssetDir(staticRoot, 'assets/agents')) {
    if (!allowed.has(path)) allowed.add(path)
  }

  while (queue.length > 0) {
    const asset = queue.shift() as string
    if (!asset.endsWith('.js') && !asset.endsWith('.mjs')) continue
    let content: string
    try {
      content = await readFile(join(staticRoot, asset.slice(1)), 'utf8')
    } catch {
      continue
    }
    for (const match of content.matchAll(ASSET_REFERENCE)) {
      const name = match[1]
      if (!name) continue
      const path = `/assets/${name}`
      if (!allowed.has(path) && existsSync(join(assetsDir, name))) {
        allowed.add(path)
        queue.push(path)
      }
    }
  }

  return allowed
}

/** Root-level shell files the disconnected PWA needs to render and install. */
const ROOT_SHELL_FILES = [
  '/remote.html',
  '/manifest.webmanifest',
  '/apple-touch-icon.png',
  '/icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/notification-badge.png',
  '/logo.png',
  '/favicon.ico'
]

/** gzip budget for the whole eagerly-loaded initial remote JS closure. */
export const INITIAL_JS_GZIP_BUDGET_BYTES = 500 * 1024
/** gzip budget for any single eagerly-loaded initial JS chunk. */
export const MAX_CHUNK_GZIP_BUDGET_BYTES = 350 * 1024

/**
 * Compute the eagerly-loaded initial JavaScript closure: the entry and
 * modulepreload chunks referenced directly by `remote.html` plus every chunk
 * they import **statically** (`from "./x.js"`). Lazy dynamic imports and their
 * modulepreload dep arrays are excluded — they load on interaction, not first
 * paint — so the closure is exactly what a phone parses to show the first
 * screen. Returns a sorted, deduplicated list of `/assets/...` JS paths.
 */
async function collectEagerJsClosure(staticRoot: string, initialRefs: string[]): Promise<string[]> {
  const assetsDir = join(staticRoot, 'assets')
  const eager = new Set<string>()
  const queue: string[] = []
  for (const ref of initialRefs) {
    if ((ref.endsWith('.js') || ref.endsWith('.mjs')) && !eager.has(ref)) {
      eager.add(ref)
      queue.push(ref)
    }
  }
  while (queue.length > 0) {
    const asset = queue.shift() as string
    let content: string
    try {
      content = await readFile(join(staticRoot, asset.slice(1)), 'utf8')
    } catch {
      continue
    }
    for (const match of content.matchAll(STATIC_IMPORT_REFERENCE)) {
      const name = match[1]
      if (!name) continue
      const path = `/assets/${name}`
      if (!eager.has(path) && existsSync(join(assetsDir, name))) {
        eager.add(path)
        queue.push(path)
      }
    }
  }
  return [...eager].sort()
}

/**
 * Compute the full cache-classified asset graph, precache manifest, and bundle
 * budget. `precache` covers the disconnected shell — root files plus every
 * eagerly-loaded JS/CSS the initial paint needs — while lazy feature chunks
 * (the connected client) are excluded so a rebuild never pins stale hashes.
 * The bundle budget is measured over the same eager closure.
 */
export async function computePwaAssetGraph(staticRoot: string): Promise<PwaAssetGraph> {
  const closure = await computePwaAssetClosure(staticRoot)
  const publicAssets = new Set(await collectPublicAssetDir(staticRoot, 'assets/agents'))

  const immutable = new Set<string>()
  const mutable = new Set<string>()
  for (const path of closure) {
    if (publicAssets.has(path)) mutable.add(path)
    else immutable.add(path)
  }

  const initial = await collectInitialAssetRefs(staticRoot)
  const eagerJs = await collectEagerJsClosure(staticRoot, initial)
  const precacheAssets = [...new Set([...initial, ...eagerJs])].sort()
  const precache = [...ROOT_SHELL_FILES, ...precacheAssets]

  const budget = computeInitialJsBudget(staticRoot, eagerJs)

  return { closure, immutable, mutable, precache, budget }
}

/** Raw + gzip sizes of the initial remote JavaScript closure. */
function computeInitialJsBudget(staticRoot: string, initialRefs: string[]): PwaBundleBudget {
  const chunks: PwaBudgetChunk[] = []
  for (const url of initialRefs) {
    if (!url.endsWith('.js') && !url.endsWith('.mjs')) continue
    let raw: Buffer
    try {
      raw = readFileSync(join(staticRoot, url.slice(1)))
    } catch {
      continue
    }
    chunks.push({ url, rawBytes: raw.byteLength, gzipBytes: gzipSync(raw).byteLength })
  }
  const initialJsRawBytes = chunks.reduce((sum, chunk) => sum + chunk.rawBytes, 0)
  const initialJsGzipBytes = chunks.reduce((sum, chunk) => sum + chunk.gzipBytes, 0)
  const maxInitialChunkGzipBytes = chunks.reduce((max, chunk) => Math.max(max, chunk.gzipBytes), 0)
  return { initialJsRawBytes, initialJsGzipBytes, maxInitialChunkGzipBytes, chunks }
}
