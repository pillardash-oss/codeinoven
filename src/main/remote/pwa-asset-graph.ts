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
 * references and then walking static and dynamic imports inside every JS chunk.
 * Only files in that closure are ever served — the desktop app's own entry
 * (`index.html`, `index-*.js`, unrelated chunks) is never exposed.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const ASSET_REFERENCE =
  /(?:from\s*["']|\bimport\s*\(\s*["']|\.\/assets\/)([^"')\s]+?\.(?:js|mjs|css))["')]?/g

/**
 * Compute the set of `/assets/...` paths the PWA references, transitively.
 *
 * Starts from every asset mentioned in `remote.html`, then follows `from`
 * (static) and `import()` (dynamic) imports inside each JS chunk until the
 * closure is stable. Returns asset paths only (never the HTML shell).
 */
export async function computePwaAssetClosure(staticRoot: string): Promise<Set<string>> {
  const allowed = new Set<string>()
  let html: string
  try {
    html = await readFile(join(staticRoot, 'remote.html'), 'utf8')
  } catch {
    return allowed
  }

  const queue: string[] = []
  for (const match of html.matchAll(/\.\/assets\/([^"')\s]+)/g)) {
    const path = `/assets/${match[1]}`
    if (!allowed.has(path)) {
      allowed.add(path)
      queue.push(path)
    }
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
      const name = match[1]?.replace(/^\.\//, '')
      if (!name) continue
      const path = `/assets/${name}`
      if (!allowed.has(path)) {
        allowed.add(path)
        queue.push(path)
      }
    }
  }

  return allowed
}
