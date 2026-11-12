/**
 * ── sidePanel, for real ─────────────────────────────────────────────────────
 * Electron compiles the namespace out, so `setOptions` and `open` were calls that
 * returned nothing and changed nothing: an extension that offers its UI in a side
 * panel simply had no UI. The app has a rail it can host one in, so the extension's
 * intent is carried to main here and main puts the panel in that rail.
 *
 * What travels is the extension's own `path`, unchanged. The panel is the
 * extension's HTML loaded from its own origin in its own jar, not markup the app
 * re-renders, so a panel that scripts itself works the way it does in a browser.
 */

import { answerWith, roots, state } from './context.ts'
import type { ChromeNamespace } from './context.ts'
import { makeRealEvent } from './events.ts'
import { scheduleMailbox } from './mailbox.ts'

/** Which request this is; the mailbox carries it to main. */
export type SidePanelRequestKind = 'open' | 'close'

/** One panel request main reads out of the mailbox. */
export interface SidePanelRequest {
  /** The number this life gave the request; main acts on what it has not seen. */
  seq: number
  kind: SidePanelRequestKind
  tabId: number | undefined
}

/** What an extension asked a panel to be, kept per tab and as the default. */
export interface SidePanelOptionRecord {
  /** No tab id is the default record, which is what an extension that omits it means. */
  tabId: number | undefined
  path: string | undefined
  enabled: boolean | undefined
}

/** `setPanelBehavior`'s own record, mirrored on `state`. */
export interface SidePanelBehavior {
  openPanelOnActionClick: boolean
}

/** The details object a listener on `onOpened` / `onClosed` is handed. */
export interface SidePanelDetails {
  tabId: number
  windowId: number
  path: string
}

/** What this module records on `state.sidePanel`, which the app reads back. */
export interface SidePanelStats {
  requests: number
  options: number
  behavior: SidePanelBehavior | null
  shimmed?: boolean
}

/**
 * The options object an extension hands `chrome.sidePanel`, and the command the
 * bridge hands back: the same field names, read the same defensive way, because
 * both arrive from outside this module.
 */
export interface SidePanelOptions {
  tabId?: unknown
  path?: unknown
  enabled?: unknown
}

/**
 * The object `state.sidePanel` points at.
 *
 * It is held here as well as on `state` because `PreambleState` carries an index
 * signature, so `state.sidePanel.requests` reads as `unknown`; the two names are the
 * same object, and `installSidePanel` puts this one on `state`.
 */
export const sidePanelStats: SidePanelStats = { requests: 0, options: 0, behavior: null }

export const sidePanelRequests: SidePanelRequest[] = []
export let sidePanelRequestSeq = 0
export let sidePanelBehavior: SidePanelBehavior | null = null
export const sidePanelOptionRecords: SidePanelOptionRecord[] = []
export const sidePanelOpened = makeRealEvent()
export const sidePanelClosed = makeRealEvent()

export const sidePanelScopeKey = (options?: SidePanelOptions | null): string => {
  const tabId = options && typeof options === 'object' ? options.tabId : undefined
  // Chromium keeps a per-tab override and a default; the default is the record
  // with no tab id, which is what an extension that never passes one means.
  return typeof tabId === 'number' && tabId >= 0 ? String(tabId) : ''
}

export const queueSidePanelRequest = (
  kind: SidePanelRequestKind,
  options?: SidePanelOptions | null
): void => {
  sidePanelRequestSeq += 1
  sidePanelRequests.push({
    seq: sidePanelRequestSeq,
    kind,
    tabId:
      options && typeof options.tabId === 'number' && options.tabId >= 0 ? options.tabId : undefined
  })
  if (sidePanelRequests.length > 20) {
    sidePanelRequests.splice(0, sidePanelRequests.length - 20)
  }
  sidePanelStats.requests = sidePanelRequestSeq
  scheduleMailbox()
}

export const sidePanelDetails = (command?: SidePanelOptions | null): SidePanelDetails => ({
  tabId: command && typeof command.tabId === 'number' ? command.tabId : -1,
  windowId: -1,
  path:
    command && typeof command.path === 'string'
      ? command.path
      : sidePanelOptionRecords.find((record) => record.tabId === undefined)?.path || ''
})

