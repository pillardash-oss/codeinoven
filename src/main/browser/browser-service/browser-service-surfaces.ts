import { designMotionPageScript } from '../../design/design-motion-page'
import type { AuthoredMotion } from '../../../lib/design/motion-policy'
import { type WebContents } from 'electron'
import { isPreviewOriginUrl } from '../../../lib/local-development-url'
import { fitWithin } from '../../../lib/image-payload'
import { sendToRenderer } from '../../ipc/renderer-delivery'
import { Logger } from '../../system/logger'
import { type BrowserTab } from './browser-types'
import {
  browserContextKey,
  validateBrowserUrl,
  validateProjectId,
  validateThreadId
} from './browser-validation'
import { compositionBoardTabId } from './composition-board-tab'
import { designScreenTabId } from './design-screen-tab'
import { liveContents, liveWindowContents } from './browser-view-contents'
import type { BrowserService } from '../browser-service'

/**
 * The tabs the app's own surfaces open and the readers they use.
 *
 * A design screen, a thread's work preview and a composition board are tabs like any
 * other, but they are opened by the app rather than by a person, so they land here:
 * the call that creates them, the reader that answers where a conversation's page is,
 * the reveal and load waits the surfaces poll, and the playhead a preview keeps
 * across its own reloads.
 */

/**
 * What `browser-service-surfaces` reads off the browser service.
 *
 * Each member is the service's own declaration, so this unit and the composition
 * root cannot drift apart: a changed signature is a compile error here.
 */
export interface SurfacesHost {
  readonly activeTabId: BrowserService['activeTabId']
  readonly agentTabIds: BrowserService['agentTabIds']
  readonly boxOfExistingTab: BrowserService['boxOfExistingTab']
  readonly destroy: BrowserService['destroy']
  readonly ensureTab: BrowserService['ensureTab']
  readonly isRelaxed: BrowserService['isRelaxed']
  readonly load: BrowserService['load']
  readonly loadWaits: BrowserService['loadWaits']
  readonly parkTab: BrowserService['parkTab']
  readonly pendingNavigationStarts: BrowserService['pendingNavigationStarts']
  readonly playheads: BrowserService['playheads']
  readonly rememberReveal: BrowserService['rememberReveal']
  readonly stage: BrowserService['stage']
  readonly tabs: BrowserService['tabs']
  readonly transportState: BrowserService['transportState']
  readonly window: BrowserService['window']
}

export class BrowserServiceSurfaces {
  constructor(private readonly host: SurfacesHost) {}

  /**
   * Refuse to build a page for a window that is already gone.
   *
   * The service is normally detached before its window is destroyed, so this is
   * the last line of defence rather than the first: a window torn down while a
   * caller was mid-flight used to surface Electron's own
   * `Object has been destroyed` in the UI, which says nothing to the user about
   * what happened or what to do.
   */
  private requireWindow(): void {
    if (!liveWindowContents(this.host.window))
      throw new Error(
        'The app window is no longer open, so a browser page cannot be shown. Reopen the window and try again.'
      )
  }

  /** The agent tab bound to a project and thread, or null when it has none.
   *  A preview uses this to decide between navigating the thread's existing tab
   *  and creating its first one, so the answer comes from the browser rather
   *  than from a memo a caller keeps on the side. */
  agentTabFor(projectId: string, threadId: string): string | null {
    return this.host.agentTabIds.get(browserContextKey(projectId, threadId)) ?? null
  }

