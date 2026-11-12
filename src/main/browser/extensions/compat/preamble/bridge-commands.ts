/**
 * The bridge command hub: every command the app sends a worker, dispatched by kind.
 *
 * WHY THIS MODULE EXISTS
 * The app talks to a worker over one long-lived port, and a command arrives as a plain
 * object whose `kind` says what the app saw and whose `name` says which event it
 * belongs to. Nothing here decides anything: a tab lifecycle the app announced becomes
 * the `chrome.tabs` event an extension registered, a window closing becomes the
 * `chrome.windows.onRemoved` under the id the app lent it, and an answer to a request
 * this worker made settles the request it belongs to. An extension's click is routed
 * by string equality on those names, so the branch order and every literal below are
 * the contract, not a style choice.
 *
 * WHAT IT OWNS
 * The three counters the app reads back through the mailbox: how many commands reached
 * this worker, a short log of what they were, and how many listeners each event had
 * when it was fired. Those are the difference between "the event never arrived" and
 * "it arrived and nobody was listening", which is the question every missing menu or
 * panel turns into.
 *
 * WHAT IT DOES NOT OWN
 * The port itself and the listener that receives it: `native-messaging.ts` installs
 * that listener, because the same port also carries the native host requests it has
 * queued, and this module is the dispatch half it hands each command to.
 */
import { noop, state } from './context.ts'
import { runtimeEvents, tabEvents, windowEvents } from './events.ts'
import type { RealEvent } from './events.ts'
import {
  HOSTED_POPUP_WINDOW_ID,
  currentBridgePort,
  hostedPopout,
  markTabReplayComplete,
  tabActivity
} from './bridge.ts'
import type { TabSnapshot } from './bridge.ts'
import { actionState, scheduleMailbox } from './mailbox.ts'
import { applyDarkReaderPolicy, forgetDarkReaderFrames, setDarkReaderPower } from './dark-reader.ts'
import { handleNativeCommand } from './native-messaging.ts'
import type { NativeInboundCommand } from './native-messaging.ts'
import { settleCookieRequest } from './cookies.ts'
import { webRequestEvents } from './web-request.ts'
import { webNavigationEvents } from './extension-page.ts'
import { downloadEvents } from './downloads.ts'
import {
  notificationButtonClicked,
  notificationClicked,
  notificationClosed
} from './notifications.ts'
import { sidePanelClosed, sidePanelDetails, sidePanelOpened } from './side-panel.ts'
import { contextMenuClicked } from './context-menus.ts'

/**
 * One command the app posts over the bridge port.
 *
 * Every member is `unknown`: the envelope is written by app main and only read here,
 * and each field is narrowed at the point it is used. `kind` and `name` are compared
 * as strings; everything else is handed to the module that owns its shape.
 */
export interface BridgeCommand {
  kind?: unknown
  name?: unknown
  args?: unknown
  requestId?: unknown
  details?: unknown
  id?: unknown
  buttonIndex?: unknown
  byUser?: unknown
  tab?: unknown
  info?: unknown
  error?: unknown
  // The members of a side panel command and of a dark reader command, which are
  // handed to the modules that own those shapes as the command itself.
  tabId?: unknown
  path?: unknown
  onlyTabId?: unknown
  disabledTabIds?: unknown
  enable?: unknown
  enabled?: unknown
  refresh?: unknown
  [member: string]: unknown
}

/** One event's delivery record: fired how often, before how many listeners, failing how often. */
export interface DispatchRecord {
  delivered: number
  listeners: number
  errors: number
}

/** Every event's record, by the name the command carried. */
export type DispatchRecords = Record<string, DispatchRecord>

/** The options-page report `installExtensionPage` puts on the state this hub updates. */
interface ExtensionPageReport {
  requested: number
  failed: number
  lastError: unknown
}

/**
 * How many commands have reached this worker.
 *
 * Read and written through `state`, because the mailbox is what carries it out: the
 * count is the only way the app can tell a worker that heard nothing from one that
 * chose to do nothing.
 */
