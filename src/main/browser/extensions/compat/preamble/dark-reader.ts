/**
 * The `extension` namespace this runtime leaves out, and Dark Reader's tab scope.
 *
 * WHY THIS MODULE EXISTS
 * Electron loads these extension copies with `allowFileAccess:false`, so Dark
 * Reader's settings page waits on `chrome.extension.isAllowedFileSchemeAccess`
 * forever unless the member answers. The rest of the module is Dark Reader's site
 * toggle: its own UI switches a site on or off for every tab with that hostname,
 * but this app's scope is the temporary tab the user is looking at. The scope is
 * applied at the message boundary instead, so the extension still owns theme
 * creation, updates and cleanup in every document.
 *
 * WHAT IT HOLDS
 * The retained theme payloads (so a scope change can re-send or clean each one) and
 * the listeners registered on `runtime.onMessage` (so the app can drive the
 * extension's own UI protocol). Both live at module scope because the app's bridge
 * commands land long after install.
 */
import { answering, chromeApi, ensureNamespace, noop, roots, state } from './context.ts'
import type { PreambleEvent } from './context.ts'
import { tabActivity } from './bridge.ts'

/** The runtime namespace, viewed with the members this module reads and patches. */
interface PreambleRuntime {
  id: string
  getURL: (path: string) => string
  getManifest: () => DarkReaderManifest
  onMessage: PreambleEvent
}

/** The manifest members the re-injection pass reads. */
interface DarkReaderManifest {
  content_scripts?: ContentScriptDeclaration[]
  [member: string]: unknown
}

/** One declared content script, as the re-injection pass replays it. */
interface ContentScriptDeclaration {
  js?: string[]
  matches?: string[]
  exclude_matches?: string[]
  all_frames?: unknown
  world?: string
}

/** The extension's own scripting API, as the re-injection pass calls it. */
interface PreambleScripting {
  executeScript: (details: {
    target: { tabId: number; allFrames: boolean }
    files: string[]
    world: string
  }) => Promise<unknown>
}

/** One theme message Dark Reader sends into a document. */
interface DarkReaderMessage {
  type: string
  scriptId?: unknown
  [member: string]: unknown
}

/** The document a retained theme payload was sent to. */
interface DarkReaderFrameOptions {
  documentId?: number
  frameId?: number
  [member: string]: unknown
}

/** `chrome.tabs`, viewed with the one member this module wraps. */
interface DarkReaderTabs {
  sendMessage: (
    id: number,
    message: DarkReaderMessage | undefined,
    ...args: DarkReaderFrameOptions[]
  ) => unknown
}

/** One retained theme payload, so a scope change can re-send or clean it. */
interface DarkReaderFrame {
  id: number
  message: DarkReaderMessage
  options: DarkReaderFrameOptions
  sendMessage: DarkReaderTabs['sendMessage']
}

/** The tab scope the app installs, in the runtime's own tab ids. */
interface DarkReaderPolicy {
  onlyTabId: number | null
  disabledTabIds: unknown[]
}

/** One command the app's bridge delivers to this module. */
interface DarkReaderCommand {
  onlyTabId?: unknown
  disabledTabIds?: unknown
  enable?: unknown
  refresh?: unknown
  enabled?: unknown
}

/** One tab the app reported, as the re-injection pass reads it. */
type DarkReaderTab = { id: number; url: string }

/**
 * Whether this copy is Dark Reader's own worker.
 *
 * Computed by {@link installDarkReader} at the point the original computed it, from
 * the extension's own id: the app's bridge command handler reads this flag after
 * install to decide whether a Dark Reader command has any work to do.
 */
export let darkReader = false

/**
 * Install the `extension` namespace and, when this copy is Dark Reader's, keep the
 * app's temporary tab scope at the message boundary.
 */
export function installDarkReader(): void {
  // Electron loads these copies with allowFileAccess:false. Dark Reader awaits
  // this callback while building its settings page; a missing method leaves its
  // UI request unanswered forever.
  ensureNamespace('extension', { isAllowedFileSchemeAccess: answering(false) }, [])

  const runtime = chromeApi.runtime as PreambleRuntime
  // Dark Reader's site toggle covers every tab with that hostname. Keep the
  // app's temporary tab scope at the message boundary instead, so the extension
  // still owns theme creation, updates and cleanup in every document.
  darkReader = runtime.id === 'eimadpbcbfnmbkopoojfekhnkhdbieeh'
  if (darkReader) {
    const messages = runtime.onMessage
    const addListener = messages.addListener.bind(messages)
    const removeListener = messages.removeListener.bind(messages)
    messages.addListener = (listener) => {
      darkReaderListeners.add(listener)
      addListener(listener)
    }
    messages.removeListener = (listener) => {
      darkReaderListeners.delete(listener)
      removeListener(listener)
    }
    const wrappedTabs = new WeakSet()
    for (const root of roots) {
      const tabs = root.tabs as DarkReaderTabs | undefined
      if (!tabs || typeof tabs.sendMessage !== 'function' || wrappedTabs.has(tabs)) continue
      wrappedTabs.add(tabs)
      const sendMessage = tabs.sendMessage.bind(tabs)
      tabs.sendMessage = (id, message, ...args) => {
        if (message && darkReaderThemeTypes.has(message.type)) {
          const options = args[0] && typeof args[0] === 'object' ? args[0] : {}
          const key = id + ':' + (options.documentId || options.frameId || 0)
          darkReaderFrames.delete(key)
          darkReaderFrames.set(key, { id, message, options, sendMessage })
          // Bound retained theme payloads even on pages with many frames.
          if (darkReaderFrames.size > 512) {
            const oldest = darkReaderFrames.keys().next().value
            if (oldest !== undefined) darkReaderFrames.delete(oldest)
          }
          message = darkReaderDelivery(id, message)
        }
        return sendMessage(id, message, ...args)
      }
    }
  }
}

