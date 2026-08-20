import { session, WebContentsView, type BrowserWindow } from 'electron'
import type {
  BrowserConsoleEntry,
  BrowserConsoleLevel,
  BrowserPageState,
  BrowserViewBounds
} from '../../lib/ipc-contract'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { Logger } from '../system/logger'

const BROWSER_PARTITION = 'persist:codeinoven-browser'
const MAX_BROWSER_URL_LENGTH = 8192
const MAX_CONSOLE_ENTRIES = 500
const TAB_ID_PATTERN = /^browser:[a-zA-Z0-9:_-]{1,240}$/u

interface BrowserTab {
  view: WebContentsView
  initialNavigationStarted: boolean
  consoleEntries: BrowserConsoleEntry[]
}

interface PendingBrowserTab {
  resolve: (tab: BrowserTab) => void
  timer: ReturnType<typeof setTimeout>
}

function validateTabId(value: unknown): string {
  if (typeof value !== 'string' || !TAB_ID_PATTERN.test(value)) {
    throw new TypeError('Browser tab ID is invalid')
  }
  return value
}

function validateBrowserUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_BROWSER_URL_LENGTH) {
    throw new TypeError('Browser URL must be a string of at most 8192 characters')
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError('Browser URL is malformed')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('Browser URL must use http or https')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new TypeError('Browser URL must not contain credentials')
  }
  return parsed.href
}

function validateBounds(value: unknown): BrowserViewBounds {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Browser bounds must be an object')
  }
  const bounds = value as Record<string, unknown>
  const result: BrowserViewBounds = {
    x: bounds['x'] as number,
    y: bounds['y'] as number,
    width: bounds['width'] as number,
    height: bounds['height'] as number
  }
  for (const coordinate of Object.values(result)) {
    if (!Number.isInteger(coordinate) || coordinate < 0 || coordinate > 100_000) {
      throw new TypeError('Browser bounds must contain non-negative integer coordinates')
    }
  }
  return result
}

/** Owns sandboxed page content while the renderer owns the browser chrome. */
export class BrowserService {
  private readonly tabs = new Map<string, BrowserTab>()
  private readonly pendingTabs = new Map<string, PendingBrowserTab>()
  private readonly agentTabIds = new Map<string, string>()
  private activeTabId: string | null = null
  private consoleSequence = 0

