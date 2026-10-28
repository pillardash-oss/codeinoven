import type {
  BrowserConsoleEntry,
  BrowserConsoleLevel,
  BrowserDevToolsState,
  BrowserPageState
} from '../../../lib/ipc-contract'
import { sendToRenderer } from '../../ipc/renderer-delivery'
import { type BrowserTab } from './browser-types'
import { MAX_CONSOLE_ENTRIES } from './browser-validation'
import { liveContents } from './browser-view-contents'
import type { BrowserService } from '../browser-service'

/**
 * The page state the rail is published.
 *
 * Every tab change the renderer sees is one event built here: the address, the title,
 * the loading and error flags, the favicon, the design mark, and the console entries a
 * page logged. One builder means the strip and the panel can never disagree about a
 * page.
 */

/**
 * What `browser-service-page-state` reads off the browser service.
 *
 * Each member is the service's own declaration, so this unit and the composition
 * root cannot drift apart: a changed signature is a compile error here.
 */
export interface PageStateHost {
  readonly capture: BrowserService['capture']
  consoleSequence: BrowserService['consoleSequence']
  readonly tabs: BrowserService['tabs']
  readonly window: BrowserService['window']
}

export class BrowserServicePageState {
  constructor(private readonly host: PageStateHost) {}

  stateFor(tabId: string, tab: BrowserTab): BrowserPageState {
    const contents = tab.view.webContents
    return {
      tabId,
      // The surface the tab belongs to. A store that keeps something per browser
      // (the browsing history does) reads the ownership here rather than looking
      // the tab up in a list the other surface's tabs are not in.
      projectId: tab.projectId,
      threadId: tab.threadId,
      boxId: tab.boxId,
      url: contents.getURL(),
      title: contents.getTitle(),
      favicon: tab.favicon,
      loading: contents.isLoading(),
      loadError: tab.loadError,
      // Read from the view rather than cached: these drive the tab's speaker and
      // recording indicators, and a muted tab that the page itself unmuted must
      // report the mute state that is actually in force.
      audible: contents.isCurrentlyAudible(),
      muted: contents.isAudioMuted(),
      capturing: this.host.capture.isCapturing(tabId),
      ...this.host.capture.activity(tabId),
      design: tab.design,
      composition: tab.composition,
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward()
    }
  }

  utilityTabContext(
    tabId: string,
    tab: BrowserTab
  ): {
    tabId: string
    projectId: string
    threadId: string
  } {
    return { tabId, projectId: tab.projectId, threadId: tab.threadId }
  }

  publishState(tabId: string): void {
    const tab = this.host.tabs.get(tabId)
    if (!tab || this.host.window.webContents.isDestroyed()) return
    sendToRenderer(this.host.window.webContents, 'browser:state', this.stateFor(tabId, tab))
    sendToRenderer(
      this.host.window.webContents,
      'browser:devToolsChanged',
      this.devToolsStateFor(tabId, tab)
    )
  }

  devToolsStateFor(tabId: string, tab: BrowserTab): BrowserDevToolsState {
    return { tabId, open: liveContents(tab.view)?.isDevToolsOpened() ?? false }
  }

  appendConsoleEntry(
    tabId: string,
    input: {
      level: BrowserConsoleLevel
      message: string
      sourceId: string
      lineNumber: number
      frameUrl: string | null
    }
  ): void {
    const tab = this.host.tabs.get(tabId)
    if (!tab) return
    const entry: BrowserConsoleEntry = {
      id: `${Date.now()}:${this.host.consoleSequence++}`,
      tabId,
      level: input.level,
      message: input.message.slice(0, 10_000),
      sourceId: input.sourceId.slice(0, 2_048),
      lineNumber: Math.max(0, input.lineNumber),
      timestamp: Date.now(),
      frameUrl: input.frameUrl === null ? null : input.frameUrl.slice(0, 2_048)
    }
    tab.consoleEntries = [...tab.consoleEntries, entry].slice(-MAX_CONSOLE_ENTRIES)
  }
}
