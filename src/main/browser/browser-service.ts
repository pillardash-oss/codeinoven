import {
  app,
  BrowserWindow,
  Menu,
  MenuItem,
  dialog,
  session,
  shell,
  webFrameMain,
  WebContentsView,
  type Session,
  type WebFrameMain
} from 'electron'
import { join } from 'node:path'
import type { Database } from '../database/database'
import { ProjectRepo } from '../database/repositories/project-repo'
import { ThreadRepo } from '../database/repositories/thread-repo'
import type { Project, Thread } from '../../lib/types'
import type {
  BrowserConsoleEntry,
  BrowserConsoleLevel,
  BrowserDevToolsState,
  BrowserDownload,
  BrowserDownloadState,
  BrowserPageState,
  BrowserPermissionDecision,
  BrowserPermissionRequest,
  BrowserSiteDataScope,
  BrowserViewBounds
} from '../../lib/ipc-contract'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { Logger } from '../system/logger'
import { fetchIconAsDataUrl } from '../editor/favicon-service'
import { PermissionPromptWindow } from './permission-prompt-window'

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
/** Character cap for the "<project> - <thread>" context line shown above
 *  page alert/confirm dialogs, so a long thread title cannot dominate them. */
const MAX_DIALOG_LABEL_LENGTH = 120

interface BrowserTab {
  view: WebContentsView
  projectId: string
  threadId: string
  initialNavigationStarted: boolean
  consoleEntries: BrowserConsoleEntry[]
  /** Favicon data URL from the last `page-favicon-updated`, cleared on navigation. */
  favicon: string | null
}

interface PendingBrowserPermission {
  request: BrowserPermissionRequest
  callback: (granted: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

/** A destructive site-data action offered by the native site-settings menu. */
interface SiteMenuAction {
  scope: BrowserSiteDataScope
  label: string
  detail: string
}

const SITE_MENU_ACTIONS: readonly SiteMenuAction[] = [
  {
    scope: 'cookies',
    label: 'Clear cookies',
    detail: 'Cookies for sites visited in this browser will be deleted. You may be signed out.'
  },
  {
    scope: 'site-data',
    label: 'Clear site data',
    detail:
      'Storage, service workers and sessions for sites visited in this browser will be deleted.'
  },
  {
    scope: 'cache',
    label: 'Clear cache',
    detail: 'Cached files for sites visited in this browser will be deleted.'
  },
  {
    scope: 'permissions',
    label: 'Reset permissions',
    detail:
      'Remembered camera, microphone and other permission choices for sites visited in this browser will be forgotten.'
  }
]

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

function validatePermissionDecision(value: unknown): BrowserPermissionDecision {
  if (
    typeof value !== 'string' ||
    (value !== 'allow' && value !== 'allow-once' && value !== 'deny' && value !== 'dismiss')
  ) {
    throw new TypeError('Browser permission decision is invalid')
  }
  return value
}

function validateDownloadId(value: unknown): string {
  if (typeof value !== 'string' || !DOWNLOAD_ID_PATTERN.test(value)) {
    throw new TypeError('Browser download ID is invalid')
  }
  return value
}

const SITE_DATA_SCOPES: readonly BrowserSiteDataScope[] = [
  'cookies',
  'site-data',
  'cache',
  'permissions'
]

/** Storage buckets cleared by `session.clearStorageData()` for each scope.
 *  Cookies get their own scope so "cookies" and "site data" stay separable. */
const SCOPE_STORAGE_TYPES: Record<
  'cookies' | 'site-data',
  Array<
    | 'cookies'
    | 'filesystem'
    | 'indexdb'
    | 'localstorage'
    | 'shadercache'
    | 'serviceworkers'
    | 'cachestorage'
  >
> = {
  cookies: ['cookies'],
  'site-data': ['cachestorage', 'filesystem', 'indexdb', 'localstorage', 'serviceworkers']
}

function validateSiteDataScopes(value: unknown): BrowserSiteDataScope[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > SITE_DATA_SCOPES.length) {
    throw new TypeError('Browser site data scopes must be a non-empty array')
  }
  const unique = new Set(value)
  for (const scope of unique) {
    if (!SITE_DATA_SCOPES.includes(scope as BrowserSiteDataScope)) {
      throw new TypeError(`Browser site data scope is invalid: ${String(scope)}`)
    }
  }
  return [...unique]
}

function validateSiteMenuPoint(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100_000) {
    throw new TypeError(`Browser site menu ${label} is invalid`)
  }
  return Math.round(value)
}

