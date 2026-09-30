/**
 * Popup windows a page opened, hosted by the app instead of by the system.
 *
 * A page's `window.open(url, name, features)` is a popup window, not a tab, and
 * the app hosts it in a `WebContentsView` the browser rail can show: one tab per
 * popup, so a sign-in or a checkout happens in a panel of the browser the user is
 * already in rather than in an operating-system window that can hide behind the
 * app, get lost, or land on the wrong screen.
 *
 * The hosting mechanism is Electron's own `createWindow` hook
 * (`setWindowOpenHandler` -> `{ action: 'allow', createWindow }`). The hook is
 * handed the `WebContents` Chromium created for the popup, which is not attached
 * to a window yet, so the app can present it in a view of its own. That is what
 * keeps the popup a real popup, and it is why the native window is never created
 * at all: adopting the `WebContents` of a popup Electron created as a *window* is
 * refused outright (`options.webContents is already attached to a window`).
 *
 * Because it is a real popup, it keeps working and it closes itself:
 *
 *   - `window.opener` and `window.opener.postMessage` reach the page that opened
 *     it, which is how a sign-in hands its result back;
 *   - the popup inherits the opener's session, so the cookies the sign-in just
 *     set are the ones the page around it already has;
 *   - `window.close()` (what every completed OAuth and checkout flow calls)
 *     destroys the popup's own `WebContents`, which lands here as `destroyed`
 *     and takes the popup out of the rail with no app code asking for it;
 *   - the opener closing destroys what it opened, so a closed browser tab never
 *     leaves an orphaned sign-in behind.
 *
 * This class owns the list and the lifetime: which popups exist, which one is on
 * screen, where an offscreen one is laid out, and when one is gone. It never
 * touches the window, the stage or the page's own behaviour: the service supplies
 * those through `BrowserPopupWindowHost`, so all view plumbing stays in one place.
 */

import { WebContentsView, type WebContents } from 'electron'
import type { BrowserPopupWindow, BrowserViewBounds } from '../../../lib/ipc-contract'
import { Logger } from '../../system/logger'
import { applyBrowserPageBackground } from './browser-page-background'
import type { BrowserPageOwner, BrowserViewport } from './browser-types'

/** One live popup window: its page, its view, and what the rail needs to show it. */
export interface BrowserPopupWindowRecord {
  id: string
  /** The tab whose page opened it. */
  tabId: string
  projectId: string
  threadId: string
  /** The box the owning tab lives in. A popup keeps its opener's jar, so this is
   *  carried rather than re-derived from the context. */
  boxId: string | null
  /**
   * The extension whose own popup this is, or null when a page opened it with
   * `window.open`.
   *
   * An extension's popup is hosted by the rail rather than by a window it opened,
   * so its page belongs to that extension's own origin, and the only navigation it
   * may make outside its own files is the one every page may make.
   */
  extensionId: string | null
  view: WebContentsView
  url: string
  title: string
  favicon: string | null
  loading: boolean
  /**
   * The frame the rail last displayed this popup's page at, which is also the
   * size the page is laid out at while it is off screen. Null until the rail has
   * shown it, which is what makes the first show the one that may take the
   * keyboard.
   */
  displayedBounds: BrowserViewBounds | null
  /** The size the page asked for when it opened, used while it has never been
   *  displayed and so has no frame of its own yet. */
  requestedViewport: BrowserViewport
}

/** Everything the registry needs from the service that owns the window. */
export interface BrowserPopupWindowHost {
  /** Mount a popup's page in the app window at a frame. */
  mount(view: WebContentsView, bounds: BrowserViewBounds): void
  /**
   * Take a popup's page off the app window and lay it out offscreen, where it
   * keeps running. Used for every popup the rail is not showing right now.
   */
  unmount(view: WebContentsView, viewport: BrowserViewport): void
  /** Drop a popup's view for good, after its page is gone. */
  discard(view: WebContentsView): void
  /**
   * Give a popup's page its own browser behaviour: the keyboard chords it
   * claims, its right-click menu, and where a window it opens lands.
   */
  wire(record: BrowserPopupWindowRecord): void
  /** The list changed, so the rail's copy of it is stale. */
  changed(): void
}