const darkReaderFrames = new Map<string, DarkReaderFrame>()
const darkReaderListeners = new Set<(...args: unknown[]) => void>()

/**
 * Forget the theme payloads retained for a tab the app reported gone.
 *
 * The bridge command hub owns the tab lifecycle, and a payload kept for a tab nobody
 * has any more is a scope change re-sending a theme into a page that no longer
 * exists. The map stays private here, because this module is the only one that emits
 * from it; the hub asks by tab id and nothing else.
 */
export function forgetDarkReaderFrames(tabId: unknown): void {
  for (const [key, frame] of darkReaderFrames) {
    if (frame.id === tabId) darkReaderFrames.delete(key)
  }
}
let darkReaderPolicy: DarkReaderPolicy = { onlyTabId: null, disabledTabIds: [] }

function darkReaderAllowsTab(id: number): boolean {
  return (
    (darkReaderPolicy.onlyTabId === null || darkReaderPolicy.onlyTabId === id) &&
    !darkReaderPolicy.disabledTabIds.includes(id)
  )
}

const darkReaderThemeTypes = new Set([
  'bg-cs-add-dynamic-theme',
  'bg-cs-add-css-filter',
  'bg-cs-add-static-theme',
  'bg-cs-add-svg-filter',
  'bg-cs-clean-up'
])

function darkReaderDelivery(id: number, message: DarkReaderMessage): DarkReaderMessage {
  return darkReaderAllowsTab(id) ? message : { type: 'bg-cs-clean-up', scriptId: message.scriptId }
}

/** Install the tab scope the app announced, and refresh what each document holds. */
export function applyDarkReaderPolicy(command: DarkReaderCommand): void {
  if (!darkReader) return
  darkReaderPolicy = {
    onlyTabId: typeof command.onlyTabId === 'number' ? command.onlyTabId : null,
    disabledTabIds: Array.isArray(command.disabledTabIds) ? command.disabledTabIds : []
  }
  for (const frame of darkReaderFrames.values()) {
    Promise.resolve(
      frame.sendMessage(frame.id, darkReaderDelivery(frame.id, frame.message), frame.options)
    ).catch(() => {})
  }
  if (command.enable === true || command.refresh === true) {
    // Use Dark Reader's own UI protocol to switch it on. The caller is the
    // app-owned bridge, and the scope is installed before themes are emitted.
    const sender = {
      id: (chromeApi.runtime as PreambleRuntime).id,
      url: (chromeApi.runtime as PreambleRuntime).getURL('ui/popup/index.html')
    }
    for (const listener of darkReaderListeners) {
      try {
        listener(
          {
            type: 'ui-bg-change-settings',
            data: command.enable === true ? { enabled: true } : {}
          },
          sender,
          noop
        )
      } catch (error) {
        state.errors.push('dark-reader-enable: ' + String(error))
      }
    }
  }
}

/** Switch Dark Reader itself off, or re-inject its declared scripts after a reload. */
export async function setDarkReaderPower(command: DarkReaderCommand): Promise<void> {
  if (!darkReader) return
  if (command.enabled === false) {
    // Clean every document we delivered a theme to, including frames that the
    // extension's own startup state has not finished recording yet.
    const frames = [...darkReaderFrames.values()]
    for (let offset = 0; offset < frames.length; offset += 16) {
      await Promise.allSettled(
        frames
          .slice(offset, offset + 16)
          .map((frame) =>
            frame.sendMessage(
              frame.id,
              { type: 'bg-cs-clean-up', scriptId: frame.message.scriptId },
              frame.options
            )
          )
      )
    }
    return
  }
  // Reloading an extension does not re-inject its manifest scripts into pages
  // already open. Run the declared scripts, in order and in their declared
  // worlds, through the extension's own scripting API without reloading sites.
  const manifest = (chromeApi.runtime as PreambleRuntime).getManifest()
  const scripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : []
  const matches = (url: string, pattern: string): boolean => {
    if (pattern === '<all_urls>') return /^https?:/u.test(url)
    if (typeof pattern !== 'string') return false
    const match = /^(\*|https?):\/\/(\*|\*\.[^/]+|[^/]+)(\/.*)$/u.exec(pattern)
    if (!match) return false
    const parsed = new URL(url)
    if (match[1] !== '*' && parsed.protocol !== match[1] + ':') return false
    const host = match[2]
    if (
      host !== '*' &&
      !(host.startsWith('*.')
        ? parsed.hostname === host.slice(2) || parsed.hostname.endsWith(host.slice(1))
        : parsed.hostname === host)
    )
      return false
    const path = match[3].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    return new RegExp('^' + path + '$').test(parsed.pathname + parsed.search)
  }
  for (const tab of Object.values(tabActivity.tabs as Record<string, DarkReaderTab>)) {
    if (!tab || !/^https?:/u.test(tab.url || '')) continue
    for (const script of scripts) {
      if (!Array.isArray(script.js) || script.js.length === 0) continue
      if (
        !script.matches?.some((pattern) => matches(tab.url, pattern)) ||
        script.exclude_matches?.some((pattern) => matches(tab.url, pattern))
      )
        continue
      try {
        await (chromeApi.scripting as PreambleScripting).executeScript({
          target: { tabId: tab.id, allFrames: script.all_frames === true },
          files: script.js,
          world: script.world || 'ISOLATED'
        })
      } catch (error) {
        state.errors.push('dark-reader-inject: ' + String(error))
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  applyDarkReaderPolicy({ ...darkReaderPolicy, enable: true })
}
