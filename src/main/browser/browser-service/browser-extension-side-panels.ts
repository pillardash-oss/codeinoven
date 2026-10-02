/**
 * Extension side panels, hosted by the app over the browser rail.
 *
 * Electron compiles `chrome.sidePanel` out of the runtime, so an extension that
 * declares a panel has no host of its own. The app supplies one the same way it
 * hosts an extension's action popup: the extension's own document is loaded from
 * its own origin in the jar the extension runs in, and it is presented in a native
 * view over the frame the rail measured for it. This class is metadata about the
 * panels and their lifetime, never their content.
 *
 * The hosting shape mirrors `BrowserPopupWindows`: a panel is parked offscreen
 * until the rail places it, it keeps running there rather than being unloaded, and
 * it leaves the list when its document ends. Everything native a view needs is
 * supplied through `BrowserExtensionSidePanelHost`, so the service is the only
 * place that touches the window, the stage and the session.
 */

import { WebContentsView, type Session, type WebContents } from 'electron'
import type { BrowserExtensionSidePanel, BrowserViewBounds } from '../../../lib/ipc-contract'
import { Logger } from '../../system/logger'
import { applyBrowserPageBackground } from './browser-page-background'
import type { BrowserViewport } from './browser-types'

/** The size a panel is laid out at until the rail has measured a frame for it. */
const DEFAULT_SIDE_PANEL_VIEWPORT: BrowserViewport = { width: 320, height: 720 }

/** One live extension side panel: its document, its view, and what the rail needs. */
export interface BrowserExtensionSidePanelRecord {
  extensionId: string
  extensionName: string
  projectId: string
  /** The jar the extension runs in, which is the only session its document
   *  resolves in and the bridge a closed/open report is pushed through. */
  boxId: string | null
  /** The app browser tab this panel belongs to. */
  appTabId: string
  /** The tab id the extension itself sees: its page's `WebContents` id. */
  extensionTabId: number
  path: string
  url: string
  title: string
  view: WebContentsView
  /** The frame the rail last displayed this panel at, or null until it has. */
  displayedBounds: BrowserViewBounds | null
}

/** Everything the panel registry needs from the service that owns the window. */
export interface BrowserExtensionSidePanelHost {
  /** Mount a panel's document in the app window at a frame. */
  mount(view: WebContentsView, bounds: BrowserViewBounds): void
  /** Take a panel's document off the app window and lay it out offscreen. */
  unmount(view: WebContentsView, viewport: BrowserViewport): void
  /** Drop a panel's view for good, after its document is gone. */
  discard(view: WebContentsView): void
  /** The list changed, so the rail's copy of it is stale. */
  changed(): void
  /**
   * A panel opened or closed, so its extension's worker can be told through its
   * own `chrome.sidePanel.onOpened` / `onClosed`.
   */
  notify(record: BrowserExtensionSidePanelRecord, opened: boolean): void
}

/**
 * A panel's live document, or undefined once it is gone.
 *
 * A page that closes itself destroys its own `WebContents`, and the view stops
 * carrying one at all, so the document is read through here every time it is used.
 */
function pageOf(record: BrowserExtensionSidePanelRecord): WebContents | undefined {
  return record.view.webContents
}

export class BrowserExtensionSidePanels {
  /** One panel per extension: the rail's invokes name a panel by extension id. */
  private readonly panels = new Map<string, BrowserExtensionSidePanelRecord>()

  constructor(private readonly viewHost: BrowserExtensionSidePanelHost) {}

  /** A hidden panel keeps its extension session alive until its page closes. */
  liveJars(): { projectId: string; boxId: string | null }[] {
    const jars: { projectId: string; boxId: string | null }[] = []
    for (const record of this.panels.values()) {
      const page = pageOf(record)
      if (page && !page.isDestroyed()) {
        jars.push({ projectId: record.projectId, boxId: record.boxId })
      }
    }
    return jars
  }

