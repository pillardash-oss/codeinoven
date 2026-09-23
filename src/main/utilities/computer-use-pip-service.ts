import { BrowserWindow, nativeImage } from 'electron'
import type {
  ComputerUseActivity,
  ComputerUsePipCursor,
  ComputerUsePipFrame,
  ComputerUsePipState,
  PermissionLevel
} from '../../lib/types'
import type { CuaOperationEvent } from './utility-orchestration-service'
import { CuaBridgeService } from './cua-bridge-service'
import { StdioMcpClient, type McpClient } from '../agents/mcp-stdio-client'
import type { StorageEngine } from '../storage/storage-engine'
import { Logger } from '../system/logger'
import { sendToRenderer } from '../ipc/renderer-delivery'

const TARGET_FRAME_RATE = 15
const FRAME_INTERVAL_MS = Math.round(1_000 / TARGET_FRAME_RATE)
const MAX_MISSES = TARGET_FRAME_RATE
const AUTO_DISMISS_GRACE_MS = 3_000
/** The default capture ceiling. The overlay's default preview is 224 CSS px
 *  wide, which is exactly this many device pixels on a 2x display, so the
 *  default footprint stays pixel-perfect without paying for anything larger. */
const BASE_FRAME_DIMENSION = 448
/** Hard ceiling for the capture. Measured against real screen frames, going
 *  past this buys no visible fidelity (896 = 39.25 dB, 1344 = 39.44 dB against
 *  a native-resolution reference at the same display size) while quadrupling
 *  both the per-frame encode cost and the bytes streamed over IPC. */
const MAX_FRAME_DIMENSION = 896
const JPEG_QUALITY = 78
const MAX_CURSOR_POINT_NODES = 32
const CURSOR_POINT_CONTAINER_KEYS = [
  'position',
  'screen_position',
  'screenPosition',
  'coordinates'
] as const

interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

interface WindowRecord {
  window_id: number
  app_name?: string
  title?: string
  is_on_screen?: boolean
  on_current_space?: boolean | null
  z_index?: number | null
  bounds?: WindowBounds
}

interface CursorPosition {
  x: number
  y: number
  visible?: boolean
}

/**
 * Floating PiP monitor for computer use. The utility orchestration service
 * notifies this service whenever an agent drives an app through the Cua
 * driver; the service then latches onto that pid, polls its frontmost window,
 * and streams bounded JPEG frames to the renderer for an always-visible overlay.
 *
 * It also owns the per-thread computer-use activity mirror that thread rows
 * consume. That mirror is deliberately independent of the overlay: the overlay
 * needs a capturable window, while a desktop-scoped run (`get_desktop_state`,
 * `escalate_session`, a desktop `hotkey`) has no pid at all and must still be
 * visible in the thread list.
 */
export class ComputerUsePipService {
  private readonly cuaBridge: CuaBridgeService
  private client: McpClient | null = null
  /** The tier the cached client was spawned for; its launch environment fixes it. */
  private clientPermissionLevel: PermissionLevel | null = null
  /** The daemon claim this overlay holds, so a release never drops another's. */
  private claimedDaemonKey: string | null = null
  private targetPid: number | null = null
  private appName = ''
  private windowId: number | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private active = false
  private misses = 0
  private captureInFlight = false
  /**
   * Bumped by every teardown, so a capture that resumes after one never revives
   * the run it was started for: its client and daemon hold were already released.
   */
  private runGeneration = 0
  private ownerThreadId: string | null = null
  private targetSessionId: string | null = null
  /**
   * The tier the tracked run runs at, taken from the operation that latched the
   * overlay. The driver's authorization mode is a daemon-wide, start-time
   * property, so the monitor has to ask for the same one the run already owns
   * instead of pinning a mode of its own.
   */
  private targetPermissionLevel: PermissionLevel = 'auto_review'
  private cursor: ComputerUsePipCursor | null = null
  private dismissedThreadId: string | null = null
  /** Device pixels of preview the renderer is about to paint, as reported by
   *  the overlay. The capture is scaled to cover it so a scaled-up preview is
   *  never a magnified small frame. Null until the overlay reports. */
  private requestedFrameWidth: number | null = null
  private autoDismissTimer: ReturnType<typeof setTimeout> | null = null
  /** Threads whose agent is currently driving the computer, keyed by thread id.
   *  Bounded by the threads running computer use right now: an entry is dropped
   *  as soon as that thread's turn ends. */
  private readonly activityByThread = new Map<string, ComputerUseActivity>()

