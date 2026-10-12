/**
 * The focus an extension's offscreen document needs to be useful.
 *
 * `chrome.offscreen` is real in this runtime, so an extension that cannot reach
 * the clipboard from its worker   a password manager generating a password for
 * the context menu, for example   creates an offscreen document and asks it to do
 * the write. Chromium lets that work: an offscreen document is a page, so the
 * async clipboard API is available to it, and the browser treats it as focused
 * for the APIs that require a focused document.
 *
 * Electron creates the document   `chrome.offscreen.createDocument` is the
 * runtime's own   but never marks it focused. Measured against the shipped
 * runtime: a fresh offscreen document reports `document.hasFocus() === false`,
 * `navigator.clipboard.writeText` rejects with `NotAllowedError: Document is not
 * focused`, and the `document.execCommand('copy')` fallback returns `false`, so
 * the clipboard is left unchanged. Granting the session every clipboard
 * permission changes nothing: the refusal is the focus precondition, not a
 * permission.
 *
 * Focusing the document's `WebContents` restores what Chromium does. Measured:
 * after the focus, `document.hasFocus()` is true, `writeText` resolves, and the
 * real pasteboard holds the value, while the window the user is working in keeps
 * the keyboard   the offscreen document is not shown, so it takes no OS focus.
 * The state holds for the document's life and survives the user returning to the
 * window, so one focus at load is enough.
 *
 * The document is identified by the pair this runtime gives it: a browser-created
 * `WebContents` (`getType() === 'remote'`) whose document is an extension page.
 * Every page the app hosts itself   a popup, a side panel, a tab   is a
 * `WebContentsView`, measured as type `window`, so nothing the user is looking at
 * is ever refocused.
 */

import { app, type WebContents } from 'electron'

/** The origin every extension page, and so every offscreen document, is served from. */
const EXTENSION_ORIGIN = 'chrome-extension://'

/**
 * Whether a `WebContents` is an extension offscreen document.
 *
 * The runtime gives an offscreen document the `remote` type, and every
 * `WebContents` the app builds is a `WebContentsView` (type `window`) or the
 * application window itself. The URL check is what confirms it is an extension's
 * own document rather than some other browser-created contents.
 */
function isExtensionOffscreenDocument(contents: WebContents): boolean {
  return contents.getType() === 'remote' && contents.getURL().startsWith(EXTENSION_ORIGIN)
}

/**
 * Focus every extension offscreen document this runtime creates.
 *
 * A document is watched from the moment its `WebContents` is created, and focused
 * on each load, because a document that reloads loses the focus the previous load
 * was given.
 */
export class BrowserExtensionOffscreenDocuments {
  private readonly watched = new Set<number>()

  private readonly onContentsCreated = (_event: Electron.Event, contents: WebContents): void => {
    this.watch(contents)
  }

  constructor() {
    app.on('web-contents-created', this.onContentsCreated)
  }

  dispose(): void {
    app.removeListener('web-contents-created', this.onContentsCreated)
    this.watched.clear()
  }

  private watch(contents: WebContents): void {
    // The runtime gives an offscreen document its `remote` type at creation, and
    // no other contents in this app is one, so only those are watched. The URL is
    // not known until the document navigates, so the focus is decided per load.
    if (contents.getType() !== 'remote') return
    if (this.watched.has(contents.id)) return
    this.watched.add(contents.id)
    const focus = (): void => this.focus(contents)
    contents.on('dom-ready', focus)
    contents.on('did-finish-load', focus)
    contents.once('destroyed', () => this.watched.delete(contents.id))
  }

  private focus(contents: WebContents): void {
    if (contents.isDestroyed()) return
    if (!isExtensionOffscreenDocument(contents)) return
    contents.focus()
  }
}
