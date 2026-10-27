/// <reference types="node" />

import { lstatSync, realpathSync, existsSync } from 'fs'
import { writeFile, rename, mkdir, readFile, readdir, rm, open, access } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'path'
import { randomBytes } from 'crypto'
import { APP_SLUG, ORG_SLUG } from './brand'

/** Generate a unique ID */
export function generateId(): string {
  return randomBytes(12).toString('hex')
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath)
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..')
}

/**
 * Resolve a caller-provided relative path and reject paths that can leave rootPath.
 * Existing symlinks may point elsewhere within the root, but never outside it.
 */
export function resolveWithinRoot(rootPath: string, relativePath: string): string {
  if (isAbsolute(relativePath) || win32.isAbsolute(relativePath)) {
    throw new Error(`Storage path must be relative: "${relativePath}"`)
  }

  if (relativePath.split(/[\\/]+/u).includes('..')) {
    throw new Error(`Storage path cannot contain parent traversal: "${relativePath}"`)
  }

  const absoluteRoot = resolve(rootPath)
  const resolvedPath = resolve(absoluteRoot, relativePath)
  if (!isWithinRoot(absoluteRoot, resolvedPath)) {
    throw new Error(`Storage path escapes the config root: "${relativePath}"`)
  }

  let canonicalRoot = absoluteRoot
  try {
    canonicalRoot = realpathSync.native(absoluteRoot)
  } catch (error) {
    if (!isMissingFileError(error)) throw error
  }

  const pathFromRoot = relative(absoluteRoot, resolvedPath)
  let currentPath = absoluteRoot
  for (const segment of pathFromRoot.split(sep).filter(Boolean)) {
    currentPath = join(currentPath, segment)

    try {
      lstatSync(currentPath)
      const canonicalPath = realpathSync.native(currentPath)
      if (!isWithinRoot(canonicalRoot, canonicalPath)) {
        throw new Error(`Storage path follows a symlink outside the config root: "${relativePath}"`)
      }
    } catch (error) {
      if (isMissingFileError(error)) break
      throw error
    }
  }

  return resolvedPath
}

/**
 * Windows can briefly refuse a rename while another process holds the target
 * open (an antivirus scan, the updater replacing the install, or a reader that
 * has not released the file yet). These are the error codes the retry covers.
 */
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** Total rename attempts (the first try plus four retries) before giving up. */
const RENAME_MAX_ATTEMPTS = 5

/** First backoff step; each retry waits one more step, so the bound is 20+40+60+80 = 200 ms. */
const RENAME_RETRY_STEP_MS = 20

function isRetryableRenameError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    RETRYABLE_RENAME_CODES.has(error.code)
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Rename with a short, bounded backoff on the transient Windows lock errors.
 * A permanently locked path fails after RENAME_MAX_ATTEMPTS instead of hanging
 * the caller, and every other error is rethrown immediately.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      if (!isRetryableRenameError(error) || attempt >= RENAME_MAX_ATTEMPTS) throw error
      await delay(RENAME_RETRY_STEP_MS * attempt)
    }
  }
}

/**
 * Best-effort fsync of the directory holding a durable write, so the rename
 * itself survives a power loss. Not every platform allows a directory to be
 * opened for syncing (Windows notably does not), so a failure here is ignored.
 */
