import { screen, type BrowserWindow } from 'electron'
import { Logger } from './logger'
import type { StorageEngine } from '../storage/storage-engine'

const WINDOW_STATE_FILE = 'window-state/window-state.json'

const DEFAULT_WIDTH = 1440
const DEFAULT_HEIGHT = 900
const MIN_WIDTH = 1024
const MIN_HEIGHT = 700
/** Minimum amount of the restored window that must be visible on a display. */
const VISIBLE_MARGIN = 50
/** Debounce window for move/resize persistence. */
const SAVE_DEBOUNCE_MS = 500

interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
}

export interface PersistedWindowState {
  bounds: WindowBounds
  maximized: boolean
}

/**
 * Persists the main window's size, position, and maximized state across
 * launches. State is stored under the config root in its own file so it stays
 * out of the renderer-editable AppConfig. The restored (non-maximized) bounds
 * are captured via `getNormalBounds()`, so quitting maximized still restores the
 * window's pre-maximize size next launch.
 */
export class WindowStateService {
  private readonly storage: StorageEngine
  private state: PersistedWindowState
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(storage: StorageEngine) {
    this.storage = storage
    this.state = {
      bounds: { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT },
      maximized: false
    }
  }

  /** Load persisted state. Must run after the app is ready (uses `screen`). */
  async load(): Promise<void> {
    const persisted = await this.storage.read<Partial<PersistedWindowState>>(WINDOW_STATE_FILE)
    if (!persisted || typeof persisted !== 'object') return
    const bounds = this.validateBounds(persisted.bounds)
    this.state = {
      bounds,
      maximized: persisted.maximized === true
    }
  }

  /** BrowserWindow constructor options restoring the last size/position. */
  getWindowOptions(): WindowBounds {
    const { bounds } = this.state
    const options: WindowBounds = { width: bounds.width, height: bounds.height }
    if (typeof bounds.x === 'number') options.x = bounds.x
    if (typeof bounds.y === 'number') options.y = bounds.y
    return options
  }

  /** Whether the window should be maximized on its first paint. */
  shouldRestoreMaximized(): boolean {
    return this.state.maximized
  }

  /** Wire up debounced persistence for geometry changes plus a close flush. */
  attach(window: BrowserWindow): void {
    window.on('resize', () => this.schedulePersist(window))
    window.on('move', () => this.schedulePersist(window))
    window.on('maximize', () => this.schedulePersist(window))
    window.on('unmaximize', () => this.schedulePersist(window))
    window.on('close', () => this.persist(window))
    window.on('closed', () => this.cancelScheduledPersist())
  }

  /** Capture the current state and write it immediately. */
  persist(window: BrowserWindow): void {
    this.capture(window)
    void this.write()
  }

  /** Flush the pending debounced save, capturing the window if still alive. */
  async persistNow(window: BrowserWindow | null): Promise<void> {
    this.cancelScheduledPersist()
    if (window) this.capture(window)
    await this.write()
  }

  private capture(window: BrowserWindow): void {
    if (window.isDestroyed()) return
    const bounds = window.getNormalBounds()
    this.state = {
      bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      maximized: window.isMaximized()
    }
  }

  private schedulePersist(window: BrowserWindow): void {
    this.cancelScheduledPersist()
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.persist(window)
    }, SAVE_DEBOUNCE_MS)
  }

  private cancelScheduledPersist(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
  }

  private async write(): Promise<void> {
    try {
      await this.storage.write(WINDOW_STATE_FILE, this.state)
    } catch (error) {
      Logger.error('Failed to persist window state:', error)
    }
  }

  /**
   * Clamp the saved size to the window minimums and the largest available
   * display, and drop the saved position when it no longer lands on any
   * connected display (the display was unplugged) so Electron centers it.
   */
  private validateBounds(bounds: Partial<WindowBounds> | undefined): WindowBounds {
    const savedWidth =
      typeof bounds?.width === 'number' && Number.isFinite(bounds.width)
        ? bounds.width
        : DEFAULT_WIDTH
    const savedHeight =
      typeof bounds?.height === 'number' && Number.isFinite(bounds.height)
        ? bounds.height
        : DEFAULT_HEIGHT

    const displays = screen.getAllDisplays()
    const largestDisplay = displays.reduce(
      (largest, display) => {
        const area = display.bounds.width * display.bounds.height
        return area > largest.area ? { area, ...display.bounds } : largest
      },
      {
        area: 0,
        x: 0,
        y: 0,
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT
      }
    )

    const width = Math.max(MIN_WIDTH, Math.min(Math.round(savedWidth), largestDisplay.width))
    const height = Math.max(MIN_HEIGHT, Math.min(Math.round(savedHeight), largestDisplay.height))

    const savedX = bounds?.x
    const savedY = bounds?.y
    if (typeof savedX !== 'number' || typeof savedY !== 'number') {
      return { width, height }
    }
    const x = Math.round(savedX)
    const y = Math.round(savedY)

    const landsOnScreen = displays.some((display) => {
      const area = display.workArea
      return (
        x + width > area.x + VISIBLE_MARGIN &&
        x < area.x + area.width - VISIBLE_MARGIN &&
        y + height > area.y + VISIBLE_MARGIN &&
        y < area.y + area.height - VISIBLE_MARGIN
      )
    })

    if (!landsOnScreen) return { width, height }

    return { x, y, width, height }
  }
}
