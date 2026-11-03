import type {
  DisplayCapturePhase,
  DisplayCaptureState,
  DisplayFrame,
  DisplaySourceDescriptor,
  DisplaySourceKind,
  DisplaySourceListing
} from '$shared/ipc/display'
import { DISPLAY_SOURCE_KINDS } from '$shared/ipc/display'
import { invoke, subscribe } from '$lib/ipc.svelte'
import { logRendererError } from '$lib/system/renderer-logger'

/**
 * State for the display panel: the preview tabs a user opened, and the frame each
 * one is showing.
 *
 * The panel is a viewer, so this store holds no device state of its own. It owns
 * three things: which targets are open as tabs, which one is on screen, and the
 * last frame each tab received. Everything about how a frame is produced lives in
 * the main process.
 *
 * A session lives exactly as long as its tab, and a session only captures while
 * the panel is showing that tab: `setActive` and `setPanelVisible` send the demand
 * that pauses everything else, so an open tab the user has switched away from
 * costs a bare timer tick every 600 ms and no child process at all.
 */

/** Quantization step reported to main, matching the service's own. */
const DEMAND_STEP = 64

export interface DisplayTab {
  id: string
  /** Minted per open, so a reopened tab can never be confused with its predecessor. */
  sessionId: string
  kind: DisplaySourceKind
  sourceId: string
  label: string
  detail: string | null
  frame: DisplayFrame | null
  phase: DisplayCapturePhase
  /** Sentence shown while retrying or failed; cleared by the next good frame. */
  stateDetail: string | null
  /** Last demand main was told about, so an unchanged size costs no IPC. */
  sentDemand: number | null
  sentVisible: boolean | null
}

export interface DisplaySourceSection {
  kind: DisplaySourceKind
  label: string
  listing: DisplaySourceListing | null
  loading: boolean
}

/** What the picker calls each kind. The rail calls the panel itself "Display". */
const KIND_LABELS: Record<DisplaySourceKind, string> = {
  android: 'Android',
  ios: 'iOS Simulator',
  'desktop-screen': 'Desktop screens',
  'desktop-window': 'Windows'
}

function tabIdFor(source: DisplaySourceDescriptor): string {
  return `${source.kind}:${source.sourceId}`
}

function sessionId(): string {
  return crypto.randomUUID()
}

class DisplayPanelState {
  tabs = $state<DisplayTab[]>([])
  activeTabId = $state<string | null>(null)
  listings = $state<Partial<Record<DisplaySourceKind, DisplaySourceListing>>>({})
  loadingKinds = $state<Partial<Record<DisplaySourceKind, boolean>>>({})
  /** True while the panel is mounted and its active tab is the one on screen. */
  panelVisible = $state(false)

  private cleanups: Array<() => void> = []
  private started = false

  activeTab = $derived(this.tabs.find((tab) => tab.id === this.activeTabId) ?? null)

  /** Every kind, in picker order, with whatever has been discovered so far. */
  sections = $derived(
    DISPLAY_SOURCE_KINDS.map((kind): DisplaySourceSection => ({
      kind,
      label: KIND_LABELS[kind],
      listing: this.listings[kind] ?? null,
      loading: this.loadingKinds[kind] === true
    }))
  )

  /** True when at least one target is open, so the panel shows the stage. */
  hasTabs = $derived(this.tabs.length > 0)

  init(): void {
    if (this.started) return
    this.started = true
    this.cleanups.push(
      subscribe('display:frame', (frame: DisplayFrame) => {
        const tab = this.tabs.find((candidate) => candidate.id === frame.tabId)
        if (!tab) return
        tab.frame = frame
      })
    )
    this.cleanups.push(
      subscribe('display:captureState', (state: DisplayCaptureState) => {
        const tab = this.tabs.find((candidate) => candidate.sessionId === state.sessionId)
        if (!tab) return
        tab.phase = state.phase
        tab.stateDetail = state.detail ?? null
      })
    )
  }

  destroy(): void {
    for (const cleanup of this.cleanups) cleanup()
    this.cleanups = []
    this.started = false
  }