async function syncContainingDirectory(filePath: string): Promise<void> {
  try {
    const handle = await open(dirname(filePath), 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Directory fsync is unsupported on some platforms; the file sync above remains.
  }
}

/**
 * Write to a unique temporary file then rename it into place, never leaving the
 * temporary file behind on any path. `durable` also flushes the temporary file
 * (and the containing directory) to disk before the rename is reported done.
 */
async function writeAtomically(filePath: string, content: string, durable: boolean): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${generateId()}.tmp`
  try {
    if (durable) {
      const handle = await open(tmpPath, 'wx', 0o600)
      try {
        await handle.writeFile(content, { encoding: 'utf-8' })
        await handle.sync()
      } finally {
        await handle.close()
      }
    } else {
      await writeFile(tmpPath, content, { encoding: 'utf-8', flag: 'wx', mode: 0o600 })
    }
    await renameWithRetry(tmpPath, filePath)
    if (durable) await syncContainingDirectory(filePath)
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Atomic write: write to a unique temporary file then rename it into place.
 * Deliberately cheap: no fsync, so it stays safe on the hot JSON write path.
 * The rename is retried on the transient Windows lock errors (EPERM, EBUSY,
 * EACCES) with a bounded backoff, so a momentarily held target still lands.
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  await writeAtomically(filePath, content, false)
}

/**
 * Durable atomic write: the temporary file is fsynced before the rename, and
 * the containing directory is fsynced after it, so the content survives a power
 * loss or a forced kill between the rename and the disk flush. Opt in only for
 * stores written at boot and shutdown; the default atomicWrite stays cheap.
 */
export async function atomicWriteDurable(filePath: string, content: string): Promise<void> {
  await writeAtomically(filePath, content, true)
}

/** Read and parse a JSON file, returning null if it doesn't exist */
export async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch (error) {
    if (isMissingFileError(error)) return null
    if (error instanceof SyntaxError) {
      throw new Error(`Corrupt JSON file "${filePath}": ${error.message}`, { cause: error })
    }
    throw error
  }
}

/** Write an object as formatted JSON atomically */
export async function writeJson(filePath: string, data: unknown): Promise<void> {
  await atomicWrite(filePath, JSON.stringify(data, null, 2))
}

/** Ensure a directory exists (recursive) */
export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true })
}

/** Async equivalent of existsSync for interactive filesystem probes. */
export async function pathIsAccessible(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** List directory entries, returning empty array if dir doesn't exist */
export async function listDir(dirPath: string): Promise<string[]> {
  try {
    return await readdir(dirPath)
  } catch (error) {
    if (isMissingFileError(error)) return []
    throw error
  }
}

/** List only direct child directories, ignoring files such as macOS metadata. */
export async function listDirectories(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (error) {
    if (isMissingFileError(error)) return []
    throw error
  }
}

/** Remove a directory recursively */
export async function removeDir(dirPath: string): Promise<void> {
  await rm(dirPath, { recursive: true, force: true })
}

/**
 * Is this an Electron launch of the unpackaged app? Electron sets
 * `process.defaultApp` to `true` only when the app was started by being handed
 * to the default Electron executable (`electron .`   exactly what
 * `electron-vite dev` does), and leaves it `undefined` in a packaged app. It is
 * therefore the one signal a shared utility can use to tell a development
 * launch from a shipped one without importing `electron`.
 */
export function isUnpackagedElectronLaunch(): boolean {
  const electronProcess = process as NodeJS.Process & { readonly defaultApp?: boolean }
  return electronProcess.defaultApp === true
}

/**
 * Is this launch running from a Windows app package (MSIX/AppX) rather than a
 * traditional installer?
 *
 * Electron sets `process.windowsStore` when the process carries Windows package
 * identity, which is exactly the Store-distributed case. Package identity
 * changes three things this app cares about: Windows derives the Application
 * User Model ID from the package instead of from a Start Menu shortcut, the
 * install directory is read-only, and the Store owns app updates. Shared
 * utilities cannot import `electron`, so this reads the flag off the process the
 * same way {@link isUnpackagedElectronLaunch} does.
 */
export function isWindowsStorePackage(): boolean {
  const electronProcess = process as NodeJS.Process & { readonly windowsStore?: boolean }
  return electronProcess.windowsStore === true
}

/**
 * Get the app config root path.
 *
 * An absolute `CODEINOVEN_CONFIG_ROOT` redirects the whole app-owned data root.
 * It is honored by unpackaged launches (so several worktrees can run `bun dev`
 * against isolated data) and by the packaged-startup smoke harness that proves
 * a first run from an empty root. A shipped app ignores it unless the smoke
 * harness sets it, so a stray environment variable can never repoint a user's
 * real data root.
 */
export function getCanonicalConfigRoot(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '~'
  return join(home, '.config', ORG_SLUG, APP_SLUG)
}

/**
 * Whether this launch is the packaged-startup smoke proof: the app a build starts
 * by itself, from an empty data root, to prove the artifact it just produced
 * boots. A shipped app only honours the smoke's data-root redirect when this is
 * set, so the variable is the launch's own declaration that it is unattended.
 */
export function isPackagedSmokeLaunch(): boolean {
  return Boolean(process.env['CODEINOVEN_PACKAGED_SMOKE_OUTPUT'])
}

/**
 * Whether this launch must never touch the OS keyring.
 *
 * `safeStorage` initializes its keyring item the first time it is asked for
 * anything, and macOS answers a keyring access from a bundle that is not the
 * signature which stored that item with a modal prompt for the login keychain's
 * password. An ad-hoc-signed build gets a fresh signature on every package run,
 * so every verification launch would otherwise stop and wait for a human to
 * unlock the keychain in the middle of a build. A launch the build starts is
 * unattended by definition, so it treats the keyring as unavailable and keeps
 * the build non-interactive.
 */
export function skipsOsKeyring(): boolean {
  return isPackagedSmokeLaunch()
}

/**
 * Get the app config root path.
 *
 * An absolute `CODEINOVEN_CONFIG_ROOT` redirects the whole app-owned data root.
 * It is honored by unpackaged launches (so several worktrees can run `bun dev`
 * against isolated data) and by the packaged-startup smoke harness that proves
 * a first run from an empty root. A shipped app ignores it unless the smoke
 * harness sets it, so a stray environment variable can never repoint a user's
 * real data root.
 */
export function getConfigRoot(): string {
  const configuredRoot = process.env['CODEINOVEN_CONFIG_ROOT']
  if (
    configuredRoot &&
    isAbsolute(configuredRoot) &&
    (isPackagedSmokeLaunch() || isUnpackagedElectronLaunch())
  ) {
    return configuredRoot
  }
  return getCanonicalConfigRoot()
}

/**
 * Environment variable that opts a launch out of background registration.
 *
 * Set it when starting a probe instance: a second app the agent (or a tester)
 * starts to inspect behaviour without touching the session already running. An
 * opted-out process creates no menu bar icon, registers no login item, never
 * holds the machine awake for a due run, and quits when its window closes
 * instead of parking   so a probe can never leave a second icon beside the
 * user's app.
 */
export const NO_BACKGROUND_ENV = 'CODEINOVEN_NO_BACKGROUND'

/**
 * Whether this launch must stay out of background registration.
 *
 * This is the deliberate, per-process opt-out, honoured only where
 * `CODEINOVEN_CONFIG_ROOT` is honoured (an unpackaged launch, or the packaged
 * smoke harness), so a stray variable in a shipped app's environment can never
 * strip the user's menu bar. It is never inferred from an isolated data root:
 * probing the menu bar itself needs background mode on, so the opt-out must be
 * asked for rather than assumed.
 */
export function isBackgroundRegistrationDisabled(): boolean {
  if (!isPackagedSmokeLaunch() && !isUnpackagedElectronLaunch()) return false
  const value = process.env[NO_BACKGROUND_ENV]?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

/** Get project storage path */
export function getProjectPath(projectId: string): string {
  return join(getConfigRoot(), 'projects', projectId)
}

/** Get assistant storage path (assistant icons and future per-assistant artifacts). */
export function getAssistantPath(assistantId: string): string {
  return join(getConfigRoot(), 'assistants', assistantId)
}

const SCOPE_DIRECTORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Validate a managed-scope directory name: exactly one relative, path-safe
 * segment with no traversal or absolute forms.
 */
export function validateScopeDirectoryName(directoryName: string): string {
  if (
    directoryName.length === 0 ||
    directoryName.length > 128 ||
    isAbsolute(directoryName) ||
    win32.isAbsolute(directoryName) ||
    !SCOPE_DIRECTORY_PATTERN.test(directoryName) ||
    directoryName.split(/[\\/]+/u).includes('..')
  ) {
    throw new Error(`Managed scope directory name is not path-safe: "${directoryName}"`)
  }
  return directoryName
}

/**
 * Canonical app-managed root for one scope worktree:
 * `<config-root>/projects/<project-id>/scope/<directory-name>`.
 * Deterministic for a given config root; never accepts absolute names.
 * The returned path is symlink-resolved (`realpath`) so it exactly matches the
 * path Git registers for the worktree (macOS `/var` → `/private/var`, etc.).
 */
export function getScopeRootPath(projectId: string, directoryName: string): string {
  const logical = join(
    getProjectPath(projectId),
    'scope',
    validateScopeDirectoryName(directoryName)
  )
  // Resolve symlinks from the deepest existing ancestor upward so the value is
  // canonical even before the worktree directory exists, which exactly matches
  // the path Git registers (`/var/folders` → `/private/var/folders` on macOS).
  let ancestor = logical
  while (!existsSync(ancestor)) {
    const parent = join(ancestor, '..')
    if (parent === ancestor) break
    ancestor = parent
  }
  try {
    return join(realpathSync.native(ancestor), logical.slice(ancestor.length))
  } catch {
    return logical
  }
}

/** Get thread storage path */
export function getThreadPath(projectId: string, threadId: string): string {
  return join(getProjectPath(projectId), 'threads', threadId)
}
