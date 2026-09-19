/**
 * Pure path rules shared by the project file service and its sub-modules:
 * root-containment checks, revision hashing, UTF-8 decoding and relative-path
 * validation. No filesystem state lives here.
 */

import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'

export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024
export const MAX_DIRECTORY_ENTRIES = 10_000
export const MAX_RELATIVE_PATH_LENGTH = 4_096

/** Cache/invalidation key for a (project, scope) root pair. */
export function scopedKey(projectId: string, scopeBucketId?: string): string {
  return scopeBucketId ? `${projectId}::${scopeBucketId}` : projectId
}

export function isWithinRoot(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target)
  return (
    pathFromRoot === '' ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))
  )
}

/** Whether a symlinked directory's target, fully resolved through both the
 *  link and the root, stays inside the project. Mirrors the file-index
 *  service's guard so links escaping the project or cycling up the tree are
 *  never listed. */
export async function isSymlinkedDirectoryInsideRoot(
  root: string,
  linkPath: string
): Promise<boolean> {
  try {
    const [rootReal, linkReal] = await Promise.all([realpath(root), realpath(linkPath)])
    return isWithinRoot(rootReal, linkReal)
  } catch {
    return false
  }
}

export function revisionOf(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

export function decodeText(content: Uint8Array): string {
  if (content.includes(0)) {
    throw new Error('Binary files cannot be edited in the sidebar')
  }
  try {
    return new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true
    }).decode(content)
  } catch {
    throw new Error('Only valid UTF-8 text files can be edited in the sidebar')
  }
}

export function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code === 'ENOENT'
  )
}

/**
 * Whether a filesystem error means "no entry can live at this path", for the
 * two citation resolvers: `ENOENT` for a missing entry, and `ENOTDIR` for a
 * path that runs through a file where a directory would have to be. Both
 * answer the same way, with no entry, and neither may throw: these run over
 * agent-authored text, where one candidate that happens to name a path under a
 * file would otherwise fail the call for every citation in the message.
 */
export function isUnresolvablePathError(error: unknown): boolean {
  return (
    isMissingPathError(error) ||
    (error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string' &&
      error.code === 'ENOTDIR')
  )
}

export function validateRelativePath(path: string, allowEmpty: boolean): string[] {
  if (path.length > MAX_RELATIVE_PATH_LENGTH) {
    throw new Error('Project file path is too long')
  }
  if (path.includes('\0') || path.includes('\\')) {
    throw new Error('Project file path contains unsupported characters')
  }
  if (isAbsolute(path) || /^[a-zA-Z]:/u.test(path)) {
    throw new Error('Project file path must be relative')
  }
  if (!allowEmpty && path.length === 0) {
    throw new Error('Project file path is required')
  }

  const segments = path.split('/').filter(Boolean)
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('Project file path is not available in the sidebar')
  }
  if (segments.join('/') !== path && path !== '') {
    throw new Error('Project file path must use normalized relative segments')
  }
  return segments
}

export function validateEntryName(name: string): void {
  if (
    name.length === 0 ||
    name.length > 255 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    throw new Error('File name must be one valid path segment')
  }
}
