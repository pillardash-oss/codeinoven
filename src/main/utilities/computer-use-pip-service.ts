import { BrowserWindow, nativeImage } from 'electron'
import type {
  ComputerUsePipCursor,
  ComputerUsePipFrame,
  ComputerUsePipState
} from '../../lib/types'
import { CuaBridgeService } from './cua-bridge-service'
import { StdioMcpClient, type McpClient } from '../agents/mcp-stdio-client'
import type { StorageEngine } from '../storage/storage-engine'
import { Logger } from '../system/logger'
import { sendToRenderer } from '../ipc/renderer-delivery'

const TARGET_FRAME_RATE = 15
const FRAME_INTERVAL_MS = Math.round(1_000 / TARGET_FRAME_RATE)
const MAX_MISSES = TARGET_FRAME_RATE
const AUTO_DISMISS_GRACE_MS = 3_000
const MAX_FRAME_DIMENSION = 448
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
 */
export class ComputerUsePipService {
  private readonly cuaBridge: CuaBridgeService
  private client: McpClient | null = null
  private targetPid: number | null = null
  private appName = ''
  private windowId: number | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private active = false
  private misses = 0
  private captureInFlight = false
  private ownerThreadId: string | null = null
  private targetSessionId: string | null = null
  private cursor: ComputerUsePipCursor | null = null
  private dismissedThreadId: string | null = null
  private autoDismissTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly storage: StorageEngine) {
    this.cuaBridge = new CuaBridgeService(storage)
  }

  /** Latch onto the app (pid) a thread's agent is currently driving. */
  async track(pid: number, threadId: string, sessionId?: string): Promise<void> {
    if (!Number.isInteger(pid) || pid <= 0) return
    this.clearAutoDismiss()
    // The user closed the overlay this turn — keep it hidden for the rest of
    // the turn; only the next agent turn (after a new user message) re-enables it.
    if (this.dismissedThreadId === threadId) return
    const targetChanged =
      this.targetPid !== pid || this.targetSessionId !== (sessionId ?? null) || !this.active
    this.ownerThreadId = threadId
    this.targetSessionId = sessionId ?? null
    if (targetChanged) this.cursor = null
    if (this.active && this.targetPid === pid) return
    this.targetPid = pid
    this.misses = 0
    this.active = true
    this.broadcastState()
    await this.captureOnce()
    this.ensureLoop()
  }

  /** Bring the tracked app to the foreground (used by the PiP click). */
  async bringToFront(): Promise<void> {
    const pid = this.targetPid
    if (pid === null || !this.active) return
    const client = await this.ensureClient()
    // The driver refuses pid-only activation when the app owns multiple
    // windows (ambiguous_window_target) — always front the exact tracked
    // window, falling back to the latest frontmost one.
    const windowId = this.windowId
    try {
      await client.callTool('bring_to_front', {
        pid,
        ...(windowId !== null ? { window_id: windowId } : {})
      })
    } catch {
      // windowId can be stale (window closed) — retry with pid-only app-level
      // activation so the click still pulls the app forward.
      await client.callTool('bring_to_front', { pid })
    }
  }

  /** Stop tracking and hide the PiP (user-requested close). */
  async dismiss(): Promise<void> {
    this.dismissedThreadId = this.ownerThreadId
    this.hide()
  }

  /**
   * Called when a thread's agent turn begins (a user message was accepted).
   * Clears the user's close so the next turn may show the PiP again if CUA is
   * used, and cancels a pending auto-dismiss from a just-finished turn.
   */
  notifyTurnStarted(threadId: string): void {
    if (this.dismissedThreadId === threadId) this.dismissedThreadId = null
    if (this.ownerThreadId === threadId) this.clearAutoDismiss()
  }

  /**
   * Called when a thread's utility turn ends. If that thread owns the PiP,
   * hide the overlay shortly after so it never lingers past the run.
   */
  notifyTurnEnded(threadId: string): void {
    if (!this.active || this.ownerThreadId !== threadId) return
    this.clearAutoDismiss()
    this.autoDismissTimer = setTimeout(() => {
      this.autoDismissTimer = null
      this.hide()
    }, AUTO_DISMISS_GRACE_MS)
  }

  /** Tear down the overlay without touching the user's per-turn close marker. */
  private hide(): void {
    const wasActive = this.active
    this.active = false
    this.targetPid = null
    this.appName = ''
    this.windowId = null
    this.misses = 0
    this.ownerThreadId = null
    this.targetSessionId = null
    this.cursor = null
    this.clearAutoDismiss()
    this.clearLoop()
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
    this.clearLoop()
    const client = this.client
    this.client = null
    if (client) await client.close().catch(() => undefined)
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
    if (this.client) return this.client
    const resolved = await this.cuaBridge.resolveUtility('codeinoven-pip', 'auto_review')
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
    this.client = client
    return client
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
        this.misses += 1
        if (this.misses >= MAX_MISSES) this.hide()
        return
      }
      this.misses = 0
      this.appName = window.app_name || this.appName || 'App'
      this.windowId = window.window_id
      const screenshotRequest = client.callTool('get_window_state', {
        pid,
        window_id: window.window_id,
        include_screenshot: true,
        max_elements: 1,
        ...(sessionId ? { session: sessionId } : {})
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
      if (!image) return
      const optimizedImage = optimizeImage(image)
      if (cursorResult.status === 'fulfilled') {
        const cursorPosition = extractCursorPosition(cursorResult.value)
        if (cursorPosition) {
          const projectedCursor = projectCursor(cursorPosition, window, optimizedImage)
          if (projectedCursor) this.cursor = projectedCursor
        }
      }
      // The overlay may have been dismissed (or re-targeted) while we awaited
      // the driver — never resurrect it with a stale frame.
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
        await this.client?.close().catch(() => undefined)
        this.client = null
        this.hide()
      }
    } finally {
      this.captureInFlight = false
    }
  }

  private async frontmostWindow(client: McpClient, pid: number): Promise<WindowRecord | null> {
    const result = await client.callTool('list_windows', { pid })
    const windows = extractWindows(result)
    if (windows.length === 0) return null
    const visible = windows.filter((window) => window.is_on_screen !== false)
    const candidates = visible.length > 0 ? visible : windows
    const ranked = [...candidates].sort((left, right) => {
      const leftIndex = typeof left.z_index === 'number' ? left.z_index : -1
      const rightIndex = typeof right.z_index === 'number' ? right.z_index : -1
      if (leftIndex !== rightIndex) return rightIndex - leftIndex
      return Number(Boolean(left.is_on_screen)) - Number(Boolean(right.is_on_screen))
    })
    return ranked[0] ?? null
  }

  private broadcastState(): void {
    this.broadcast('computerUse:pipState', this.getState())
  }

  private broadcast(
    channel: 'computerUse:pipFrame' | 'computerUse:pipState',
    payload: unknown
  ): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        sendToRenderer(win.webContents, channel, payload)
      }
    }
  }
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

function optimizeImage(image: { dataUrl: string; width: number; height: number }): {
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
    const scale = Math.min(1, MAX_FRAME_DIMENSION / Math.max(width, height))
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
