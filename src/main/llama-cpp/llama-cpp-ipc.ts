/**
 * IPC for the Llama.cpp settings page.
 *
 * The renderer never runs a shell to answer "is llama.cpp installed": detection,
 * the readiness probe, and the `.gguf` picker all happen here. The installs and
 * the servers themselves run in the PTY service, so the user watches real output.
 */
import { BrowserWindow, dialog } from 'electron'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { validateEntityId } from '../ipc/ipc-validation'
import { isLlamaCppHostValid, isLlamaCppPortValid } from '../../lib/llama-cpp'
import { detectLlamaCppRuntime, probeLlamaCppServer } from './llama-cpp-service'

export interface LlamaCppIpcDeps {
  /**
   * Re-discover the custom base-URL provider models for a project, so a server
   * the user just started appears in the model picker without a second step.
   */
  refreshProviderModels: (projectId: string) => Promise<void>
}

export function registerLlamaCppIpc(deps: LlamaCppIpcDeps): void {
  ipcMain.handle('llamaCpp:detect', () => detectLlamaCppRuntime())

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

  ipcMain.handle('llamaCpp:pickModel', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    if (win && !win.isFocused()) win.focus()
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a GGUF model',
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

  ipcMain.handle('llamaCpp:refreshProviderModels', async (_, rawProjectId: unknown) => {
    const projectId = validateEntityId(rawProjectId, 'Project ID')
    await deps.refreshProviderModels(projectId)
    return true
  })
}