export function bridgeCommandCount(): number {
  const current = state.bridgeCommands
  return typeof current === 'number' ? current : 0
}

/**
 * The short log of what actually reached this worker, created on first use.
 *
 * Held on `state` for the same reason as the count: it is the app that reads it, and
 * the alternative is guessing whether an event was ever delivered.
 */
export function bridgeCommandLog(): string[] {
  const current = state.commandLog
  if (Array.isArray(current)) return current as string[]
  const created: string[] = []
  state.commandLog = created
  return created
}

/** The per-event delivery counters, created on first use. */
export function dispatchRecords(): DispatchRecords {
  const current = state.eventDispatch
  if (current && typeof current === 'object') return current as DispatchRecords
  const created: DispatchRecords = {}
  state.eventDispatch = created
  return created
}

/** One event's counter, created the first time a command fires that event. */
export function dispatchRecord(name: string): DispatchRecord {
  const records = dispatchRecords()
  const existing = records[name]
  if (existing) return existing
  const created: DispatchRecord = { delivered: 0, listeners: 0, errors: 0 }
  records[name] = created
  return created
}

/** The options-page report, created the way the module that owns it creates it. */
function extensionPageReport(): ExtensionPageReport {
  const current = state.extensionPages
  if (current && typeof current === 'object') return current as ExtensionPageReport
  const created: ExtensionPageReport = { requested: 0, failed: 0, lastError: null }
  state.extensionPages = created
  return created
}

/** One command argument read as an object, when it is one. */
function argumentRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

/**
 * Dispatch one command the app posted over the bridge port.
 *
 * The branch order is the order the single-closure preamble dispatched in, and the
 * literals are the protocol: reordering or renaming one is a click that lands nowhere.
 * Nothing here throws on a malformed command — a worker has nobody to throw to, and a
 * command the app sent but this worker could not use is recorded rather than raised.
 */