  /**
   * Open or re-show one design screen in a tab of its own.
   *
   * A canvas click is the user choosing a page, and two canvases are two pages:
   * a tab per screen is what keeps clicking one from replacing another's. The
   * tab id is derived from the screen's identity rather than minted (see
   * {@link designScreenTabId}), so the same canvas addresses the same tab every
   * time: clicked twice it replaces its own page and leaves every other tab
   * alone, and a tab the user left open across a restart is found again rather
   * than copied where a freshly minted id would not be.
   *
   * The tab is parked offscreen before it loads, exactly as an agent-opened tab
   * is, so the page runs whether or not it ends up on screen.
   */
  async openDesignScreen(input: {
    projectId: string
    threadId: string
    /** Project-relative folder of the design, part of the screen's identity. */
    directory: string
    /** Entry file of the screen, normalized, or null for the folder listing. */
    entry: string | null
    url: string
    /** Bring the tab to the user once it is loaded, or leave it in the sidebar. */
    reveal: boolean
  }): Promise<{ tabId: string; tab: 'reused' | 'opened' }> {
    this.requireWindow()
    const movedTab = [...this.host.tabs].find(
      ([id, tab]) =>
        id.startsWith('browser:screen:') &&
        tab.projectId === input.projectId &&
        tab.threadId === input.threadId &&
        tab.design?.directory === input.directory &&
        this.tabUrl(id) === input.url
    )
    const tabId = movedTab?.[0] ?? designScreenTabId(input)
    const reused = this.host.tabs.has(tabId)
    const tab = this.host.ensureTab(
      tabId,
      input.projectId,
      input.threadId,
      this.host.boxOfExistingTab(tabId)
    )
    if (!reused) {
      tab.initialNavigationStarted = true
      // Mount the tab offscreen before anything else: the page must run whether or
      // not the user ends up looking at it.
      this.host.parkTab(tabId)
    } else if (this.host.activeTabId !== tabId && !this.host.stage.isParked(tab.view)) {
      // A tab the parked cap evicted has no stage window left, so it is mounted
      // again before it navigates, exactly as an agent's operation revives one.
      this.host.parkTab(tabId)
    }
    this.host.load(tabId, input.url)
    // The event carries the URL that was asked for rather than whatever the page
    // holds a moment after a load started, so the sidebar row is named from the
    // screen the user clicked even before the page commits. It is sent for a
    // reused tab too, because that is also the only thing that moves the user to
    // a page the thread already has open. A screen tab is the user's, not the
    // agent's: nothing here claims the thread's agent tab, so no later preview
    // replaces this page under them.
    sendToRenderer(liveWindowContents(this.host.window), 'browser:openRequested', input.url, {
      projectId: input.projectId,
      threadId: input.threadId,
      requestedTabId: tabId,
      reveal: input.reveal,
      boxId: tab.boxId
    })
    return { tabId, tab: reused ? 'reused' : 'opened' }
  }

  /**
   * Show an app-owned page in the thread's own browser tab.
   *
   * The design and video boards move the thread's one tab through every screen of
   * a design, and they do it while the app is idle: there is no live conversation
   * to hold, so routing the navigation through the agent's `navigate` utility
   * operation would ask for a browser-action approval nobody can answer and leave
   * the board with no pictures. This is the app showing its own served folder, so
   * it does the same work the `open` utility operation does, except that it reuses
   * the thread's existing tab instead of stacking a second one.
   *
   * A newly opened tab reveals itself only when the caller asked for focus and the
   * user has not shown they dismiss agent-opened tabs, exactly as `open` does; a
   * reused tab reveals only when the caller asked, so a capture never disturbs the
   * page the user is watching.
   */
  async showThreadWorkTab(input: {
    projectId: string
    threadId: string
    url: string
    attention: 'focus' | 'background'
    reveal: boolean
  }): Promise<{ tabId: string; tab: 'reused' | 'opened' }> {
    this.requireWindow()
    const projectId = validateProjectId(input.projectId)
    const threadId = validateThreadId(input.threadId)
    const url = validateBrowserUrl(input.url)
    const contextKey = browserContextKey(projectId, threadId)
    const existing = this.agentTabFor(projectId, threadId)
    const reused = existing !== null && this.host.tabs.has(existing)
    const tabId = reused ? existing : `browser:agent:${crypto.randomUUID()}`
    const tab = this.host.ensureTab(tabId, projectId, threadId, this.host.boxOfExistingTab(tabId))
    if (!reused) {
      tab.initialNavigationStarted = true
      // Mount the tab offscreen before anything else: the page must run whether
      // or not the user ends up looking at it.
      this.host.parkTab(tabId)
    } else if (this.host.activeTabId !== tabId && !this.host.stage.isParked(tab.view)) {
      // A tab the parked cap evicted has no stage window left, so it is mounted
      // again before it navigates, exactly as an agent's operation revives one.
      this.host.parkTab(tabId)
    }
    this.host.agentTabIds.set(contextKey, tabId)
    this.host.load(tabId, url)
    const reveal =
      input.reveal || (!reused && input.attention === 'focus' && !this.host.isRelaxed(threadId))
    if (reveal) this.host.rememberReveal(tabId, threadId)
    sendToRenderer(liveWindowContents(this.host.window), 'browser:openRequested', url, {
      projectId,
      threadId,
      requestedTabId: tabId,
      reveal,
      boxId: tab.boxId
    })
    return { tabId, tab: reused ? 'reused' : 'opened' }
  }

