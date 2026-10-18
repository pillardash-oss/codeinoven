import { SvelteMap } from 'svelte/reactivity'
import type {
  BrowserCompositionPlayback,
  BrowserCompositionTab,
  BrowserPageState,
  BrowserTransportCommand
} from '$shared/ipc-contract'
import { invoke, subscribe } from '$lib/ipc.svelte'

/** A composition tab the app can drive, with the identity the transport needs. */
export interface VideoCompositionTab extends BrowserCompositionTab {
  tabId: string
  /** The scope that owns the tab, so a board can place its native view. */
  projectId: string
  threadId: string
  /** The address the tab is showing, which is what re-attaching the view needs. */
  url: string
  /** The cookie jar the tab runs against, or null for the scope's own. */
  boxId: string | null
}

function compositionKey(projectId: string, threadId: string): string {
  return JSON.stringify([projectId, threadId])
}

/**
 * The composition tab a conversation is showing, and the transport that drives it.
 *
 * A video composition is played by a browser tab, and the page owns the clock:
 * the app reads the playhead and commands it rather than animating anything
 * itself. The tab's identity and its manifest arrive on `browser:state`, which
 * every tab reports, so this keeps the newest composition tab per conversation
 * and drops one that navigated away from its folder.
 *
 * The timeline and the note jump both read from here, so neither has to poll the
 * whole tab list to find the composition it belongs to.
 */
class VideoTimelineState {
  private readonly tabs = new SvelteMap<string, VideoCompositionTab>()
  /**
   * The same compositions, keyed by the view showing them.
   *
   * A board plays its composition in a view of its own, and the view is the only
   * thing that identifies it when the thread also has a browser tab on the same
   * folder. Keying by tab is what lets the board address its own page rather than
   * whichever composition tab reported last.
   */
  private readonly byTabId = new SvelteMap<string, VideoCompositionTab>()
  private started = false

  /**
   * Wire the session's listener. Idempotent.
   *
   * Subscribed from the runtime seam rather than the constructor: the browser is
   * not part of the first paint, and a store built while the renderer document
   * evaluates should not carry a listener for a panel nobody has opened.
   */
  start(): void {
    if (this.started) return
    this.started = true
    subscribe('browser:state', (state) => this.adopt(state))
  }

  /**
   * Record one tab's page state, or forget the composition it no longer shows.
   *
   * Public because a push is not always available. A view main already holds on a
   * composition is answered with `reused` and deliberately not reloaded, so no
   * `browser:state` follows the open and a renderer that was not listening when
   * that state was first published would never learn about the composition at all.
   * The board reads that tab's state itself and hands it here instead, so the two
   * arrival routes fill the same entries.
   */
  adopt(state: BrowserPageState): void {
    const key = compositionKey(state.projectId, state.threadId)
    if (state.composition) {
      const tab: VideoCompositionTab = {
        ...state.composition,
        tabId: state.tabId,
        projectId: state.projectId,
        threadId: state.threadId,
        url: state.url,
        boxId: state.boxId
      }
      this.tabs.set(key, tab)
      this.byTabId.set(state.tabId, tab)
      return
    }
    // A tab that is no longer showing a composition must not keep answering
    // for one: the folder may have been replaced by a normal page.
    if (this.tabs.get(key)?.tabId === state.tabId) this.tabs.delete(key)
    this.byTabId.delete(state.tabId)
  }

  /**
   * Read one view's own page state and record it.
   *
   * The pull half of {@link adopt}, for a view whose state was published before
   * this store was listening. A tab that went away between the open and this read
   * reports nothing, and a view whose composition is not recognised yet reports no
   * composition: both leave the store as it was, so the push that follows a first
   * load is what settles them.
   */
  async seed(tabId: string): Promise<void> {
    try {
      const state = await invoke('browser:pageState', tabId)
      if (state !== null) this.adopt(state)
    } catch {
      // A view that is gone is not this store's failure to report.
    }
  }

  /** The composition this conversation is showing, or null when it shows none. */
  compositionFor(projectId: string, threadId: string): VideoCompositionTab | null {
    return this.tabs.get(compositionKey(projectId, threadId)) ?? null
  }

  /** The composition this conversation is showing in one folder, or null. */
  compositionIn(
    projectId: string,
    threadId: string,
    directory: string
  ): VideoCompositionTab | null {
    const tab = this.compositionFor(projectId, threadId)
    return tab && tab.directory === directory ? tab : null
  }

  /**
   * The composition one view is showing, or null when it is not a composition.
   *
   * The video board owns a view of its own and asks for it by identity, so the
   * board plays the page it opened even while another composition tab exists for
   * the same thread.
   */
  compositionByTab(tabId: string): VideoCompositionTab | null {
    return this.byTabId.get(tabId) ?? null
  }

  /**
   * The playhead as the page reports it, or null while the tab is not answering.
   *
   * A tab that has been closed between a render and this call reports nothing
   * rather than throwing, because a timeline that is going away must not fail
   * loudly on its way out.
   */
  async playback(tabId: string): Promise<BrowserCompositionPlayback | null> {
    try {
      return await invoke('browser:transportState', tabId)
    } catch {
      return null
    }
  }

  /** Send one transport command and answer with the state it produced. */
  async command(
    tabId: string,
    command: BrowserTransportCommand,
    value: number | boolean = 0
  ): Promise<BrowserCompositionPlayback | null> {
    try {
      return await invoke('browser:transport', tabId, command, value)
    } catch {
      return null
    }
  }

  /** Put the playhead at a second. Seeking pauses nowhere: the transport keeps
   *  whatever play state it had. */
  async seek(tabId: string, seconds: number): Promise<BrowserCompositionPlayback | null> {
    return this.command(tabId, 'seek', Math.max(0, seconds))
  }
}

export const videoTimelineState = new VideoTimelineState()