  constructor(private readonly storage: StorageEngine) {
    this.cuaBridge = new CuaBridgeService(storage)
  }

  /**
   * Called for every computer-use operation an agent performs. The activity
   * mirror is updated unconditionally; window tracking only starts when the
   * operation named a target process.
   */
  onActivity(event: CuaOperationEvent): void {
    this.recordActivity(event)
    if (event.pid !== null) {
      void this.track(event.pid, event.threadId, event.sessionId, event.permissionLevel)
    }
  }

  /** Every thread whose agent is currently driving the computer. */
  getActivitySnapshot(): ComputerUseActivity[] {
    return [...this.activityByThread.values()]
  }

  private recordActivity(event: CuaOperationEvent): void {
    const activity: ComputerUseActivity = {
      threadId: event.threadId,
      active: true,
      at: Date.now(),
      operation: event.operation,
      ...(event.pid !== null ? { pid: event.pid } : {})
    }
    this.activityByThread.set(event.threadId, activity)
    this.broadcast('computerUse:activity', activity)
  }

  /** Mark a thread's computer-use activity over and tell the renderer to drop
   *  its row indicator. */
  private clearActivity(threadId: string): void {
    const existing = this.activityByThread.get(threadId)
    if (!existing) return
    this.activityByThread.delete(threadId)
    this.broadcast('computerUse:activity', {
      threadId,
      active: false,
      at: existing.at,
      ...(existing.operation ? { operation: existing.operation } : {})
    } satisfies ComputerUseActivity)
  }

  /** Latch onto the app (pid) a thread's agent is currently driving. */
  private async track(
    pid: number,
    threadId: string,
    sessionId: string | undefined,
    permissionLevel: PermissionLevel
  ): Promise<void> {
    if (!Number.isInteger(pid) || pid <= 0) return
    this.clearAutoDismiss()
    // The user closed the overlay this turn   keep it hidden for the rest of
    // the turn; only the next agent turn (after a new user message) re-enables it.
    if (this.dismissedThreadId === threadId) return
    const targetChanged =
      this.targetPid !== pid || this.targetSessionId !== (sessionId ?? null) || !this.active
    this.ownerThreadId = threadId
    this.targetSessionId = sessionId ?? null
    this.targetPermissionLevel = permissionLevel
    if (targetChanged) this.cursor = null
    if (this.active && this.targetPid === pid) return
    this.targetPid = pid
    this.misses = 0
    this.active = true
    this.broadcastState()
    await this.captureOnce()
    this.ensureLoop()
  }

  /**
   * Bring the tracked app to the foreground (used by the PiP click).
   *
   * Activation alone does NOT raise the window. Measured against the driver:
   * `bring_to_front` takes the foreground (the target pid does become the
   * frontmost app, which is the focus flicker users report) while the window
   * stays exactly where it was. The target app's own `Window > Bring All to
   * Front` menu item is what orders its windows front, so the click runs both
   * and then verifies the result through the driver's frontmost flag.
   *
   * The window id is re-resolved here instead of trusted from the capture loop:
   * the driver fronts the OWNER of whatever window id it is given, so a stale id
   * (a failed capture for a new target leaves the previous target's id in place)
   * would raise a different app than the one this preview is showing.
   */
  async bringToFront(): Promise<void> {
    const pid = this.targetPid
    if (pid === null || !this.active) return
    const client = await this.ensureClient()
    const windows = await this.listWindows(client, pid)
    const target =
      windows.find((window) => window.window_id === this.windowId) ??
      rankWindows(windows)[0] ??
      null
    const windowId = target?.window_id ?? null
    const activation = await this.callOutcome(client, 'bring_to_front', {
      pid,
      ...(windowId !== null ? { window_id: windowId } : {})
    })
    const raise =
      windowId === null
        ? 'skipped: no window to name'
        : await this.callOutcome(client, 'invoke_menu', {
            pid,
            window_id: windowId,
            path: ['Window', 'Bring All to Front']
          })
    const frontmost = await this.isFrontmost(client, pid)
    Logger.dev('Computer-use PiP bring-to-front', {
      pid,
      windowId,
      windowOnScreen: target?.is_on_screen ?? null,
      windowOnCurrentSpace: target?.on_current_space ?? null,
      activation,
      raise,
      frontmost
    })
    if (frontmost === false) {
      Logger.error('Computer-use PiP could not bring the tracked app to the front:', {
        pid,
        windowId,
        activation,
        raise
      })
    }
  }