  /**
   * Show one composition in the video board's own view.
   *
   * The board is a player rather than a page the user opened, so this is the one
   * open path that deliberately sends no `browser:openRequested`: that event is
   * what puts a tab in the strip, and a composition the user is watching in the
   * board must not appear as a second browser tab they never asked for. The view
   * is still an ordinary registered tab, so the tab-mark pipeline marks it as a
   * composition and the transport drives it exactly as it drives any other.
   *
   * The view is named from the composition ({@link compositionBoardTabId}), so
   * coming back to the board finds the view it already had, and a page already
   * showing the composition is left on it rather than reloaded: a reload resets
   * the playhead of a composition the user is watching.
   */
  async showCompositionBoardTab(input: {
    projectId: string
    threadId: string
    /** Project-relative folder of the composition, with forward slashes. */
    directory: string
    url: string
  }): Promise<{ tabId: string; tab: 'reused' | 'opened' }> {
    this.requireWindow()
    const projectId = validateProjectId(input.projectId)
    const threadId = validateThreadId(input.threadId)
    const url = validateBrowserUrl(input.url)
    const movedTab = [...this.host.tabs].find(
      ([id, tab]) =>
        id.startsWith('browser:board:') &&
        tab.projectId === projectId &&
        tab.threadId === threadId &&
        tab.composition?.directory === input.directory
    )
    const tabId =
      movedTab?.[0] ?? compositionBoardTabId({ projectId, threadId, directory: input.directory })
    // A board owns one selected video. Dispose earlier compositions, including
    // views left behind before the renderer acquired lifecycle cleanup.
    for (const [previousId, previous] of this.host.tabs) {
      if (
        previousId !== tabId &&
        previousId.startsWith('browser:board:') &&
        previous.projectId === projectId &&
        previous.threadId === threadId
      )
        this.host.destroy(previousId, 'closed')
    }
    const existing = this.host.tabs.get(tabId)
    if (existing) {
      // A view already on this page is the one being asked for again, so it is
      // not reloaded. Anything else is a folder switch, and the new page loads
      // over a view that is either on screen or staged offscreen.
      if (this.tabUrl(tabId) === url) return { tabId, tab: 'reused' }
      if (this.host.activeTabId !== tabId && !this.host.stage.isParked(existing.view)) {
        // A view the parked cap evicted has no stage window left, so it is mounted
        // again before it navigates, exactly as an agent's operation revives one.
        this.host.parkTab(tabId)
      }
      this.host.load(tabId, url)
      return { tabId, tab: 'reused' }
    }
    const tab = this.host.ensureTab(tabId, projectId, threadId, this.host.boxOfExistingTab(tabId))
    tab.initialNavigationStarted = true
    // Mount the view offscreen before anything else: the page must run whether or
    // not the board is on screen to place it yet.
    this.host.parkTab(tabId)
    this.host.load(tabId, url)
    return { tabId, tab: 'opened' }
  }

  /**
   * The URL a tab is showing right now, or null when it is gone.
   *
   * A preview asks this before loading something, because a page the tab already
   * has open is a page the user is already looking at: reloading it would throw
   * away what they are watching, and a composition that is playing must not be
   * replaced by a still.
   */
  tabUrl(tabId: string): string | null {
    const tab = this.host.tabs.get(tabId)
    if (!tab) return null
    const contents = liveContents(tab.view)
    if (!contents) return null
    return contents.getURL()
  }

