import { app, nativeTheme, type WebContents } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The three things every one of the app's own child windows needs to be built
 * the same way.
 *
 * The browser permission prompt and the toast overlay are both first-party
 * documents the app opens over a browser page: they share the app's preload,
 * they are resolved from the same renderer output in dev and in a packaged
 * build, and they are opened with the same theme hint. Keeping that here means a
 * change to any of the three cannot land in one window and miss the other.
 */

/** Resolve the app preload bundle the child documents run with.
 *
 *  `import.meta.url` is the compiled main bundle file (which lives in
 *  `out/main`), so take its directory first; the preload is one level up in
 *  `out/preload`. Passing the full file path to `join` instead silently resolved
 *  outside the bundle tree and the popup loaded with no preload. */
export function resolveChildWindowPreload(): string {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../preload')
  for (const name of ['index.mjs', 'index.js', 'index.cjs']) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return join(dir, 'index.js')
}

/** First-paint theme hint for a child window; the document refines it from the
 *  live app state as soon as it is running. */
export function resolveAppTheme(): 'light' | 'dark' {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/**
 * Load one of the app's own renderer documents into `target`.
 *
 * Dev serves it from the Vite dev server so the document picks up HMR and the
 * same module graph as the app window; a packaged build reads it from the
 * renderer output beside the main bundle.
 */
export function loadRendererDocument(
  target: Pick<WebContents, 'loadURL' | 'loadFile'>,
  document: string,
  query: Record<string, string> = {}
): Promise<void> {
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    const url = new URL(document, `${process.env['ELECTRON_RENDERER_URL']}/`)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    return target.loadURL(url.href).catch(() => {})
  }
  const path = join(dirname(fileURLToPath(import.meta.url)), '../renderer', document)
  return target.loadFile(path, { query }).catch(() => {})
}