  /** Stop tracking and hide the PiP (user-requested close). */
  async dismiss(): Promise<void> {
    this.dismissedThreadId = this.ownerThreadId
    await this.hide()
  }

  /**
   * Called when a thread's agent turn begins (a user message was accepted).
   * Clears the user's close so the next turn may show the PiP again if CUA is
   * used, cancels a pending auto-dismiss from a just-finished turn, and drops
   * any computer-use activity a crashed previous turn never cleared.
   */
  notifyTurnStarted(threadId: string): void {
    if (this.dismissedThreadId === threadId) this.dismissedThreadId = null
    if (this.ownerThreadId === threadId) this.clearAutoDismiss()
    this.clearActivity(threadId)
  }

  /**
   * Called when a thread's utility turn ends. The thread's computer-use
   * activity ends with it, and if that thread owns the PiP the overlay is
   * hidden shortly after so it never lingers past the run.
   */
  notifyTurnEnded(threadId: string): void {
    this.clearActivity(threadId)
    if (!this.active || this.ownerThreadId !== threadId) return
    this.clearAutoDismiss()
    this.autoDismissTimer = setTimeout(() => {
      this.autoDismissTimer = null
      void this.hide()
    }, AUTO_DISMISS_GRACE_MS)
  }

  /**
   * Tear down the overlay without touching the user's per-turn close marker.
   *
   * The driver client and the daemon claim go with it: the overlay is a live
   * view of one run, so keeping one Cua MCP server for the whole app lifetime
   * would hold a daemon open for as long as CodeInOven runs.
   */
  private async hide(): Promise<void> {
    const wasActive = this.active
    this.active = false
    this.runGeneration += 1
    this.targetPid = null
    this.appName = ''
    this.windowId = null
    this.misses = 0
    this.ownerThreadId = null
    this.targetSessionId = null
    this.cursor = null
    this.clearAutoDismiss()
    this.clearLoop()
    const client = this.client
    this.client = null
    this.clientPermissionLevel = null
    if (client) await client.close().catch(() => undefined)
    await this.releaseDaemonClaim()
    if (wasActive) this.broadcastState()
  }

  private clearAutoDismiss(): void {
    if (this.autoDismissTimer) {
      clearTimeout(this.autoDismissTimer)
      this.autoDismissTimer = null
    }
  }

  getState(): ComputerUsePipState {
    return this.active && this.targetPid !== null
      ? {
          active: true,
          pid: this.targetPid,
          appName: this.appName,
          threadId: this.ownerThreadId ?? undefined
        }
      : { active: false }
  }

  async dispose(): Promise<void> {
    this.clearAutoDismiss()
    this.active = false
    this.runGeneration += 1
    this.clearLoop()
    const client = this.client
    this.client = null
    this.clientPermissionLevel = null
    if (client) await client.close().catch(() => undefined)
    await this.releaseDaemonClaim()
  }

  private ensureLoop(): void {
    if (this.timer || !this.active) return
    this.timer = setInterval(() => {
      void this.captureOnce()
    }, FRAME_INTERVAL_MS)
  }

