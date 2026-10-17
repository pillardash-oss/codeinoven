import { dialog as nativeDialog, type BrowserWindow } from 'electron'
import { stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { StorageEngine } from '../storage/storage-engine'
import { Logger } from './logger'

const stateFile = 'file-dialog-location.json'
let storage: StorageEngine | undefined
let writes: Promise<void> = Promise.resolve()
let lastDirectory: string | undefined

function getStorage(): StorageEngine {
  return (storage ??= new StorageEngine())
}

async function existingDirectory(path: string): Promise<string | undefined> {
  if (!isAbsolute(path)) return undefined
  let candidate = path
  for (;;) {
    try {
      if ((await stat(candidate)).isDirectory()) return candidate
    } catch {
      // Removed folders and disconnected volumes fall back to an existing parent.
    }
    const parent = dirname(candidate)
    if (parent === candidate) return undefined
    candidate = parent
  }
}

async function defaultDirectory(): Promise<string | undefined> {
  try {
    if (!lastDirectory) {
      const saved = await getStorage().read<{ directory?: unknown }>(stateFile)
      if (typeof saved?.directory === 'string') lastDirectory = saved.directory
      else {
        const config = await getStorage().getConfig()
        lastDirectory = config.lastAttachmentDialogPath ?? config.lastFolderDialogPath
      }
    }
    return lastDirectory ? await existingDirectory(lastDirectory) : undefined
  } catch (error) {
    Logger.error('Could not restore file dialog location', error)
    return undefined
  }
}

async function remember(directory: string): Promise<void> {
  lastDirectory = directory
  writes = writes.then(async () => {
    try {
      await getStorage().write(stateFile, { directory })
    } catch (error) {
      Logger.error('Could not persist file dialog location', error)
    }
  })
  await writes
}

async function showOpenDialog(
  options: Electron.OpenDialogOptions
): Promise<Electron.OpenDialogReturnValue>
async function showOpenDialog(
  window: BrowserWindow,
  options: Electron.OpenDialogOptions
): Promise<Electron.OpenDialogReturnValue>
async function showOpenDialog(
  windowOrOptions: BrowserWindow | Electron.OpenDialogOptions,
  suppliedOptions?: Electron.OpenDialogOptions
): Promise<Electron.OpenDialogReturnValue> {
  const options = suppliedOptions ?? (windowOrOptions as Electron.OpenDialogOptions)
  const directory = await defaultDirectory()
  const resolved = { ...options, ...(directory ? { defaultPath: directory } : {}) }
  const result = suppliedOptions
    ? await nativeDialog.showOpenDialog(windowOrOptions as BrowserWindow, resolved)
    : await nativeDialog.showOpenDialog(resolved)
  if (!result.canceled && result.filePaths[0]) {
    const selected = result.filePaths[0]
    // Mixed file/folder pickers must remember the selected folder itself.
    const directorySelection = await stat(selected).then(
      (entry) => entry.isDirectory(),
      () => false
    )
    await remember(directorySelection ? selected : dirname(selected))
  }
  return result
}

async function showSaveDialog(
  options: Electron.SaveDialogOptions
): Promise<Electron.SaveDialogReturnValue>
async function showSaveDialog(
  window: BrowserWindow,
  options: Electron.SaveDialogOptions
): Promise<Electron.SaveDialogReturnValue>
async function showSaveDialog(
  windowOrOptions: BrowserWindow | Electron.SaveDialogOptions,
  suppliedOptions?: Electron.SaveDialogOptions
): Promise<Electron.SaveDialogReturnValue> {
  const options = suppliedOptions ?? (windowOrOptions as Electron.SaveDialogOptions)
  const directory = await defaultDirectory()
  const resolved = {
    ...options,
    ...(directory
      ? {
          defaultPath: options.defaultPath
            ? join(directory, basename(options.defaultPath))
            : directory
        }
      : {})
  }
  const result = suppliedOptions
    ? await nativeDialog.showSaveDialog(windowOrOptions as BrowserWindow, resolved)
    : await nativeDialog.showSaveDialog(resolved)
  if (!result.canceled && result.filePath) await remember(dirname(result.filePath))
  return result
}

/** One local picker history across every feature, project and Oven. */
export const dialog = { ...nativeDialog, showOpenDialog, showSaveDialog }
