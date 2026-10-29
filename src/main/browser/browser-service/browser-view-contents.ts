import type { BrowserWindow, WebContents, WebContentsView } from 'electron'

/**
 * The live page behind a native view, or `undefined` once its page is gone.
 *
 * `WebContentsView.webContents` only holds a page while that page is alive. A
 * page that destroys itself (a script calling `window.close()`, a tab adopted
 * from another page, a renderer that exited) leaves the view carrying nothing,
 * and Electron's own type does not admit it, so `view.webContents.isDestroyed()`
 * throws `Cannot read properties of undefined` instead of answering.
 *
 * Every read of a tab's page goes through this, for two reasons. A handler that
 * throws inside a `destroyed` event aborts the close of the record that holds the
 * view, which leaves the tab named in the service with nothing behind it; and one
 * such record used to poison every attach that followed, because a show parks the
 * outgoing tab before it attaches the next one. Answering "nothing to act on" is
 * what keeps a dead page a local, recoverable fact.
 */
export function liveContents(view: WebContentsView | null | undefined): WebContents | undefined {
  if (!view) return undefined
  const contents: WebContents | undefined = view.webContents
  if (!contents || contents.isDestroyed()) return undefined
  return contents
}

/**
 * The app window's own page, or null once that window is gone.
 *
 * A destroyed `BrowserWindow` throws on `.webContents` itself, so even asking
 * whether the page is alive has to be guarded: a browser unit reaching for the
 * window it was built around after the user closed that window used to raise
 * `Object has been destroyed` inside an event handler, which aborts the rest of
 * the handler and surfaces as an uncaught exception in the app's logs.
 */
export function liveWindowContents(
  window: BrowserWindow | null | undefined
): WebContents | undefined {
  if (!window) return undefined
  try {
    if (window.isDestroyed()) return undefined
    const contents: WebContents | undefined = window.webContents
    if (!contents || contents.isDestroyed()) return undefined
    return contents
  } catch {
    return undefined
  }
}
