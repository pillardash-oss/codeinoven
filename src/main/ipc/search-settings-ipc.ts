import { BrowserWindow, dialog } from 'electron'
import type { WebContents } from 'electron'
import type { SearchService } from '../search/search-service'
import { validateSearchModelPath } from '../search/search-path-validation'
import { sendToRenderer } from './renderer-delivery'
import { trustedIpcMain as ipcMain } from './trusted-ipc-main'

function requireArtifactId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,127}$/u.test(value)) {
    throw new RangeError('Model artifact id is invalid.')
  }
  return value
}

function requireModelId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    value.includes('\u0000') ||
    value.includes('/') ||
    value.includes('\\')
  ) {
    throw new RangeError('Model id is invalid.')
  }
  return value
}

function requirePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new RangeError('Model path is invalid.')
  }
  return value
}

/**
 * Registers the intent-search IPC surface: model catalog, downloads, import,
 * enable/active-model control, index rebuild, and the progress stream.
 */
export function registerSearchSettingsIpc(
  service: SearchService,
  renderer: () => WebContents | null
): () => void {
  const stopProgress = service.onProgress((progress) => {
    sendToRenderer(renderer(), 'search:progress', progress)
  })

  ipcMain.handle('search:getState', () => service.state())
  ipcMain.handle('search:downloadArtifact', (_event, rawId: unknown) =>
    service.downloadArtifact(requireArtifactId(rawId))
  )
  ipcMain.handle('search:cancelDownload', (_event, rawId: unknown) =>
    service.cancelDownload(requireArtifactId(rawId))
  )
  ipcMain.handle('search:deleteModel', (_event, rawId: unknown) =>
    service.deleteModel(requireModelId(rawId))
  )
  ipcMain.handle('search:pickModelFile', async () => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    if (window && !window.isFocused()) window.focus()
    const options: Electron.OpenDialogOptions = {
      title: 'Import an Embedding Model',
      properties: ['openFile'],
      filters: [{ name: 'GGUF Embedding Model', extensions: ['gguf'] }]
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
  ipcMain.handle('search:importModel', (_event, rawPath: unknown) =>
    service.importModel(requirePath(rawPath))
  )
  ipcMain.handle('search:validateModelPath', (_event, rawPath: unknown) =>
    validateSearchModelPath(requirePath(rawPath))
  )
  ipcMain.handle('search:setContextTokens', (_event, rawTokens: unknown) => {
    if (typeof rawTokens !== 'number' || !Number.isFinite(rawTokens)) {
      throw new TypeError('Context window must be a number.')
    }
    return service.setContextTokens(rawTokens)
  })
  ipcMain.handle('search:setEnabled', (_event, rawEnabled: unknown) => {
    if (typeof rawEnabled !== 'boolean') throw new TypeError('Enabled flag must be a boolean.')
    return service.setEnabled(rawEnabled)
  })
  ipcMain.handle('search:setActiveModel', (_event, rawId: unknown) =>
    service.setActiveModel(rawId === null ? null : requireModelId(rawId))
  )
  ipcMain.handle('search:rebuildIndex', () => service.rebuildIndex())

  return stopProgress
}
