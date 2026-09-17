import { rm, stat } from 'fs/promises'
import { resolve } from 'path'
import { simpleGit } from 'simple-git'
import type { SimpleGit } from 'simple-git'
import { Logger } from '../../system/logger'

export function sleep(ms: number): Promise<void> {
  return new Promise((resolveTimeout) => setTimeout(resolveTimeout, ms))
}

/** Kind of git command for error classification. */
export type CommandKind = 'read' | 'mutation'

interface GitCommandError extends Error {
  /** Exit code reported by the git binary. */
  code?: number
  /** git's own error output. */
  gitError?: string
}

const GIT_UNAVAILABLE_MESSAGE = 'Git is not available on this machine'

/** Resolve a validated absolute directory, mirroring `RepositoryService`. */
export async function validateRepositoryDirectory(projectPath: string): Promise<string> {
  const candidate = projectPath.trim()
  if (!candidate) throw new TypeError('Project path is required')
  const absolutePath = resolve(candidate)
  let metadata
  try {
    metadata = await stat(absolutePath)
  } catch {
    throw new Error(`Project directory does not exist: ${absolutePath}`)
  }
  if (!metadata.isDirectory()) {
    throw new Error(`Project path is not a directory: ${absolutePath}`)
  }
  return absolutePath
}

export function createGitClient(directory: string, extraConfig: string[] = []): SimpleGit {
  return simpleGit(directory, {
    config: extraConfig,
    maxConcurrentProcesses: 1
  })
}

/**
 * A client with git's editor replaced by a no-op, for the commands that commit
 * on the user's behalf.
 *
 * `git rebase --continue` finishes a resolved conflict by committing it, and
 * that commit runs the configured editor. Measured against real git: with
 * nothing configured and no terminal it exits 1 with "Terminal is dumb, but
 * EDITOR unset. Please supply the message using either -m or -F option", and
 * with git's default `vi` it runs the editor with the message path as its
 * argument and never returns. Either way the rebase the panel just offered to
 * continue cannot continue, and in the blocking case the main process waits on
 * a promise that never settles. `core.editor=true` is git's own no-op editor,
 * and on the command line it outranks `VISUAL`, `EDITOR` and any configured
 * `core.editor` such as `code --wait`.
 *
 * simple-git refuses to pass an editor through unless the caller opts in,
 * because an editor value is arbitrary code. Every value here is ours (`true`),
 * never anything a user typed, and the opt-in is on this client alone rather
 * than the shared default, so no other command's argv can carry an editor.
 * `GIT_EDITOR` still outranks a config entry, but only a process launched from
 * a shell that exports it would carry one into the app.
 */
export function createGitClientWithoutEditor(directory: string): SimpleGit {
  return simpleGit(directory, {
    config: ['core.editor=true'],
    maxConcurrentProcesses: 1,
    unsafe: { allowUnsafeEditor: true }
  })
}

/** Transient auth header via per-command `-c` config   never persisted, never logged. */
export function createAuthenticatedGitClient(directory: string, token: string): SimpleGit {
  return simpleGit(directory, {
    maxConcurrentProcesses: 1,
    config: [`http.extraheader=Authorization: Bearer ${token}`]
  })
}

/**
 * Backoff schedule for retries after an `index.lock` contention failure. The
 * agent's own git CLI and this service are separate processes with no shared
 * queue, so concurrent `git add`/`commit`/`status` writes race the same lock;
 * the loser fails immediately with "index.lock: File exists". A short retry
 * almost always wins once the other side finishes its write.
 */
const INDEX_LOCK_RETRY_DELAYS_MS = [100, 250, 500, 1000] as const
/** A lock file older than this is debris from a crashed or killed git process. */
const STALE_INDEX_LOCK_AGE_MS = 10_000

function isIndexLockError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const causeMessage =
    error.cause instanceof Error ? error.cause.message : String(error.cause ?? '')
  return `${error.message}\n${causeMessage}`.includes('index.lock')
}

/**
 * Remove an abandoned `.git/index.lock` so a crashed git process cannot wedge
 * every later command forever. Only locks older than the staleness window are
 * removed   a fresh lock belongs to a live concurrent git write.
 * `rev-parse --git-path` resolves the correct location even inside worktrees.
 */
async function breakStaleIndexLock(directory: string): Promise<void> {
  try {
    const lockPath = (
      await createGitClient(directory).raw(['rev-parse', '--git-path', 'index.lock'])
    ).trim()
    if (!lockPath) return
    const absolute = resolve(directory, lockPath)
    const metadata = await stat(absolute).catch(() => null)
    if (!metadata || metadata.isDirectory()) return
    if (Date.now() - metadata.mtimeMs <= STALE_INDEX_LOCK_AGE_MS) return
    await rm(absolute, { force: true })
    Logger.dev(`Removed stale git index lock: ${absolute}`)
  } catch {
    // Best effort   the retry loop re-reports the underlying git failure.
  }
}

/**
 * Run a git task, retrying with backoff when it loses an `index.lock` race.
 * A stale lock (left by a crashed git process) is broken before each retry.
 */
export async function withIndexLockRetry<T>(directory: string, task: () => Promise<T>): Promise<T> {
  let attempt = 0
  for (;;) {
    try {
      return await task()
    } catch (error) {
      if (attempt >= INDEX_LOCK_RETRY_DELAYS_MS.length || !isIndexLockError(error)) throw error
      await breakStaleIndexLock(directory)
      await sleep(INDEX_LOCK_RETRY_DELAYS_MS[attempt++])
    }
  }
}

export async function runGitCommand<T>(
  projectId: string,
  kind: CommandKind,
  task: () => Promise<T>
): Promise<T> {
  try {
    return await withIndexLockRetry(projectId, task)
  } catch (failure) {
    const error = failure as GitCommandError
    const message = error.gitError ?? error.message ?? 'Unknown git error'
    if (error.code === 127 || String(error.code) === 'ENOENT' || message.includes('ENOENT')) {
      if (kind === 'mutation') {
        Logger.error(`Git unavailable during mutation for project ${projectId}`)
      }
      throw new Error(GIT_UNAVAILABLE_MESSAGE, { cause: failure })
    }
    throw new Error(message, { cause: failure })
  }
}
