import type { BrowserWindow } from 'electron'
import {
  DISPLAY_SOURCE_KINDS,
  isDisplayControlAction,
  isDisplaySourceKind,
  type DisplaySourceKind
} from '../../lib/ipc/display'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { Logger } from '../system/logger'
import type { DisplayThreadActivity } from '../../lib/ipc/display'
import { DisplayPresence } from './display-presence'
import { bindDisplayWindow, displayService } from './display-runtime'
import { detectDisplayTargets } from './display-targets'

/**
 * The display panel's renderer boundary, registered at boot and almost empty.
 *
 * Every channel here validates its arguments and then reaches for the runtime,
 * which loads the capture service (and its adb, simctl and desktopCapturer
 * adapters) only on first use. Nothing in this file imports one of those, so the
 * cost of having the panel at all is a handful of handler rows.
 *
 * Presence is the other half: the panel has no rail item until an agent starts or
 * attaches to a display target, so this boundary also owns the one watch that
 * decides when that happened.
 */
export interface DisplayIpcDeps {
  window: () => BrowserWindow | null
  /** Every process the agent process service tracks right now. */
  listAgentProcesses: () => Promise<{ command: string; threadId?: string | null }[]>
}

export function registerDisplayIpc(deps: DisplayIpcDeps): void {
  bindDisplayWindow(deps.window)

  const send = (channel: 'display:available' | 'display:activity', payload: unknown): void => {
    const window = deps.window()
    if (!window || window.isDestroyed()) return
    sendToRenderer(window.webContents, channel, payload)
  }
  const presence = new DisplayPresence({
    listAgentProcesses: deps.listAgentProcesses,
    detectTargets: detectDisplayTargets,
    onAvailable: () => send('display:available', true),
    onActivity: (threadId, active, at) => {
      const activity: DisplayThreadActivity = { threadId, active, at }
      send('display:activity', activity)
    }
  })

  ipcMain.handle('display:listSources', async (_event, kind: unknown) => {
    const service = await displayService()
    return service.listSources(requireKind(kind))
  })
  ipcMain.handle('display:start', async (_event, request: unknown) => {
    const service = await displayService()
    service.start(requireRequest(request))
  })
  ipcMain.handle('display:demand', async (_event, sessionId: unknown, demand: unknown) => {
    const service = await displayService()
    service.setDemand(requireSessionId(sessionId), requireDemand(demand))
  })
  ipcMain.handle('display:stop', async (_event, sessionId: unknown) => {
    const service = await displayService()
    service.stop(requireSessionId(sessionId))
  })
  ipcMain.handle('display:control', async (_event, sessionId: unknown, action: unknown) => {
    const service = await displayService()
    await service.control(requireSessionId(sessionId), requireControl(action))
  })
  ipcMain.handle('display:presence', () => presence.state)
  ipcMain.handle('display:noteWorkingThreads', (_event, threadIds: unknown) => {
    if (!Array.isArray(threadIds) || threadIds.some((id) => typeof id !== 'string')) {
      throw new TypeError('Working threads must be a list of thread ids')
    }
    presence.setWorkingThreads(threadIds as string[])
  })

  Logger.dev('Display panel registered: capture modules load on first use')
}

/** Reject anything that is not one of the four kinds the app can mirror. */
function requireKind(value: unknown): DisplaySourceKind {
  if (!isDisplaySourceKind(value)) {
    throw new TypeError(`A display source must be one of ${DISPLAY_SOURCE_KINDS.join(', ')}`)
  }
  return value
}

function requireSessionId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new TypeError('A display session id must be a non-empty string')
  }
  return value
}

function requireDemand(value: unknown): { maxDimension: number; visible: boolean } {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('A display demand must be an object')
  }
  const demand = value as { maxDimension?: unknown; visible?: unknown }
  if (typeof demand.maxDimension !== 'number' || !Number.isFinite(demand.maxDimension)) {
    throw new TypeError('A display demand must carry a finite maxDimension')
  }
  if (typeof demand.visible !== 'boolean') {
    throw new TypeError('A display demand must carry a visible flag')
  }
  return { maxDimension: demand.maxDimension, visible: demand.visible }
}

function requireControl(value: unknown) {
  if (!isDisplayControlAction(value)) throw new TypeError('That display control is not known')
  return value
}

function requireRequest(value: unknown): {
  sessionId: string
  tabId: string
  kind: DisplaySourceKind
  sourceId: string
} {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('A display session request must be an object')
  }
  const request = value as {
    sessionId?: unknown
    tabId?: unknown
    kind?: unknown
    sourceId?: unknown
  }
  const kind = requireKind(request.kind)
  if (typeof request.tabId !== 'string' || request.tabId.length === 0) {
    throw new TypeError('A display session request must name the tab it belongs to')
  }
  if (typeof request.sourceId !== 'string' || request.sourceId.length === 0) {
    throw new TypeError('A display session request must name a source')
  }
  return {
    sessionId: requireSessionId(request.sessionId),
    tabId: request.tabId,
    kind,
    sourceId: request.sourceId
  }
}