  /** Open a target as a tab (or focus the tab it already has) and start capturing. */
  openSource(source: DisplaySourceDescriptor): void {
    const id = tabIdFor(source)
    const existing = this.tabs.find((tab) => tab.id === id)
    if (existing) {
      this.setActive(existing.id)
      return
    }
    const tab: DisplayTab = {
      id,
      sessionId: sessionId(),
      kind: source.kind,
      sourceId: source.sourceId,
      label: source.label,
      detail: source.detail ?? null,
      frame: null,
      phase: 'starting',
      stateDetail: null,
      sentDemand: null,
      sentVisible: null
    }
    this.tabs = [...this.tabs, tab]
    this.activeTabId = tab.id
    void invoke('display:start', {
      sessionId: tab.sessionId,
      tabId: tab.id,
      kind: tab.kind,
      sourceId: tab.sourceId
    }).catch((error: unknown) => {
      tab.phase = 'failed'
      tab.stateDetail = error instanceof Error ? error.message : String(error)
      logRendererError('The display session could not start', error)
    })
  }

  /** Close one tab and stop its capture. The neighbour takes over, if there is one. */
  closeTab(id: string): void {
    const index = this.tabs.findIndex((tab) => tab.id === id)
    if (index < 0) return
    const tab = this.tabs[index]
    void invoke('display:stop', tab.sessionId).catch((error: unknown) =>
      logRendererError('The display session could not be stopped', error)
    )
    this.tabs = this.tabs.filter((candidate) => candidate.id !== id)
    if (this.activeTabId === id) {
      const next = this.tabs[Math.min(index, this.tabs.length - 1)] ?? null
      this.activeTabId = next?.id ?? null
    }
  }

  /** Show one tab's preview. Every other tab stops capturing. */
  setActive(id: string): void {
    const tab = this.tabs.find((candidate) => candidate.id === id)
    if (!tab) return
    this.activeTabId = tab.id
    for (const candidate of this.tabs) {
      this.pushDemand(candidate, candidate.id === tab.id)
    }
  }

  /**
   * Mark the panel as shown or hidden. Sent by the panel component as it mounts
   * and unmounts, so collapsing the dock stops every capture without closing the
   * tabs the user opened.
   */
  setPanelVisible(visible: boolean): void {
    if (this.panelVisible === visible) return
    this.panelVisible = visible
    const activeId = this.activeTabId
    for (const candidate of this.tabs) {
      this.pushDemand(candidate, visible && candidate.id === activeId)
    }
  }

  /**
   * Report the size the stage paints at. Deduped against the last value sent, so a
   * resize handle dragged across the panel's width sends a handful of updates
   * rather than one per pixel.
   */
  reportStageSize(tabId: string, maxDimension: number): void {
    const tab = this.tabs.find((candidate) => candidate.id === tabId)
    if (!tab) return
    this.pushDemand(tab, this.panelVisible && tab.id === this.activeTabId, maxDimension)
  }

  /** Discover one kind's targets. Never called on a timer; the picker asks. */
  async refresh(kind: DisplaySourceKind): Promise<void> {
    this.loadingKinds = { ...this.loadingKinds, [kind]: true }
    try {
      const listing = await invoke('display:listSources', kind)
      this.listings = { ...this.listings, [kind]: listing }
    } catch (error: unknown) {
      this.listings = {
        ...this.listings,
        [kind]: {
          kind,
          sources: [],
          problem: error instanceof Error ? error.message : String(error)
        }
      }
      logRendererError(`Display sources for ${kind} could not be listed`, error)
    } finally {
      this.loadingKinds = { ...this.loadingKinds, [kind]: false }
    }
  }

  /** Discover every kind, one after another so a slow adb does not hold up the rest. */
  async refreshAll(): Promise<void> {
    for (const kind of DISPLAY_SOURCE_KINDS) {
      void this.refresh(kind)
    }
  }

  /** Send the stage demand, skipping a value main already has. */
  private pushDemand(tab: DisplayTab, visible: boolean, reported = tab.sentDemand ?? 0): void {
    const maxDimension = Math.max(DEMAND_STEP, Math.round(reported / DEMAND_STEP) * DEMAND_STEP)
    if (tab.sentDemand === maxDimension && tab.sentVisible === visible) return
    tab.sentDemand = maxDimension
    tab.sentVisible = visible
    void invoke('display:demand', tab.sessionId, { maxDimension, visible }).catch(
      (error: unknown) => logRendererError('A display demand could not be reported', error)
    )
  }
}

export const displayPanel = new DisplayPanelState()