  private clearLoop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async ensureClient(): Promise<McpClient> {
    const level = this.targetPermissionLevel
    if (this.client && this.clientPermissionLevel === level) return this.client
    const generation = this.runGeneration
    if (this.client) {
      // A client's tier is fixed by the environment it was spawned with, so a
      // run at a different tier needs its own driver process.
      const stale = this.client
      this.client = null
      this.clientPermissionLevel = null
      await stale.close().catch(() => undefined)
    }
    await this.claimDaemon(level)
    const resolved = await this.cuaBridge.resolveUtility('codeinoven-pip', level)
    if (!resolved) throw new Error('Cua Driver is not available for the PiP monitor')
    const utility = resolved.utility
    if (utility.kind !== 'mcp' || !utility.config.command) {
      throw new Error('Cua MCP command is unavailable for the PiP monitor')
    }
    const client = await StdioMcpClient.connect(
      utility.config.command,
      utility.config.args ?? [],
      utility.config.environment ?? {}
    )
    if (this.runGeneration !== generation) {
      // The overlay was dismissed (or the app is quitting) while this client was
      // connecting. Releasing here keeps a client and a daemon hold from
      // outliving the run they were created for.
      await this.releaseDaemonClaim()
      await client.close().catch(() => undefined)
      throw new Error('The computer-use preview ended while connecting to Cua Driver')
    }
    this.client = client
    this.clientPermissionLevel = level
    return client
  }

  /**
   * Hold the shared Cua daemon for as long as this overlay is up.
   *
   * The agent's turn releases its own claim when it ends, and an idle
   * unrestricted daemon is stopped at that point   so the preview has to own a
   * claim of its own or its frames would fail for the rest of the dismissal
   * grace period.
   */
  private async claimDaemon(level: PermissionLevel): Promise<void> {
    const key = `pip:${this.targetSessionId ?? this.ownerThreadId ?? 'unowned'}`
    if (this.claimedDaemonKey === key) return
    await this.releaseDaemonClaim()
    await this.cuaBridge.claimDaemonMode(level, key)
    this.claimedDaemonKey = key
  }

  private async releaseDaemonClaim(): Promise<void> {
    const key = this.claimedDaemonKey
    if (!key) return
    this.claimedDaemonKey = null
    await this.cuaBridge.releaseDaemonClaim(key).catch((error: unknown) => {
      Logger.dev('Computer-use PiP daemon claim release failed:', error)
    })
  }

  private async captureOnce(): Promise<void> {
    if (!this.active || this.targetPid === null || this.captureInFlight) return
    this.captureInFlight = true
    const pid = this.targetPid
    const sessionId = this.targetSessionId
    try {
      const client = await this.ensureClient()
      const window = await this.frontmostWindow(client, pid)
      if (!window) {
        this.missFrame(`pid ${pid} has no capturable top-level window`)
        return
      }
      this.appName = window.app_name || this.appName || 'App'
      this.windowId = window.window_id
      // The window capture deliberately runs WITHOUT the agent's session. The
      // driver refuses window-scope tools on a session the agent escalated to
      // desktop scope ("window-scope tool 'get_window_state' is disabled while
      // session '<id>' is in desktop scope"), which silently killed every frame
      // of a desktop-scope run. The agent cursor is still read from that session
      // below, and `get_agent_cursor_state` works in either scope.
      const screenshotRequest = client.callTool('get_window_state', {
        pid,
        window_id: window.window_id,
        include_screenshot: true,
        max_elements: 1
      })
      const cursorRequest = sessionId
        ? client.callTool('get_agent_cursor_state', { session: sessionId })
        : Promise.resolve(null)
      const [screenshotResult, cursorResult] = await Promise.allSettled([
        screenshotRequest,
        cursorRequest
      ])
      const image =
        screenshotResult.status === 'fulfilled' ? extractImage(screenshotResult.value) : null
      if (!image) {
        // A refused capture resolves with `isError: true` instead of rejecting,
        // so this has to be accounted for here   returning quietly left the
        // overlay latched as active with no frame to show, and the UI is gated
        // on having a frame.
        this.missFrame(
          `the driver returned no screenshot for window ${window.window_id}`,
          screenshotResult
        )
        return
      }
      this.misses = 0
      const optimizedImage = optimizeImage(image, this.frameCap())
      if (cursorResult.status === 'fulfilled') {
        const cursorPosition = extractCursorPosition(cursorResult.value)
        if (cursorPosition) {
          const projectedCursor = projectCursor(cursorPosition, window, optimizedImage)
          if (projectedCursor) this.cursor = projectedCursor
        }
      }
      // The overlay may have been dismissed (or re-targeted) while we awaited
      // the driver   never resurrect it with a stale frame.
      if (!this.active || this.targetPid !== pid || this.targetSessionId !== sessionId) return
      const frame: ComputerUsePipFrame = {
        pid,
        appName: this.appName,
        windowId: window.window_id,
        dataUrl: optimizedImage.dataUrl,
        width: optimizedImage.width,
        height: optimizedImage.height,
        timestamp: Date.now(),
        ...(this.cursor ? { cursor: this.cursor } : {})
      }
      this.broadcast('computerUse:pipFrame', frame)
    } catch (error) {
      Logger.error('computer-use PiP capture failed:', error)
      if (!this.active || this.targetPid !== pid) return
      this.misses += 1
      if (this.misses >= MAX_MISSES) {
        await this.hide()
      }
    } finally {
      this.captureInFlight = false
    }
  }

