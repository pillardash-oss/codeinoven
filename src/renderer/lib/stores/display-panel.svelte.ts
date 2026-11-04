import type {
  DisplayCapturePhase,
  DisplayCaptureState,
  DisplayControlAction,
  DisplayFrame,
  DisplayInputGesture,
  DisplayInputPermission,
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
  /**
   * The frame as a URL the browser paints directly.
   *
   * Built from the target's own PNG bytes and revoked the moment it is replaced: no
   * base64, no re-encode, and no growing list of live blobs behind a moving picture.
   */
  url: string | null
  phase: DisplayCapturePhase
  /** Sentence shown while retrying or failed; cleared by the next good frame. */
  detail: string | null
  /** True when the target accepts taps and typing from the panel. */
  input: boolean
  /** Why it does not, when it does not. */
  inputProblem: string | null
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
  /**
   * Whether this machine lets the app post input into another window.
   *
   * Read when a simulator is targeted, never at boot: a person who never mirrors a
   * device should not meet a permission prompt for it. Null means nobody has asked
   * yet, which is different from "asked and refused".
   */
  inputPermission = $state<DisplayInputPermission | null>(null)
  /** True while the system prompt for that grant is being raised. */
  requestingPermission = $state(false)
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
        const url = URL.createObjectURL(new Blob([frame.bytes], { type: frame.mime }))
        const previous = session.url
        session.frame = frame
        session.url = url
        if (previous) URL.revokeObjectURL(previous)
      })
    )
    this.cleanups.push(
      subscribe('display:captureState', (state: DisplayCaptureState) => {
        for (const session of Object.values(this.sessions)) {
          if (session.sessionId !== state.sessionId) continue
          session.phase = state.phase
          session.detail = state.detail ?? null
          session.input = state.input
          session.inputProblem = state.inputProblem ?? null
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
  start(tabId: string, kind: DisplaySourceKind, sourceId: string): string {
    this.stop(tabId)
    const session: DisplaySession = {
      tabId,
      sessionId: crypto.randomUUID(),
      frame: null,
      url: null,
      phase: 'starting',
      detail: null,
      input: false,
      inputProblem: null
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
    return session.sessionId
  }

  /**
   * Stop a tab's capture and forget it.
   *
   * `sessionId` is the session the caller started. Returning from fullscreen
   * mounts the dock's stage before the fullscreen one is torn down, so a cleanup
   * that stopped by tab id alone would kill the frame that had just been asked
   * for. A cleanup only ever stops its own session.
   */
  stop(tabId: string, sessionId?: string): void {
    const session = this.sessions[tabId]
    if (!session) return
    if (sessionId !== undefined && session.sessionId !== sessionId) return
    if (session.url) URL.revokeObjectURL(session.url)
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

  /** Give up the visible slot, but only if this caller still holds it: the stage
   *  that is being unmounted can outlive the one that replaced it. */
  releaseVisibleTab(tabId: string): void {
    if (this.visibleTabId === tabId) this.setVisibleTab(null)
  }

  /**
   * Report the size the stage paints at. Deduped against the last value sent, so
   * dragging the dock's edge sends a handful of updates rather than one per pixel.
   */
  reportStageSize(tabId: string, maxDimension: number): void {
    this.pushDemand(tabId, this.visibleTabId === tabId, maxDimension)
  }

  /**
   * Read the input grant for this machine.
   *
   * Never cached: a person who turns it on while the panel is open must see the
   * panel come alive on the next check, and a stale "yes" is the one answer that
   * would make every tap silently do nothing.
   */
  async checkInputPermission(): Promise<DisplayInputPermission | null> {
    try {
      const permission = await invoke('display:inputPermission')
      this.inputPermission = permission
      return permission
    } catch (error: unknown) {
      logRendererError('The input permission could not be read', error)
      return null
    }
  }

  /** Raise the system's own prompt for that grant, then keep what it answered. */
  async requestInputPermission(): Promise<DisplayInputPermission | null> {
    if (this.requestingPermission) return this.inputPermission
    this.requestingPermission = true
    try {
      const permission = await invoke('display:requestInputPermission')
      this.inputPermission = permission
      return permission
    } catch (error: unknown) {
      logRendererError('The input permission could not be requested', error)
      return null
    } finally {
      this.requestingPermission = false
    }
  }

  /** Open the settings pane that owns the grant, where the platform has one. */
  openInputSettings(): void {
    void invoke('display:openInputSettings').catch((error: unknown) =>
      logRendererError('The permission settings could not be opened', error)
    )
  }

  /** Press one of the target's own buttons. */
  control(tabId: string, action: DisplayControlAction): void {
    const session = this.sessions[tabId]
    if (!session) return
    void invoke('display:control', session.sessionId, action).catch((error: unknown) =>
      logRendererError(`The display control "${action}" failed`, error)
    )
  }

  /**
   * Work the target's screen: a tap, a drag, a typed word.
   *
   * Fire and forget, like a finger: the frame that comes back is the receipt, so
   * a gesture that fails says so in the log rather than in a dialog in front of
   * the picture the user is watching.
   */
  sendInput(tabId: string, gesture: DisplayInputGesture): void {
    const session = this.sessions[tabId]
    if (!session) return
    void invoke('display:input', session.sessionId, gesture).catch((error: unknown) =>
      logRendererError(`The display gesture "${gesture.type}" failed`, error)
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
