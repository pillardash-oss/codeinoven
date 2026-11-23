import { BrowserWindow } from 'electron'
import {
  DISPLAY_CONTROLS_BY_KIND,
  type DisplayCapturePhase,
  type DisplayCaptureState,
  type DisplayControlAction,
  type DisplayControlOutcome,
  type DisplayFrame,
  type DisplayFrameDemand,
  type DisplayInputGesture,
  type DisplaySessionRequest,
  type DisplaySourceKind,
  type DisplaySourceListing
} from '../../lib/ipc/display'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { appServiceRegistry } from '../system/app-service-registry'
import { Logger } from '../system/logger'
import { AndroidDisplayCapture, ANDROID_CREDENTIAL_NOTICE, listAndroidSources } from './display-adb'
import { resolveAdb } from './display-adb-paths'
import { quantizeDemand, type DisplayCapture } from './display-capture'
import { DesktopDisplayCapture, listDesktopSources } from './display-desktop'
import { IosDisplayCapture, listIosSources } from './display-ios'
import { startDisplayStream, type DisplayStreamHandle } from './stream/display-stream-process'

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
 * screenshot is one child process and a socket read (a couple of frames a second
 * is the honest ceiling), while a desktop capture is a window enumeration plus an
 * encode in a worker.
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
/** A frame whose capture took longer than this is reported, so the source's cost
 *  stays a measured number instead of a guess. */
const SLOW_CAPTURE_MS = 250
/** Ceiling for the backoff, so a device that comes back is noticed within seconds. */
const MAX_RETRY_MS = 8_000
/** Failures before a session calls itself failed rather than retrying. */
const FAILED_AFTER = 8
/** How long a hidden stage keeps its device stream before it is shut down. */
const STREAM_HIDE_GRACE_MS = 5_000
/** How long a changed stage size settles before the stream is rebuilt at it. */
const STREAM_RESIZE_DEBOUNCE_MS = 1_000
/** A rebuild costs about a second of live picture, so the stage has to outgrow the
 *  encode, or shrink well below it, before one is worth it. The canvas scales the rest. */
const STREAM_GROW_RATIO = 1.2
const STREAM_SHRINK_RATIO = 0.6
/** Let the stage's first size arrive so the stream starts at it, not at the default. */
const STREAM_START_DELAY_MS = 80
/** A stream that never went live is retried this many times before the session polls. */
const STREAM_START_ATTEMPTS = 3
/** A stream that went live and then died is re-armed this many times, so a device
 * that comes back (an emulator rebooting, a cable replugged) restores the mirror by
 * itself instead of leaving the tab on the polled capture for the rest of its life. */
const STREAM_REARM_ATTEMPTS = 20
/** How long to wait before retrying a stream that could not start. */
const STREAM_RETRY_MS = 400
/** The first re-arm gap, and its ceiling: a device that takes a minute to come back
 * is still picked up, while a stream that keeps dying settles at one try per 8s. */
const STREAM_REARM_MS = 2_000
const STREAM_REARM_MAX_MS = 8_000
/** How often a screen the panel is explaining is looked at again. A person who types
 *  their PIN takes seconds, and one adb query costs less than the frame beside it. */