/** Validate the display host shown at the top of the site-settings menu. */
function validateBoundedHost(value: unknown): string {
  if (typeof value !== 'string' || value.length > 260 || value.includes('\0')) {
    throw new TypeError('Browser site menu host is invalid')
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

/** Build the injected wrapper that prefixes page alert/confirm messages with
 *  the owning thread's context line. Escaping goes through `JSON.stringify`,
 *  so any project or thread name is embedded safely as a JS string literal. */
function dialogContextScript(label: string): string {
  return `(() => {
  const label = ${JSON.stringify(label)};
  const win = window;
  if (win.__cioDialogOriginals === undefined) win.__cioDialogOriginals = {};
  const originals = win.__cioDialogOriginals;
  for (const [name, kind] of [['alert', 'Alert'], ['confirm', 'Confirm']]) {
    if (typeof originals[name] !== 'function') {
      const current = win[name];
      if (typeof current !== 'function') continue;
      originals[name] = current.bind(win);
    }
    const original = originals[name];
    win[name] = function (message) {
      const text = message == null ? '' : String(message);
      return original(label + ' ' + kind + '\\n\\n' + text);
    };
  }
})()`
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

/** How a permission reply affects what the browser remembers. */
interface PermissionResolution {
  granted: boolean
  rememberGrant: boolean
  rememberDeny: boolean
}

const permissionResolutions: Record<BrowserPermissionDecision, PermissionResolution> = {
  allow: { granted: true, rememberGrant: true, rememberDeny: false },
  'allow-once': { granted: true, rememberGrant: false, rememberDeny: false },
  deny: { granted: false, rememberGrant: false, rememberDeny: true },
  dismiss: { granted: false, rememberGrant: false, rememberDeny: false }
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
  private readonly permissionDenies = new Map<string, Set<string>>()
  private readonly pendingPermissions = new Map<string, PendingBrowserPermission>()
  private readonly downloads = new Map<string, BrowserDownloadRecord>()
  private readonly promptWindow: PermissionPromptWindow
  private readonly projects: ProjectRepo
  private readonly threads: ThreadRepo
  private activeTabId: string | null = null
  /** Last known content bounds of the active tab's native view (window-content
   *  coordinates). The permission popup anchors itself to this area so it
   *  never collides with toasts at the window edge. */
  private activeTabBounds: BrowserViewBounds | null = null
  /** True while a Sonner toast is visible in the renderer. A native
   *  WebContentsView floats above every DOM surface, so while this is set the
   *  active browser view stays detached and the DOM toast composites normally. */
  private toastVisible = false
  private consoleSequence = 0

  constructor(
    private readonly window: BrowserWindow,
    db: Database
  ) {
    this.promptWindow = new PermissionPromptWindow(window)
    this.projects = new ProjectRepo(db)
    this.threads = new ThreadRepo(db)
  }

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
        if (this.activeTabId !== tabId) {
          this.activeTabId = tabId
          if (!this.toastVisible) this.window.contentView.addChildView(tab.view)
        }
        tab.view.setBounds(bounds)
        this.activeTabBounds = bounds
        // Refresh the alert/confirm context label on every activation so a
        // renamed project or thread is reflected without waiting for a reload.
        this.injectDialogContext(tabId)
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
      // Missing tabs are silently ignored   the renderer may call hide
      // during teardown after the tab was already destroyed.
    })
    ipcMain.handle('browser:setToastVisible', (_event, rawVisible) => {
      this.setToastVisible(rawVisible === true)
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
    ipcMain.handle('browser:toggleDevTools', (_event, rawTabId) => {
      const tab = this.requireTab(validateTabId(rawTabId))
      const contents = tab.view.webContents
      if (contents.isDevToolsOpened()) {
        contents.closeDevTools()
        return false
      }
      // Plain native behavior: default dock inside the window, resizable
      // there, fully undockable from DevTools' own controls.
      contents.openDevTools()
      return true
    })
    ipcMain.handle('browser:clearData', async (_event, rawProjectId) => {
      await this.clearProjectData(validateProjectId(rawProjectId))
    })
    ipcMain.handle('browser:clearSiteData', (_event, rawProjectId, rawScopes) => {
      const projectId = validateProjectId(rawProjectId)
      const scopes = validateSiteDataScopes(rawScopes)
      void this.clearSiteData(projectId, scopes).catch((error: unknown) => {
        Logger.error('Browser site data could not be cleared:', error)
      })
    })
    ipcMain.handle('browser:siteMenu', (_event, rawProjectId, rawHost, rawX, rawY) => {
      const projectId = validateProjectId(rawProjectId)
      const host = validateBoundedHost(rawHost)
      const x = validateSiteMenuPoint(rawX, 'x coordinate')
      const y = validateSiteMenuPoint(rawY, 'y coordinate')
      // Native popup menus run a nested run loop; detach from the invoke reply
      // so the renderer's call resolves immediately.
      setImmediate(() => this.showSiteMenu(projectId, host, x, y))
    })
    ipcMain.handle('browser:resolvePermission', (_event, rawRequestId, rawDecision) => {
      const requestId = validatePermissionRequestId(rawRequestId)
      const decision = validatePermissionDecision(rawDecision)
      this.resolvePermission(requestId, permissionResolutions[decision])
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
    this.toastVisible = false
    this.activeTabBounds = null
    this.promptWindow.dispose()
    for (const requestId of [...this.pendingPermissions.keys()]) {
      this.resolvePermission(requestId, permissionResolutions.dismiss)
    }
    for (const tab of this.tabs.values()) {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    }
    this.tabs.clear()
    this.agentTabIds.clear()
    this.configuredSessions.clear()
    this.permissionGrants.clear()
    this.permissionDenies.clear()
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
      consoleEntries: [],
      favicon: null
    }
    this.tabs.set(tabId, tab)

    const publish = (): void => this.publishState(tabId)
    view.webContents.on('did-finish-load', () => this.injectDialogContext(tabId))
    view.webContents.on(
      'did-frame-finish-load',
      (_event, isMainFrame, frameProcessId, frameRoutingId) => {
        if (isMainFrame) return
        const frame = webFrameMain.fromId(frameProcessId, frameRoutingId)
        if (frame) this.injectDialogContext(tabId, frame)
      }
    )
    view.webContents.on('devtools-opened', publish)
    view.webContents.on('devtools-closed', publish)
    view.webContents.on('did-start-loading', publish)
    view.webContents.on('did-stop-loading', publish)
    view.webContents.on('did-navigate', () => {
      // A new document starts without an icon; the old site's favicon must not linger.
      tab.favicon = null
      publish()
    })
    view.webContents.on('did-navigate-in-page', publish)
    view.webContents.on('page-title-updated', publish)
    view.webContents.on('page-favicon-updated', (_event, favicons) => {
      const source = favicons.find((candidate) => candidate.length > 0) ?? null
      if (!source) return
      // Electron reports icon URLs, but remote images are blocked by the
      // renderer CSP   convert to a data URL so any consumer can render it.
      void fetchIconAsDataUrl(source).then((favicon) => {
        if (!favicon || tab.favicon === favicon) return
        tab.favicon = favicon
        publish()
      })
    })
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
    const denies = new Set<string>()
    this.permissionGrants.set(partition, grants)
    this.permissionDenies.set(partition, denies)
    browserSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
      const origin = permissionOrigin(requestingOrigin)
      if (!origin) return false
      const mediaType = Reflect.get(details, 'mediaType')
      const scope = permissionKey(
        origin,
        permission,
        typeof mediaType === 'string' ? mediaType : ''
      )
      // A remembered "Don't allow" wins over any cached grant for the same key.
      return !denies.has(scope) && grants.has(scope)
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
      const mediaTypes = Array.isArray(rawMediaTypes)
        ? rawMediaTypes.filter((value): value is string => typeof value === 'string')
        : []
      const request: BrowserPermissionRequest = {
        id,
        tabId,
        projectId,
        origin,
        permission,
        mediaTypes
      }
      // A remembered "Don't allow" for any of these keys: refuse silently so the
      // site is not re-prompted, without suspending the view or showing a modal.
      const partition = `${BROWSER_PARTITION_PREFIX}${projectId}`
      if (
        permissionGrantKeys(request).some((key) => this.permissionDenies.get(partition)?.has(key))
      ) {
        callback(false)
        return
      }
      const timer = setTimeout(
        () => this.resolvePermission(id, permissionResolutions.dismiss),
        PERMISSION_TIMEOUT_MS
      )
      this.pendingPermissions.set(id, { request, callback, timer })
      // Native OS popup composites above the WebContentsView: the page stays
      // live and interactive while the prompt is on screen.
      this.promptWindow.show(request, this.pendingPermissions.size, this.promptAnchor())
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

  /** Open the OS-native site-settings context menu. Runs in a nested run loop
   *  and composites above the WebContentsView, so the page never has to be
   *  detached for the menu. */
  private showSiteMenu(projectId: string, host: string, x: number, y: number): void {
    if (this.window.isDestroyed()) return
    const menu = new Menu()
    if (host) menu.append(new MenuItem({ label: host, enabled: false }))
    menu.append(new MenuItem({ type: 'separator' }))
    for (const action of SITE_MENU_ACTIONS) {
      menu.append(
        new MenuItem({
          label: `${action.label}…`,
          click: () => this.confirmAndClearSiteData(projectId, action)
        })
      )
    }
    menu.popup({
      window: this.window,
      x,
      y,
      callback: () => {
        if (!this.window.webContents.isDestroyed()) {
          sendToRenderer(this.window.webContents, 'browser:siteMenuClosed')
        }
      }
    })
  }

  /** Confirm the destructive site-data action with a parented native dialog
   *  before executing it. */
  private confirmAndClearSiteData(projectId: string, action: SiteMenuAction): void {
    if (this.window.isDestroyed()) return
    void dialog
      .showMessageBox(this.window, {
        type: 'warning',
        message: `${action.label}?`,
        detail: action.detail,
        buttons: [action.label, 'Cancel'],
        defaultId: 1,
        cancelId: 1
      })
      .then((result) => {
        if (result.response !== 0) return
        return this.clearSiteData(projectId, [action.scope]).catch((error: unknown) => {
          Logger.error('Browser site data could not be cleared:', error)
          if (this.window.isDestroyed()) return
          void dialog.showMessageBox(this.window, {
            type: 'error',
            message: 'Site data could not be cleared',
            detail:
              error instanceof Error && error.message
                ? error.message
                : 'An unexpected error occurred while clearing browser site data.',
            buttons: ['OK']
          })
        })
      })
      .catch((error: unknown) => {
        Logger.error('Browser site data confirmation failed:', error)
      })
  }

  private async clearProjectData(projectId: string): Promise<void> {
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.request.projectId === projectId)
        this.resolvePermission(requestId, permissionResolutions.dismiss)
    }
    for (const record of this.downloads.values()) {
      if (record.download.projectId === projectId && record.download.state === 'progressing') {
        record.item.cancel()
      }
    }
    const partition = `${BROWSER_PARTITION_PREFIX}${projectId}`
    this.permissionGrants.get(partition)?.clear()
    this.permissionDenies.get(partition)?.clear()
    const browserSession = this.sessionForProject(projectId)
    await Promise.all([browserSession.clearStorageData(), browserSession.clearCache()])
    await browserSession.closeAllConnections()
    for (const tab of this.tabs.values()) {
      if (tab.projectId === projectId && tab.initialNavigationStarted) tab.view.webContents.reload()
    }
  }

  /** Clear only the requested scopes for the project's browser session. Tabs of
   *  the project reload afterwards so cleared state takes effect immediately. */
  private async clearSiteData(projectId: string, scopes: BrowserSiteDataScope[]): Promise<void> {
    if (scopes.includes('permissions')) {
      for (const [requestId, pending] of this.pendingPermissions) {
        if (pending.request.projectId === projectId) {
          this.resolvePermission(requestId, permissionResolutions.dismiss)
        }
      }
      const partition = `${BROWSER_PARTITION_PREFIX}${projectId}`
      this.permissionGrants.get(partition)?.clear()
      this.permissionDenies.get(partition)?.clear()
    }
    const browserSession = this.sessionForProject(projectId)
    const work: Promise<unknown>[] = []
    for (const scope of scopes) {
      if (scope === 'cache') {
        work.push(browserSession.clearCache())
      } else if (scope === 'cookies' || scope === 'site-data') {
        work.push(browserSession.clearStorageData({ storages: SCOPE_STORAGE_TYPES[scope] }))
      }
    }
    if (work.length > 0) {
      await Promise.all(work)
      await browserSession.closeAllConnections()
    }
    for (const tab of this.tabs.values()) {
      if (tab.projectId === projectId && tab.initialNavigationStarted) tab.view.webContents.reload()
    }
  }

  private resolvePermission(requestId: string, resolution: PermissionResolution): void {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingPermissions.delete(requestId)
    if (resolution.rememberGrant || resolution.rememberDeny) {
      const partition = `${BROWSER_PARTITION_PREFIX}${pending.request.projectId}`
      const grants = this.permissionGrants.get(partition)
      const denies = this.permissionDenies.get(partition)
      for (const key of permissionGrantKeys(pending.request)) {
        if (resolution.rememberDeny) {
          grants?.delete(key)
          denies?.add(key)
        } else if (resolution.rememberGrant) {
          denies?.delete(key)
          grants?.add(key)
        }
      }
    }
    pending.callback(resolution.granted)
    // Show the next queued request, or drop the prompt when the queue is empty.
    const next = this.pendingPermissions.values().next()
    if (next.done) {
      this.promptWindow.hide()
      return
    }
    this.promptWindow.show(next.value.request, this.pendingPermissions.size, this.promptAnchor())
  }

  /** Content-anchored placement data for the permission popup: the active tab's
   *  last known view bounds, or nothing when no tab is on screen. */
  private promptAnchor(): { x: number; y: number; width: number } | null {
    const bounds = this.activeTabBounds
    return bounds ? { x: bounds.x, y: bounds.y, width: bounds.width } : null
  }

  /** Resolve the "<project> - <thread>" context line for a tab's dialogs, or
   *  null when either record is missing (native dialog then stays untouched). */
  private dialogLabel(tab: BrowserTab): string | null {
    let project: Project | null
    let thread: Thread | null
    try {
      project = this.projects.get(tab.projectId)
      thread = this.threads.get(tab.threadId)
    } catch (error: unknown) {
      Logger.error('Browser dialog context lookup failed:', error)
      return null
    }
    if (!project || !thread) return null
    const name = project.name.trim()
    const title = thread.title.trim()
    if (!name || !title) return null
    const label = `${name} - ${title}`
    return label.length > MAX_DIALOG_LABEL_LENGTH
      ? `${label.slice(0, MAX_DIALOG_LABEL_LENGTH)}…`
      : label
  }

  /** Install the labeled alert/confirm shim into a document's JS context.
   *  Chromium renders page dialogs as native windows parented to the app
   *  window and carries no context about which CodeInOven thread owns the
   *  page, so every loaded frame gets a wrapper that prefixes the dialog
   *  message with "<project> - <thread> <Alert|Confirm>" followed by the
   *  page's own text. Injection is idempotent per document: re-injection
   *  (after thread renames or replays) rewraps the same original callables
   *  instead of stacking prefixes. `prompt()` is left untouched because
   *  Electron never renders it. */
  private injectDialogContext(tabId: string, frame?: WebFrameMain): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    const label = this.dialogLabel(tab)
    if (!label) return
    const script = dialogContextScript(label)
    const contents = tab.view.webContents
    if (contents.isDestroyed()) return
    if (frame) {
      this.runDialogScript(frame, script)
      return
    }
    let frames: readonly WebFrameMain[]
    try {
      frames = contents.mainFrame.framesInSubtree
    } catch {
      // Between documents there is no frame tree to inject into.
      return
    }
    for (const candidate of frames) this.runDialogScript(candidate, script)
  }

  private runDialogScript(frame: WebFrameMain, script: string): void {
    if (frame.isDestroyed()) return
    void frame.executeJavaScript(script).catch(() => {
      // Frames can be replaced mid-navigation; the shim installs on the next
      // frame load, so a failed injection here is harmless.
    })
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
      favicon: tab.favicon,
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
    sendToRenderer(
      this.window.webContents,
      'browser:devToolsChanged',
      this.devToolsStateFor(tabId, tab)
    )
  }

  private devToolsStateFor(tabId: string, tab: BrowserTab): BrowserDevToolsState {
    return { tabId, open: tab.view.webContents.isDevToolsOpened() }
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
  }

  private detachActiveView(): void {
    if (!this.activeTabId) return
    const tab = this.tabs.get(this.activeTabId)
    if (tab) this.window.contentView.removeChildView(tab.view)
    this.activeTabId = null
  }

  /** Suspend the active native browser view while a toast is on screen. A
   *  WebContentsView floats above every DOM surface, so toasts would be hidden
   *  behind it; detaching lets the DOM toast composite normally. When the
   *  toast clears, the view is re-attached. */
  private setToastVisible(visible: boolean): void {
    this.toastVisible = visible
    if (!this.activeTabId) return
    const tab = this.tabs.get(this.activeTabId)
    if (!tab) return
    if (visible) this.window.contentView.removeChildView(tab.view)
    else this.window.contentView.addChildView(tab.view)
  }

  private destroy(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.request.tabId === tabId)
        this.resolvePermission(requestId, permissionResolutions.dismiss)
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
