import { app, ipcMain as electronIpcMain } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Logger } from '../system/logger'
import { PrivilegedIpcValidator } from './ipc-validation'

type InvokeHandler = Parameters<typeof electronIpcMain.handle>[1]
type EventListener = Parameters<typeof electronIpcMain.on>[1]

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
  const isProduction = app?.isPackaged === true || process.env['NODE_ENV'] === 'production'
  const appPath = typeof app?.getAppPath === 'function' ? app.getAppPath() : process.cwd()
  if (!isProduction && process.env['ELECTRON_RENDERER_URL']) {
    const devUrl = process.env['ELECTRON_RENDERER_URL'].replace(/\/$/u, '')
    return [
      process.env['ELECTRON_RENDERER_URL'],
      `${devUrl}/permission-prompt.html`,
      `${devUrl}/toast-overlay.html`
    ]
  }
  const rendererRoot = join(appPath, 'out', 'renderer')
  return [
    pathToFileURL(join(rendererRoot, 'index.html')).href,
    // The frameless browser permission popup (a first-party document sharing the
    // app preload) is trusted to resolve permissions and nothing else.
    pathToFileURL(join(rendererRoot, 'permission-prompt.html')).href,
    // The frameless toast overlay is the app's own toaster in a window of its
    // own, so it reports interactions and asks for the stack it should draw.
    pathToFileURL(join(rendererRoot, 'toast-overlay.html')).href
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
    electronIpcMain.handle(channel, (event, ...args) => {
      getSenderValidator().assertTrustedSender(event)
      return handler(event, ...args)
    })
  },

  on(channel: string, listener: EventListener): typeof trustedIpcMain {
    electronIpcMain.on(channel, (event, ...args) => {
      if (!getSenderValidator().isTrustedSenderFrame(event.senderFrame)) {
        Logger.error('One-way IPC rejected: sender frame is not trusted', { channel })
        return
      }
      listener(event, ...args)
    })
    return trustedIpcMain
  },

  removeHandler(channel: string): void {
    electronIpcMain.removeHandler(channel)
  }
}
