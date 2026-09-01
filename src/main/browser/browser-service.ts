import { app, session, shell, WebContentsView, type BrowserWindow, type Session } from 'electron'
import { join } from 'node:path'
import type {
  BrowserConsoleEntry,
  BrowserConsoleLevel,
  BrowserDownload,
  BrowserDownloadState,
  BrowserPageState,
  BrowserPermissionRequest,
  BrowserViewBounds
} from '../../lib/ipc-contract'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { Logger } from '../system/logger'

const BROWSER_PARTITION_PREFIX = 'persist:codeinoven-browser:'
const MAX_BROWSER_URL_LENGTH = 8192
const MAX_CONSOLE_ENTRIES = 500
const MAX_TRACKED_DOWNLOADS = 50
const DOWNLOAD_EVENT_INTERVAL_MS = 150
const TAB_ID_PATTERN = /^browser:[a-zA-Z0-9:_-]{1,240}$/u
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9:._-]{1,240}$/u
const PERMISSION_REQUEST_ID_PATTERN = /^[a-f0-9-]{36}$/u
const PERMISSION_TIMEOUT_MS = 60_000
const DOWNLOAD_ID_PATTERN = /^[a-f0-9-]{36}$/u

interface BrowserTab {
  view: WebContentsView
  projectId: string
  threadId: string
  initialNavigationStarted: boolean
  consoleEntries: BrowserConsoleEntry[]
}

interface PendingBrowserPermission {
  request: BrowserPermissionRequest
  callback: (granted: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

interface BrowserDownloadRecord {
  item: Electron.DownloadItem
  download: BrowserDownload
  lastEmittedAt: number
}

function validateTabId(value: unknown): string {
  if (typeof value !== 'string' || !TAB_ID_PATTERN.test(value)) {
    throw new TypeError('Browser tab ID is invalid')
  }
  return value
}

function validateProjectId(value: unknown): string {
  if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value)) {
    throw new TypeError('Browser project ID is invalid')
  }
  return value
}

function validateThreadId(value: unknown): string {
  if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value)) {
    throw new TypeError('Browser thread ID is invalid')
  }
  return value
}

function browserContextKey(projectId: string, threadId: string): string {
  return `${projectId}:${threadId}`
}

function validatePermissionRequestId(value: unknown): string {
  if (typeof value !== 'string' || !PERMISSION_REQUEST_ID_PATTERN.test(value)) {
    throw new TypeError('Browser permission request ID is invalid')
  }
  return value
}

function validateDownloadId(value: unknown): string {
  if (typeof value !== 'string' || !DOWNLOAD_ID_PATTERN.test(value)) {
    throw new TypeError('Browser download ID is invalid')
  }
  return value
}

/** Reduce a server-suggested filename to a safe, absolute-path-free basename. */
function safeBasename(value: string): string {
  // Substitute every path separator, drive-part, or control character with an
  // underscore, then collapse dots/whitespace so the result is a plain basename.
  let cleaned = ''
  for (const char of value) {
    const code = char.charCodeAt(0)
    const substitute =
      code === 0x2f || // '/'
      code === 0x5c || // '\'
      code === 0x3a || // ':'
      code === 0x2a || // '*'
      code === 0x3f || // '?'
      code === 0x22 || // '"'
      code === 0x3c || // '<'
      code === 0x3e || // '>'
      code === 0x7c || // '|'
      code < 0x20 ||
      code === 0x7f
    cleaned += substitute ? '_' : char
  }
  const normalized = cleaned.replace(/\s+/g, ' ').trim().replace(/^\.+/, '')
  const base = normalized.length > 0 ? normalized.slice(0, 240) : 'download'
  return base
}

function permissionOrigin(value: string): string | null {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null
  } catch {
    return null
  }
}

function permissionKey(origin: string, permission: string, scope = ''): string {
  return `${origin}\n${permission}\n${scope}`
}

