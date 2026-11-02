import type { WebContents } from 'electron'

/**
 * Load one of an extension's own pages into the document that shows it.
 *
 * `loadURL` reports the navigation it started, and an extension page routinely
 * starts its own before that one commits: Bitwarden's popup rewrites its address as
 * it boots, which aborts the navigation the app asked for. Electron rejects the
 * awaited `loadURL` with `ERR_ABORTED` for that, and treating it as "the page did
 * not load" is what closed the popup and threw   a passkey prompt that is never
 * drawn, with the ceremony still waiting on it.
 *
 * So an abort is answered by looking at the document that is actually there. A page
 * on the requested address is a page that loaded, whichever navigation produced it;
 * anything else is a real failure the caller may still act on.
 */
export async function loadExtensionDocument(page: WebContents, url: string): Promise<boolean> {
  try {
    await page.loadURL(url)
    return true
  } catch (error: unknown) {
    if (!isAbortedNavigation(error) || page.isDestroyed()) throw error
    return pageArrivedAt(page.getURL(), url)
  }
}

/** Whether a rejected navigation was superseded rather than refused. */
export function isAbortedNavigation(error: unknown): boolean {
  const code = error instanceof Error ? Reflect.get(error, 'code') : undefined
  if (code === 'ERR_ABORTED') return true
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('ERR_ABORTED')
}

/**
 * Whether a document ended up on the page a load asked for.
 *
 * The path and the origin are what a rewrite keeps: an extension that boots into a
 * route of its own document stays on its own file and only changes what follows it,
 * while a document that never arrived is still showing whatever was there before,
 * which is a different file.
 */
function pageArrivedAt(current: string, requested: string): boolean {
  try {
    const shown = new URL(current)
    const wanted = new URL(requested)
    return (
      shown.protocol === wanted.protocol &&
      shown.host === wanted.host &&
      shown.pathname === wanted.pathname
    )
  } catch {
    return false
  }
}