  /**
   * Host one extension's side panel.
   *
   * The caller supplies the jar's session and the extension-relative address,
   * because only the extension service knows which jar the extension runs in. The
   * panel is parked offscreen immediately, so a panel that opens while the rail is
   * closed still has a real viewport and a document that is genuinely running.
   */
  open(input: {
    session: Session
    extensionId: string
    extensionName: string
    projectId: string
    boxId: string | null
    appTabId: string
    extensionTabId: number
    /** Absolute path of the page-tabs preload, or null when it could not be written.
     *  Without it the panel still opens; its `chrome.tabs` answers come from the
     *  push that follows each load instead of arriving before the page's own code. */
    preload: string | null
    path: string
    url: string
  }): void {
    const existing = this.panels.get(input.extensionId)
    if (existing) {
      // Asking again for the panel already showing in this tab is the user coming
      // back to it, not a second copy: the rail already holds and places it.
      if (existing.appTabId === input.appTabId && existing.url === input.url) return
      this.close(input.extensionId, 'its extension opened it on another tab')
    }
    const view = new WebContentsView({
      webPreferences: {
        session: input.session,
        // The wrappers that answer this page's `chrome.tabs.query` have to be in
        // the document before the extension's own bundle reads them, which only a
        // preload manages. See `browser-extension-page-tabs.ts`.
        preload: input.preload ?? undefined,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        devTools: true
      }
    })
    applyBrowserPageBackground(view)
    const record: BrowserExtensionSidePanelRecord = {
      extensionId: input.extensionId,
      extensionName: input.extensionName,
      projectId: input.projectId,
      boxId: input.boxId,
      appTabId: input.appTabId,
      extensionTabId: input.extensionTabId,
      path: input.path,
      url: input.url,
      // The extension's own name stands in until its document sets a title.
      title: input.extensionName,
      view,
      displayedBounds: null
    }
    this.panels.set(record.extensionId, record)
    this.track(record)
    this.viewHost.unmount(record.view, DEFAULT_SIDE_PANEL_VIEWPORT)
    Logger.dev('Browser extension side panel opened', {
      extensionId: record.extensionId,
      appTabId: record.appTabId,
      url: record.url
    })
    this.viewHost.notify(record, true)
    this.viewHost.changed()
    void view.webContents.loadURL(input.url).catch((error: unknown) => {
      // A panel that could not load is not a panel: without this the rail would
      // keep a tab that can never show anything.
      Logger.dev('Browser extension side panel could not be loaded:', {
        extensionId: input.extensionId,
        error
      })
      this.close(input.extensionId, 'its page could not be loaded')
    })
  }

  /** Every live panel, optionally for one project. */
  list(projectId?: string): BrowserExtensionSidePanel[] {
    const panels: BrowserExtensionSidePanel[] = []
    for (const record of this.panels.values()) {
      if (projectId !== undefined && record.projectId !== projectId) continue
      panels.push({
        extensionId: record.extensionId,
        extensionName: record.extensionName,
        appTabId: record.appTabId,
        projectId: record.projectId,
        path: record.path,
        url: record.url,
        title: record.title
      })
    }
    return panels
  }

  /** Put a panel's document on screen at the frame the rail measured for it. */
  show(extensionId: string, bounds: BrowserViewBounds): void {
    const record = this.panels.get(extensionId)
    if (!record || !pageOf(record)) return
    const firstShow = record.displayedBounds === null
    record.displayedBounds = bounds
    this.viewHost.mount(record.view, bounds)
    // The first show is the panel arriving, so it takes the keyboard the way a
    // newly opened panel does. A later show is the rail coming back to a panel
    // the user was already reading, which must not steal the keyboard.
    const page = pageOf(record)
    if (firstShow && page && !page.isDestroyed()) page.focus()
  }

  /** Take a panel's document off the app window, keeping it running offscreen. */
  hide(extensionId: string): void {
    const record = this.panels.get(extensionId)
    if (!record || !pageOf(record)) return
    this.viewHost.unmount(record.view, this.viewportFor(record))
  }

