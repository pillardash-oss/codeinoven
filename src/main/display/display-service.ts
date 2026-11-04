import { BrowserWindow } from 'electron'
import {
  DISPLAY_CONTROLS_BY_KIND,
  type DisplayCapturePhase,
  type DisplayCaptureState,
  type DisplayControlAction,
  type DisplayFrame,
  type DisplayFrameDemand,
  type DisplaySessionRequest,
  type DisplaySourceKind,
  type DisplaySourceListing
} from '../../lib/ipc/display'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { appServiceRegistry } from '../system/app-service-registry'
import { Logger } from '../system/logger'
import { listAndroidSources, AndroidDisplayCapture } from './display-adb'
import { resolveAdb } from './display-adb-paths'
import { encodeDisplayFrame, quantizeDemand, type DisplayCapture } from './display-capture'
import { DesktopDisplayCapture, listDesktopSources } from './display-desktop'
import { IosDisplayCapture, listIosSources } from './display-ios'

/**
 * The display panel's main-process half.
 *
 * One session per open preview tab. A session owns a capture adapter, a cadence,
 * and a failure backoff; it produces a frame only while the stage is on screen,
 * and it tears the adapter down the moment the tab closes. Nothing here runs on a
 * timer for a panel nobody is looking at, which is the whole reason a session can
 * exist for as long as its tab does.
 *
 * Cadence is chosen per source kind from what a frame actually costs: a device
 * screenshot is a child process plus a PNG decode (roughly 2 frames a second is
 * the honest ceiling), while a desktop capture is a window enumeration.
 */
export interface DisplayServiceDeps {
  /** The window the frames are for. Null before the window exists, or after it closed. */
  window: () => BrowserWindow | null
}

/** How long one kind waits between frames. A budget, never a promise. */
const TARGET_INTERVAL_MS: Record<DisplaySourceKind, number> = {
  android: 400,
  ios: 450,
  'desktop-screen': 350,
  'desktop-window': 350
}
/** How often an on-screen-but-paused session looks again. Pausing is not stopping. */
const IDLE_POLL_MS = 600
/** Floor between two captures of one session. A source slower than its target
 *  interval (a simulator screenshot costs about a second) would otherwise be
 *  captured back to back for as long as the tab is open. */
const MIN_CAPTURE_GAP_MS = 250
/** First wait after a failure, doubled per consecutive failure. */
const RETRY_BASE_MS = 500
/** A frame whose decode plus encode costs more than this is reported, so the
 *  cost stays a measured number instead of a guess. */
const SLOW_ENCODE_MS = 60
/** Ceiling for the backoff, so a device that comes back is noticed within seconds. */
const MAX_RETRY_MS = 8_000
/** Failures before a session calls itself failed rather than retrying. */
const FAILED_AFTER = 8

interface DisplaySession {
  id: string
  tabId: string
  kind: DisplaySourceKind
  sourceId: string
  label: string
  capture: DisplayCapture
  demand: DisplayFrameDemand
  /** The pending scheduler tick, when one is armed. */
  timer: ReturnType<typeof setTimeout> | null
  failures: number
  phase: DisplayCapturePhase
  /** Detail shown for the last failure, cleared by the next good frame. */
  detail: string | null
  /** Frames delivered by this session, so the first one's cost is reported once. */
  frames: number
  disposed: boolean
  /** True while one `grab` is in flight, so a tick can never stack frames. */
  busy: boolean
}

export class DisplayService {
  private readonly sessions = new Map<string, DisplaySession>()
  private ipcRegistered = false

  /** True once the window's reload watch is attached. */
  private watchingWindow = false

  constructor(private readonly deps: DisplayServiceDeps) {}

