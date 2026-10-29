import { screen, type WebContents } from 'electron'
import type { BrowserViewBounds } from '../../../lib/ipc-contract'
import { sendToRenderer } from '../../ipc/renderer-delivery'
import { Logger } from '../../system/logger'
import { type BrowserPageOwner } from './browser-types'
import {
  parsePeekProbeAnswer,
  peekProbePoint,
  peekProbeScript,
  PEEK_ORIGIN_PROBE_TIMEOUT_MS,
  resolvePeekOrigin,
  type BrowserPeekMediaTarget,
  type BrowserPeekPoint,
  type BrowserPeekRect
} from './browser-peek'
import type { BrowserService } from '../browser-service'
import { liveWindowContents } from './browser-view-contents'

/**
 * Tabs opened from inside a page: links, siblings and peeks.
 *
 * A new tab is created for the same box as the page that asked for it, which is what
 * keeps a link opened from a page in the same jar. A peek is the hover preview the same
 * path builds, and it measures the page before the surface can draw it.
 */

/**
 * What `browser-service-new-tabs` reads off the browser service.
 *
 * Each member is the service's own declaration, so this unit and the composition
 * root cannot drift apart: a changed signature is a compile error here.
 */
export interface NewTabsHost {
  readonly childTabOpeners: BrowserService['childTabOpeners']
  readonly destroy: BrowserService['destroy']
  readonly ensureTab: BrowserService['ensureTab']
  readonly load: BrowserService['load']
  readonly parkTab: BrowserService['parkTab']
  readonly peekTabs: BrowserService['peekTabs']
  readonly requestPanelShortcut: BrowserService['requestPanelShortcut']
  readonly window: BrowserService['window']
}

export class BrowserServiceNewTabs {
  constructor(private readonly host: NewTabsHost) {}

  /**
   * Create a tab in the same project and thread as `source`, load it, and ask
   * the renderer to show it.
   *
   * Shared by the links and popups a page opens and by the context-menu actions
   * that open an address in a new tab, so every new tab is parked, loaded and
   * announced the same way.
   */
  openNewTabFor(
    owner: BrowserPageOwner,
    url: string,
    peek = false,
    origin: BrowserViewBounds | null = null,
    childContents?: WebContents
  ): WebContents {
    const sourceTabId = this.host.peekTabs.get(owner.tabId) ?? owner.tabId
    if (peek) {
      for (const [peekId, sourceId] of this.host.peekTabs) {
        if (sourceId === sourceTabId) this.host.destroy(peekId, 'closed')
      }
    }
    const tabId = `browser:${crypto.randomUUID()}`
    if (peek) this.host.peekTabs.set(tabId, sourceTabId)
    // A new sibling inherits the box it was opened from: a popup or a link
    // belongs beside the page that produced it, in the same jar.
    const tab = this.host.ensureTab(
      tabId,
      owner.projectId,
      owner.threadId,
      owner.boxId,
      childContents
    )
    tab.initialNavigationStarted = true
    if (childContents) {
      this.host.childTabOpeners.set(tabId, owner.tabId)
      childContents.once('destroyed', () => {
        // Manual close removes the relationship first. Only script/native close
        // needs to remove the surviving tab-strip entry here.
        if (!this.host.childTabOpeners.has(tabId)) return
        this.host.destroy(tabId, 'closed')
        this.host.requestPanelShortcut(tabId, 'close-tab')
      })
    }
    this.host.parkTab(tabId)
    // Electron navigates adopted children, including their original POST body.
    if (!childContents) this.host.load(tabId, url)
    sendToRenderer(liveWindowContents(this.host.window), 'browser:openRequested', url, {
      projectId: owner.projectId,
      threadId: owner.threadId,
      requestedTabId: tabId,
      sourceTabId,
      peek,
      reveal: true,
      boxId: owner.boxId,
      origin
    })
    return tab.view.webContents
  }

  /**
   * Open an ephemeral peek page, growing out of the thing it was asked for.
   *
   * The probe is what makes the opening flight start on the link, the picture or
   * the player rather than at a corner of the window, and it is bounded: the page
   * is asked once, within `PEEK_ORIGIN_PROBE_TIMEOUT_MS`, and the tab is created
   * afterwards with whatever answer came back. In practice that is a few
   * milliseconds, because the question is a containment test in a frame that is
   * already running; the budget is what a page that is busy, mid-navigation or
   * without a document can cost, and it is spent before the surface exists rather
   * than while it is on screen.
   *
   * `media` names the element a menu already knows the page was clicked on, and is
   * null for a link or for a gesture that names nothing.
   */
  openPeekFrom(
    owner: BrowserPageOwner,
    contents: WebContents,
    url: string,
    frame: BrowserViewBounds | null,
    point: BrowserPeekPoint | null,
    media: BrowserPeekMediaTarget | null = null
  ): void {
    void this.peekOriginFor(contents, frame, point, media).then((origin) => {
      try {
        this.openNewTabFor(owner, url, true, origin)
      } catch (error: unknown) {
        Logger.error('Browser Peek refused a link:', error)
      }
    })
  }

  /** Where the pointer is, in a page view's own pixels. */
  pointerViewPoint(frame: BrowserViewBounds): BrowserPeekPoint {
    const cursor = screen.getCursorScreenPoint()
    const content = this.host.window.getContentBounds()
    return {
      x: Math.round(cursor.x - content.x - frame.x),
      y: Math.round(cursor.y - content.y - frame.y)
    }
  }

  /**
   * The rectangle a peek's flight starts from: the link, picture or player under
   * `point`, or null when there is no point to speak of, because the page is not
   * on screen, the click never landed on it, or the page answered nothing in time.
   *
   * `point` arrives in the page view's own pixels, which is what Electron reports
   * for a right-click and what the pointer is read as, and the answer has to be in
   * the window's, because that is where the renderer's panel and ghost are laid
   * out. The frame is what converts one into the other.
   */
  async peekOriginFor(
    contents: WebContents,
    frame: BrowserViewBounds | null,
    point: BrowserPeekPoint | null,
    media: BrowserPeekMediaTarget | null = null
  ): Promise<BrowserViewBounds | null> {
    if (frame === null || point === null) return null
    const link = await this.probePeekRect(contents, point, media)
    return resolvePeekOrigin({
      link,
      point: { x: frame.x + point.x, y: frame.y + point.y },
      frame,
      zoomFactor: contents.isDestroyed() ? 1 : contents.getZoomFactor()
    })
  }

  /** Ask the page which link or media element is under a point, bounded. */
  async probePeekRect(
    contents: WebContents,
    point: BrowserPeekPoint,
    media: BrowserPeekMediaTarget | null = null
  ): Promise<BrowserPeekRect | null> {
    if (contents.isDestroyed()) return null
    const script = peekProbeScript(peekProbePoint(point, contents.getZoomFactor()), media)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const answer = await Promise.race([
        contents.executeJavaScript(script) as Promise<unknown>,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), PEEK_ORIGIN_PROBE_TIMEOUT_MS)
        })
      ])
      return parsePeekProbeAnswer(answer)
    } catch {
      // A page mid-navigation answers with an error rather than a rectangle.
      return null
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}