function isUsableViewport(viewport: BrowserViewport | null): viewport is BrowserViewport {
  if (!viewport) return false
  return (
    Number.isFinite(viewport.width) &&
    Number.isFinite(viewport.height) &&
    viewport.width > 0 &&
    viewport.height > 0
  )
}

/**
 * A popup's live page, or undefined once that page is gone.
 *
 * A page that closes itself   which is how every completed sign-in and checkout
 * ends   destroys its own `WebContents`, and the view stops carrying one at all:
 * `view.webContents` becomes undefined rather than an object reporting itself
 * destroyed. So the page is read through here every time it is used, and a
 * missing one means the popup is nothing but a record on its way out.
 */
function pageOf(record: BrowserPopupWindowRecord): WebContents | undefined {
  return record.view.webContents
}

export class BrowserPopupWindows {
  private readonly popups = new Map<string, BrowserPopupWindowRecord>()
  /**
   * The popup whose page is on screen. At most one is displayed at a time,
   * because the rail shows one popup at a time, and the app's window composites
   * every native view above the DOM, so a second displayed popup would simply
   * cover the first.
   */
  private displayedId: string | null = null
  /**
   * True while a DOM toast holds native views off screen. A toast is DOM, and a
   * native view floats above all DOM, so the displayed popup steps aside for it
   * and comes back at the same frame (see `setSuspended`).
   */
  private suspended = false

  constructor(private readonly viewHost: BrowserPopupWindowHost) {}

  /**
   * Take ownership of one popup window's page.
   *
   * Called from inside Electron's `createWindow` hook with the `WebContents`
   * Chromium created for the popup, and answers the same object, because the hook
   * requires that exact one back: returning anything else makes Electron report
   * the popup as unconnected. The newly hosted popup is laid out offscreen
   * immediately, so a popup that opens while the rail is closed still has a real
   * viewport and a page that is genuinely running.
   */
  host(
    contents: WebContents,
    context: { owner: BrowserPageOwner; url: string; viewport: BrowserViewport | null }
  ): WebContents {
    const record: BrowserPopupWindowRecord = {
      id: `popup:${crypto.randomUUID()}`,
      tabId: context.owner.tabId,
      projectId: context.owner.projectId,
      threadId: context.owner.threadId,
      boxId: context.owner.boxId,
      extensionId: null,
      view: this.viewFor(contents),
      url: context.url,
      title: contents.getTitle(),
      favicon: null,
      loading: true,
      displayedBounds: null,
      requestedViewport: isUsableViewport(context.viewport)
        ? context.viewport
        : { width: 480, height: 720 }
    }
    this.popups.set(record.id, record)
    this.track(record)
    this.viewHost.wire(record)
    this.viewHost.unmount(record.view, record.requestedViewport)
    Logger.dev('Browser popup window opened', {
      popupId: record.id,
      tabId: record.tabId,
      url: record.url
    })
    this.viewHost.changed()
    return contents
  }

  /**
   * Host an extension's own action popup, which no page opened.
   *
   * A `window.open` popup arrives as a `WebContents` Chromium created for it; an
   * extension's popup has no such thing to adopt, because Electron draws no
   * toolbar and no action popup for one to come from. So the caller creates the
   * view bound to the jar the extension runs in and this takes it on the same
   * terms as any other popup: parked offscreen until the rail places it, tracked
   * while it runs, and out of the list when its page ends.
   */
  hostExtension(context: {
    owner: BrowserPageOwner
    extensionId: string
    url: string
    view: WebContentsView
    viewport: BrowserViewport | null
  }): string {
    const record: BrowserPopupWindowRecord = {
      id: `popup:${crypto.randomUUID()}`,
      tabId: context.owner.tabId,
      projectId: context.owner.projectId,
      threadId: context.owner.threadId,
      boxId: context.owner.boxId,
      extensionId: context.extensionId,
      view: context.view,
      url: context.url,
      title: '',
      favicon: null,
      loading: true,
      displayedBounds: null,
      requestedViewport: isUsableViewport(context.viewport)
        ? context.viewport
        : { width: 480, height: 720 }
    }
    // The extension's own document, so it gets its own surface the same way a
    // page does, and its title and favicon arrive through the usual tracking.
    applyBrowserPageBackground(record.view)
    this.popups.set(record.id, record)
    this.track(record)
    this.viewHost.wire(record)
    this.viewHost.unmount(record.view, record.requestedViewport)
    Logger.dev('Browser extension popup opened', {
      popupId: record.id,
      tabId: record.tabId,
      extensionId: context.extensionId
    })
    this.viewHost.changed()
    return record.id
  }