export function handleBridgeCommand(command: BridgeCommand | null | undefined): void {
  if (!command || typeof command !== 'object') return
  state.bridgeCommands = bridgeCommandCount() + 1
  // A short log of what actually reached this worker, for the app's own
  // diagnostics: the alternative is guessing whether an event was delivered.
  const log = bridgeCommandLog()
  log.push(
    typeof command.name === 'string'
      ? String(command.kind) + ':' + command.name
      : String(command.kind)
  )
  if (log.length > 100) {
    log.splice(0, log.length - 100)
  }
  // Every branch below compares this name and looks a dispatcher up by it, and a
  // property key is coerced to a string anyway: naming it once is the same read.
  const name = String(command.name)
  // What was delivered and how many listeners were there to receive it: an
  // event delivered before an extension registered its listener looks exactly
  // like one it never reacted to, and the two are worth telling apart when a
  // menu or a panel does not appear. Tab events and navigation events both
  // record through here, because the shim's own delivery is the first thing to
  // doubt when a real extension seems not to react.
  const emitRecorded = (eventName: string, dispatcher: RealEvent, args: unknown[]): void => {
    const entry = dispatchRecord(eventName)
    entry.delivered += 1
    entry.listeners = typeof dispatcher.__cioCount === 'function' ? dispatcher.__cioCount() : 0
    const errorsBefore = state.errors.length
    dispatcher.__cioEmit(args)
    entry.errors += state.errors.length - errorsBefore
  }
  if (command.kind === 'dark-reader-power') {
    void setDarkReaderPower(command).then(
      () =>
        currentBridgePort()?.postMessage({
          kind: 'command-complete',
          requestId: command.requestId
        }),
      (error) =>
        currentBridgePort()?.postMessage({
          kind: 'command-complete',
          requestId: command.requestId,
          error: String(error)
        })
    )
  } else if (command.kind === 'dark-reader-tab-policy') {
    applyDarkReaderPolicy(command)
  } else if (command.kind === 'window') {
    const args: unknown[] = Array.isArray(command.args) ? command.args : []
    // A window this app handed the extension is gone. It is forgotten here first,
    // so `chrome.tabs.query` and `runtime.getContexts` stop reporting a window
    // whose page no longer exists, and the extension's own listeners then hear it
    // under the id they were given.
    if (name === 'onRemoved' && args[0] === HOSTED_POPUP_WINDOW_ID) {
      hostedPopout.url = null
      hostedPopout.focused = false
    }
    const dispatcher = windowEvents[name]
    if (dispatcher) emitRecorded(name, dispatcher, args)
  } else if (command.kind === 'tab') {
    const args: unknown[] = Array.isArray(command.args) ? command.args : []
    if (name === 'onActivated') {
      const activated = argumentRecord(args[0])
      if (activated && typeof activated.tabId === 'number') {
        tabActivity.activeTabId = activated.tabId
      }
    } else if (name === 'onCreated' || name === 'onHighlighted') {
      const created = argumentRecord(args[0])
      if (created && created.active === true && typeof created.id === 'number') {
        tabActivity.activeTabId = created.id
      }
    } else if (name === 'onUpdated') {
      const info = argumentRecord(args[2])
      if (info && info.active === true && typeof info.id === 'number') {
        tabActivity.activeTabId = info.id
      }
    } else if (name === 'onRemoved') {
      if (args[0] === tabActivity.activeTabId) tabActivity.activeTabId = null
    }
    if (name === 'onCreated') {
      const tab = argumentRecord(args[0])
      if (tab && typeof tab.id === 'number' && tab.id >= 0) {
        tabActivity.tabs[String(tab.id)] = Object.assign(
          {
            discarded: false,
            highlighted: tab.active === true,
            windowType: 'normal',
            autoDiscardable: false,
            mutedInfo: { muted: false }
          },
          tab
        ) as TabSnapshot
      }
    } else if (name === 'onUpdated') {
      const tab = argumentRecord(args[2])
      if (tab && typeof tab.id === 'number' && tab.id >= 0) {
        const key = String(tab.id)
        tabActivity.tabs[key] = Object.assign(
          {
            discarded: false,
            highlighted: tab.active === true,
            windowType: 'normal',
            autoDiscardable: false,
            mutedInfo: { muted: false }
          },
          tabActivity.tabs[key] || {},
          tab
        ) as TabSnapshot
      }
    } else if (name === 'onRemoved' && typeof args[0] === 'number') {
      delete tabActivity.tabs[String(args[0])]
    }
    if (
      name === 'onRemoved' ||
      (name === 'onUpdated' && argumentRecord(args[1])?.status === 'loading')
    ) {
      forgetDarkReaderFrames(args[0])
    }
    if (typeof tabActivity.activeTabId === 'number') {
      for (const key of Object.keys(tabActivity.tabs)) {
        const active = Number(key) === tabActivity.activeTabId
        tabActivity.tabs[key].active = active
        tabActivity.tabs[key].highlighted = active
      }
    }
    const dispatcher = tabEvents[name]
    if (dispatcher) {
      emitRecorded(name, dispatcher, args)
      // A closed tab's action state goes with the event, so a long session
      // does not accumulate entries for tabs nobody has.
      if (name === 'onRemoved' && Array.isArray(command.args) && command.args[0] !== undefined) {
        delete actionState.tabs[String(command.args[0])]
      }
    }
  } else if (command.kind === 'tab-replay-complete') {
    markTabReplayComplete()
  } else if (command.kind === 'web-navigation') {
    // The details object is built on the app's side in `chrome.webNavigation`'s
    // own shape, so a listener written against the real API runs unmodified.
    const dispatcher = webNavigationEvents[name]
    if (dispatcher) {
      emitRecorded(
        name,
        dispatcher,
        Array.isArray(command.args) ? command.args : [command.details || {}]
      )
    }
  } else if (command.kind === 'side-panel-opened') {
    sidePanelOpened.__cioEmit([sidePanelDetails(command)])
  } else if (command.kind === 'side-panel-closed') {
    sidePanelClosed.__cioEmit([sidePanelDetails(command)])
  } else if (command.kind === 'notification-click') {
    const id = String(command.id || '')
    // A button click is not a body click: Chromium reports them on different
    // events, and an extension that offers buttons only listens for the former.
    if (typeof command.buttonIndex === 'number') {
      notificationButtonClicked.__cioEmit([id, command.buttonIndex])
    } else {
      notificationClicked.__cioEmit([id])
    }
  } else if (command.kind === 'notification-close') {
    notificationClosed.__cioEmit([String(command.id || ''), command.byUser === true])
  } else if (command.kind === 'downloads') {
    const dispatcher = downloadEvents[name]
    if (dispatcher) {
      const args: unknown[] = Array.isArray(command.args) ? command.args : []
      // `onDeterminingFilename` hands its listener a `suggest` callback, and a
      // listener that exists but never calls it leaves the filename to the app.
      // The app already decided it, so this one only keeps the listener's own
      // signature intact.
      emitRecorded(
        'downloads.' + name,
        dispatcher,
        name === 'onDeterminingFilename' ? [args[0], noop] : args
      )
    }
  } else if (command.kind === 'cookies-result') {
    settleCookieRequest(command)
  } else if (command.kind === 'extension-page-result') {
    // A page the app could not open is something the extension cannot see: it
    // was told the call was made. Recording it here is what the capability
    // report can name, and pushing it into `state.errors` is the whole of what
    // this can do about it: a worker has nobody to throw to.
    if (command.error) {
      const report = extensionPageReport()
      report.failed += 1
      report.lastError = String(command.error)
      state.errors.push('open-options-page: ' + String(command.error))
    }
  } else if (command.kind === 'web-request') {
    const webRequestEvent = webRequestEvents[name]
    if (webRequestEvent) {
      // One argument, the details object: that is the whole listener signature
      // this API has, so an extension that destructures `details` reads exactly
      // what main built in the API's own shape.
      emitRecorded('webRequest.' + name, webRequestEvent, [
        command.details && typeof command.details === 'object' ? command.details : {}
      ])
    }
  } else if (command.kind === 'startup') {
    state.startupAt = Date.now()
    runtimeEvents.onStartup.__cioEmit([])
  } else if (command.kind === 'installed') {
    const rawDetails = command.details
    const details =
      rawDetails && typeof rawDetails === 'object' && !Array.isArray(rawDetails)
        ? (rawDetails as Record<string, unknown>)
        : {}
    const installed = {
      reason: details.reason === 'update' ? 'update' : 'install',
      ...(typeof details.previousVersion === 'string'
        ? { previousVersion: details.previousVersion }
        : {})
    }
    emitRecorded('onInstalled', runtimeEvents.onInstalled, [installed])
  } else if (command.kind === 'menu-click') {
    const tab = argumentRecord(command.tab)
    if (tab && typeof tab.id === 'number' && tab.id >= 0) {
      tabActivity.activeTabId = tab.id
    }
    contextMenuClicked.__cioEmit([command.info || {}, command.tab || null])
  } else if (command.kind === 'keep-alive') {
    // The app touches a worker that owns a native messaging port so it is not
    // released while it holds one, which is Chromium's own rule for a native
    // port. Recorded only so a worker that never seems to sleep can be
    // explained from its own mailbox.
    state.nativeKeepAliveAt = Date.now()
  } else if (
    command.kind === 'native-connect-result' ||
    command.kind === 'native-message' ||
    command.kind === 'native-disconnect'
  ) {
    handleNativeCommand(command as NativeInboundCommand)
  }
  scheduleMailbox()
}

/**
 * The hub installs nothing: every command it dispatches arrives on the bridge port,
 * and the listener that takes that port is installed by `native-messaging.ts`, which
 * owns the queue the same port flushes.
 *
 * It stays a named step in the composition so that the order the single-closure
 * preamble ran in is still readable, and so a reader looking for where commands are
 * wired finds the place that says where instead of nothing at all.
 */
export function installBridgeCommands(): void {
  // Nothing to install: see above.
}
