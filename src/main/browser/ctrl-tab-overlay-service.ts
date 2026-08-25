import { app, ipcMain, WebContentsView, type BrowserWindow, type WebContents } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { is } from '@electron-toolkit/utils'
import type { NativeSwitcherPayload } from '../../lib/ipc-contract'
import { trustedIpcMain } from '../ipc/trusted-ipc-main'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { Logger } from '../system/logger'

const MAX_SWITCHER_THREADS = 50
const MAX_THREAD_TITLE_LENGTH = 500
const MAX_PROJECT_ID_LENGTH = 512

function validateSwitcherPayload(value: unknown): NativeSwitcherPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Native switcher payload must be an object')
  }
  const payload = value as Record<string, unknown>
  if (!Array.isArray(payload['threads'])) {
    throw new TypeError('Native switcher payload must contain a threads array')
  }
  const threads: NativeSwitcherPayload['threads'] = []
  for (const raw of payload['threads'].slice(-MAX_SWITCHER_THREADS)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const thread = raw as Record<string, unknown>
    const id = thread['id']
    const title = thread['title']
    const projectId = thread['projectId']
    const icon = thread['icon']
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      id.length > 512 ||
      typeof title !== 'string' ||
      title.length > MAX_THREAD_TITLE_LENGTH ||
      typeof projectId !== 'string' ||
      projectId.length > MAX_PROJECT_ID_LENGTH ||
      (icon !== null && typeof icon !== 'string')
    ) {
      continue
    }
    threads.push({ id, title, projectId, icon: icon ?? null, selected: thread['selected'] === true })
  }
  const theme = payload['theme'] === 'dark' ? 'dark' : 'light'
  return {
    threads,
    highlightedThreadId:
      typeof payload['highlightedThreadId'] === 'string' ? payload['highlightedThreadId'] : null,
    theme,
    windowHeight:
      typeof payload['windowHeight'] === 'number' && Number.isFinite(payload['windowHeight'])
        ? payload['windowHeight']
        : 0
  }
}

/**
 * Owns the native Ctrl+Tab switcher overlay view.
 *
 * The browser page is a native `WebContentsView`, so it composes above the whole
 * renderer DOM — a DOM modal can never sit above it. When the browser view is on
 * screen the renderer therefore drives this service, which shows a second native
 * view (loaded from `switcher.html`) stacked above the browser. The overlay owns
 * its list UI and keyboard input; selection/highlight/dismiss are relayed back
 * to the renderer, which performs the actual thread switch.
 */
export class CtrlTabOverlayService {
  private view: WebContentsView | null = null
  private session: NativeSwitcherPayload | null = null
  private loaded = false
  private attached = false
  private readonly mainBundleDirectory = dirname(fileURLToPath(import.meta.url))

  constructor(private readonly window: BrowserWindow) {}

  register(): void {
    trustedIpcMain.handle('switcher:open', (_event, rawPayload) => {
      this.open(validateSwitcherPayload(rawPayload))
    })
    trustedIpcMain.handle('switcher:close', () => {
      this.close()
    })

    ipcMain.handle('switcher:pageGetData', (event) => {
      if (!this.isOverlaySender(event.sender)) return null
      return this.session
    })
    ipcMain.on('switcher:pageSelect', (event, threadId) => {
      if (!this.isOverlaySender(event.sender)) return
      if (typeof threadId !== 'string' || threadId.length === 0) return
      sendToRenderer(this.window.webContents, 'switcher:select', threadId)
    })
    ipcMain.on('switcher:pageHighlight', (event, threadId) => {
      if (!this.isOverlaySender(event.sender)) return
      if (typeof threadId !== 'string' || threadId.length === 0) return
      sendToRenderer(this.window.webContents, 'switcher:highlight', threadId)
    })
    ipcMain.on('switcher:pageClose', (event) => {
      if (!this.isOverlaySender(event.sender)) return
      this.close()
      sendToRenderer(this.window.webContents, 'switcher:closed')
    })
  }

  open(payload: NativeSwitcherPayload): void {
    if (this.window.isDestroyed()) return
    this.session = payload
    const view = this.ensureView()

    if (!this.loaded) {
      this.loaded = true
      void this.loadPage().catch((error: unknown) => {
        Logger.error('Native switcher overlay failed to load', {
          error: error instanceof Error ? error.message : String(error)
        })
      })
    }

    this.applyTheme(payload.theme)
    const bounds = this.window.contentView.getBounds()
    view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height })
    // `addChildView` appends at the top of the native view stack, so this both
    // attaches a fresh overlay and re-raises an already-attached one above the
    // browser view.
    this.window.contentView.addChildView(view)
    this.attached = true
    view.webContents.focus()
    view.webContents.send('switcher:data', payload)
  }

  close(): void {
    const view = this.view
    this.session = null
    if (!view || this.window.isDestroyed()) return
    if (this.attached) {
      try {
        this.window.contentView.removeChildView(view)
      } catch (error) {
        Logger.dev('Native switcher overlay removal failed', {
          error: error instanceof Error ? error.message : String(error)
        })
      }
      this.attached = false
    }
    if (!this.window.webContents.isDestroyed()) this.window.webContents.focus()
  }

  dispose(): void {
    this.close()
    const view = this.view
    this.view = null
    this.loaded = false
    if (view && !view.webContents.isDestroyed()) view.webContents.close()
  }

  private ensureView(): WebContentsView {
    if (this.view) return this.view
    const view = new WebContentsView({
      webPreferences: {
        preload: join(this.mainBundleDirectory, '../preload/switcher-preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false
      }
    })
    view.setBackgroundColor('#00000000')
    view.webContents.on('did-finish-load', () => {
      if (this.session) {
        this.applyTheme(this.session.theme)
        if (!view.webContents.isDestroyed() && !view.webContents.isLoadingMainFrame()) {
          view.webContents.send('switcher:data', this.session)
        }
      }
    })
    this.view = view
    return view
  }

  private async loadPage(): Promise<void> {
    const view = this.view
    if (!view) return
    const productionPath = join(this.mainBundleDirectory, '../renderer/switcher.html')
    const isProduction = app.isPackaged || process.env['NODE_ENV'] === 'production'
    if (!isProduction && is.dev && process.env['ELECTRON_RENDERER_URL']) {
      await view.webContents.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/switcher.html`)
      return
    }
    await view.webContents.loadFile(productionPath)
  }

  private applyTheme(theme: NativeSwitcherPayload['theme']): void {
    const view = this.view
    if (!view || view.webContents.isDestroyed()) return
    const dark = theme === 'dark'
    void view.webContents
      .executeJavaScript(`document.documentElement.classList.toggle('dark', ${dark})`)
      .catch(() => undefined)
  }

  private isOverlaySender(sender: WebContents): boolean {
    return this.view?.webContents === sender
  }
}