  /** Every live popup window, newest last, optionally for one project. */
  list(projectId?: string): BrowserPopupWindow[] {
    const popups: BrowserPopupWindow[] = []
    for (const record of this.popups.values()) {
      if (projectId !== undefined && record.projectId !== projectId) continue
      popups.push({
        id: record.id,
        tabId: record.tabId,
        projectId: record.projectId,
        url: record.url,
        title: record.title,
        favicon: record.favicon,
        loading: record.loading,
        extensionId: record.extensionId
      })
    }
    return popups
  }

  /** How many popup windows one tab is holding open, for the cap on new ones. */
  countForTab(tabId: string): number {
    let count = 0
    for (const record of this.popups.values()) if (record.tabId === tabId) count += 1
    return count
  }

  /**
   * The tab that owns the page a `WebContents` belongs to, for the reports that
   * arrive with a contents and need a tab: a permission the page asks for, a file
   * it downloads.
   */
  tabIdForContents(contentsId: number): string | undefined {
    for (const record of this.popups.values()) {
      const page = pageOf(record)
      if (page && page.id === contentsId) return record.tabId
    }
    return undefined
  }

  has(id: string): boolean {
    return this.popups.has(id)
  }

  /**
   * The popup one extension already has open in one tab, if it has one.
   *
   * Opening the same extension again is the user coming back to its popup, not
   * asking for a second copy of it, so the caller places this one instead.
   */
  extensionPopupFor(extensionId: string, tabId: string): string | null {
    for (const record of this.popups.values()) {
      if (record.extensionId === extensionId && record.tabId === tabId) return record.id
    }
    return null
  }

  /**
   * Put a popup's page on screen at the frame the rail measured for it. Any other
   * displayed popup steps aside, so the panel's frame is never covered by a popup
   * that is no longer selected.
   */
  show(id: string, bounds: BrowserViewBounds): void {
    const record = this.popups.get(id)
    if (!record || !pageOf(record)) return
    const firstShow = record.displayedBounds === null
    if (this.displayedId !== null && this.displayedId !== id) this.hide(this.displayedId)
    record.displayedBounds = bounds
    this.displayedId = id
    if (this.suspended) return
    this.viewHost.mount(record.view, bounds)
    // The first show is the popup arriving, and a popup the user cannot type in
    // is not a popup: Chromium gives a real popup the keyboard when it opens, so
    // the app does the same here. A later show is the rail coming back to a popup
    // the user was already looking at, which must not steal the keyboard from
    // whatever they moved on to.
    const page = pageOf(record)
    if (firstShow && page && !page.isDestroyed()) page.focus()
  }

  /** Take a popup's page off the app window, keeping it running offscreen. */
  hide(id: string): void {
    const record = this.popups.get(id)
    if (!record) return
    if (this.displayedId === id) this.displayedId = null
    // A page that is already gone has nothing to take off screen; its record is
    // dropped by the report that destroyed it.
    if (!pageOf(record)) return
    this.viewHost.unmount(record.view, this.viewportFor(record))
  }

  /** Give a popup's page the keyboard, for the popup the user just picked. */
  focus(id: string): void {
    const record = this.popups.get(id)
    const page = record ? pageOf(record) : undefined
    if (!page || page.isDestroyed()) return
    page.focus()
  }

  /**
   * Close a popup on the user's behalf, or forget one its page already closed.
   *
   * Closing the `WebContents` is what ends the page; the popup then takes itself
   * out through `destroyed`, so this needs no separate cleanup path.
   */
  close(id: string, reason: string): void {
    const record = this.popups.get(id)
    if (!record) return
    Logger.dev('Browser popup window closed', { popupId: id, reason })
    const page = pageOf(record)
    if (page && !page.isDestroyed()) page.close()
    this.forget(id)
  }

