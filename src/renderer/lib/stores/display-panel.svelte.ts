import type {
  DisplayCapturePhase,
  DisplayCaptureState,
  DisplayControlAction,
  DisplayFrame,
  DisplaySourceKind,
  DisplaySourceListing
} from '$shared/ipc/display'
import { DISPLAY_SOURCE_KINDS } from '$shared/ipc/display'
import { invoke, subscribe } from '$lib/ipc.svelte'
import { logRendererError } from '$lib/system/renderer-logger'

/**
 * State for the display panel: one capture session per open mirror tab, and what
 * each kind can be pointed at.
 *
 * The panel is tabbed by the context dock itself, so this store holds no tab list
 * of its own: a tab is `DisplayContextTab`, and everything here is keyed by that
 * tab's id. A session lives while its tab's stage is mounted and captures only
 * while that stage is on screen, so switching tabs or folding the dock stops the
 * device work instead of leaving it running for a picture nobody is looking at.
 */

/** Quantization step reported to main, matching the service's own. */
const DEMAND_STEP = 64

/** One tab's capture, as the renderer sees it. */
export interface DisplaySession {
  tabId: string
  /** Minted per mounted stage, so a stale session can never be mistaken for a new one. */
  sessionId: string
  frame: DisplayFrame | null
  phase: DisplayCapturePhase
  /** Sentence shown while retrying or failed; cleared by the next good frame. */
  detail: string | null
}

export interface DisplaySourceSection {
  kind: DisplaySourceKind
  label: string
  listing: DisplaySourceListing | null
  loading: boolean
}

/** What the picker calls each kind. */
const KIND_LABELS: Record<DisplaySourceKind, string> = {
  android: 'Android devices',
  ios: 'iOS Simulators',
  'desktop-screen': 'Desktop screens',
  'desktop-window': 'Windows'
}

class DisplayPanelState {
  /** Sessions by display tab id. */
  sessions = $state<Record<string, DisplaySession>>({})
  listings = $state<Partial<Record<DisplaySourceKind, DisplaySourceListing>>>({})
  loadingKinds = $state<Partial<Record<DisplaySourceKind, boolean>>>({})
  /** The tab whose stage the dock is showing, so demand can be scoped to it. */
  visibleTabId = $state<string | null>(null)

  private cleanups: Array<() => void> = []
  private started = false
  /**
   * Last demand each tab reported, so an unchanged size costs no IPC.
   *
   * Deliberately plain, not `$state`: the only writer is a measurement effect,
   * and a reactive field written by an effect that also reads state is a loop
   * with a nicer name.
   */
  private readonly demands = new Map<string, { maxDimension: number; visible: boolean }>()

  /** Every kind, in picker order, with whatever has been discovered so far. */
  sections = $derived(
    DISPLAY_SOURCE_KINDS.map((kind): DisplaySourceSection => ({
      kind,
      label: KIND_LABELS[kind],
      listing: this.listings[kind] ?? null,
      loading: this.loadingKinds[kind] === true
    }))
  )

  init(): void {
    if (this.started) return
    this.started = true
    this.cleanups.push(
      subscribe('display:frame', (frame: DisplayFrame) => {
        const session = this.sessions[frame.tabId]
        if (!session || session.sessionId !== frame.sessionId) return
        session.frame = frame
      })
    )
    this.cleanups.push(
      subscribe('display:captureState', (state: DisplayCaptureState) => {
        for (const session of Object.values(this.sessions)) {
          if (session.sessionId !== state.sessionId) continue
          session.phase = state.phase
          session.detail = state.detail ?? null
          return
        }
      })
    )
  }

  destroy(): void {
    for (const cleanup of this.cleanups) cleanup()
    this.cleanups = []
    this.started = false
  }

  sessionFor(tabId: string | null): DisplaySession | null {
    return tabId ? (this.sessions[tabId] ?? null) : null
  }

  /**
   * Begin mirroring one target for a tab.
   *
   * Replacing a session for the same tab stops the old one first: retargeting a
   * tab (`applyDisplayTarget`) must not leave the previous device's capture
   * running behind the new picture.
   */
  start(tabId: string, kind: DisplaySourceKind, sourceId: string): void {
    this.stop(tabId)
    const session: DisplaySession = {
      tabId,
      sessionId: crypto.randomUUID(),
      frame: null,
      phase: 'starting',
      detail: null
    }
    this.demands.delete(tabId)
    this.sessions = { ...this.sessions, [tabId]: session }
    void invoke('display:start', {
      sessionId: session.sessionId,
      tabId,
      kind,
      sourceId
    }).catch((error: unknown) => {
      session.phase = 'failed'
      session.detail = error instanceof Error ? error.message : String(error)
      logRendererError('The display session could not start', error)
    })
  }

  /** Stop a tab's capture and forget it. */
  stop(tabId: string): void {
    const session = this.sessions[tabId]
    if (!session) return
    const next = { ...this.sessions }
    delete next[tabId]
    this.sessions = next
    this.demands.delete(tabId)
    void invoke('display:stop', session.sessionId).catch((error: unknown) =>
      logRendererError('The display session could not be stopped', error)
    )
  }

  /** Tell main which tab is on screen. Only that tab captures. */
  setVisibleTab(tabId: string | null): void {
    if (this.visibleTabId === tabId) return
    const previous = this.visibleTabId
    this.visibleTabId = tabId
    if (previous && previous !== tabId) this.pushDemand(previous, false)
    if (tabId) this.pushDemand(tabId, true)
  }

  /**
   * Report the size the stage paints at. Deduped against the last value sent, so
   * dragging the dock's edge sends a handful of updates rather than one per pixel.
   */
  reportStageSize(tabId: string, maxDimension: number): void {
    this.pushDemand(tabId, this.visibleTabId === tabId, maxDimension)
  }

  /** Press one of the target's own buttons. */
  control(tabId: string, action: DisplayControlAction): void {
    const session = this.sessions[tabId]
    if (!session) return
    void invoke('display:control', session.sessionId, action).catch((error: unknown) =>
      logRendererError(`The display control "${action}" failed`, error)
    )
  }

  /** Discover one kind's targets. Never on a timer: the picker asks. */
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

  /** Discover every kind. Kicked off together so one slow adb never delays the
   *  rest; each section paints what it has as it arrives. */
  refreshAll(): void {
    for (const kind of DISPLAY_SOURCE_KINDS) void this.refresh(kind)
  }

  private pushDemand(tabId: string, visible: boolean, reported?: number): void {
    const session = this.sessions[tabId]
    if (!session) return
    const previous = this.demands.get(tabId)
    const requested = reported ?? previous?.maxDimension ?? DEMAND_STEP
    const maxDimension = Math.max(DEMAND_STEP, Math.round(requested / DEMAND_STEP) * DEMAND_STEP)
    if (previous?.maxDimension === maxDimension && previous.visible === visible) return
    this.demands.set(tabId, { maxDimension, visible })
    void invoke('display:demand', session.sessionId, { maxDimension, visible }).catch(
      (error: unknown) => logRendererError('A display demand could not be reported', error)
    )
  }
}

export const displayPanel = new DisplayPanelState()
