/**
 * Citation resolution for agent-authored file references. Pure functions over a
 * project root: a candidate resolves only when it exists on disk as a regular
 * file or directory inside the root, with symlinks and traversal rejected.
 */

import { lstat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { toPosixPath } from '../../../lib/paths'
import {
  MAX_RELATIVE_PATH_LENGTH,
  isUnresolvablePathError,
  isWithinRoot
} from './project-files-paths'

/**
 * Existence probe for absolute citation paths that live outside the project
 * root (e.g. Codex `:codex-file-citation` tokens). Returns whether the path
 * exists on disk as a regular file or directory (symlinks resolve to false).
 * Purely an existence check, no content is read or returned.
 */
export async function externalCitationPathExists(rawCandidate: string): Promise<boolean> {
  if (!rawCandidate || rawCandidate.includes('\0')) return false
  if (!isAbsolute(rawCandidate)) return false
  try {
    const metadata = await lstat(rawCandidate)
    if (metadata.isSymbolicLink()) return false
    return metadata.isFile() || metadata.isDirectory()
  } catch (error) {
    if (isUnresolvablePathError(error)) return false
    throw error
  }
}

/**
 * Canonical project-relative path for one candidate, or null when it does not
 * exist inside the root. A candidate that runs through a regular file does not
 * exist either, which is the normal shape of a linked worktree's `.git`: it is
 * a file, so `.git/heads` has nothing under it. That resolves to `null` like
 * any other missing entry, and must not reject the call, because the resolver
 * runs over agent-authored text.
 */
export async function resolveCitationPath(
  root: string,
  rawCandidate: string
): Promise<string | null> {
  if (rawCandidate.length === 0 || rawCandidate.length > MAX_RELATIVE_PATH_LENGTH) return null
  if (rawCandidate.includes('\0') || rawCandidate.includes('\\')) return null

  let candidate = rawCandidate
  if (candidate.startsWith('file://')) {
    try {
      candidate = decodeURIComponent(new URL(candidate).pathname)
    } catch {
      return null
    }
  }
  while (candidate.startsWith('./')) candidate = candidate.slice(2)

  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate)
  if (!isWithinRoot(root, absolute)) return null

  const relativePath = toPosixPath(relative(root, absolute))
  if (!relativePath || relativePath === '..' || relativePath.startsWith('../')) return null

  const segments = relativePath.split('/').filter(Boolean)
  if (segments.some((segment) => segment === '.' || segment === '..')) return null

  try {
    let current = root
    for (const [index, segment] of segments.entries()) {
      current = resolve(current, segment)
      if (!isWithinRoot(root, current)) return null
      const metadata = await lstat(current)
      if (metadata.isSymbolicLink()) return null
      if (index < segments.length - 1) {
        // A segment that is not a directory leaves nothing beneath it, so the
        // candidate cannot exist: stop here instead of asking lstat for a path
        // through a file and taking its ENOTDIR. `<worktree>/.git` is a regular
        // file, and `.git/rebase-merge` is exactly that input.
        if (!metadata.isDirectory()) return null
        continue
      }
      if (!metadata.isFile() && !metadata.isDirectory()) return null
    }
    return relativePath
  } catch (error) {
    if (isUnresolvablePathError(error)) return null
    throw error
  }
}