  /** Close every popup one tab opened, for a tab that is going away. */
  closeForTab(tabId: string, reason: string): void {
    for (const record of [...this.popups.values()]) {
      if (record.tabId === tabId) this.close(record.id, reason)
    }
  }

  /**
   * Close every popup a condition names, for the world changing under one.
   *
   * An extension popup's page belongs to an extension that can be uninstalled or
   * taken out of a box while the popup is on screen, and a page whose extension is
   * gone has nothing left to talk to.
   */
  closeWhere(matches: (record: BrowserPopupWindowRecord) => boolean, reason: string): void {
    for (const record of [...this.popups.values()]) {
      if (matches(record)) this.close(record.id, reason)
    }
  }

  /** Close every popup the browser holds, for a teardown that outranks them. */
  closeAll(reason: string): void {
    for (const id of [...this.popups.keys()]) this.close(id, reason)
  }

  /**
   * Hold every displayed popup off screen while a DOM toast is on screen, and put
   * the one that was up back afterwards at the frame it was at. The page is never
   * resized by this: the toast is momentary, and a popup that reflowed for it
   * would come back looking different from the one the user was reading.
   */
  setSuspended(suspended: boolean): void {
    if (this.suspended === suspended) return
    this.suspended = suspended
    const displayed = this.displayedId === null ? null : this.popups.get(this.displayedId)
    if (!displayed || !pageOf(displayed)) return
    if (suspended) this.viewHost.unmount(displayed.view, this.viewportFor(displayed))
    else if (displayed.displayedBounds)
      this.viewHost.mount(displayed.view, displayed.displayedBounds)
  }

  private viewFor(contents: WebContents): WebContentsView {
    // The popup's own `WebContents`, presented by the app. Its preferences are
    // Chromium's: a popup opened by `window.open` inherits the opener's
    // `webPreferences` (sandbox, context isolation, no node integration) and the
    // opener's session, so the app neither re-declares nor weakens them.
    const view = new WebContentsView({ webContents: contents })
    // A popup starts at `about:blank` legitimately, so it begins with no surface
    // of its own and is given one when a document of its own commits.
    applyBrowserPageBackground(view)
    return view
  }

  /** Follow one popup's page: what it is showing, and when it ends. */
  private track(record: BrowserPopupWindowRecord): void {
    const contents = record.view.webContents
    const refresh = (): void => {
      if (contents.isDestroyed()) return
      record.url = contents.getURL()
      record.title = contents.getTitle()
      record.loading = contents.isLoading()
      this.viewHost.changed()
    }
    contents.on('did-start-loading', () => {
      record.loading = true
      this.viewHost.changed()
    })
    contents.on('did-stop-loading', refresh)
    contents.on('did-navigate', refresh)
    contents.on('did-navigate', () => applyBrowserPageBackground(record.view))
    contents.on('did-navigate-in-page', refresh)
    contents.on('page-title-updated', refresh)
    contents.on('page-favicon-updated', (_event, favicons) => {
      record.favicon = favicons[0] ?? null
      this.viewHost.changed()
    })
    // A page that closed itself   every completed sign-in and checkout does   is
    // reported here and nowhere else: there is no window to hear it from. A popup
    // the app closed itself is already gone from the list and needs no report.
    contents.on('destroyed', () => {
      if (!this.popups.has(record.id)) return
      Logger.dev('Browser popup window closed itself', { popupId: record.id })
      this.forget(record.id)
    })
  }

  /** Drop a popup whose page is already gone, and tell the rail. */
  private forget(id: string): void {
    const record = this.popups.get(id)
    if (!record) return
    this.popups.delete(id)
    if (this.displayedId === id) this.displayedId = null
    this.viewHost.discard(record.view)
    this.viewHost.changed()
  }

  /**
   * The size a popup's page is laid out at while off screen: the frame the rail
   * last displayed it at when there is one, so bringing it back never reflows the
   * page the user was reading, and the size it asked for when there is not.
   */
  private viewportFor(record: BrowserPopupWindowRecord): BrowserViewport {
    const bounds = record.displayedBounds
    if (!bounds) return record.requestedViewport
    return { width: bounds.width, height: bounds.height }
  }
}