  /**
   * Bring an existing tab to the user.
   *
   * Creating a tab reveals it as a side effect, but showing a page the thread
   * already has open makes no new tab, so nothing would move the sidebar. The
   * renderer already knows how to open or focus a tab from this event, so
   * revealing reuses it rather than adding a second reveal path.
   */
  revealTab(tabId: string): void {
    const tab = this.host.tabs.get(tabId)
    if (!tab || !liveWindowContents(this.host.window)) return
    sendToRenderer(
      liveWindowContents(this.host.window),
      'browser:openRequested',
      tab.view.webContents.getURL(),
      {
        projectId: tab.projectId,
        threadId: tab.threadId,
        requestedTabId: tabId,
        reveal: true,
        boxId: tab.boxId
      }
    )
  }

  /**
   * Wait until a tab is no longer loading, bounded.
   *
   * A capture taken mid-navigation shows a half-painted page, and a page that
   * never finishes (a hung script, an unreachable host) must not hold the caller
   * forever, so the wait ends on stop, failure, or the deadline. The wait itself
   * belongs to the page rather than to this call: a board sweep, a frame capture
   * and a refresh of the same tab are three callers on one `WebContents`, and
   * `BrowserLoadWaits` holds one listener pair for all of them (see that module
   * for why a pair per caller is worse than it looks).
   */
  async waitForTabLoad(tabId: string, timeoutMs = 8_000): Promise<void> {
    const tab = this.host.tabs.get(tabId)
    if (!tab) return
    const contents: WebContents | undefined = tab.view.webContents
    if (!contents) return
    const startedAt = Date.now()
    const pendingStart = this.host.pendingNavigationStarts.get(tabId)
    if (pendingStart) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        pendingStart.catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, timeoutMs))
        })
      ])
      if (timer !== undefined) clearTimeout(timer)
    }
    const remaining = Math.max(0, timeoutMs - (Date.now() - startedAt))
    await this.host.loadWaits.wait(contents, remaining)
  }

  /**
   * Capture a tab as a small PNG data URL, for a UI preview rather than a model.
   *
   * Distinct from the agent's `screenshot` operation: that one is capped for
   * tokens and skipped when the page has not changed, while a preview wants a
   * fresh picture at the size the panel can show.
   */
  async captureThumbnail(
    tabId: string,
    maxWidth: number
  ): Promise<{ dataUrl: string; width: number; height: number } | null> {
    const tab = this.host.tabs.get(tabId)
    if (!tab) return null
    const contents = liveContents(tab.view)
    if (!contents) return null
    const captured = await contents.capturePage()
    const source = captured.getSize()
    if (source.width < 1 || source.height < 1) return null
    const target = fitWithin(source.width, source.height, maxWidth)
    const resized =
      target.width !== source.width || target.height !== source.height
        ? captured.resize({ width: target.width, height: target.height })
        : captured
    const size = resized.getSize()
    return {
      dataUrl: `data:image/png;base64,${resized.toPNG().toString('base64')}`,
      width: size.width,
      height: size.height
    }
  }

  /**
   * Draw one exact frame of a composition and settle the page before a capture.
   *
   * A composition owns how a frame is drawn   the render contract is a global
   * function the project defines   so the app calls it and waits rather than
   * reimplementing it. The page is asked to draw the frame itself, then the paint
   * is waited out, because a project that redraws from its own loop during a
   * settle would otherwise be captured mid-paint. A project that defines no render
   * function is reported rather than captured as a guess.
   *
   * The wait goes through the transport when one is armed, and that is not a
   * detail: arming parks the page's own `requestAnimationFrame`, so a wait built
   * on it is never called back and every capture of a composition the app had
   * shown timed out instead of answering.
   */
  designMotionTab(projectId: string, threadId: string, expectedUrl: string): string | null {
    const id = this.agentTabFor(projectId, threadId)
    const tab = id ? this.host.tabs.get(id) : null
    return id && tab && liveContents(tab.view)?.getURL() === expectedUrl ? id : null
  }

  async inspectDesignMotion(
    tabId: string,
    expectedUrl: string,
    input: { targetId?: string; motion?: AuthoredMotion; sampleMs?: number }
  ): Promise<unknown> {
    const tab = this.host.tabs.get(tabId)
    const contents = tab ? liveContents(tab.view) : undefined
    if (!contents) throw new Error('The design preview is unavailable')
    if (contents.getURL() !== expectedUrl)
      throw new Error('The preview navigated. Reopen the screen before inspecting motion.')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result: unknown = await Promise.race([
        contents.executeJavaScript(designMotionPageScript(input)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Motion observation timed out')), 4000)
        })
      ])
      if (contents.isDestroyed() || contents.getURL() !== expectedUrl)
        throw new Error('The preview changed during motion observation')
      return result
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Reload every live tab showing a page under one preview origin, and report how
   * many were reloaded.
   *
   * A preview server knows its own origin and nothing about browsers, so its tab
   * is found by the URL it is showing rather than by a registration. Matching on
   * the origin means a tab the user navigated somewhere else is left alone, and a
   * tab is never reloaded out from under a page that has nothing to do with the
   * folder that changed.
   */
  reloadPreviewOrigin(origin: string): number {
    let reloaded = 0
    for (const [tabId, tab] of this.host.tabs) {
      const contents = liveContents(tab.view)
      if (!contents) continue
      if (!isPreviewOriginUrl(contents.getURL(), origin)) continue
      // Reloading is deferred until the tab's playhead has been read, so a
      // composition the agent just edited resumes where it was instead of being
      // thrown back to its first frame. A tab that is not a composition answers
      // without touching the page.
      void this.reloadKeepingPlayhead(tabId, tab).catch((error: unknown) => {
        Logger.error('A preview tab could not refresh itself:', error)
      })
      reloaded += 1
    }
    return reloaded
  }

  /**
   * Refresh one preview tab, keeping a composition's playhead across the reload.
   *
   * The document is about to be replaced, so where it was is read first and handed
   * to the next arming of the transport. The reload still happens when that read
   * fails: a preview that stops refreshing because playback could not be asked about
   * would be a worse trade than losing one second of position.
   */
  async reloadKeepingPlayhead(tabId: string, tab: BrowserTab): Promise<void> {
    if (tab.composition) await this.rememberPlayhead(tabId, tab)
    // A page that destroyed its own view leaves the view carrying nothing, so the
    // reload is skipped rather than asked of a page that is no longer there.
    liveContents(tab.view)?.reload()
  }

  /** A composition tab's playhead as the page reports it, or null. */
  async readPlayhead(tabId: string): Promise<{ time: number; playing: boolean } | null> {
    const playback = await this.host.transportState(tabId).catch(() => null)
    return playback ? { time: playback.time, playing: playback.playing } : null
  }

  /**
   * Remember where a composition's playhead is, for the next arming to restore.
   *
   * The folder is stored with the position, so a tab reused for another composition
   * can never restore this one's playhead. A page with no armed transport answers
   * nothing, and that answer deliberately does not overwrite a position already
   * remembered: a capture's frozen page is exactly that page, and the position worth
   * restoring is the one from before it was loaded.
   */
  async rememberPlayhead(tabId: string, tab: BrowserTab): Promise<void> {
    const directory = tab.composition?.directory
    if (!directory) return
    const playback = await this.readPlayhead(tabId)
    // The tab can be closed while the page is being asked, and a position for a
    // tab that is gone would never be restored by anything.
    if (this.host.tabs.get(tabId) !== tab) return
    if (playback) this.host.playheads.set(tabId, { directory, ...playback })
  }

  /** Take the remembered playhead for one folder, when that is the folder it is for. */
  takePlayhead(tabId: string, directory: string): { time: number; playing: boolean } | null {
    const saved = this.host.playheads.get(tabId)
    if (!saved) return null
    this.host.playheads.delete(tabId)
    return saved.directory === directory ? { time: saved.time, playing: saved.playing } : null
  }
}