  constructor(private readonly window: BrowserWindow) {
    const browserSession = session.fromPartition(BROWSER_PARTITION)
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false)
    })
    browserSession.on('will-download', (event) => event.preventDefault())
  }

  register(): void {
    ipcMain.handle('browser:show', (_event, rawTabId, rawInitialUrl, rawBounds) => {
      const tabId = validateTabId(rawTabId)
      const initialUrl = validateBrowserUrl(rawInitialUrl)
      const bounds = validateBounds(rawBounds)
      const tab = this.ensureTab(tabId)

      if (this.activeTabId && this.activeTabId !== tabId) this.detachActiveView()
      if (this.activeTabId !== tabId) {
        this.window.contentView.addChildView(tab.view)
        this.activeTabId = tabId
      }
      tab.view.setBounds(bounds)
      if (!tab.initialNavigationStarted) {
        tab.initialNavigationStarted = true
        this.load(tabId, initialUrl)
      }
      return this.stateFor(tabId, tab)
    })

    ipcMain.handle('browser:hide', (_event, rawTabId) => {
      const tabId = validateTabId(rawTabId)
      if (this.activeTabId === tabId) this.detachActiveView()
    })
    ipcMain.handle('browser:navigate', (_event, rawTabId, rawUrl) => {
      this.load(validateTabId(rawTabId), validateBrowserUrl(rawUrl))
    })
    ipcMain.handle('browser:goBack', (_event, rawTabId) => {
      const tab = this.requireTab(validateTabId(rawTabId))
      if (tab.view.webContents.navigationHistory.canGoBack()) {
        tab.view.webContents.navigationHistory.goBack()
      }
    })
    ipcMain.handle('browser:goForward', (_event, rawTabId) => {
      const tab = this.requireTab(validateTabId(rawTabId))
      if (tab.view.webContents.navigationHistory.canGoForward()) {
        tab.view.webContents.navigationHistory.goForward()
      }
    })
    ipcMain.handle('browser:reload', (_event, rawTabId) => {
      this.requireTab(validateTabId(rawTabId)).view.webContents.reload()
    })
    ipcMain.handle('browser:stop', (_event, rawTabId) => {
      this.requireTab(validateTabId(rawTabId)).view.webContents.stop()
    })
    ipcMain.handle('browser:getConsole', (_event, rawTabId) => {
      return [...this.requireTab(validateTabId(rawTabId)).consoleEntries]
    })
    ipcMain.handle('browser:clearConsole', (_event, rawTabId) => {
      this.requireTab(validateTabId(rawTabId)).consoleEntries = []
    })
    ipcMain.handle('browser:destroy', (_event, rawTabId) => {
      this.destroy(validateTabId(rawTabId))
    })
  }

  dispose(): void {
    this.detachActiveView()
    for (const tab of this.tabs.values()) {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    }
    this.tabs.clear()
    for (const pending of this.pendingTabs.values()) clearTimeout(pending.timer)
    this.pendingTabs.clear()
    this.agentTabIds.clear()
  }

  async executeUtility(
    operation: string,
    input: Record<string, unknown>,
    context: { projectId: string; threadId: string }
  ): Promise<unknown> {
    if (operation === 'open') {
      const url = validateBrowserUrl(this.requiredInputString(input, 'url'))
      const tabId = `browser:agent:${crypto.randomUUID()}`
      this.agentTabIds.set(context.threadId, tabId)
      sendToRenderer(this.window.webContents, 'browser:openRequested', url, tabId)
      const tab = await this.waitForTab(tabId)
      return this.stateFor(tabId, tab)
    }

    const tabId = this.agentTabIds.get(context.threadId)
    if (!tabId) throw new Error('Open a browser page before using this operation')
    const tab = this.requireTab(tabId)
    if (operation === 'navigate') {
      const url = validateBrowserUrl(this.requiredInputString(input, 'url'))
      this.load(tabId, url)
      return { tabId, url }
    }
    if (operation === 'reload') {
      tab.view.webContents.reload()
      return { tabId, reloading: true }
    }
    if (operation === 'snapshot') {
      return tab.view.webContents.executeJavaScript(`(() => ({
        url: location.href,
        title: document.title,
        text: (document.body?.innerText ?? '').slice(0, 30000),
        elements: Array.from(document.querySelectorAll('a, button, input, textarea, select, [role="button"], [contenteditable="true"]'))
          .slice(0, 250)
          .map((element) => ({
            tag: element.tagName.toLowerCase(),
            id: element.id || undefined,
            name: element.getAttribute('name') || undefined,
            role: element.getAttribute('role') || undefined,
            type: element.getAttribute('type') || undefined,
            text: (element.innerText || element.getAttribute('aria-label') || element.getAttribute('placeholder') || '').trim().slice(0, 300)
          }))
      }))()`)
    }
    if (operation === 'click') {
      const selector = this.requiredInputString(input, 'selector')
      return tab.view.webContents.executeJavaScript(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!(element instanceof HTMLElement)) return { clicked: false, reason: 'not found' };
        element.scrollIntoView({ block: 'center', inline: 'center' });
        element.click();
        return { clicked: true };
      })()`)
    }
    if (operation === 'type') {
      const selector = this.requiredInputString(input, 'selector')
      const text = this.requiredInputString(input, 'text', true)
      return tab.view.webContents.executeJavaScript(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!(element instanceof HTMLElement)) return { typed: false, reason: 'not found' };
        element.focus();
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          element.value = ${JSON.stringify(text)};
        } else if (element.isContentEditable) {
          element.textContent = ${JSON.stringify(text)};
        } else {
          return { typed: false, reason: 'element is not editable' };
        }
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return { typed: true };
      })()`)
    }
    if (operation === 'screenshot') {
      const image = await tab.view.webContents.capturePage()
      return { tabId, dataUrl: `data:image/png;base64,${image.toPNG().toString('base64')}` }
    }
    if (operation === 'console') {
      return { tabId, entries: [...tab.consoleEntries] }
    }
    throw new Error(`In-app browser does not expose the operation "${operation}"`)
  }

  private ensureTab(tabId: string): BrowserTab {
    const existing = this.tabs.get(tabId)
    if (existing) return existing

    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        devTools: true
      }
    })
    view.setBackgroundColor('#00000000')
    const tab: BrowserTab = { view, initialNavigationStarted: false, consoleEntries: [] }
    this.tabs.set(tabId, tab)
    const pending = this.pendingTabs.get(tabId)
    if (pending) {
      clearTimeout(pending.timer)
      this.pendingTabs.delete(tabId)
      pending.resolve(tab)
    }

    const publish = (): void => this.publishState(tabId)
    view.webContents.on('did-start-loading', publish)
    view.webContents.on('did-stop-loading', publish)
    view.webContents.on('did-navigate', publish)
    view.webContents.on('did-navigate-in-page', publish)
    view.webContents.on('page-title-updated', publish)
    view.webContents.on('console-message', (details) => {
      this.appendConsoleEntry(tabId, {
        level: details.level,
        message: details.message,
        sourceId: details.sourceId,
        lineNumber: details.lineNumber
      })
    })
    view.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return
        this.appendConsoleEntry(tabId, {
          level: 'error',
          message: `Navigation failed (${errorCode}): ${errorDescription}`,
          sourceId: validatedURL,
          lineNumber: 0
        })
      }
    )
    view.webContents.on('render-process-gone', (_event, details) => {
      this.appendConsoleEntry(tabId, {
        level: 'error',
        message: `Browser renderer stopped: ${details.reason} (exit ${details.exitCode})`,
        sourceId: view.webContents.getURL(),
        lineNumber: 0
      })
    })
    view.webContents.on('will-navigate', (event, url) => {
      try {
        validateBrowserUrl(url)
      } catch {
        event.preventDefault()
      }
    })
    view.webContents.setWindowOpenHandler(({ url }) => {
      try {
        sendToRenderer(this.window.webContents, 'browser:openRequested', validateBrowserUrl(url))
      } catch (error) {
        Logger.error('Browser popup rejected unsafe URL:', error)
      }
      return { action: 'deny' }
    })
    return tab
  }

  private requireTab(tabId: string): BrowserTab {
    const tab = this.tabs.get(tabId)
    if (!tab) throw new Error('Browser tab does not exist')
    return tab
  }

  private load(tabId: string, url: string): void {
    const tab = this.requireTab(tabId)
    void tab.view.webContents.loadURL(url).catch((error: unknown) => {
      Logger.dev('Browser navigation did not complete:', { tabId, url, error })
      this.publishState(tabId)
    })
  }

  private stateFor(tabId: string, tab: BrowserTab): BrowserPageState {
    const contents = tab.view.webContents
    return {
      tabId,
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward()
    }
  }

  private publishState(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab || this.window.webContents.isDestroyed()) return
    sendToRenderer(this.window.webContents, 'browser:state', this.stateFor(tabId, tab))
  }

  private appendConsoleEntry(
    tabId: string,
    input: {
      level: BrowserConsoleLevel
      message: string
      sourceId: string
      lineNumber: number
    }
  ): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    const entry: BrowserConsoleEntry = {
      id: `${Date.now()}:${this.consoleSequence++}`,
      tabId,
      level: input.level,
      message: input.message.slice(0, 10_000),
      sourceId: input.sourceId.slice(0, 2_048),
      lineNumber: Math.max(0, input.lineNumber),
      timestamp: Date.now()
    }
    tab.consoleEntries = [...tab.consoleEntries, entry].slice(-MAX_CONSOLE_ENTRIES)
    if (!this.window.webContents.isDestroyed()) {
      sendToRenderer(this.window.webContents, 'browser:console', entry)
    }
  }

  private detachActiveView(): void {
    if (!this.activeTabId) return
    const tab = this.tabs.get(this.activeTabId)
    if (tab) this.window.contentView.removeChildView(tab.view)
    this.activeTabId = null
  }

  private destroy(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    if (this.activeTabId === tabId) this.detachActiveView()
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    this.tabs.delete(tabId)
    for (const [threadId, agentTabId] of this.agentTabIds) {
      if (agentTabId === tabId) this.agentTabIds.delete(threadId)
    }
  }

  private waitForTab(tabId: string): Promise<BrowserTab> {
    const existing = this.tabs.get(tabId)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTabs.delete(tabId)
        reject(new Error('The in-app browser tab did not become visible'))
      }, 10_000)
      this.pendingTabs.set(tabId, { resolve, timer })
    })
  }

  private requiredInputString(
    input: Record<string, unknown>,
    field: string,
    allowEmpty = false
  ): string {
    const value = input[field]
    if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > 8192) {
      throw new TypeError(`${field} must be a string${allowEmpty ? '' : ' with content'}`)
    }
    return value
  }
}
