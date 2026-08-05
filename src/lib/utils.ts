import { lstatSync, realpathSync } from 'fs'
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

/** Get the app config root path */
export function getConfigRoot(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '~'
  return join(home, '.config', ORG_SLUG, APP_SLUG)
}

/** Get project storage path */
export function getProjectPath(projectId: string): string {
  return join(getConfigRoot(), 'projects', projectId)
}

/** Get thread storage path */
export function getThreadPath(projectId: string, threadId: string): string {
  return join(getProjectPath(projectId), 'threads', threadId)
}
