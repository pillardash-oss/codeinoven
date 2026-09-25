/// <reference types="node" />

import { lstatSync, realpathSync, existsSync } from 'fs'
import { writeFile, rename, mkdir, readFile, readdir, rm } from 'fs/promises'
import { isAbsolute, join, relative, resolve, sep, win32 } from 'path'
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

/** Atomic write: write to a unique temporary file then rename it into place. */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${generateId()}.tmp`
  try {
    await writeFile(tmpPath, content, { encoding: 'utf-8', flag: 'wx', mode: 0o600 })
    await rename(tmpPath, filePath)
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined)
    throw error
  }
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
function isUnpackagedElectronLaunch(): boolean {
  const electronProcess = process as NodeJS.Process & { readonly defaultApp?: boolean }
  return electronProcess.defaultApp === true
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
  const isPackagedSmoke = Boolean(process.env['CODEINOVEN_PACKAGED_SMOKE_OUTPUT'])
  if (
    configuredRoot &&
    isAbsolute(configuredRoot) &&
    (isPackagedSmoke || isUnpackagedElectronLaunch())
  ) {
    return configuredRoot
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '~'
  return join(home, '.config', ORG_SLUG, APP_SLUG)
}

/** Get project storage path */
export function getProjectPath(projectId: string): string {
  return join(getConfigRoot(), 'projects', projectId)
}

/** Get routine storage path (routine icons and future per-routine artifacts). */
export function getRoutinePath(routineId: string): string {
  return join(getConfigRoot(), 'routines', routineId)
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
