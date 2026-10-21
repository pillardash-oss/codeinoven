import { dialog as nativeDialog, type BrowserWindow } from 'electron'
import { realpath, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { StorageEngine } from '../storage/storage-engine'
import { Logger } from './logger'

const stateFile = 'file-dialog-location.json'
let storage: StorageEngine | undefined
let writes: Promise<void> = Promise.resolve()
let lastDirectory: string | undefined

/**
 * Point the picker memory at the data root the app actually runs on.
 *
 * Without this the module would build its own `StorageEngine`, which resolves
 * the canonical config root even when the running app (a test, a probe, an
 * isolated worktree) was handed a different one. A picker driven there then
 * wrote into the human's real data root, overwriting the directory their own
 * pickers remembered.
 */
export function setFileDialogStorage(engine: StorageEngine): void {
  storage = engine
  lastDirectory = undefined
}

function getStorage(): StorageEngine {
  return (storage ??= new StorageEngine())
}

/**
 * Whether a human can be at the picker in this process.
 *
 * A test suite drives the same IPC handlers a person does, so its scripted
 * selections would otherwise be remembered as the human's last directory. No
 * human is present there, so nothing is remembered.
 */
function humanCanPick(): boolean {
  return !process.env['VITEST']
}

/**
 * Is this path inside the operating system's scratch area?
 *
 * A temp directory is never a place a person parks their pickers, so a value
 * that points there is either a run that should not have written it or a
 * directory that no longer exists. macOS resolves `/var` to `/private/var`, so
 * both spellings of the scratch root are compared.
 */
async function isScratchDirectory(path: string): Promise<boolean> {
  const roots = new Set<string>([tmpdir(), await realpath(tmpdir()).catch(() => tmpdir())])
  const forms = new Set<string>([path, await realpath(path).catch(() => path)])
  for (const root of roots) {
    for (const form of forms) {
      const offset = relative(root, form)
      if (offset === '' || (!offset.startsWith('..') && !isAbsolute(offset))) return true
    }
  }
  return false
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
    // A remembered scratch path is stale evidence, not a human preference: fall
    // through to the config fallback and then to the home directory.
    if (lastDirectory && (await isScratchDirectory(lastDirectory))) lastDirectory = undefined
    return (lastDirectory ? await existingDirectory(lastDirectory) : undefined) ?? homedir()
  } catch (error) {
    Logger.error('Could not restore file dialog location', error)
    return homedir()
  }
}

async function remember(directory: string): Promise<void> {
  lastDirectory = directory
  // Only a human at a real picker writes the shared memory: an agent's picker
  // (`agentDialog`), a test, and a scratch directory all stay session-local.
  if (!humanCanPick() || (await isScratchDirectory(directory))) return
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

/** Agent pickers must never update the human's persisted picker location. */
export const agentDialog = nativeDialog
