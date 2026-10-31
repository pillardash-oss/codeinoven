import { type WebContents } from 'electron'
import { type BrowserSearchEngine } from '../../../lib/browser-search-engines'
import type { BrowserDesignTab, BrowserScrollbarTheme } from '../../../lib/ipc-contract'
import { Logger } from '../../system/logger'
import { type BrowserTab } from './browser-types'
import {
  NO_TAB_MARK,
  isSameTabMark,
  tabMarkFor,
  type BrowserTabMark,
  type TabMarkRecogniser
} from './browser-tab-mark'
import type { BrowserService } from '../browser-service'
import type { BrowserAgentActionApprover } from './browser-service-agent-approval'

/**
 * The values the app pushes into the browser at boot.
 *
 * The browser owns no configuration of its own: the search engine, the scrollbar
 * theme, the design/composition recogniser and the permission-card approver all come
 * from the renderer or from bootstrap. Each setter is here, together with the small
 * amount of work it implies   the stylesheet a theme swap replaces, and the tab mark a
 * recogniser change re-applies to the tabs already open.
 */

/**
 * What `browser-service-configuration` reads off the browser service.
 *
 * Each member is the service's own declaration, so this unit and the composition
 * root cannot drift apart: a changed signature is a compile error here.
 */
export interface ConfigurationHost {
  agentActionApprover: BrowserService['agentActionApprover']
  readonly armCompositionQuietly: BrowserService['armCompositionQuietly']
  contextMenuSearchEngine: BrowserService['contextMenuSearchEngine']
  readonly inspector: BrowserService['inspector']
  readonly playheads: BrowserService['playheads']
  readonly publishState: BrowserService['publishState']
  readonly releaseTransportAudio: BrowserService['releaseTransportAudio']
  readonly requireTab: BrowserService['requireTab']
  readonly scrollbarStyles: BrowserService['scrollbarStyles']
  scrollbarTheme: BrowserService['scrollbarTheme']
  tabMarkRecogniser: BrowserService['tabMarkRecogniser']
  readonly tabs: BrowserService['tabs']
}

export class BrowserServiceConfiguration {
  constructor(private readonly host: ConfigurationHost) {}

  /**
   * Record that a tab is rendering a design folder. Non-null `design` on the
   *  published state is what makes the panel offer the element inspector, so only
   *  the design capability calls this: it is the one caller that knows a served
   *  folder is a design rather than an arbitrary directory.
   *
   *  A composition is recognized rather than marked, because its mark carries the
   *  timeline its manifest declares and that has to be read.
   */
  markDesignTab(tabId: string, design: BrowserDesignTab): void {
    const tab = this.host.requireTab(tabId)
    tab.design = { directory: design.directory, origin: design.origin }
    this.host.publishState(tabId)
  }

  /**
   * Register how a tab is recognised from the page it is showing.
   *
   * Without this, a tab is a design only when a design capability marked it, which
   * is what left a tab the agent opened itself, and a tab the renderer restored after
   * a restart, showing a design as an ordinary page. The same recognition is what
   * arms a composition's transport, so both marks come from one rule.
   */
  setTabMarkRecogniser(recogniser: TabMarkRecogniser | null): void {
    this.host.tabMarkRecogniser = recogniser
  }

  /** Register the permission-card approver for attached-page mutations. */
  setAgentActionApprover(approver: BrowserAgentActionApprover | null): void {
    this.host.agentActionApprover = approver
  }

  /**
   * Set the search engine the context menu's web search uses.
   *
   * Called once with the boot config and again whenever the renderer reports a
   * config change, because the browser's native context menu is built here and
   * this process holds the config rather than the service.
   */
  setSearchEngine(engine: BrowserSearchEngine): void {
    this.host.contextMenuSearchEngine = engine
  }

  /**
   * Set the app's scrollbar colours and apply them to every open tab.
   *
   * Called once with the renderer's first push and again whenever the app theme
   * changes, so a default page scrollbar stays on brand without the renderer
   * having to know which tabs exist. A user-origin stylesheet is what keeps a
   * site's own scrollbar styling in charge where it exists.
   */
  setScrollbarTheme(theme: BrowserScrollbarTheme): void {
    this.host.scrollbarTheme = theme
    for (const [tabId, tab] of this.host.tabs) this.applyScrollbarTheme(tabId, tab.view.webContents)
  }

