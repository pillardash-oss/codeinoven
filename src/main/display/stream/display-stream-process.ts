import { MessageChannelMain, utilityProcess, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import {
  type StreamPortAnnouncement,
  type StreamStartMessage
} from '../../../lib/display-stream-protocol'
import { appResourcesRoot } from '../../bootstrap/app-resources'
import { Logger } from '../../system/logger'
import displayStreamHostPath from './display-stream-host.ts?modulePath'
import { SCRCPY_VERSION } from './scrcpy-protocol'

/** The channel that hands the renderer its end of a stream's message port. */
export const DISPLAY_STREAM_PORT_CHANNEL = 'display:streamPort'

export interface DisplayStreamOptions {
  window: BrowserWindow
  sessionId: string
  adb: string
  serial: string
  maxSize: number
  /** The first frame is on its way, so the session is live. */
  onLive: () => void
  /** The stream is over, for the given reason. `wasLive` says whether it ever played. */
  onEnded: (detail: string | null, wasLive: boolean) => void
}

export interface DisplayStreamHandle {
  stop: () => void
}

interface HostLifecycle {
  type: 'live' | 'ended'
  detail?: string | null
  wasLive?: boolean
}

function isHostLifecycle(value: unknown): value is HostLifecycle {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    (value.type === 'live' || value.type === 'ended')
  )
}

/** Where the bundled scrcpy server file lives for this launch. */
export function scrcpyServerPath(): string {
  return join(appResourcesRoot(), 'display', `scrcpy-server-v${SCRCPY_VERSION}`)
}

/**
 * Start one device stream in its own process and give the renderer its port.
 *
 * The main process creates the channel and then steps out of the way: one end goes
 * to the utility process, the other to the page, and every packet after that
 * travels between those two.
 */
export function startDisplayStream(options: DisplayStreamOptions): DisplayStreamHandle {
  const { window } = options
  const { port1, port2 } = new MessageChannelMain()
  const host = utilityProcess.fork(displayStreamHostPath, [], {
    stdio: ['ignore', 'ignore', 'pipe'],
    serviceName: 'CodeInOven device stream'
  })
  let stderrTail = ''
  let settled = false
  let wasLive = false
  const settle = (detail: string | null): void => {
    if (settled) return
    settled = true
    options.onEnded(detail, wasLive)
  }
  host.stderr?.on('data', (chunk: Buffer | string) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-1_000)
  })
  host.on('message', (message: unknown) => {
    if (!isHostLifecycle(message)) return
    if (message.type === 'live') {
      wasLive = true
      options.onLive()
      return
    }
    settle(message.detail ?? null)
  })
  let killTimer: ReturnType<typeof setTimeout> | null = null
  host.once('exit', (code) => {
    if (killTimer) clearTimeout(killTimer)
    settle(code === 0 ? null : stderrTail.trim() || `The stream process exited with code ${code}`)
  })
  const start: StreamStartMessage = {
    type: 'start',
    kind: 'android',
    serial: options.serial,
    adb: options.adb,
    serverPath: scrcpyServerPath(),
    maxSize: options.maxSize
  }
  host.postMessage(start, [port1])
  if (window.isDestroyed() || window.webContents.isDestroyed()) {
    host.kill()
  } else {
    const announcement: StreamPortAnnouncement = { sessionId: options.sessionId }
    window.webContents.postMessage(DISPLAY_STREAM_PORT_CHANNEL, announcement, [port2])
  }
  Logger.dev(`Display stream started for ${options.serial} at ${options.maxSize}px`)
  return {
    stop: () => {
      settled = true
      // Ask first so the host can remove the device's server and the adb forward;
      // the kill is only the backstop for a host that never answers.
      host.postMessage({ type: 'stop' })
      killTimer = setTimeout(() => host.kill(), 1_500)
    }
  }
}
