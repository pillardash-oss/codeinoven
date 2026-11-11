/**
 * IPC for the Local AI page.
 *
 * The renderer never runs a shell to answer "is this engine installed": detection,
 * the readiness probe, and the model picker all happen here. The installs and the
 * servers themselves run in the PTY service, so the user watches real output.
 *
 * The engine a call is for travels with every request, because the page serves two
 * of them: `llama-server` for GGUF models and `mlx_lm.server` for MLX repositories.
 * Only llama.cpp writes a log file of its own, so the log channels are the one part
 * that stays llama.cpp-only.
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
  llamaCppBaseUrl,
  localAiModelCopy,
  localAiPtyId,
  type LlamaCppLogStream,
  type LocalAiRuntimeId,
  type LocalAiRuntimeStatus
} from '../../lib/llama-cpp'
import { detectLlamaCppRuntime } from './llama-cpp-runtime'
import { detectMlxRuntime } from './mlx-runtime'
import { probeLocalAiServer, stopLocalAiServer } from './local-ai-process'
import { followLocalAiLog, localAiLogPath, tailLocalAiLog } from './local-ai-log'
import { resolveModelLocation } from './local-ai-model-location'
import { sharedLocalAiRuntimeRegistry } from './local-ai-runtime-registry'

/** The engines the page can launch, and the order a bad value falls back through. */
function readRuntime(value: unknown): LocalAiRuntimeId {
  return value === 'mlx' ? 'mlx' : 'llama.cpp'
}

export function registerLocalAiIpc(
  options: {
    hasPtySession?: (terminalId: string) => boolean
  } = {}
): void {
  const followers = new Map<string, () => void>()

  /** The engine's binary, its version, and the installer that manages it here. */
  ipcMain.handle('localAi:detect', (_, rawRuntime: unknown): Promise<LocalAiRuntimeStatus> => {
    return readRuntime(rawRuntime) === 'mlx' ? detectMlxRuntime() : detectLlamaCppRuntime()
  })

  /** Ends the process holding a row's port when no PTY of ours owns it. */
  ipcMain.handle('localAi:stopServer', async (_, rawPort: unknown, rawRuntime: unknown) => {
    const port = typeof rawPort === 'number' ? rawPort : Number.NaN
    if (!isLlamaCppPortValid(port)) return false
    return stopLocalAiServer(port, readRuntime(rawRuntime))
  })

  ipcMain.handle('localAi:logPath', (_, rawId: unknown) => localAiLogPath(requireEntryId(rawId)))

  ipcMain.handle('localAi:logTail', (_, rawId: unknown) => tailLocalAiLog(requireEntryId(rawId)))

  /** Subscribe or unsubscribe a row's log stream, seeding what the file holds. */
  ipcMain.handle(
    'localAi:logStream',
    async (event, rawId: unknown, rawFollow: unknown): Promise<LlamaCppLogStream> => {
      const entryId = requireEntryId(rawId)
      const follow = rawFollow === true
      const lines = await tailLocalAiLog(entryId)
      const existing = followers.get(entryId)
      if (existing) {
        existing()
        followers.delete(entryId)
      }
      if (!follow) return { source: 'file', lines }
      const sessionAlive = options.hasPtySession?.(localAiPtyId(entryId)) ?? false
      if (sessionAlive) {
        // The PTY is still streaming this row's output, so a second source would
        // print every line twice.
        return { source: 'pty', lines: [] }
      }
      const target = event.sender
      // The card already listens on the PTY data channel for this row, so a
      // followed log file arrives exactly like the terminal output it replaces.
      const channel = `pty:data:${localAiPtyId(entryId)}`
      let stop = (): void => undefined
      const follower = await followLocalAiLog(entryId, (chunk) => {
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

  ipcMain.handle(
    'localAi:probe',
    async (_, rawHost: unknown, rawPort: unknown, rawRuntime: unknown) => {
      if (typeof rawHost !== 'string' || !isLlamaCppHostValid(rawHost)) {
        return { ready: false, models: [], error: 'The host is not valid' }
      }
      const port = typeof rawPort === 'number' ? rawPort : Number.NaN
      if (!isLlamaCppPortValid(port)) {
        return { ready: false, models: [], error: 'The port is not valid' }
      }
      // A row may bind every interface; the probe always goes over loopback,
      // which is where that server listens too.
      return probeLocalAiServer(
        llamaCppBaseUrl({ host: rawHost, port }),
        port,
        readRuntime(rawRuntime)
      )
    }
  )

  /**
   * Where the model this row downloaded lives, so the row stops naming a tag and
   * names the folder instead. Asked once, when the row answers.
   */
  ipcMain.handle(
    'localAi:modelLocation',
    async (_, rawReference: unknown, rawHost: unknown, rawPort: unknown, rawRuntime: unknown) => {
      if (typeof rawReference !== 'string' || rawReference.length > 512) return null
      if (typeof rawHost !== 'string' || !isLlamaCppHostValid(rawHost)) return null
      const port = typeof rawPort === 'number' ? rawPort : Number.NaN
      if (!isLlamaCppPortValid(port)) return null
      return resolveModelLocation({
        baseUrl: llamaCppBaseUrl({ host: rawHost, port }),
        runtime: readRuntime(rawRuntime),
        reference: rawReference
      })
    }
  )

  ipcMain.handle('localAi:pickModel', async (_event, rawRuntime: unknown) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    if (win && !win.isFocused()) win.focus()
    const runtime = readRuntime(rawRuntime)
    const copy = localAiModelCopy(runtime)
    // An MLX model is a folder of weights; a GGUF model is a single file. The
    // dialog names and filters what this engine actually loads, so a wrong choice
    // is obvious before the user picks it.
    const options: Electron.OpenDialogOptions =
      runtime === 'mlx'
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

  // The page's "Unload now": the user overriding the idle window, which the
  // confirmation card warns about before it reaches here.
  ipcMain.handle('localAi:unloadNow', () => sharedLocalAiRuntimeRegistry().unloadNow())
}

/** The row id names a log file, so it is validated here, not at the log path. */
function requireEntryId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 80) {
    throw new Error('Unknown local AI server id')
  }
  return value.trim()
}
