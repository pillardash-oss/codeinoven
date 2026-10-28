import type { SimpleGit } from 'simple-git'
import type { GitRemoteInfo, GitStatus } from '../../../lib/types'
import {
  assertRelativePath as assertRepositoryRelativePath,
  readBlob as readGitBlob,
  refExists as gitRefExists,
  workingFileContent as readWorkingFileContent
} from './git-service-diffs'
import type { CommandKind } from './git-service-runtime'
import {
  createAuthenticatedGitClient,
  createGitClient,
  createGitClientWithoutEditor,
  runGitCommand,
  validateRepositoryDirectory
} from './git-service-runtime'
import { detectConflictState, mapStatus } from './git-service-status'

/**
 * The plumbing every git concern in this folder shares: the two per-project
 * lanes that serialize repository access, the client factories, error
 * classification, and the bounded read helpers.
 *
 * It owns no user-facing operation. Every feature unit takes one of these in its
 * constructor and queues its own work through it, so the ordering guarantees
 * live in exactly one place.
 */
export class GitServiceCore {
  private readonly queues = new Map<string, Promise<unknown>>()

  /**
   * The remote lane, one per project, deliberately separate from `queues`.
   *
   * Fetch is the only git operation that spends its whole life on the network
   * while touching nothing a user is working with: it writes remote-tracking
   * refs and `FETCH_HEAD`, never the index or the working tree. On the shared
   * lane it held every local operation behind it for the length of the round
   * trip, so a panel-open fetch meant no staging, committing, stashing or even
   * a diff until the network answered, for work that has nothing to do with the
   * remote.
   *
   * Every remote round trip shares this lane instead: a bare fetch takes it
   * alone, and a local operation that is also a remote round trip (push, pull,
   * the peer sync's fetch, the PR-conflict prepare and finish) takes it from
   * inside the local lane. Two remote round trips in one repository would race
   * `FETCH_HEAD` and the refs they prune or publish, which is the only thing
   * they have to be serialized against.
   */
  private readonly remoteQueues = new Map<string, Promise<unknown>>()

  /**
   * Run `task` against a repository in strict FIFO order per project id.
   * Reads and mutations share the queue so a status read never races a commit.
   * Remote round trips are not here; see `enqueueRemote`.
   */
  enqueue<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(projectId) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.queues.set(
      projectId,
      next.then(
        () => undefined,
        () => undefined
      )
    )
    return next
  }

  /**
   * Take this repository's turn to talk to a remote.
   *
   * The lane is FIFO, so awaiting it waits for whatever remote round trip is
   * already running or queued, and holding it keeps every later one behind this
   * task. Acquisition is always local lane then remote lane, and a task on this
   * lane never takes the local one, so the two cannot deadlock.
   */
  enqueueRemote<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.remoteQueues.get(projectId) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.remoteQueues.set(
      projectId,
      next.then(
        () => undefined,
        () => undefined
      )
    )
    return next
  }

  client(directory: string, extraConfig: string[] = []): SimpleGit {
    return createGitClient(directory, extraConfig)
  }

  clientWithoutEditor(directory: string): SimpleGit {
    return createGitClientWithoutEditor(directory)
  }

  withAuthHeader(directory: string, token: string): SimpleGit {
    return createAuthenticatedGitClient(directory, token)
  }

  async wrapError<T>(projectId: string, kind: CommandKind, task: () => Promise<T>): Promise<T> {
    return runGitCommand(projectId, kind, task)
  }

  async repo(projectPath: string): Promise<string> {
    return validateRepositoryDirectory(projectPath)
  }

  async getStatus(projectPath: string): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      return this.readStatus(directory)
    })
  }

  /** Non-queued status read   only safe inside a queued task. */
  async readStatus(directory: string): Promise<GitStatus> {
    return this.wrapError(directory, 'read', async () => {
      const status = await this.client(directory).status()
      const conflictState = await detectConflictState(this.client(directory), directory)
      return mapStatus(directory, status, conflictState)
    })
  }

  /** Non-queued remote list   only safe inside a queued task. */
  async readRemotes(directory: string): Promise<GitRemoteInfo[]> {
    return this.wrapError(directory, 'read', async () => {
      const remotes = await this.client(directory).getRemotes(true)
      return remotes.map((remote) => ({
        name: remote.name,
        url: remote.refs?.fetch ?? ''
      }))
    })
  }

  /** Resolve a project-relative path and forbid escaping the repository root. */
  assertRelativePath(directory: string, path: string): string {
    return assertRepositoryRelativePath(directory, path)
  }

  /**
   * True when a rev (e.g. `abc123^`) resolves to an existing commit.
   *
   * Detection is read from stdout on purpose: `rev-parse --verify --quiet`
   * prints nothing and exits non-zero for a missing rev, but simple-git only
   * rejects a raw command when it produced error output   so a rejected promise
   * is not a reliable existence signal here.
   */
  async refExists(git: SimpleGit, rev: string): Promise<boolean> {
    return gitRefExists(git, rev)
  }

  /**
   * Read a git blob (e.g. `HEAD:src/a.ts` or `:src/a.ts`) with a payload cap.
   * Returns null when the path does not exist in that ref (new/deleted files).
   * Blobs larger than 8x the diff bound are skipped rather than buffered whole.
   */
  async readBlob(
    git: SimpleGit,
    ref: string
  ): Promise<{ content: string; truncated: boolean } | null> {
    return readGitBlob(git, ref)
  }

  /**
   * Read a working-tree file bounded to `maximumBytes`, detecting binary
   * content via NUL bytes (mirrors the old untracked-diff probe). The diff
   * bound is the default; the conflict path passes the configured cap.
   */
  async workingFileContent(
    directory: string,
    path: string,
    maximumBytes?: number
  ): Promise<{ content: string; truncated: boolean; binary: boolean } | null> {
    return readWorkingFileContent(directory, path, maximumBytes)
  }
}
