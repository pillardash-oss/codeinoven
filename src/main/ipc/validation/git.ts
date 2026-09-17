import { toPosixPath } from '../../../lib/paths'
import type { GitConflictSide, GitRebaseAction, GitRestoreTarget } from '../../../lib/types'
import { assertRecord, rejectUnknownFields, validateBoundedString } from './primitives'

const GIT_PATH_PATTERN = /^[^\0]*$/u
const GIT_BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u
const GIT_REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const GIT_URL_SCHEMES = new Set(['https', 'http', 'ssh', 'git', 'file'])
const GIT_COMMIT_MESSAGE_MAX = 4096
/** Upper bound on one assembled conflict-resolution payload (child of MAX_DIFF_BYTES). */
const GIT_CONFLICT_RESOLUTION_MAX = 500 * 1024
const GIT_RESET_MODES = new Set(['soft', 'mixed', 'hard'])

/**
 * Validate a project-relative git path: must be non-empty, bounded, free of
 * control characters, and must not contain `..` segments (path traversal).
 */
export function validateGitRelativePath(value: unknown, label = 'Git file path'): string {
  const path = validateBoundedString(value, label, 1, 4096)
  if (!GIT_PATH_PATTERN.test(path)) {
    throw new TypeError(`${label} must not contain control characters`)
  }
  const segments = toPosixPath(path).split('/')
  if (segments.some((segment) => segment === '..')) {
    throw new TypeError(`${label} must not escape the repository root`)
  }
  return path
}

/** Validate a list of project-relative git paths. */
export function validateGitPathArray(value: unknown, label = 'Git file paths'): string[] {
  if (!Array.isArray(value) || value.length > 2000) {
    throw new TypeError(`${label} must be an array of at most 2000 paths`)
  }
  return value.map((entry, index) => validateGitRelativePath(entry, `${label}[${index}]`))
}

/** Validate a branch name (letters, numbers, dots, underscores, hyphens, slashes). */
export function validateBranchName(value: unknown, label = 'Git branch'): string {
  const branch = validateBoundedString(value, label, 1, 256)
  if (!GIT_BRANCH_PATTERN.test(branch) || branch.endsWith('/') || branch.endsWith('.')) {
    throw new TypeError(`${label} is not a valid git branch name`)
  }
  return branch
}

/** Validate a commit message, allowing free-form multi-line text. */
export function validateCommitMessage(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Commit message must be a string')
  if (value.length === 0 || value.length > GIT_COMMIT_MESSAGE_MAX || value.includes('\0')) {
    throw new TypeError(`Commit message must be between 1 and ${GIT_COMMIT_MESSAGE_MAX} characters`)
  }
  return value.replace(/\r\n/gu, '\n')
}

/**
 * Validate assembled conflict-resolution content: free-form multi-line text up
 * to the diff bounded cap, without NUL control characters.
 */
export function validateConflictResolutionContent(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new TypeError('Conflict resolution must be a string without NUL characters')
  }
  if (value.length > GIT_CONFLICT_RESOLUTION_MAX) {
    throw new TypeError(
      `Conflict resolution must be at most ${GIT_CONFLICT_RESOLUTION_MAX} characters`
    )
  }
  return value.replace(/\r\n/gu, '\n')
}

/** Validate a git reset severity mode (soft / mixed / hard). */
export function validateGitResetMode(value: unknown): 'soft' | 'mixed' | 'hard' {
  if (typeof value !== 'string' || !GIT_RESET_MODES.has(value)) {
    throw new TypeError('Reset mode must be one of: soft, mixed, hard')
  }
  return value as 'soft' | 'mixed' | 'hard'
}

/** Validate which side of a conflict to take wholesale. */
export function validateGitConflictSide(value: unknown): GitConflictSide {
  if (value !== 'incoming' && value !== 'current') {
    throw new TypeError('Conflict side must be one of: incoming, current')
  }
  return value
}

/** Validate how to move a stopped rebase along. */
export function validateGitRebaseAction(value: unknown): GitRebaseAction {
  if (value !== 'continue' && value !== 'skip') {
    throw new TypeError('Rebase action must be one of: continue, skip')
  }
  return value
}

/** Validate a restore target: the index only, or the index and working tree. */
export function validateGitRestoreTarget(value: unknown): GitRestoreTarget {
  if (value !== 'staged' && value !== 'worktree') {
    throw new TypeError('Restore target must be one of: staged, worktree')
  }
  return value
}

/** Validate a revision-like restore source (commit hash, `stash@{n}`, branch). */
export function validateGitRevision(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().startsWith('-')) {
    throw new TypeError('A valid git revision is required')
  }
  return value.trim()
}

/** Validate a git identity name/email pair. */
export function validateGitIdentity(value: unknown): { name: string; email: string } {
  const input = assertRecord(value, 'Git identity')
  rejectUnknownFields(input, new Set(['name', 'email']), 'git identity')
  return {
    name: validateBoundedString(input.name, 'Git identity name', 1, 256),
    email: validateBoundedString(input.email, 'Git identity email', 1, 256)
  }
}

/** Validate a remote name (single path-safe segment). */
export function validateRemoteName(value: unknown): string {
  const name = validateBoundedString(value, 'Remote name', 1, 128)
  if (!GIT_REMOTE_NAME_PATTERN.test(name)) {
    throw new TypeError(
      'Remote name must contain only letters, numbers, dots, underscores, and hyphens'
    )
  }
  return name
}

/** Validate a remote URL (scheme-constrained, bounded length). */
export function validateRemoteUrl(value: unknown): string {
  const url = validateBoundedString(value, 'Remote URL', 1, 4096)
  if (!url.includes(':') && !url.startsWith('/')) {
    throw new TypeError('Remote URL must be a valid git remote URL')
  }
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/iu.exec(url)
  if (schemeMatch && !GIT_URL_SCHEMES.has(schemeMatch[1]!.toLowerCase())) {
    throw new TypeError(`Remote URL scheme "${schemeMatch[1]}" is not supported`)
  }
  if (url.includes('\n') || url.includes('\r') || url.includes('\0')) {
    throw new TypeError('Remote URL must not contain control characters')
  }
  return url
}