  /** Every target one kind can offer right now. Read-only and never cached. */
  async listSources(kind: DisplaySourceKind): Promise<DisplaySourceListing> {
    try {
      if (kind === 'android') return await listAndroidSources()
      if (kind === 'ios') return await listIosSources()
      return await listDesktopSources(kind)
    } catch (error) {
      // A discovery failure is a listing with a reason, never a rejected call:
      // the picker has to be able to say what is wrong.
      Logger.dev(`Display sources for ${kind} could not be listed:`, error)
      return {
        kind,
        sources: [],
        problem: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /** Begin mirroring one target, replacing any session that id already had. */
  start(request: DisplaySessionRequest): void {
    this.stop(request.sessionId)
    const capture = this.createCapture(request)
    const session: DisplaySession = {
      id: request.sessionId,
      tabId: request.tabId,
      kind: request.kind,
      sourceId: request.sourceId,
      label: capture.label,
      capture,
      demand: { maxDimension: 640, visible: true },
      timer: null,
      failures: 0,
      phase: 'starting',
      detail: null,
      frames: 0,
      disposed: false,
      busy: false
    }
    this.sessions.set(session.id, session)
    this.watchWindowReload()
    appServiceRegistry.register({
      id: `display-preview:${session.id}`,
      kind: 'worker',
      name: `${session.label} preview`,
      detail: `Display panel · ${session.kind}`,
      scope: 'app',
      stop: () => this.stop(session.id)
    })
    this.broadcastState(session)
    this.schedule(session, 0)
  }

  /** Report the stage's size and whether anyone can see it. */
  setDemand(sessionId: string, demand: DisplayFrameDemand): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const maxDimension = quantizeDemand(demand.maxDimension)
    const wasPaused = !session.demand.visible
    session.demand = { maxDimension, visible: demand.visible }
    // Coming back from a pause is the one case that should not wait for the idle
    // tick: the user just looked at the tab again.
    if (demand.visible && wasPaused) this.schedule(session, 0)
  }

  /**
   * Press one of the target's own buttons.
   *
   * Refused for an action the target's kind does not advertise, so the rail and
   * this boundary read the same list instead of two copies that can drift.
   */
  async control(sessionId: string, action: DisplayControlAction): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('That display session is no longer open')
    if (!DISPLAY_CONTROLS_BY_KIND[session.kind].includes(action)) {
      throw new Error(`A ${session.kind} target has no "${action}" control`)
    }
    if (!session.capture.control) throw new Error('This target cannot be controlled')
    await session.capture.control(action)
  }

  /** Stop one session and forget it. Safe for an id that is already gone. */
  stop(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.disposed = true
    if (session.timer) clearTimeout(session.timer)
    session.timer = null
    try {
      session.capture.dispose()
    } catch (error) {
      Logger.dev('Display capture did not close cleanly:', error)
    }
    this.sessions.delete(sessionId)
    appServiceRegistry.unregister(`display-preview:${sessionId}`)
  }

  /** Stop every session. Called on quit, or when the window goes away. */
  dispose(): void {
    for (const id of [...this.sessions.keys()]) this.stop(id)
  }

  /**
   * A renderer reload starts a new page with no sessions of its own, so the old
   * ones would keep capturing for a stage that no longer exists. The page that
   * reloads is the only reader these frames have, so a reload ends them all; the
   * panel that comes back asks for its own.
   */
  private watchWindowReload(): void {
    if (this.watchingWindow) return
    this.watchingWindow = true
    const window = this.deps.window()
    const contents = window?.webContents
    if (!contents || contents.isDestroyed()) return
    contents.on('did-start-loading', () => {
      this.dispose()
    })
  }

  private createCapture(request: DisplaySessionRequest): DisplayCapture {
    if (request.kind === 'android') {
      const adb = resolveAdb()
      if (!adb) throw new Error('adb was not found, so the Android target cannot be read.')
      return new AndroidDisplayCapture(request.sourceId, request.sourceId, adb)
    }
    if (request.kind === 'ios') {
      return new IosDisplayCapture(request.sourceId, request.sourceId)
    }
    const label =
      request.kind === 'desktop-screen' ? 'Desktop screen' : `Window · ${request.sourceId}`
    return new DesktopDisplayCapture(request.kind, request.sourceId, label)
  }

  /**
   * Arm the next tick.
   *
   * `delay` 0 is used for the first frame, a resumed tab, and a fresh session:
   * the user is waiting to see something, so nothing is gained by waiting longer.
   */
  private schedule(session: DisplaySession, delay: number): void {
    if (session.disposed) return
    if (session.timer) clearTimeout(session.timer)
    session.timer = setTimeout(
      () => {
        session.timer = null
        void this.tick(session)
      },
      Math.max(0, delay)
    )
  }

  private async tick(session: DisplaySession): Promise<void> {
    if (session.disposed) return
    const window = this.deps.window()
    if (!window || window.isDestroyed()) {
      // No window means no stage: let go rather than capture for nobody.
      this.stop(session.id)
      return
    }
    // A hidden or minimised window is not on screen, whatever the stage reports.
    const onScreen = session.demand.visible && window.isVisible() && !window.isMinimized()
    if (!onScreen) {
      this.schedule(session, IDLE_POLL_MS)
      return
    }
    const startedAt = Date.now()
    try {
      const grabStartedAt = Date.now()
      const image = await session.capture.grab(session.demand.maxDimension)
      if (session.disposed) return
      const encodeStartedAt = Date.now()
      const encoded = image ? encodeDisplayFrame(image, session.demand.maxDimension) : null
      // Decoding a full-resolution device PNG and encoding a JPEG are the only
      // work this panel does on the main process, so their cost is reported
      // rather than assumed: a frame that decodes slowly is the signal that a
      // source needs to capture smaller, not a number to guess at.
      const encodeMs = Date.now() - encodeStartedAt
      session.frames += 1
      if (encodeMs > SLOW_ENCODE_MS || session.frames === 1) {
        Logger.dev(
          `Display frame for ${session.kind} took ${encodeMs} ms to decode and encode at ${session.demand.maxDimension}px (capture ${encodeStartedAt - grabStartedAt} ms)`
        )
      }
      if (!encoded) throw new Error('the target returned nothing to paint')
      session.failures = 0
      session.detail = null
      this.setPhase(session, 'live')
      const frame: DisplayFrame = {
        sessionId: session.id,
        tabId: session.tabId,
        dataUrl: encoded.dataUrl,
        width: encoded.width,
        height: encoded.height,
        timestamp: Date.now()
      }
      this.send('display:frame', frame, window)
      this.schedule(
        session,
        Math.max(MIN_CAPTURE_GAP_MS, TARGET_INTERVAL_MS[session.kind] - (Date.now() - startedAt))
      )
    } catch (error) {
      if (session.disposed) return
      this.fail(session, error)
    }
  }

  /** Account for a failed capture, announce it, and back off. */
  private fail(session: DisplaySession, error: unknown): void {
    session.failures += 1
    session.detail = error instanceof Error ? error.message : String(error)
    this.setPhase(session, session.failures >= FAILED_AFTER ? 'failed' : 'retrying')
    const backoff = Math.min(MAX_RETRY_MS, RETRY_BASE_MS * 2 ** (session.failures - 1))
    this.schedule(session, backoff)
  }

  /** Move a session's phase and tell the stage, once per real change. */
  private setPhase(session: DisplaySession, phase: DisplayCapturePhase): void {
    if (session.phase === phase && phase !== 'retrying') return
    session.phase = phase
    this.broadcastState(session)
  }

  private broadcastState(session: DisplaySession): void {
    const state: DisplayCaptureState = {
      sessionId: session.id,
      phase: session.phase,
      ...(session.detail ? { detail: session.detail } : {})
    }
    this.send('display:captureState', state, null)
  }

  /** Deliver one event to the session's window, or to every window when none is given. */
  private send(
    channel: 'display:frame' | 'display:captureState',
    payload: unknown,
    target: BrowserWindow | null
  ): void {
    if (target) {
      if (!target.isDestroyed()) sendToRenderer(target.webContents, channel, payload)
      return
    }
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        sendToRenderer(window.webContents, channel, payload)
      }
    }
  }
}