  /** Build the user-origin stylesheet a page's default scrollbar is drawn with. */
  scrollbarThemeCss(theme: BrowserScrollbarTheme): string {
    return (
      '::-webkit-scrollbar{width:6px;height:6px}' +
      '::-webkit-scrollbar-track{background:transparent}' +
      `::-webkit-scrollbar-thumb{background:${theme.thumb}}` +
      `::-webkit-scrollbar-thumb:hover{background:${theme.thumbHover}}`
    )
  }

  /**
   * Install the current colours into one tab's document. Re-run on every
   * `dom-ready`, because a navigation replaces the stylesheet with the document.
   * The insert is user-origin on purpose: author styles win the cascade, so a
   * site that styles its own scrollbar keeps it.
   */
  applyScrollbarTheme(tabId: string, contents: WebContents): void {
    const theme = this.host.scrollbarTheme
    if (!theme || contents.isDestroyed()) return
    const previous = this.host.scrollbarStyles.get(tabId)
    this.host.scrollbarStyles.delete(tabId)
    contents
      .insertCSS(this.scrollbarThemeCss(theme), { cssOrigin: 'user' })
      .then((key) => {
        if (contents.isDestroyed()) return
        this.host.scrollbarStyles.set(tabId, key)
        if (previous) void contents.removeInsertedCSS(previous).catch(() => {})
      })
      .catch(() => {})
  }

  /**
   * Decide, from the origin a tab is showing, what the app knows about its folder.
   *
   * Called on every committed navigation and nowhere else, because the origin is the
   * only thing that can change the answer: an in-page navigation cannot move a page
   * to another origin. A tab that navigated away from its folder therefore loses its
   * mark, and a tab that arrives on an authored-work folder gains one whether or not
   * a capability opened it.
   *
   * The answer is asynchronous because a composition's mark carries the timeline
   * its manifest declares, so the URL is read again when it lands: a mark for a
   * document the tab has already left would arm the transport with the wrong video.
   */
  refreshTabMark(tabId: string, tab: BrowserTab): void {
    const contents = tab.view.webContents
    if (contents.isDestroyed()) return
    const url = contents.getURL()
    const recogniser = this.host.tabMarkRecogniser
    if (!recogniser) {
      this.applyTabMark(tabId, tab, url, NO_TAB_MARK)
      return
    }
    // Recognition is a mark, never a write: the app is told which folder the page
    // shows, and the thread's own authored-work record is left to the session that
    // started the work. A user opening a design folder in a tab of their own, a
    // reload, or a tab restored after a restart therefore marks the tab (the
    // inspector and the transport still follow it) without claiming the thread.
    void recogniser(tab.projectId, tab.threadId, url)
      .then((recognised) => {
        if (contents.isDestroyed() || contents.getURL() !== url) return
        this.applyTabMark(tabId, tab, url, recognised)
      })
      .catch((error: unknown) => {
        Logger.error('Browser tab recognition failed:', error)
      })
  }

  /**
   * Land a recognised mark on a tab, and arm or disarm what it governs.
   *
   * Arming waits for the document to settle unless it already has: the transport is
   * installed into the page, and the load's own `did-finish-load` covers the case
   * where the mark was resolved while the document was still arriving.
   */
  applyTabMark(tabId: string, tab: BrowserTab, url: string, recognised: BrowserTabMark): void {
    const previous: BrowserTabMark = { design: tab.design, composition: tab.composition }
    const next = tabMarkFor(url, previous, recognised)
    if (isSameTabMark(next, previous)) return
    tab.design = next.design
    tab.composition = next.composition
    if (next.design === null) this.host.inspector.setArmed(tabId, tab.view.webContents, false, null)
    this.host.publishState(tabId)
    if (!next.composition) {
      // A tab that left the composition has no playhead to restore, and the mute
      // the player took from it belongs to the tab rather than to the composition.
      this.host.playheads.delete(tabId)
      this.host.releaseTransportAudio(tabId, tab)
      return
    }
    // Arming is idempotent per document and per timeline, so this needs no guard
    // against the load's own arm: whichever of the two arrives second does nothing.
    this.host.armCompositionQuietly(tabId, tab)
  }
}
