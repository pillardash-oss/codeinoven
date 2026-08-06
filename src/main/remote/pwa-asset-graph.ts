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
 */

import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Match a relative asset reference inside a chunk. Vite emits several shapes:
 * `from "./x.js"`, `import("./x.js")`, and dependency arrays like
 * `["./x.js","./x.css"]`. The `./` prefix disambiguates real asset references
 * from incidental strings such as `".css"` or `".js"`.
 */
const ASSET_REFERENCE = /\.\/([A-Za-z0-9._-]+\.(?:js|mjs|css))/g

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