  /**
   * Account for one frame the monitor could not render. The overlay only mounts
   * once it has a frame, so a capture that keeps failing must age out exactly
   * like a missing window does   otherwise the service reports itself active
   * with nothing to show and the user is left with no PiP and no explanation.
   * The reason is logged once per run of failures, never per frame (the loop
   * runs at 15 fps).
   */
  private missFrame(reason: string, failure?: PromiseSettledResult<unknown>): void {
    this.misses += 1
    if (this.misses === 1) {
      const detail = failure ? settledFailureText(failure) : null
      Logger.dev(`Computer-use PiP frame unavailable: ${reason}.${detail ? ` ${detail}` : ''}`)
    }
    if (this.misses >= MAX_MISSES) void this.hide()
  }

  /**
   * Renderer-reported demand: how many device pixels wide the preview is about
   * to be painted. The capture is sized to cover it, clamped between the default
   * footprint and the measured ceiling, so scaling the preview up adds real
   * pixels instead of magnifying the default frame.
   */
  setRequestedFrameWidth(deviceWidth: number): void {
    this.requestedFrameWidth = deviceWidth
  }

  /** The resize ceiling for the next capture. */
  private frameCap(): number {
    return frameCapFor(this.requestedFrameWidth)
  }

  private async frontmostWindow(client: McpClient, pid: number): Promise<WindowRecord | null> {
    return rankWindows(await this.listWindows(client, pid))[0] ?? null
  }

  /** The tracked pid's current top-level windows, freshly resolved. */
  private async listWindows(client: McpClient, pid: number): Promise<WindowRecord[]> {
    return extractWindows(await client.callTool('list_windows', { pid }))
  }