function permissionGrantKeys(request: BrowserPermissionRequest): string[] {
  if (request.permission === 'media' && request.mediaTypes.length > 0) {
    return request.mediaTypes.map((mediaType) =>
      permissionKey(request.origin, request.permission, mediaType)
    )
  }
  return [permissionKey(request.origin, request.permission)]
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
  private readonly agentTabIds = new Map<string, string>()
  private readonly configuredSessions = new Set<string>()
  private readonly permissionGrants = new Map<string, Set<string>>()
  private readonly pendingPermissions = new Map<string, PendingBrowserPermission>()
  private readonly permissionSuspendedTabs = new Set<string>()
  private readonly downloads = new Map<string, BrowserDownloadRecord>()
  private activeTabId: string | null = null
  private consoleSequence = 0

  constructor(private readonly window: BrowserWindow) {}

  register(): void {
    ipcMain.handle(
      'browser:show',
      (_event, rawTabId, rawProjectId, rawThreadId, rawInitialUrl, rawBounds) => {
        const tabId = validateTabId(rawTabId)
        const projectId = validateProjectId(rawProjectId)
        const threadId = validateThreadId(rawThreadId)
        const initialUrl = validateBrowserUrl(rawInitialUrl)
        const bounds = validateBounds(rawBounds)
        const tab = this.ensureTab(tabId, projectId, threadId)

        if (this.activeTabId && this.activeTabId !== tabId) this.detachActiveView()
        if (this.permissionModalPending()) {
          // A permission modal is open in the renderer. A native WebContentsView
          // floats above every DOM surface of this window, so attaching it here
          // would cover the DOM permission dialog and swallow its Allow/Deny
          // clicks (e.g. the browser is fullscreen and the tab calls a mic). Keep
          // the native view detached for the whole permission lifetime; the panel
          // re-shows it through `browser:show` once the modal is gone.
          this.activeTabId = null
          tab.view.setBounds(bounds)
          if (!tab.initialNavigationStarted) {
            tab.initialNavigationStarted = true
            this.load(tabId, initialUrl)
          }
          return this.stateFor(tabId, tab)
        }
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
      }
    )

    ipcMain.handle('browser:hide', (_event, rawTabId) => {
      const tabId = validateTabId(rawTabId)
      if (this.activeTabId === tabId) this.detachActiveView()
      // Missing tabs are silently ignored — the renderer may call hide
      // during teardown after the tab was already destroyed.
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
      const tab = this.tabs.get(validateTabId(rawTabId))
      return tab ? [...tab.consoleEntries] : []
    })
    ipcMain.handle('browser:clearConsole', (_event, rawTabId) => {
      this.requireTab(validateTabId(rawTabId)).consoleEntries = []
    })
    ipcMain.handle('browser:clearData', async (_event, rawProjectId) => {
      await this.clearProjectData(validateProjectId(rawProjectId))
    })
    ipcMain.handle('browser:resolvePermission', (_event, rawRequestId, rawGranted) => {
      const requestId = validatePermissionRequestId(rawRequestId)
      if (typeof rawGranted !== 'boolean') {
        throw new TypeError('Browser permission response must be a boolean')
      }
      this.resolvePermission(requestId, rawGranted)
    })
    ipcMain.handle('browser:destroy', (_event, rawTabId) => {
      this.destroy(validateTabId(rawTabId))
    })
    ipcMain.handle('browser:destroyThread', (_event, rawProjectId, rawThreadId) => {
      const projectId = validateProjectId(rawProjectId)
      const threadId = validateThreadId(rawThreadId)
      for (const [tabId, tab] of this.tabs) {
        if (tab.projectId === projectId && tab.threadId === threadId) this.destroy(tabId)
      }
    })
    ipcMain.handle('browser:destroyProject', (_event, rawProjectId) => {
      const projectId = validateProjectId(rawProjectId)
      for (const [tabId, tab] of this.tabs) {
        if (tab.projectId === projectId) this.destroy(tabId)
      }
    })
    ipcMain.handle('browser:getDownloads', (_event, rawProjectId) => {
      const projectId = validateProjectId(rawProjectId)
      return [...this.downloads.values()]
        .filter((record) => record.download.projectId === projectId)
        .map((record) => ({ ...record.download }))
    })
    ipcMain.handle('browser:cancelDownload', (_event, rawDownloadId) => {
      this.downloads.get(validateDownloadId(rawDownloadId))?.item.cancel()
    })
    ipcMain.handle('browser:pauseDownload', (_event, rawDownloadId) => {
      const record = this.downloads.get(validateDownloadId(rawDownloadId))
      if (record && !record.item.isPaused()) {
        record.item.pause()
        record.download = { ...record.download, paused: true }
        this.emitDownload(record.download.id, true)
      }
    })
    ipcMain.handle('browser:resumeDownload', (_event, rawDownloadId) => {
      const record = this.downloads.get(validateDownloadId(rawDownloadId))
      if (record && record.item.canResume()) {
        record.item.resume()
        record.download = { ...record.download, paused: false }
        this.emitDownload(record.download.id, true)
      }
    })
    ipcMain.handle('browser:openDownload', (_event, rawDownloadId) => {
      const record = this.downloads.get(validateDownloadId(rawDownloadId))
      if (record && record.download.savePath) void shell.openPath(record.download.savePath)
    })
    ipcMain.handle('browser:revealDownload', (_event, rawDownloadId) => {
      const record = this.downloads.get(validateDownloadId(rawDownloadId))
      if (!record?.download.savePath) return false
      shell.showItemInFolder(record.download.savePath)
      return true
    })
  }

  dispose(): void {
    this.detachActiveView()
    for (const requestId of [...this.pendingPermissions.keys()]) {
      this.resolvePermission(requestId, false, false)
    }
    for (const tab of this.tabs.values()) {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    }
    this.tabs.clear()
    this.agentTabIds.clear()
    this.configuredSessions.clear()
    this.permissionGrants.clear()
    for (const record of this.downloads.values()) {
      if (record.download.state === 'progressing') record.item.cancel()
    }
    this.downloads.clear()
  }

  async executeUtility(
    operation: string,
    input: Record<string, unknown>,
    context: { projectId: string; threadId: string }
  ): Promise<unknown> {
    const projectId = validateProjectId(context.projectId)
    const threadId = validateThreadId(context.threadId)
    const contextKey = browserContextKey(projectId, threadId)
    if (operation === 'open') {
      const url = validateBrowserUrl(this.requiredInputString(input, 'url'))
      const tabId = `browser:agent:${crypto.randomUUID()}`
      const tab = this.ensureTab(tabId, projectId, threadId)
      tab.initialNavigationStarted = true
      this.agentTabIds.set(contextKey, tabId)
      this.load(tabId, url)
      sendToRenderer(this.window.webContents, 'browser:openRequested', url, {
        projectId,
        threadId,
        requestedTabId: tabId,
        reveal: true
      })
      return { ...this.utilityTabContext(tabId, tab), page: this.stateFor(tabId, tab) }
    }

    const tabId = this.agentTabIds.get(contextKey)
    if (!tabId) throw new Error('Open a browser page before using this operation')
    const tab = this.requireTab(tabId)
    if (tab.projectId !== projectId || tab.threadId !== threadId) {
      throw new Error('The current browser tab belongs to a different project or thread')
    }
    const utilityContext = this.utilityTabContext(tabId, tab)
    if (operation === 'navigate') {
      const url = validateBrowserUrl(this.requiredInputString(input, 'url'))
      this.load(tabId, url)
      return { ...utilityContext, url }
    }
    if (operation === 'reload') {
      tab.view.webContents.reload()
      return { ...utilityContext, reloading: true }
    }
    if (operation === 'snapshot') {
      const snapshot: unknown = await tab.view.webContents.executeJavaScript(`(() => ({
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
      return { ...utilityContext, snapshot }
    }
    if (operation === 'click') {
      const selector = this.requiredInputString(input, 'selector')
      const result: unknown = await tab.view.webContents.executeJavaScript(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!(element instanceof HTMLElement)) return { clicked: false, reason: 'not found' };
        element.scrollIntoView({ block: 'center', inline: 'center' });
        element.click();
        return { clicked: true };
      })()`)
      return { ...utilityContext, result }
    }
    if (operation === 'type') {
      const selector = this.requiredInputString(input, 'selector')
      const text = this.requiredInputString(input, 'text', true)
      const result: unknown = await tab.view.webContents.executeJavaScript(`(() => {
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
      return { ...utilityContext, result }
    }
    if (operation === 'screenshot') {
      const image = await tab.view.webContents.capturePage()
      return {
        ...utilityContext,
        dataUrl: `data:image/png;base64,${image.toPNG().toString('base64')}`
      }
    }
    if (operation === 'console') {
      return { ...utilityContext, entries: [...tab.consoleEntries] }
    }
    throw new Error(`In-app browser does not expose the operation "${operation}"`)
  }

  private ensureTab(tabId: string, projectId: string, threadId: string): BrowserTab {
    const existing = this.tabs.get(tabId)
    if (existing) {
      if (existing.projectId !== projectId || existing.threadId !== threadId) {
        throw new Error('Browser tab belongs to a different project or thread')
      }
      return existing
    }

    const browserSession = this.sessionForProject(projectId)

    const view = new WebContentsView({
      webPreferences: {
        session: browserSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        devTools: true
      }
    })
    view.setBackgroundColor('#00000000')
    const tab: BrowserTab = {
      view,
      projectId,
      threadId,
      initialNavigationStarted: false,
      consoleEntries: []
    }
    this.tabs.set(tabId, tab)

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
        const safeUrl = validateBrowserUrl(url)
        const popupTabId = `browser:${crypto.randomUUID()}`
        const popupTab = this.ensureTab(popupTabId, tab.projectId, tab.threadId)
        popupTab.initialNavigationStarted = true
        this.load(popupTabId, safeUrl)
        sendToRenderer(this.window.webContents, 'browser:openRequested', safeUrl, {
          projectId: tab.projectId,
          threadId: tab.threadId,
          requestedTabId: popupTabId,
          reveal: true
        })
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

  private sessionForProject(projectId: string): Session {
    const partition = `${BROWSER_PARTITION_PREFIX}${projectId}`
    const browserSession = session.fromPartition(partition)
    if (this.configuredSessions.has(partition)) return browserSession
    const grants = new Set<string>()
    this.permissionGrants.set(partition, grants)
    browserSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
      const origin = permissionOrigin(requestingOrigin)
      if (!origin) return false
      const mediaType = Reflect.get(details, 'mediaType')
      return grants.has(
        permissionKey(origin, permission, typeof mediaType === 'string' ? mediaType : '')
      )
    })
    browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      const tabEntry = [...this.tabs.entries()].find(
        ([, tab]) => tab.projectId === projectId && tab.view.webContents.id === contents.id
      )
      const requestingUrl = Reflect.get(details, 'requestingUrl')
      const securityOrigin = Reflect.get(details, 'securityOrigin')
      const origin = permissionOrigin(
        typeof requestingUrl === 'string' && requestingUrl.length > 0
          ? requestingUrl
          : typeof securityOrigin === 'string' && securityOrigin.length > 0
            ? securityOrigin
            : contents.getURL()
      )
      if (!tabEntry || !origin || this.window.webContents.isDestroyed()) {
        callback(false)
        return
      }
      const [tabId] = tabEntry
      const id = crypto.randomUUID()
      const rawMediaTypes: unknown = Reflect.get(details, 'mediaTypes')
      const request: BrowserPermissionRequest = {
        id,
        tabId,
        projectId,
        origin,
        permission,
        mediaTypes: Array.isArray(rawMediaTypes)
          ? rawMediaTypes.filter((value): value is string => typeof value === 'string')
          : []
      }
      const timer = setTimeout(() => this.resolvePermission(id, false), PERMISSION_TIMEOUT_MS)
      this.pendingPermissions.set(id, { request, callback, timer })
      this.suspendActiveViewForPermission()
      sendToRenderer(this.window.webContents, 'browser:permissionRequested', request)
    })
    browserSession.on('will-download', (event, item, contents) => {
      this.handleDownload(projectId, item, contents.id)
    })
    this.configuredSessions.add(partition)
    return browserSession
  }

  /** Route a session download through the app-scoped save dialog and tracker. */
  private handleDownload(projectId: string, item: Electron.DownloadItem, contentsId: number): void {
    const tabEntry = [...this.tabs.entries()].find(
      ([, tab]) => tab.projectId === projectId && tab.view.webContents.id === contentsId
    )
    const fileName = safeBasename(item.getFilename())
    const defaultPath = join(app.getPath('downloads'), fileName)
    item.setSaveDialogOptions({
      title: 'Save downloaded file',
      defaultPath
    })

    const id = crypto.randomUUID()
    const record: BrowserDownloadRecord = {
      item,
      download: {
        id,
        tabId: tabEntry?.[0] ?? '',
        projectId,
        fileName,
        url: item.getURL().slice(0, 2048),
        mimeType: item.getMimeType().slice(0, 256),
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        speedBytes: item.getCurrentBytesPerSecond(),
        progress: item.getPercentComplete(),
        state: 'progressing',
        paused: false,
        savePath: '',
        error: ''
      },
      lastEmittedAt: 0
    }
    this.downloads.set(id, record)
    this.emitDownload(id)

    item.on('updated', () => {
      const current = this.downloads.get(id)
      if (!current) return
      current.download = {
        ...current.download,
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes() || current.download.totalBytes,
        speedBytes: item.getCurrentBytesPerSecond(),
        progress: item.getPercentComplete(),
        paused: item.isPaused()
      }
      this.emitDownload(id)
    })
    item.once('done', (_event, state) => {
      const current = this.downloads.get(id)
      if (!current) return
      const finished = state as BrowserDownloadState
      current.download = {
        ...current.download,
        state: finished,
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes() || current.download.totalBytes,
        progress: item.getPercentComplete(),
        paused: false,
        savePath: item.getSavePath(),
        error:
          finished === 'interrupted'
            ? 'The download was interrupted and could not resume.'
            : current.download.error
      }
      this.emitDownload(id, true)
      this.trimDownloads()
    })
  }

  private emitDownload(id: string, force = false): void {
    const record = this.downloads.get(id)
    if (!record || this.window.webContents.isDestroyed()) return
    const now = Date.now()
    if (!force && now - record.lastEmittedAt < DOWNLOAD_EVENT_INTERVAL_MS) return
    record.lastEmittedAt = now
    sendToRenderer(this.window.webContents, 'browser:download', { ...record.download })
  }

  private trimDownloads(): void {
    if (this.downloads.size <= MAX_TRACKED_DOWNLOADS) return
    const terminal = [...this.downloads.entries()].filter(
      ([, record]) => record.download.state !== 'progressing'
    )
    while (this.downloads.size > MAX_TRACKED_DOWNLOADS && terminal.length > 0) {
      const [id] = terminal.shift() ?? []
      if (id) this.downloads.delete(id)
    }
  }

  private async clearProjectData(projectId: string): Promise<void> {
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.request.projectId === projectId) this.resolvePermission(requestId, false, false)
    }
    for (const record of this.downloads.values()) {
      if (record.download.projectId === projectId && record.download.state === 'progressing') {
        record.item.cancel()
      }
    }
    const partition = `${BROWSER_PARTITION_PREFIX}${projectId}`
    this.permissionGrants.get(partition)?.clear()
    const browserSession = this.sessionForProject(projectId)
    await Promise.all([browserSession.clearStorageData(), browserSession.clearCache()])
    await browserSession.closeAllConnections()
    for (const tab of this.tabs.values()) {
      if (tab.projectId === projectId && tab.initialNavigationStarted) tab.view.webContents.reload()
    }
  }

  private resolvePermission(requestId: string, granted: boolean, restoreView = true): void {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingPermissions.delete(requestId)
    if (granted) {
      const partition = `${BROWSER_PARTITION_PREFIX}${pending.request.projectId}`
      const grants = this.permissionGrants.get(partition)
      for (const key of permissionGrantKeys(pending.request)) grants?.add(key)
    }
    pending.callback(granted)
    if (!this.window.webContents.isDestroyed()) {
      sendToRenderer(this.window.webContents, 'browser:permissionResolved', requestId)
    }
    if (restoreView) this.restoreTabAfterPermission(pending.request.tabId)
  }

  /** Detach whatever native browser view is currently on screen so a DOM
   *  permission modal is never covered by a native surface. This suspends the
   *  ACTIVE view even when the permission belongs to a background/popup tab
   *  (e.g. a fullscreen tab triggers a popup tab's mic request) — the old
   *  per-tab suspension only detached when the requesting tab was active. */
  private suspendActiveViewForPermission(): void {
    if (!this.activeTabId || this.permissionSuspendedTabs.has(this.activeTabId)) return
    const tab = this.tabs.get(this.activeTabId)
    if (!tab) return
    this.window.contentView.removeChildView(tab.view)
    this.permissionSuspendedTabs.add(this.activeTabId)
  }

  /** True while a browser permission modal is pending in the renderer. While
   *  set, no native browser view may be attached — a WebContentsView floats above
   *  every DOM surface, so restoring one would cover the permission dialog. */
  private permissionModalPending(): boolean {
    return this.pendingPermissions.size > 0
  }

  private restoreTabAfterPermission(tabId: string): void {
    if (
      this.activeTabId !== tabId ||
      !this.permissionSuspendedTabs.has(tabId) ||
      this.permissionModalPending()
    ) {
      return
    }
    const tab = this.tabs.get(tabId)
    if (!tab) return
    this.window.contentView.addChildView(tab.view)
    this.permissionSuspendedTabs.delete(tabId)
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

  private utilityTabContext(
    tabId: string,
    tab: BrowserTab
  ): {
    tabId: string
    projectId: string
    threadId: string
  } {
    return { tabId, projectId: tab.projectId, threadId: tab.threadId }
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
    if (tab && !this.permissionSuspendedTabs.has(this.activeTabId)) {
      this.window.contentView.removeChildView(tab.view)
    }
    this.permissionSuspendedTabs.delete(this.activeTabId)
    this.activeTabId = null
  }

  private destroy(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.request.tabId === tabId) this.resolvePermission(requestId, false, false)
    }
    if (this.activeTabId === tabId) this.detachActiveView()
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    this.tabs.delete(tabId)
    for (const [contextKey, agentTabId] of this.agentTabIds) {
      if (agentTabId === tabId) this.agentTabIds.delete(contextKey)
    }
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