const HINT_RECHECK_MS = 1_500

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
  /**
   * A sentence about the device's screen that is true only for a while.
   *
   * The lock screen of a phone with a PIN exists on the device and in no mirror, so
   * the panel can only say it is there. This process owns when it stops being true.
   */
  hint: string | null
  /** The pending re-check of `hint`, when one is armed. */
  hintTimer: ReturnType<typeof setTimeout> | null
  /** Frames delivered by this session, so the first one's cost is reported once. */
  frames: number
  disposed: boolean
  /** True while one `grab` is in flight, so a tick can never stack frames. */
  busy: boolean
  /** True when the capture adapter can be touched and typed into. */
  input: boolean
  /** Why it cannot be, when it cannot. */
  inputProblem: string | null
  /** The live video stream, while one is running. It replaces the capture tick. */
  stream: DisplayStreamHandle | null
  /** True while that stream is delivering video, false while it is still starting. */
  streamLive: boolean
  /** The size the running stream was asked to encode at. */
  streamSize: number
  /** True once a stream failed for this session: it stays on the polled capture. */
  streamBroken: boolean
  /** Stream starts since one last went live, so a flaky start is retried then given up. */
  streamStarts: number
  /** True once any stream of this session went live, so a dropped one keeps re-arming. */
  streamWasLive: boolean
  /** A pending stream start or retry. */
  streamTimer: ReturnType<typeof setTimeout> | null
  /** The grace period of a hidden stage. */
  hideTimer: ReturnType<typeof setTimeout> | null
  /** A size change waiting to settle. */
  resizeTimer: ReturnType<typeof setTimeout> | null
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
      demand: { maxDimension: 640, streamMaxDimension: 640, visible: true },
      timer: null,
      failures: 0,
      phase: 'starting',
      detail: null,
      hint: null,
      hintTimer: null,
      frames: 0,
      disposed: false,
      busy: false,
      input: Boolean(capture.input),
      inputProblem: capture.input ? null : (capture.inputProblem ?? null),
      stream: null,
      streamLive: false,
      streamSize: 0,
      streamBroken: false,
      streamStarts: 0,
      streamWasLive: false,
      streamTimer: null,
      hideTimer: null,
      resizeTimer: null
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
    if (this.canStream(session)) {
      session.streamTimer = setTimeout(() => {
        session.streamTimer = null
        this.beginStream(session)
      }, STREAM_START_DELAY_MS)
      return
    }
    this.schedule(session, 0)
  }

  /** Report the stage's size and whether anyone can see it. */
  setDemand(sessionId: string, demand: DisplayFrameDemand): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const maxDimension = quantizeDemand(demand.maxDimension)
    const streamMaxDimension = quantizeDemand(demand.streamMaxDimension)
    const wasPaused = !session.demand.visible
    session.demand = { maxDimension, streamMaxDimension, visible: demand.visible }
    // A tab that comes back on screen resumes watching a screen it was explaining.
    if (demand.visible) this.watchHint(session)
    if (this.canStream(session)) {
      this.followStreamDemand(session, wasPaused)
      return
    }
    // Coming back from a pause is the one case that should not wait for the idle
    // tick: the user just looked at the tab again.
    if (demand.visible && wasPaused) this.schedule(session, 0)
  }

  /** Only a device that speaks the scrcpy protocol streams; everything else polls. */
  private canStream(session: DisplaySession): boolean {
    return session.kind === 'android' && !session.streamBroken && resolveAdb() !== null
  }

  /**
   * Keep a device stream matched to its stage: shut it down after the stage has
   * been hidden for a while, bring it back when the stage returns, and rebuild it
   * when the stage settles at a different size (an encoder cannot be resized).
   */
  private followStreamDemand(session: DisplaySession, wasPaused: boolean): void {
    // Whatever was settling is judged again against the size just reported, so a
    // size that bounced back never costs a rebuild.
    if (session.resizeTimer) clearTimeout(session.resizeTimer)
    session.resizeTimer = null
    if (!session.demand.visible) {
      if (session.stream && !session.hideTimer) {
        session.hideTimer = setTimeout(() => {
          session.hideTimer = null
          this.endStream(session, 'hidden')
        }, STREAM_HIDE_GRACE_MS)
      }
      return
    }
    if (session.hideTimer) clearTimeout(session.hideTimer)
    session.hideTimer = null
    if (!session.stream) {
      if (session.streamTimer && !wasPaused) return
      if (session.streamTimer) clearTimeout(session.streamTimer)
      session.streamTimer = null
      this.beginStream(session)
      return
    }
    const wanted = session.demand.streamMaxDimension
    const outgrown = wanted > session.streamSize * STREAM_GROW_RATIO
    const oversized = wanted < session.streamSize * STREAM_SHRINK_RATIO
    if (!outgrown && !oversized) return
    session.resizeTimer = setTimeout(() => {
      session.resizeTimer = null
      this.endStream(session, 'resized')
      this.beginStream(session)
    }, STREAM_RESIZE_DEBOUNCE_MS)
  }

  /** Start the live video stream for a session, or fall back to the capture tick. */
  private beginStream(session: DisplaySession): void {
    if (session.disposed || session.stream) return
    const window = this.deps.window()
    const adb = resolveAdb()
    if (!window || window.isDestroyed() || !adb) {
      this.schedule(session, 0)
      return
    }
    session.streamSize = session.demand.streamMaxDimension
    session.streamLive = false
    session.stream = startDisplayStream({
      window,
      sessionId: session.id,
      adb,
      serial: session.sourceId,
      maxSize: session.streamSize,
      onLive: () => {
        if (session.disposed) return
        session.streamLive = true
        session.streamWasLive = true
        session.streamStarts = 0
        session.failures = 0
        session.detail = null
        this.setPhase(session, 'live')
      },
      onEnded: (detail) => {
        if (session.disposed || !session.stream) return
        session.stream = null
        // A stream that never painted is usually a start that lost a race on the
        // device, not a target that cannot stream, and one that painted and then
        // died is a device that went away. Either way the panel retries before it
        // settles for the much slower polled capture.
        session.streamStarts += 1
        const attempts = session.streamWasLive ? STREAM_REARM_ATTEMPTS : STREAM_START_ATTEMPTS
        const retry = session.streamStarts < attempts
        if (!retry) session.streamBroken = true
        Logger.dev(
          retry
            ? `Display stream for ${session.sourceId} ended, retrying: ${detail ?? ''}`
            : `Display stream for ${session.sourceId} ended, polling instead: ${detail ?? ''}`
        )
        if (retry) {
          const wait = session.streamWasLive
            ? Math.min(STREAM_REARM_MAX_MS, STREAM_REARM_MS * session.streamStarts)
            : STREAM_RETRY_MS
          session.streamTimer = setTimeout(() => {
            session.streamTimer = null
            if (!session.disposed && session.demand.visible) this.beginStream(session)
          }, wait)
        }
        this.schedule(session, 0)
      }
    })
    // A device can take ten seconds to start its encoder; one screenshot fills that.
    if (session.frames === 0 && !session.streamWasLive) this.schedule(session, 0)
  }

  /** Stop the running stream without ending the session. */
  private endStream(session: DisplaySession, reason: 'hidden' | 'resized' | 'stopped'): void {
    const stream = session.stream
    session.stream = null
    if (stream) Logger.dev(`Display stream for ${session.sourceId} stopping: ${reason}`)
    stream?.stop()
  }

  /**
   * Press one of the target's own buttons.
   *
   * Refused for an action the target's kind does not advertise, so the rail and
   * this boundary read the same list instead of two copies that can drift.
   */
  async control(sessionId: string, action: DisplayControlAction): Promise<DisplayControlOutcome> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('That display session is no longer open')
    if (!DISPLAY_CONTROLS_BY_KIND[session.kind].includes(action)) {
      throw new Error(`A ${session.kind} target has no "${action}" control`)
    }
    if (!session.capture.control) throw new Error('This target cannot be controlled')
    const outcome = await session.capture.control(action)
    // A button press changes the device, so its frame is asked for now instead of
    // at the next tick: the person pressed it to see what it did.
    if (!session.disposed) {
      // A press is the one moment the device's screen state is known, so the sentence
      // about it starts and ends here instead of on a timer nobody can stop.
      this.setHint(session, outcome?.credentialPrompt ? ANDROID_CREDENTIAL_NOTICE : null)
      this.schedule(session, 0)
    }
    return outcome ?? {}
  }

  /**
   * Say what the device's screen is waiting on, and watch until it is not.
   *
   * A notice about a lock screen is true of a moment: leaving the page, typing the
   * PIN, or tapping unlock on the device all end it. Re-asking the device is what
   * takes the sentence down, so it never outlives the screen it describes.
   */
  private setHint(session: DisplaySession, hint: string | null): void {
    const changed = session.hint !== hint
    session.hint = hint
    if (changed) this.broadcastState(session)
    this.watchHint(session)
  }

  /** Arm the next look at a screen the panel is explaining. */
  private watchHint(session: DisplaySession): void {
    if (session.hintTimer) clearTimeout(session.hintTimer)
    session.hintTimer = null
    // Nothing to watch, nothing to ask, or nobody looking: a hidden tab stops
    // querying the device and picks the watch up again when it is shown.
    if (!session.hint || session.disposed) return
    if (!session.capture.keyguardShowing) return
    if (!session.demand.visible) return
    session.hintTimer = setTimeout(() => {
      session.hintTimer = null
      void this.recheckHint(session)
    }, HINT_RECHECK_MS)
  }

  private async recheckHint(session: DisplaySession): Promise<void> {
    const probe = session.capture.keyguardShowing
    if (!session.hint || session.disposed || !probe) return
    let showing: boolean
    try {
      showing = await probe.call(session.capture)
    } catch {
      showing = false
    }
    if (session.disposed || !session.hint) return
    // The screen is still waiting, so the sentence is still true and stays up.
    if (showing) this.setHint(session, session.hint)
    else this.setHint(session, null)
  }

  /**
   * Work one target's own screen.
   *
   * A gesture is sent and then painted: the next frame is asked for immediately
   * instead of waiting out the session's cadence, because the whole point of
   * touching a mirrored device is seeing what the touch did.
   */
  async input(sessionId: string, gesture: DisplayInputGesture): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('That display session is no longer open')
    if (!session.capture.input) {
      throw new Error(session.inputProblem ?? 'This target cannot be controlled')
    }
    await session.capture.input(gesture)
    // A tap that lands while the stage is paused still deserves its frame: the
    // user is looking at the tab, and the demand tick only re-arms on focus.
    if (!session.disposed) this.schedule(session, 0)
  }

  /** Stop one session and forget it. Safe for an id that is already gone. */
  stop(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.disposed = true
    if (session.timer) clearTimeout(session.timer)
    session.timer = null
    for (const timer of [
      session.streamTimer,
      session.hideTimer,
      session.resizeTimer,
      session.hintTimer
    ]) {
      if (timer) clearTimeout(timer)
    }
    session.streamTimer = null
    session.hideTimer = null
    session.resizeTimer = null
    session.hintTimer = null
    this.endStream(session, 'stopped')
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
    // Not `did-start-loading`: that also fires for every iframe the page mounts (an
    // agent's artifact) and for in-page navigation, neither of which loses a stage.
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.dispose()
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
    // A running stream is the picture; the capture loop only covers for it, with one
    // screenshot while a first stream starts.
    if (session.stream && (session.streamLive || session.frames > 0)) return
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
      // A screenshot that lands after the stream came back is older than the video,
      // and the renderer reads any screenshot as "the stream is gone".
      if (session.disposed || (session.stream && session.streamLive)) return
      // A frame costs a capture and nothing else: the bytes the target produced are
      // the bytes the renderer paints, so there is no decode, resize, encode or
      // base64 conversion in this process to report on.
      const captureMs = Date.now() - grabStartedAt
      session.frames += 1
      if (captureMs > SLOW_CAPTURE_MS || session.frames === 1) {
        Logger.dev(
          `Display capture for ${session.kind} took ${captureMs} ms at ${session.demand.maxDimension}px (${image ? `${image.width}x${image.height} ${image.mime}` : 'nothing'})`
        )
      }
      if (!image) throw new Error('the target returned nothing to paint')
      session.failures = 0
      session.detail = null
      this.setPhase(session, 'live')
      const frame: DisplayFrame = {
        sessionId: session.id,
        tabId: session.tabId,
        bytes: image.bytes,
        mime: image.mime,
        width: image.width,
        height: image.height,
        timestamp: Date.now()
      }
      this.send('display:frame', frame, window)
      this.schedule(
        session,
        Math.max(MIN_CAPTURE_GAP_MS, TARGET_INTERVAL_MS[session.kind] - (Date.now() - startedAt))
      )
    } catch (error) {
      if (session.disposed || session.stream) return
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
      input: session.input,
      ...(session.inputProblem ? { inputProblem: session.inputProblem } : {}),
      ...(session.detail ? { detail: session.detail } : {}),
      ...(session.hint ? { hint: session.hint } : {})
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