  /** Give a panel's document the keyboard, for the panel the user just picked. */
  focus(extensionId: string): void {
    const record = this.panels.get(extensionId)
    const page = record ? pageOf(record) : undefined
    if (!page || page.isDestroyed()) return
    page.focus()
  }

  /**
   * Close a panel on the user's or the extension's behalf.
   *
   * Closing the `WebContents` is what ends the document; the panel then takes
   * itself out through `destroyed`, so this needs no separate cleanup path.
   */
  close(extensionId: string, reason: string): void {
    const record = this.panels.get(extensionId)
    if (!record) return
    Logger.dev('Browser extension side panel closed', { extensionId, reason })
    const page = pageOf(record)
    if (page && !page.isDestroyed()) page.close()
    this.forget(extensionId)
  }

  /** Close one extension's panel, when it is the one a request named. Null names
   *  any tab, which is what an extension-wide `sidePanel.close()` means. */
  closeForExtension(extensionId: string, extensionTabId: number | null, reason: string): void {
    const record = this.panels.get(extensionId)
    if (!record) return
    if (extensionTabId !== null && record.extensionTabId !== extensionTabId) return
    this.close(extensionId, reason)
  }

  /** Close every panel one app tab holds, for a tab that is going away. */
  closeForTab(tabId: string, reason: string): void {
    for (const record of [...this.panels.values()]) {
      if (record.appTabId === tabId) this.close(record.extensionId, reason)
    }
  }

  /** Close every panel a condition names, for an extension that is gone. */
  closeWhere(matches: (record: BrowserExtensionSidePanelRecord) => boolean, reason: string): void {
    for (const record of [...this.panels.values()]) {
      if (matches(record)) this.close(record.extensionId, reason)
    }
  }

  /**
   * The app tab whose page one panel's own document acts on.
   *
   * A panel is a `WebContents` this app hosts on an extension's behalf, so a
   * document asking "which tab am I acting on" from inside one cannot be answered
   * from focus. This is the registry's own record of that, and it is what the
   * page-tabs preload is answered with.
   */
  tabIdForContents(contentsId: number): string | undefined {
    for (const record of this.panels.values()) {
      const page = pageOf(record)
      if (page && page.id === contentsId) return record.appTabId
    }
    return undefined
  }

  /** Close every panel the browser holds, for a teardown that outranks them. */
  closeAll(reason: string): void {
    for (const extensionId of [...this.panels.keys()]) this.close(extensionId, reason)
  }

  /** Follow one panel's document: its title, and when it ends. */
  private track(record: BrowserExtensionSidePanelRecord): void {
    const contents = record.view.webContents
    contents.on('page-title-updated', (_event, title) => {
      if (contents.isDestroyed()) return
      record.title = title.trim() || record.extensionName
      this.viewHost.changed()
    })
    contents.on('did-navigate', () => applyBrowserPageBackground(record.view))
    contents.on('destroyed', () => {
      if (!this.panels.has(record.extensionId)) return
      Logger.dev('Browser extension side panel closed itself', { extensionId: record.extensionId })
      this.forget(record.extensionId)
    })
  }

  /** Drop a panel whose document is already gone, and tell the rail. */
  private forget(extensionId: string): void {
    const record = this.panels.get(extensionId)
    if (!record) return
    this.panels.delete(extensionId)
    this.viewHost.discard(record.view)
    this.viewHost.notify(record, false)
    this.viewHost.changed()
  }

  /**
   * The size a panel is laid out at while off screen: the frame the rail last
   * displayed it at when there is one, so bringing it back never reflows it, and
   * the default when there is not.
   */
  private viewportFor(record: BrowserExtensionSidePanelRecord): BrowserViewport {
    const bounds = record.displayedBounds
    if (!bounds) return DEFAULT_SIDE_PANEL_VIEWPORT
    return { width: bounds.width, height: bounds.height }
  }
}
