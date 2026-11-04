import type { BrowserWindow } from 'electron'
import {
  DISPLAY_SOURCE_KINDS,
  isDisplayControlAction,
  isDisplayInputGesture,
  isDisplaySourceKind,
  type DisplayInputGesture,
  type DisplaySourceKind
} from '../../lib/ipc/display'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { Logger } from '../system/logger'
import {
  openInputPermissionSettings,
  readInputPermission,
  requestInputPermission
} from './display-input-permission'
import { bindDisplayEventSink, displayRequests } from './display-requests'
import { bindDisplayWindow, displayService } from './display-runtime'

/**
 * The display panel's renderer boundary, registered at boot and almost empty.
 *
 * Every channel here validates its arguments and then reaches for the runtime,
 * which loads the capture service (and its adb, simctl and desktopCapturer
 * adapters) only on first use. Nothing in this file imports one of those, so the
 * cost of having the panel at all is a handful of handler rows.
 *
 * Presence is the other half, and it is agent-initiated rather than detected: the
 * `ext_simulation` tool tells this boundary which device to mirror, and the app
 * never scans for a device on its own.
 */
export interface DisplayIpcDeps {
  window: () => BrowserWindow | null
}

export function registerDisplayIpc(deps: DisplayIpcDeps): void {
  bindDisplayWindow(deps.window)

  const send = (
    channel: 'display:available' | 'display:activity' | 'display:target',
    payload: unknown
  ): void => {
    const window = deps.window()
    if (!window || window.isDestroyed()) return
    sendToRenderer(window.webContents, channel, payload)
  }

  bindDisplayEventSink({
    target: (offer) => send('display:target', offer),
    activity: (activity) => send('display:activity', activity),
    available: () => send('display:available', true)
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
  ipcMain.handle('display:input', async (_event, sessionId: unknown, gesture: unknown) => {
    const service = await displayService()
    await service.input(requireSessionId(sessionId), requireGesture(gesture))
  })
  // Reading costs a settings query and nothing else, so the panel may ask on every
  // simulator it opens instead of remembering an answer that can go stale.
  ipcMain.handle('display:inputPermission', () => readInputPermission())
  ipcMain.handle('display:requestInputPermission', () => requestInputPermission())
  ipcMain.handle('display:openInputSettings', () => openInputPermissionSettings())
  ipcMain.handle('display:presence', () => displayRequests.state())
  ipcMain.handle('display:notePanel', (_event, mirrored: unknown) => {
    if (mirrored === null) {
      displayRequests.noteMirrored(null, null)
      return
    }
    if (typeof mirrored !== 'object' || mirrored === null) {
      throw new TypeError('A mirrored target must be an object or null')
    }
    const target = mirrored as { kind?: unknown; sourceId?: unknown; threadId?: unknown }
    const kind = requireKind(target.kind)
    if (typeof target.sourceId !== 'string' || target.sourceId.length === 0) {
      throw new TypeError('A mirrored target must name its source')
    }
    displayRequests.noteMirrored(
      `${kind}:${target.sourceId}`,
      typeof target.threadId === 'string' && target.threadId.length > 0 ? target.threadId : null
    )
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

function requireGesture(value: unknown): DisplayInputGesture {
  if (!isDisplayInputGesture(value)) throw new TypeError('That display gesture is not known')
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
