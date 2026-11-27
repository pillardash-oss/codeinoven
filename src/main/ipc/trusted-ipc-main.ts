import { app, ipcMain as electronIpcMain } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Logger } from '../system/logger'
import { recordPerfOperation } from '../system/perf-trace'
import { PrivilegedIpcValidator } from './ipc-validation'
import { isShippedBuild } from '../bootstrap/app-resources'

type InvokeHandler = Parameters<typeof electronIpcMain.handle>[1]
type EventListener = Parameters<typeof electronIpcMain.on>[1]

/**
 * Channels the trace must never measure.
 *
 * Every instrumented operation writes a record, and these channels *are* the
 * record path: timing them would have each measurement produce a measurement.
 */
const UNTRACED_CHANNELS: ReadonlySet<string> = new Set([
  'perf:records',
  'perf:memory',
  'perf:flush'
])

/** Whether a handler answered with a promise rather than a value. */
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  return 'Unknown IPC failure'
}

interface TrustedIpcMainFacade {
  handle: (channel: string, handler: InvokeHandler) => void
  on: (channel: string, listener: EventListener) => TrustedIpcMainFacade
  removeHandler: (channel: string) => void
}

/**
 * Documents that are part of the app's own renderer build and may therefore
 * invoke Electron IPC: the app window, and the two frameless child documents it
 * opens over a browser page (the permission prompt and the toast overlay).
 *
 * Trust is by document URL, not by window: every one of these shares the app's
 * preload and is served from the same origin, and each is loaded from this
 * build's own output rather than from anything a user can point at.
 */
export function appRendererNavigationTargets(): string[] {
  const isProduction = isShippedBuild() || process.env['NODE_ENV'] === 'production'
  const appPath = typeof app?.getAppPath === 'function' ? app.getAppPath() : process.cwd()
  if (!isProduction && process.env['ELECTRON_RENDERER_URL']) {
    const devUrl = process.env['ELECTRON_RENDERER_URL'].replace(/\/$/u, '')
    return [
      process.env['ELECTRON_RENDERER_URL'],
      `${devUrl}/permission-prompt.html`,
      `${devUrl}/browser-overlay.html`
    ]
  }
  const rendererRoot = join(appPath, 'out', 'renderer')
  return [
    pathToFileURL(join(rendererRoot, 'index.html')).href,
    // The frameless browser permission popup (a first-party document sharing the
    // app preload) is trusted to resolve permissions and nothing else.
    pathToFileURL(join(rendererRoot, 'permission-prompt.html')).href,
    // The frameless browser overlay is the app's own toaster, and the browser's
    // floating tab strip, in a window of their own, so it reports interactions
    // and asks for the content it should draw.
    pathToFileURL(join(rendererRoot, 'browser-overlay.html')).href
  ]
}

let senderValidator: PrivilegedIpcValidator | null = null

function getSenderValidator(): PrivilegedIpcValidator {
  senderValidator ??= new PrivilegedIpcValidator({
    navigationTargets: appRendererNavigationTargets()
  })
  return senderValidator
}

/**
 * Main-process IPC facade that enforces the Electron security requirement to
 * validate every renderer sender. Import this facade instead of Electron's
 * raw `ipcMain` whenever a renderer-facing channel is registered.
 */
export const trustedIpcMain: TrustedIpcMainFacade = {
  handle(channel: string, handler: InvokeHandler): void {
    const traced = !UNTRACED_CHANNELS.has(channel)
    electronIpcMain.handle(channel, (event, ...args) => {
      getSenderValidator().assertTrustedSender(event)
      if (!traced) return handler(event, ...args)
      const startedAt = Date.now()
      const report = (outcome: 'ok' | 'error', error?: string): void => {
        recordPerfOperation({
          kind: 'ipc',
          name: `ipc:${channel}`,
          startedAt,
          durationMs: Date.now() - startedAt,
          outcome,
          context: { side: 'main' },
          ...(error === undefined ? {} : { error })
        })
      }
      let result: unknown
      try {
        result = handler(event, ...args)
      } catch (error) {
        report('error', describeFailure(error))
        throw error
      }
      if (isPromiseLike(result)) {
        return Promise.resolve(result).then(
          (value: unknown) => {
            report('ok')
            return value
          },
          (error: unknown) => {
            report('error', describeFailure(error))
            throw error
          }
        )
      }
      report('ok')
      return result
    })
  },

  on(channel: string, listener: EventListener): typeof trustedIpcMain {
    electronIpcMain.on(channel, (event, ...args) => {
      if (!getSenderValidator().isTrustedSenderFrame(event.senderFrame)) {
        Logger.error('One-way IPC rejected: sender frame is not trusted', { channel })
        return
      }
      if (UNTRACED_CHANNELS.has(channel)) {
        listener(event, ...args)
        return
      }
      const startedAt = Date.now()
      try {
        listener(event, ...args)
      } catch (error) {
        recordPerfOperation({
          kind: 'ipc',
          name: `send:${channel}`,
          startedAt,
          durationMs: Date.now() - startedAt,
          outcome: 'error',
          context: { side: 'main' },
          error: describeFailure(error)
        })
        throw error
      }
      recordPerfOperation({
        kind: 'ipc',
        name: `send:${channel}`,
        startedAt,
        durationMs: Date.now() - startedAt,
        outcome: 'ok',
        context: { side: 'main' }
      })
    })
    return trustedIpcMain
  },

  removeHandler(channel: string): void {
    electronIpcMain.removeHandler(channel)
  }
}