export const sidePanelApi = {
  setOptions: (options?: SidePanelOptions, callback?: unknown): Promise<unknown> => {
    try {
      const scope = sidePanelScopeKey(options)
      const record: SidePanelOptionRecord = {
        tabId: scope === '' ? undefined : Number(scope),
        path: options && typeof options.path === 'string' ? options.path : undefined,
        enabled: options && typeof options.enabled === 'boolean' ? options.enabled : undefined
      }
      const index = sidePanelOptionRecords.findIndex(
        (entry) => (entry.tabId === undefined ? '' : String(entry.tabId)) === scope
      )
      if (index === -1) sidePanelOptionRecords.push(record)
      else sidePanelOptionRecords[index] = record
      sidePanelStats.options = sidePanelOptionRecords.length
      scheduleMailbox()
      return answerWith(callback, undefined)
    } catch (error) {
      state.errors.push('sidePanel-setOptions: ' + String(error))
      return Promise.resolve()
    }
  },
  getOptions: (options?: SidePanelOptions, callback?: unknown): Promise<unknown> => {
    try {
      const scope = sidePanelScopeKey(options)
      const found = sidePanelOptionRecords.find(
        (entry) => (entry.tabId === undefined ? '' : String(entry.tabId)) === scope
      )
      // Chromium's own answer for a panel nobody configured is `enabled: true`
      // with no path, and an extension that reads it back before setting it
      // expects that rather than an empty object.
      return answerWith(callback, found ? { ...found } : { enabled: true })
    } catch (error) {
      state.errors.push('sidePanel-getOptions: ' + String(error))
      return Promise.resolve({ enabled: true })
    }
  },
  setPanelBehavior: (
    behavior?: Partial<SidePanelBehavior>,
    callback?: unknown
  ): Promise<unknown> => {
    try {
      sidePanelBehavior = {
        openPanelOnActionClick: !!(behavior && behavior.openPanelOnActionClick)
      }
      sidePanelStats.behavior = sidePanelBehavior
      scheduleMailbox()
      return answerWith(callback, undefined)
    } catch (error) {
      state.errors.push('sidePanel-setPanelBehavior: ' + String(error))
      return Promise.resolve()
    }
  },
  open: (options?: SidePanelOptions, callback?: unknown): Promise<unknown> => {
    try {
      queueSidePanelRequest('open', options)
      return answerWith(callback, undefined)
    } catch (error) {
      state.errors.push('sidePanel-open: ' + String(error))
      return Promise.resolve()
    }
  },
  close: (options?: SidePanelOptions, callback?: unknown): Promise<unknown> => {
    try {
      queueSidePanelRequest('close', options)
      return answerWith(callback, undefined)
    } catch (error) {
      state.errors.push('sidePanel-close: ' + String(error))
      return Promise.resolve()
    }
  }
}

export const sidePanelEvents = { onOpened: sidePanelOpened, onClosed: sidePanelClosed }

export function installSidePanel(): void {
  state.sidePanel = sidePanelStats
  // Replaced, not ensured, for the same reason as notifications: these members are
  // this file's own placeholders from the stub section above.
  for (const root of roots) {
    const api = root && (root['sidePanel'] as ChromeNamespace | undefined)
    if (!api) continue
    for (const key of Object.keys(sidePanelApi)) {
      try {
        Object.defineProperty(api, key, {
          value: sidePanelApi[key as keyof typeof sidePanelApi],
          configurable: true,
          writable: true,
          enumerable: true
        })
      } catch (error) {
        state.errors.push('sidePanel.' + key + ': ' + String(error))
      }
    }
    for (const key of Object.keys(sidePanelEvents)) {
      try {
        Object.defineProperty(api, key, {
          value: sidePanelEvents[key as keyof typeof sidePanelEvents],
          configurable: true,
          writable: true,
          enumerable: true
        })
      } catch (error) {
        state.errors.push('sidePanel.' + key + ': ' + String(error))
      }
    }
  }
  sidePanelStats.shimmed = true
}
