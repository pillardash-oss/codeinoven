import { BrowserWindow } from 'electron'
import type { ComputerUsePipFrame, ComputerUsePipState } from '../lib/types'
import { CuaBridgeService } from './cua-bridge-service'
import { StdioMcpClient, type McpClient } from './mcp-stdio-client'
import type { StorageEngine } from './storage-engine'
import { Logger } from './logger'
import { sendToRenderer } from './renderer-delivery'

const POLL_INTERVAL_MS = 1_000
const MAX_MISSES = 6
const AUTO_DISMISS_GRACE_MS = 3_000

interface WindowRecord {
  window_id: number
  app_name?: string
  title?: string
  is_on_screen?: boolean
  on_current_space?: boolean | null
  z_index?: number | null
}

/**
 * Floating PiP monitor for computer use. The utility orchestration service
 * notifies this service whenever an agent drives an app through the Cua
 * driver; the service then latches onto that pid, polls its frontmost window,
 * and streams compressed frames to the renderer for an always-visible overlay.
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
  private ownerThreadId: string | null = null
  private dismissedThreadId: string | null = null
  private autoDismissTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly storage: StorageEngine) {
    this.cuaBridge = new CuaBridgeService(storage)
  }

  /** Latch onto the app (pid) a thread's agent is currently driving. */
  async track(pid: number, threadId: string): Promise<void> {
    if (!Number.isInteger(pid) || pid <= 0) return
    this.clearAutoDismiss()
    // The user closed the overlay this turn — keep it hidden for the rest of
    // the turn; only the next agent turn (after a new user message) re-enables it.
    if (this.dismissedThreadId === threadId) return
    this.ownerThreadId = threadId
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
    await client.callTool('bring_to_front', { pid })
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
    }, POLL_INTERVAL_MS)
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
    if (!this.active || this.targetPid === null) return
    const pid = this.targetPid
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
      const result = await client.callTool('get_window_state', {
        pid,
        window_id: window.window_id,
        include_screenshot: true,
        max_elements: 1
      })
      const image = extractImage(result)
      if (!image) return
      // The overlay may have been dismissed (or re-targeted) while we awaited
      // the driver — never resurrect it with a stale frame.
      if (!this.active || this.targetPid !== pid) return
      const frame: ComputerUsePipFrame = {
        pid,
        appName: this.appName,
        windowId: window.window_id,
        dataUrl: image.dataUrl,
        width: image.width,
        height: image.height,
        timestamp: Date.now()
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

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
