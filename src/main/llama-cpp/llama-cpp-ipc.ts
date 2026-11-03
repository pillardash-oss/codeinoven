/**
 * IPC for the Llama.cpp settings page.
 *
 * The renderer never runs a shell to answer "is llama.cpp installed": detection,
 * the readiness probe, and the `.gguf` picker all happen here. The installs and
 * the servers themselves run in the PTY service, so the user watches real output.
 */
import { BrowserWindow } from 'electron'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { sendToRenderer } from '../ipc/renderer-delivery'
// The app's own picker wrapper: it reopens where the human last picked, which
// is what every other file picker here does.
import { dialog } from '../system/file-dialogs'
import {
  isLlamaCppHostValid,
  isLlamaCppPortValid,
  llamaCppPtyId,
  localAiModelCopy,
  type LlamaCppLogStream
} from '../../lib/llama-cpp'
import { detectLlamaCppRuntime, probeLlamaCppServer, stopLlamaCppServer } from './llama-cpp-service'
import { followLlamaCppLog, llamaCppLogPath, tailLlamaCppLog } from './llama-cpp-log'

/**
 * The Local AI page talks to the server binary through these channels.
 *
 * `hasPtySession` is how a row knows whether its output still arrives over the
 * PTY it was started with: after the app restarts the process lives on without
 * one, and the row reads the server's own log file instead.
 */
export function registerLlamaCppIpc(
  options: {
    hasPtySession?: (terminalId: string) => boolean
  } = {}
): void {
  const followers = new Map<string, () => void>()

  ipcMain.handle('llamaCpp:detect', () => detectLlamaCppRuntime())

  /** Ends the process that holds a row's port when no PTY of ours owns it. */
  ipcMain.handle('llamaCpp:stopServer', async (_, rawPort: unknown) => {
    const port = typeof rawPort === 'number' ? rawPort : Number.NaN
    if (!isLlamaCppPortValid(port)) return false
    return stopLlamaCppServer(port)
  })

  ipcMain.handle('llamaCpp:logPath', (_, rawId: unknown) => llamaCppLogPath(requireEntryId(rawId)))

  ipcMain.handle('llamaCpp:logTail', (_, rawId: unknown) => tailLlamaCppLog(requireEntryId(rawId)))

  /** Subscribe or unsubscribe a row's log stream, seeding what the file holds. */
  ipcMain.handle(
    'llamaCpp:logStream',
    async (event, rawId: unknown, rawFollow: unknown): Promise<LlamaCppLogStream> => {
      const entryId = requireEntryId(rawId)
      const follow = rawFollow === true
      const lines = await tailLlamaCppLog(entryId)
      const existing = followers.get(entryId)
      if (existing) {
        existing()
        followers.delete(entryId)
      }
      if (!follow) return { source: 'file', lines }
      const sessionAlive = options.hasPtySession?.(llamaCppPtyId(entryId)) ?? false
      if (sessionAlive) {
        // The PTY is still streaming this row's output, so a second source would
        // print every line twice.
        return { source: 'pty', lines: [] }
      }
      const target = event.sender
      // The card already listens on the PTY data channel for this row, so a
      // followed log file arrives exactly like the terminal output it replaces.
      const channel = `pty:data:${llamaCppPtyId(entryId)}`
      let stop = (): void => undefined
      const follower = await followLlamaCppLog(entryId, (chunk) => {
        if (!sendToRenderer(target, channel, chunk)) stop()
      })
      stop = (): void => {
        follower.stop()
        if (followers.get(entryId) === stop) followers.delete(entryId)
      }
      followers.set(entryId, stop)
      return { source: 'file', lines }
    }
  )

  ipcMain.handle('llamaCpp:probe', async (_, rawHost: unknown, rawPort: unknown) => {
    if (typeof rawHost !== 'string' || !isLlamaCppHostValid(rawHost)) {
      return { ready: false, models: [], error: 'The host is not valid' }
    }
    const port = typeof rawPort === 'number' ? rawPort : Number.NaN
    if (!isLlamaCppPortValid(port)) {
      return { ready: false, models: [], error: 'The port is not valid' }
    }
    // A row may bind every interface; the probe always goes over loopback,
    // which is where that server listens too.
    const host = rawHost.trim() === '0.0.0.0' ? '127.0.0.1' : rawHost.trim()
    return probeLlamaCppServer(`http://${host}:${port}`)
  })

  ipcMain.handle('llamaCpp:pickModel', async (_event, runtime: unknown) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    if (win && !win.isFocused()) win.focus()
    // An MLX or Core ML model is a folder, not a single file; a GGUF model is one
    // file. The dialog the user sees says which, so a wrong choice is obvious
    // before they pick it.
    const copy = localAiModelCopy(runtime === 'mlx' || runtime === 'coreml' ? runtime : 'llama.cpp')
    // An MLX or Core ML model is a folder of weights; a GGUF model is a single
    // file. The dialog names and filters what this engine actually loads, so a
    // wrong choice is obvious before the user picks it.
    const options: Electron.OpenDialogOptions =
      runtime === 'mlx' || runtime === 'coreml'
        ? { title: copy.pickTitle, properties: ['openDirectory'] }
        : {
            title: copy.pickTitle,
            properties: ['openFile'],
            filters: [
              { name: 'GGUF models', extensions: ['gguf'] },
              { name: 'All Files', extensions: ['*'] }
            ]
          }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled) return null
    return result.filePaths[0] ?? null
  })
}

/** The row id names a log file, so it is validated here, not at the log path. */
function requireEntryId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 80) {
    throw new Error('Unknown llama.cpp server id')
  }
  return value.trim()
}