  /**
   * Run one driver tool call and describe its outcome for the click log. A
   * refused call RESOLVES with `isError: true` instead of rejecting, so both
   * shapes have to be read here.
   */
  private async callOutcome(
    client: McpClient,
    name: string,
    input: Record<string, unknown>
  ): Promise<string> {
    try {
      const refusal = refusalText(await client.callTool(name, input))
      return refusal ?? 'ok'
    } catch (error) {
      return `failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  /**
   * Whether the driver reports this pid as the system-frontmost app. The only
   * trustworthy activation read the driver exposes: `bring_to_front` answers
   * `activated: true` even for a window id that no longer exists.
   */
  private async isFrontmost(client: McpClient, pid: number): Promise<boolean | null> {
    try {
      return extractAppActive(await client.callTool('list_apps', {}), pid)
    } catch (error) {
      Logger.dev('Computer-use PiP frontmost check failed:', error)
      return null
    }
  }

  private broadcastState(): void {
    this.broadcast('computerUse:pipState', this.getState())
  }

  private broadcast(
    channel: 'computerUse:pipFrame' | 'computerUse:pipState' | 'computerUse:activity',
    payload: unknown
  ): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        sendToRenderer(win.webContents, channel, payload)
      }
    }
  }
}

/**
 * The driver's own explanation when a tool call resolves with `isError: true`,
 * or null when the call succeeded. Bounded: the text can be an AX-tree dump.
 */
function refusalText(result: unknown): string | null {
  if (!isRecord(result) || result['isError'] !== true) return null
  const content = result['content']
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!isRecord(item) || item['type'] !== 'text') continue
      const text = item['text']
      if (typeof text === 'string' && text.length > 0) {
        return text.length > 200 ? `${text.slice(0, 200)}...` : text
      }
    }
  }
  return 'refused without a reason'
}

/** `active` for one pid from a `list_apps` result, or null when it is absent. */
function extractAppActive(result: unknown, pid: number): boolean | null {
  const apps = recordValue(recordValue(result)['structuredContent'])['apps']
  if (!Array.isArray(apps)) return null
  for (const value of apps) {
    if (!isRecord(value) || value['pid'] !== pid) continue
    return value['active'] === true
  }
  return null
}

/**
 * A pid's windows frontmost-first. On-screen windows win over off-screen ones
 * and the driver's z-order breaks the tie; the driver refuses pid-only
 * activation for a multi-window app, so callers must name one of these.
 */
function rankWindows(windows: WindowRecord[]): WindowRecord[] {
  const visible = windows.filter((window) => window.is_on_screen !== false)
  const candidates = visible.length > 0 ? visible : windows
  return [...candidates].sort((left, right) => {
    const leftIndex = typeof left.z_index === 'number' ? left.z_index : -1
    const rightIndex = typeof right.z_index === 'number' ? right.z_index : -1
    if (leftIndex !== rightIndex) return rightIndex - leftIndex
    return Number(Boolean(left.is_on_screen)) - Number(Boolean(right.is_on_screen))
  })
}

function extractWindows(result: unknown): WindowRecord[] {
  const structured = recordValue(result)['structuredContent']
  const windows = recordValue(structured)['windows']
  if (!Array.isArray(windows)) return []
  return windows.flatMap((value) => {
    if (!isRecord(value) || typeof value['window_id'] !== 'number') return []
    const record: WindowRecord = { window_id: value['window_id'] }
    if (typeof value['app_name'] === 'string') record.app_name = value['app_name']
    if (typeof value['title'] === 'string') record.title = value['title']
    if (typeof value['is_on_screen'] === 'boolean') record.is_on_screen = value['is_on_screen']
    if (typeof value['on_current_space'] === 'boolean' || value['on_current_space'] === null) {
      record.on_current_space = value['on_current_space']
    }
    if (typeof value['z_index'] === 'number') record.z_index = value['z_index']
    const bounds = recordValue(value['bounds'])
    const x = Number(bounds['x'])
    const y = Number(bounds['y'])
    const width = Number(bounds['width'])
    const height = Number(bounds['height'])
    if ([x, y, width, height].every(Number.isFinite) && width > 0 && height > 0) {
      record.bounds = { x, y, width, height }
    }
    return [record]
  })
}

function extractImage(result: unknown): { dataUrl: string; width: number; height: number } | null {
  if (!isRecord(result)) return null
  const content = Array.isArray(result['content']) ? result['content'] : []
  for (const item of content) {
    if (!isRecord(item) || item['type'] !== 'image') continue
    const data = item['data']
    if (typeof data !== 'string' || data.length === 0) continue
    const mimeType = typeof item['mimeType'] === 'string' ? item['mimeType'] : 'image/png'
    const structured = recordValue(result['structuredContent'])
    const width = Number(structured['screenshot_width']) || 0
    const height = Number(structured['screenshot_height']) || 0
    return {
      dataUrl: `data:${mimeType};base64,${data}`,
      width,
      height
    }
  }
  return null
}

/**
 * The capture ceiling for a renderer-requested device width. Exported because it
 * is the whole of the sharpness policy: the overlay reports the device pixels it
 * paints and this clamps that into the range worth encoding. Unknown demand keeps
 * the default footprint, which is already exact on a 2x display.
 */
export function frameCapFor(requestedFrameWidth: number | null): number {
  if (requestedFrameWidth === null || !Number.isFinite(requestedFrameWidth)) {
    return BASE_FRAME_DIMENSION
  }
  return Math.round(
    Math.min(MAX_FRAME_DIMENSION, Math.max(BASE_FRAME_DIMENSION, requestedFrameWidth))
  )
}

function optimizeImage(
  image: { dataUrl: string; width: number; height: number },
  cap: number
): {
  dataUrl: string
  width: number
  height: number
} {
  try {
    const source = nativeImage.createFromDataURL(image.dataUrl)
    if (source.isEmpty()) return image
    const sourceSize = source.getSize()
    const width = sourceSize.width || image.width
    const height = sourceSize.height || image.height
    if (width <= 0 || height <= 0) return image
    const scale = Math.min(1, cap / Math.max(width, height))
    const resized =
      scale < 1
        ? source.resize({
            width: Math.max(1, Math.round(width * scale)),
            height: Math.max(1, Math.round(height * scale))
          })
        : source
    const size = resized.getSize()
    const encoded = resized.toJPEG(JPEG_QUALITY)
    return {
      dataUrl: `data:image/jpeg;base64,${encoded.toString('base64')}`,
      width: size.width,
      height: size.height
    }
  } catch (error) {
    Logger.dev('Computer-use PiP frame optimization failed; using source image:', error)
    return image
  }
}

/**
 * Human-readable reason a driver call produced no frame: the rejection
 * message, or the driver's own explanation on a resolved `isError` result
 * (refused window captures arrive that way rather than as a rejection).
 * Bounded because an AX-tree text block can be very large.
 */
function settledFailureText(result: PromiseSettledResult<unknown>): string | null {
  if (result.status === 'rejected') {
    const reason = result.reason
    return reason instanceof Error ? reason.message : String(reason)
  }
  const content = recordValue(result.value)['content']
  if (!Array.isArray(content)) return null
  for (const item of content) {
    if (!isRecord(item) || item['type'] !== 'text') continue
    const text = item['text']
    if (typeof text === 'string' && text.length > 0) {
      return text.length > 240 ? `${text.slice(0, 240)}...` : text
    }
  }
  return null
}

function extractCursorPosition(result: unknown): CursorPosition | null {
  const structured = recordValue(result)['structuredContent']
  const roots = [structured, result]
  for (const root of roots) {
    const record = recordValue(root)
    const point = firstPoint([
      record['position'],
      record['screen_position'],
      record['screenPosition'],
      record['coordinates'],
      record['cursor_position'],
      record['cursor'],
      record
    ])
    if (!point) continue
    const visible = booleanValue(record['visible']) ?? booleanValue(record['enabled'])
    return { ...point, ...(visible === undefined ? {} : { visible }) }
  }
  return null
}

function firstPoint(values: unknown[]): { x: number; y: number } | null {
  for (const value of values) {
    const point = pointValue(value)
    if (point) return point
  }
  return null
}

function pointValue(value: unknown): { x: number; y: number } | null {
  const pending: unknown[] = [value]
  const visited = new Set<object>()
  let examined = 0

  while (pending.length > 0 && examined < MAX_CURSOR_POINT_NODES) {
    const current = pending.pop()
    if (Array.isArray(current)) {
      if (current.length < 2) continue
      const x = Number(current[0])
      const y = Number(current[1])
      if (Number.isFinite(x) && Number.isFinite(y)) return { x, y }
      continue
    }
    if (!isRecord(current) || visited.has(current)) continue
    visited.add(current)
    examined += 1

    const x = Number(current['x'])
    const y = Number(current['y'])
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y }

    for (let index = CURSOR_POINT_CONTAINER_KEYS.length - 1; index >= 0; index -= 1) {
      const nested = current[CURSOR_POINT_CONTAINER_KEYS[index]]
      if (nested !== undefined && nested !== null) pending.push(nested)
    }
  }
  return null
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function projectCursor(
  position: CursorPosition,
  window: WindowRecord,
  image: { width: number; height: number }
): ComputerUsePipCursor | null {
  const bounds = window.bounds
  if (!bounds || image.width <= 0 || image.height <= 0) return null
  const x = ((position.x - bounds.x) / bounds.width) * image.width
  const y = ((position.y - bounds.y) / bounds.height) * image.height
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return {
    visible: position.visible !== false,
    x: Math.min(Math.max(0, x), image.width),
    y: Math.min(Math.max(0, y), image.height)
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
