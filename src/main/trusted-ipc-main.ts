import { app, ipcMain as electronIpcMain } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Logger } from './logger'
import { PrivilegedIpcValidator } from './ipc-validation'

type InvokeHandler = Parameters<typeof electronIpcMain.handle>[1]
type EventListener = Parameters<typeof electronIpcMain.on>[1]

interface TrustedIpcMainFacade {
  handle: (channel: string, handler: InvokeHandler) => void
  on: (channel: string, listener: EventListener) => TrustedIpcMainFacade
  removeHandler: (channel: string) => void
}

/** Exact main-renderer documents that may invoke Electron IPC. */
export function appRendererNavigationTargets(): string[] {
  const isProduction = app?.isPackaged === true || process.env['NODE_ENV'] === 'production'
  if (!isProduction && process.env['ELECTRON_RENDERER_URL']) {
    return [process.env['ELECTRON_RENDERER_URL']]
  }
  const appPath = typeof app?.getAppPath === 'function' ? app.getAppPath() : process.cwd()
  return [pathToFileURL(join(appPath, 'out', 'renderer', 'index.html')).href]
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
