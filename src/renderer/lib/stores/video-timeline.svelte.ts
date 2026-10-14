import { SvelteMap } from 'svelte/reactivity'
import type {
  BrowserCompositionPlayback,
  BrowserCompositionTab,
  BrowserTransportCommand
} from '$shared/ipc-contract'
import { invoke, subscribe } from '$lib/ipc.svelte'

/** A composition tab the app can drive, with the identity the transport needs. */
export interface VideoCompositionTab extends BrowserCompositionTab {
  tabId: string
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
    subscribe('browser:state', (state) => {
      const key = compositionKey(state.projectId, state.threadId)
      if (state.composition) {
        this.tabs.set(key, { ...state.composition, tabId: state.tabId })
        return
      }
      // A tab that is no longer showing a composition must not keep answering
      // for one: the folder may have been replaced by a normal page.
      if (this.tabs.get(key)?.tabId === state.tabId) this.tabs.delete(key)
    })
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
