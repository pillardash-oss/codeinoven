import { stat, open, access, readFile, writeFile, rename, rm, unlink } from 'fs/promises'
import { resolve, relative, isAbsolute, sep } from 'path'
import { simpleGit } from 'simple-git'
import type { LogOptions, SimpleGit, StatusResult } from 'simple-git'
import type {
  GitBranchInfo,
  GitCommitInfo,
  GitConflictAnalysis,
  GitConflictHunk,
  GitDiff,
  GitFileChange,
  GitFileStatus,
  GitIdentity,
  GitRemoteInfo,
  GitResetMode,
  GitStashEntry,
  GitStatus,
  GitSyncSummary,
  MergeSummary,
  PullRequestCompare
} from '../../lib/types'
import { Logger } from '../system/logger'

/** Upper bound on a single diff payload so the IPC contract never floods. */
const MAX_DIFF_BYTES = 500 * 1024

/** Number of commits returned by `git log` by default. */
const DEFAULT_LOG_LIMIT = 50

/** Kind of git command for error classification. */
type CommandKind = 'read' | 'mutation'

interface GitCommandError extends Error {
  /** Exit code reported by the git binary. */
  code?: number
  /** git's own error output. */
  gitError?: string
}

const GIT_UNAVAILABLE_MESSAGE = 'Git is not available on this machine'

function isUnbornBranchLogError(failure: unknown): boolean {
  if (!(failure instanceof Error)) return false
  const error = failure as GitCommandError
  const message = error.gitError ?? error.message
  return message.includes('does not have any commits yet')
}

/**
 * Main-process git runtime built on `simple-git` — the same thin wrapper over
 * the system `git` binary the app already execs in `repository-service`,
 * `change-tracking-service`, and `project-file-index-service`.
 *
 * All repository mutations are serialized per project through a promise queue
 * (the `project-files-service` pattern) so concurrent IPC-driven operations can
 * never interleave and corrupt the working tree.
 */
export class GitService {
  private readonly queues = new Map<string, Promise<unknown>>()

  /**
   * Run `task` against a repository in strict FIFO order per project id.
   * Reads and mutations share the queue so a status read never races a commit.
   */
  private enqueue<T>(projectId: string, task: () => Promise<T>): Promise<T> {
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

  /** Resolve a validated absolute directory, mirroring `RepositoryService`. */
  private async validatedDirectory(projectPath: string): Promise<string> {
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

  private client(directory: string, extraConfig: string[] = []): SimpleGit {
    return simpleGit(directory, {
      config: extraConfig,
      maxConcurrentProcesses: 1
    })
  }

  private async wrapError<T>(
    projectId: string,
    kind: CommandKind,
    task: () => Promise<T>
  ): Promise<T> {
    try {
      return await task()
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

  private async repo(projectPath: string): Promise<string> {
    return this.validatedDirectory(projectPath)
  }

  async getStatus(projectPath: string): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      return this.readStatus(directory)
    })
  }

  /** Non-queued status read — only safe inside a queued task. */
  private async readStatus(directory: string): Promise<GitStatus> {
    return this.wrapError(directory, 'read', async () => {
      const status = await this.client(directory).status()
      return this.mapStatus(directory, status)
    })
  }

  /** Non-queued remote list — only safe inside a queued task. */
  private async readRemotes(directory: string): Promise<GitRemoteInfo[]> {
    return this.wrapError(directory, 'read', async () => {
      const remotes = await this.client(directory).getRemotes(true)
      return remotes.map((remote) => ({
        name: remote.name,
        url: remote.refs?.fetch ?? ''
      }))
    })
  }

  async getDiff(projectPath: string, relativePath: string, staged: boolean): Promise<GitDiff> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      return this.wrapError(projectPath, 'read', async () => {
        const safePath = this.assertRelativePath(directory, relativePath)
        const git = this.client(directory)
        const isUntracked = await this.isUntracked(git, safePath)
        if (isUntracked && !staged) {
          return this.untrackedDiff(directory, safePath)
        }
        const args = staged ? ['--staged', '--', safePath] : ['--', safePath]
        const [content, summary] = await Promise.all([git.diff(args), git.diffSummary(args)])
        const file = summary.files[0]
        const additions =
          file && 'insertions' in file && typeof file.insertions === 'number' ? file.insertions : 0
        const deletions =
          file && 'deletions' in file && typeof file.deletions === 'number' ? file.deletions : 0
        const truncated = Buffer.byteLength(content, 'utf-8') > MAX_DIFF_BYTES
        const boundedContent = truncated
          ? `${content.slice(0, MAX_DIFF_BYTES)}\n… (diff truncated to ${MAX_DIFF_BYTES} bytes)`
          : content
        const binary = file?.binary ?? false

        // Resolve the before/after sides so the renderer can reuse the app's
        // unified diff viewer instead of re-parsing the raw text.
        let before: string | undefined
        let after: string | undefined
        let sideTruncated = false
        if (!binary) {
          if (staged) {
            const head = await this.readBlob(git, `HEAD:${safePath}`)
            const index = await this.readBlob(git, `:${safePath}`)
            before = head?.content
            after = index?.content
            sideTruncated = (head?.truncated ?? false) || (index?.truncated ?? false)
          } else {
            const index = await this.readBlob(git, `:${safePath}`)
            const working = await this.workingFileContent(directory, safePath)
            before = index?.content
            after = working?.content
            sideTruncated = (index?.truncated ?? false) || (working?.truncated ?? false)
          }
        }

        return {
          path: safePath,
          staged,
          content: boundedContent,
          binary,
          additions,
          deletions,
          truncated: truncated || sideTruncated,
          before,
          after
        }
      })
    })
  }

  async stage(projectPath: string, paths: string[]): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      const safePaths = paths.map((path) => this.assertRelativePath(directory, path))
      if (safePaths.length > 0) {
        await this.wrapError(directory, 'mutation', async () => {
          await this.client(directory).add(safePaths)
        })
      }
      return this.readStatus(directory)
    })
  }

  /**
   * Complete resolution of a single conflicted path.
   *
   * A merge/rebase leaves the path in an unmerged index state until `git add`
   * is run on it. Editing the working file (the editor's Save) removes the
   * conflict markers on disk, but git still reports the path as conflicted. This
   * stages the path so git marks it resolved — but only when the working file no
   * longer contains conflict markers, so a partially-resolved file is never
   * staged. Returns fresh status so the renderer can clear the conflicted list.
   */
  async resolveConflicted(projectPath: string, path: string): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      const safePath = this.assertRelativePath(directory, path)
      const status = await this.client(directory).status()
      if (!status.conflicted.includes(safePath)) return this.readStatus(directory)
      const file = await this.workingFileContent(directory, safePath)
      if (!file || file.binary || file.truncated) return this.readStatus(directory)
      if (hasConflictMarkers(file.content)) return this.readStatus(directory)
      await this.wrapError(directory, 'mutation', async () => {
        await this.client(directory).add([safePath])
      })
      return this.readStatus(directory)
    })
  }

  /**
   * Parse a conflicted working file into its conflict hunks so the resolution
   * panel can offer ours/theirs side-by-side editing. Binary and oversized
   * files report their state without parsing (the user resolves those in the
   * editor instead).
   */
  async analyzeConflict(projectPath: string, relativePath: string): Promise<GitConflictAnalysis> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      const safePath = this.assertRelativePath(directory, relativePath)
      return this.wrapError(projectPath, 'read', async () => {
        const working = await this.workingFileContent(directory, safePath)
        if (!working)
          return { path: safePath, binary: false, truncated: true, content: '', hunks: [] }
        if (working.binary) {
          return { path: safePath, binary: true, truncated: false, content: '', hunks: [] }
        }
        const hunks = parseConflictHunks(working.content)
        return {
          path: safePath,
          binary: false,
          truncated: working.truncated,
          content: working.content,
          hunks
        }
      })
    })
  }

  /**
   * Persist a fully-resolved conflict file: replace the working copy with the
   * user's merged content and stage it so git clears the unmerged entry. The
   * content must contain no remaining conflict markers, otherwise resolution is
   * incomplete and the write is refused (a partially-resolved file is never
   * staged).
   */
  async saveConflictResolution(
    projectPath: string,
    relativePath: string,
    content: string
  ): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      const safePath = this.assertRelativePath(directory, relativePath)
      const status = await this.client(directory).status()
      if (!status.conflicted.includes(safePath)) return this.readStatus(directory)
      await this.wrapError(directory, 'mutation', async () => {
        if (hasConflictMarkers(content)) {
          throw new Error(
            'This file still has unresolved conflict markers — resolve every conflict first.'
          )
        }
        const target = resolve(directory, safePath)
        // Atomic write: same directory + rename, so the working file can never be
        // observed half-written.
        const temp = `${target}.resolve-tmp`
        await writeFile(temp, content, 'utf-8')
        await rename(temp, target)
        await this.client(directory).add([safePath])
      })
      return this.readStatus(directory)
    })
  }

  async unstage(projectPath: string, paths: string[]): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      const safePaths = paths.map((path) => this.assertRelativePath(directory, path))
      if (safePaths.length > 0) {
        await this.wrapError(directory, 'mutation', async () => {
          await this.client(directory).raw(['reset', '--', ...safePaths])
        })
      }
      return this.readStatus(directory)
    })
  }

  async commit(projectPath: string, message: string): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      await this.wrapError(projectPath, 'mutation', async () => {
        const cleanMessage = message.replace(/\r\n/gu, '\n')
        await this.client(directory).commit(cleanMessage)
      })
      return this.readStatus(directory)
    })
  }

  async initialize(projectPath: string): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      await this.wrapError(projectPath, 'mutation', async () => {
        await this.client(directory).init({ '--initial-branch': 'main' })
      })
      return this.readStatus(directory)
    })
  }

  async listBranches(projectPath: string): Promise<GitBranchInfo[]> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      return this.wrapError(projectPath, 'read', async () => {
        const git = this.client(directory)
        const local = await git.branchLocal()
        const tracking = await this.branchTracking(git)
        return Object.values(local.branches).map((branch): GitBranchInfo => {
          const track = tracking.get(branch.name)
          return {
            name: branch.name,
            current: branch.current,
            remote: track?.remote ?? null,
            ahead: track?.ahead ?? 0,
            behind: track?.behind ?? 0
          }
        })
      })
    })
  }

  async checkout(projectPath: string, branch: string): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      await this.wrapError(projectPath, 'mutation', async () => {
        await this.client(directory).checkout(branch)
      })
      return this.readStatus(directory)
    })
  }

  async createBranch(projectPath: string, name: string): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      await this.wrapError(projectPath, 'mutation', async () => {
        await this.client(directory).checkoutLocalBranch(name)
      })
      return this.readStatus(directory)
    })
  }

  async deleteBranch(projectPath: string, name: string, force = false): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      await this.wrapError(projectPath, 'mutation', async () => {
        await this.client(directory).deleteLocalBranch(name, force)
      })
      return this.readStatus(directory)
    })
  }

  /** `offset` skips the N newest commits — pages in older history for infinite scroll. */
  async log(projectPath: string, limit = DEFAULT_LOG_LIMIT, offset = 0): Promise<GitCommitInfo[]> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      return this.wrapError(projectPath, 'read', async () => {
        const git = this.client(directory)
        const options: LogOptions & { '--skip'?: number } = {
          maxCount: Math.max(1, Math.min(limit, 200))
        }
        if (offset > 0) options['--skip'] = Math.max(0, offset)
        let history
        try {
          history = await git.log(options)
        } catch (failure) {
          if (isUnbornBranchLogError(failure)) return []
          throw failure
        }
        return history.all.map((entry): GitCommitInfo => ({
          hash: entry.hash,
          shortHash: entry.hash.slice(0, 7),
          author: entry.author_name ?? entry.author_email ?? 'unknown',
          date: entry.date ? new Date(entry.date).getTime() : Date.now(),
          message: entry.message
        }))
      })
    })
  }

  async commitDiff(projectPath: string, hash: string): Promise<GitFileChange[]> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      return this.wrapError(projectPath, 'read', async () =>
        this.diffVsParent(this.client(directory), hash)
      )
    })
  }

  /** Full per-file diff of one file within a commit, compared against its parent. */
  async commitFileDiff(projectPath: string, hash: string, relativePath: string): Promise<GitDiff> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      return this.wrapError(projectPath, 'read', async () =>
        this.fileDiffVsParent(this.client(directory), directory, hash, relativePath)
      )
    })
  }

  /** Files changed by a stash (e.g. `stash@{0}`), compared against its parent. */
  async stashDiff(projectPath: string, id: string): Promise<GitFileChange[]> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      return this.wrapError(projectPath, 'read', async () =>
        this.diffVsParent(this.client(directory), id)
      )
    })
  }

  /** Full per-file diff of one file within a stash, compared against its parent. */
  async stashFileDiff(projectPath: string, id: string, relativePath: string): Promise<GitDiff> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      return this.wrapError(projectPath, 'read', async () =>
        this.fileDiffVsParent(this.client(directory), directory, id, relativePath)
      )
    })
  }

  /** Amend the most recent commit, folding staged changes into the new commit. */
  async amend(projectPath: string, message: string): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      await this.wrapError(projectPath, 'mutation', async () => {
        const cleanMessage = message.replace(/\r\n/gu, '\n')
        await this.client(directory).raw(['commit', '--amend', '-m', cleanMessage])
      })
      return this.readStatus(directory)
    })
  }

  /** Reset the current branch to a target commit (defaults to HEAD). */
  async reset(projectPath: string, mode: GitResetMode, target?: string): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      await this.wrapError(projectPath, 'mutation', async () => {
        const args = ['reset', `--${mode}`]
        if (target) args.push(target)
        await this.client(directory).raw(args)
      })
      return this.readStatus(directory)
    })
  }

  /**
   * Delete a commit by dropping it from history (interactive-rebase semantics).
   * `git rebase --onto <target>^ <target>` replays every commit after `target`
   * onto its parent, skipping `target` itself. Only safe for unpushed commits;
   * pushed commits need a force-push afterwards.
   */
  async deleteCommit(projectPath: string, target: string): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      await this.wrapError(projectPath, 'mutation', async () => {
        await this.client(directory).raw(['rebase', '--onto', `${target}^`, target])
      })
      return this.readStatus(directory)
    })
  }

  async getIdentity(projectPath: string): Promise<GitIdentity> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      return this.readIdentity(directory)
    })
  }

  /** Non-queued identity read — only safe inside a queued task. */
  private async readIdentity(directory: string): Promise<GitIdentity> {
    return this.wrapError(directory, 'read', async () => {
      const git = this.client(directory)
      const [name, email] = await Promise.all([
        git.raw(['config', 'user.name']).catch(() => ''),
        git.raw(['config', 'user.email']).catch(() => '')
      ])
      const safeName = name.trim() || null
      const safeEmail = email.trim() || null
      return {
        name: safeName,
        email: safeEmail,
        configured: Boolean(safeName && safeEmail)
      }
    })
  }

  async setIdentity(projectPath: string, name: string, email: string): Promise<GitIdentity> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      await this.wrapError(directory, 'mutation', async () => {
        const git = this.client(directory)
        await git.raw(['config', 'user.name', name])
        await git.raw(['config', 'user.email', email])
      })
      return this.readIdentity(directory)
    })
  }

  // ─── Remotes & sync (Phase 2) ────────────────────────────────────────────

  async listRemotes(projectPath: string): Promise<GitRemoteInfo[]> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      return this.readRemotes(directory)
    })
  }

  async addRemote(projectPath: string, name: string, url: string): Promise<GitRemoteInfo[]> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      await this.wrapError(projectPath, 'mutation', async () => {
        await this.client(directory).addRemote(name, url)
      })
      return this.readRemotes(directory)
    })
  }

  async removeRemote(projectPath: string, name: string): Promise<GitRemoteInfo[]> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      await this.wrapError(projectPath, 'mutation', async () => {
        await this.client(directory).removeRemote(name)
      })
      return this.readRemotes(directory)
    })
  }

  async fetch(projectPath: string): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      await this.wrapError(projectPath, 'mutation', async () => {
        await this.client(directory).fetch()
      })
      return this.readStatus(directory)
    })
  }

  /** Updates just one branch's remote-tracking ref — doesn't touch the working tree. */
  async fetchBranch(projectPath: string, remote: string, branch: string): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      await this.wrapError(projectPath, 'mutation', async () => {
        await this.client(directory).fetch(remote, branch)
      })
      return this.readStatus(directory)
    })
  }

  async pull(projectPath: string): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      await this.wrapError(projectPath, 'mutation', async () => {
        await this.client(directory).pull()
      })
      return this.readStatus(directory)
    })
  }

  /**
   * Pull a specific remote branch, merging or rebasing, and return the
   * refreshed status even when the integration stops on conflicts.
   *
   * The push-recovery flow needs to distinguish "pulled cleanly, safe to push"
   * from "stopped on conflicts, hand over to the conflict UI". A conflicted
   * pull is not an error — it returns the conflicted status so the renderer
   * can show the merge/rebase conflict banner and never auto-push a half-merged
   * tree. Only genuine failures (network, auth, no upstream) throw.
   */
  async pullIntegrate(
    projectPath: string,
    options: { remote?: string; branch?: string; rebase?: boolean; token?: string } = {}
  ): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      const args: string[] = []
      if (options.rebase) args.push('--rebase')
      if (options.remote) args.push(options.remote)
      if (options.branch) args.push(options.branch)
      const git = options.token
        ? this.withAuthHeader(directory, options.token)
        : this.client(directory)
      try {
        await git.pull(args)
      } catch (failure) {
        const status = await this.readStatus(directory).catch(() => null)
        if (status && status.conflicted.length > 0) return status
        await this.wrapError(projectPath, 'mutation', async () => {
          throw failure
        })
      }
      return this.readStatus(directory)
    })
  }

  async push(
    projectPath: string,
    options: { setUpstream: boolean; remote?: string; branch?: string; token?: string } = {
      setUpstream: false
    }
  ): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      await this.wrapError(projectPath, 'mutation', async () => {
        const args: string[] = []
        if (options.setUpstream) args.push('--set-upstream')
        if (options.remote) args.push(options.remote)
        if (options.branch) args.push(options.branch)
        const git = options.token
          ? this.withAuthHeader(directory, options.token)
          : this.client(directory)
        await git.push(args)
      })
      return this.readStatus(directory)
    })
  }

  async syncSummary(projectPath: string): Promise<GitSyncSummary> {
    const status = await this.getStatus(projectPath)
    return { ahead: status.ahead, behind: status.behind }
  }

  /**
   * Compare a local head with the selected merge target without requiring the
   * head to exist on the remote yet. The remote-tracking base is preferred so
   * the result matches the branch GitHub will merge into as closely as the
   * repository's latest fetch allows.
   */
  async comparePullRequestBranches(
    projectPath: string,
    base: string,
    head: string
  ): Promise<PullRequestCompare | null> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      return this.wrapError(projectPath, 'read', async () => {
        const git = this.client(directory)
        const localHead = `refs/heads/${head}`
        if (!(await this.refExists(git, localHead))) return null

        const remoteBase = `refs/remotes/origin/${base}`
        const localBase = `refs/heads/${base}`
        const baseRef = (await this.refExists(git, remoteBase))
          ? remoteBase
          : (await this.refExists(git, localBase))
            ? localBase
            : null
        if (!baseRef) return null

        const counts = await git.raw([
          'rev-list',
          '--left-right',
          '--count',
          `${baseRef}...${localHead}`
        ])
        const [behindBy = 0, aheadBy = 0] = counts
          .trim()
          .split(/\s+/u)
          .map((value) => Number.parseInt(value, 10))
        const status: PullRequestCompare['status'] =
          aheadBy > 0 && behindBy > 0
            ? 'diverged'
            : aheadBy > 0
              ? 'ahead'
              : behindBy > 0
                ? 'behind'
                : 'identical'
        const summary = await git.diffSummary([`${baseRef}...${localHead}`])
        return {
          source: 'local',
          status,
          aheadBy,
          behindBy,
          totalCommits: aheadBy,
          filesChanged: summary.files.length,
          hasChanges: aheadBy > 0
        }
      })
    })
  }

  // ─── Merge / rebase / stash (Phase 4) ────────────────────────────────────

  async merge(projectPath: string, target: string): Promise<MergeSummary> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      return this.wrapError(projectPath, 'mutation', async () => {
        interface MergeFailure {
          conflicts?: Array<{ file?: string; reason?: string }>
          result?: string
        }
        const result = await this.client(directory)
          .merge([target])
          .then(
            (ok) => ok,
            (failure: unknown) => {
              const error = failure as { git?: MergeFailure }
              return {
                conflicts: error.git?.conflicts ?? [],
                result: error.git?.result ?? ''
              } satisfies MergeFailure
            }
          )
        return this.mapMergeResult(result)
      })
    })
  }

  async rebase(projectPath: string, target: string): Promise<MergeSummary> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      return this.wrapError(projectPath, 'mutation', async () => {
        const git = this.client(directory)
        const failure = await git.rebase([target]).catch((error: unknown) => error)
        if (failure) {
          const status = await git.status()
          return this.mapMergeResult({
            conflicts: status.conflicted.map((path) => ({ file: path })),
            result: 'Rebase stopped due to conflicts.'
          })
        }
        return this.emptyMergeResult('Rebase completed.')
      })
    })
  }

  async abortMerge(projectPath: string): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      await this.wrapError(projectPath, 'mutation', async () => {
        await this.client(directory).raw(['merge', '--abort'])
      })
      return this.readStatus(directory)
    })
  }

  async abortRebase(projectPath: string): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      await this.wrapError(projectPath, 'mutation', async () => {
        await this.client(directory).raw(['rebase', '--abort'])
      })
      return this.readStatus(directory)
    })
  }

  /**
   * Prepare to resolve a PR's online merge conflicts locally: check out the PR
   * head as a local branch (`pr-<number>`) and merge the current base into it
   * so the conflicts land in the working tree for the conflict UI to resolve.
   *
   * A conflicted merge is a normal, expected state — not an error — so the
   * refreshed status (with `conflicted` paths and `conflictState: 'merge'`) is
   * returned for the renderer to hand over to the conflict-resolution UI.
   */
  async preparePrResolve(
    projectPath: string,
    options: { remote: string; pullNumber: number; baseBranch: string }
  ): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      const git = this.client(directory)
      const localBranch = `pr-${options.pullNumber}`
      const baseRef = `${options.remote}/${options.baseBranch}`
      await this.wrapError(projectPath, 'mutation', async () => {
        // Check out the PR head as a local branch (force-refresh the ref so a
        // stale `pr-<n>` from an earlier attempt always tracks the latest head).
        await git.raw([
          'fetch',
          options.remote,
          `+pull/${options.pullNumber}/head:refs/heads/${localBranch}`
        ])
        await git.raw(['checkout', localBranch])
        // Fetch the latest base and merge it in to reproduce the PR's conflict.
        await git.raw(['fetch', options.remote, options.baseBranch])
        // A conflicted merge rejects; the refreshed status below still reports
        // the conflict state, so this is expected and swallowed.
        await git.merge([baseRef]).catch(() => {})
      })
      return this.readStatus(directory)
    })
  }

  async stash(projectPath: string, message?: string, paths?: string[]): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      await this.wrapError(projectPath, 'mutation', async () => {
        if (paths && paths.length > 0) {
          const safePaths = paths.map((path) => this.assertRelativePath(directory, path))
          const args = message ? ['push', '-m', message] : ['push']
          await this.client(directory).stash([...args, '--', ...safePaths])
        } else {
          const args = message ? ['push', '-m', message] : ['push']
          await this.client(directory).stash(args)
        }
      })
      return this.readStatus(directory)
    })
  }

  /** Stop tracking paths, preserve them on disk, and add them to `.gitignore`. */
  async ignore(projectPath: string, paths: string[]): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      await this.wrapError(directory, 'mutation', async () => {
        const safePaths = paths.map((path) => this.assertRelativePath(directory, path))
        if (safePaths.length === 0) return
        const gitignorePath = resolve(directory, '.gitignore')
        let existing = ''
        try {
          existing = await readFile(gitignorePath, 'utf-8')
        } catch {
          // No .gitignore yet — a new one is created below.
        }
        const lines = existing ? existing.replace(/\r\n/gu, '\n').split('\n') : []
        const patterns: string[] = []
        for (const path of safePaths) {
          const isDirectory = await this.isDirectory(directory, path)
          const pattern = isDirectory ? `${path}/` : path
          if (!lines.includes(pattern)) patterns.push(pattern)
        }
        if (patterns.length > 0) {
          const separator = lines.length > 0 && lines[lines.length - 1]?.trim() !== '' ? '\n' : ''
          const additions =
            lines.length > 0 ? `${separator}${patterns.join('\n')}` : patterns.join('\n')
          const content = existing ? `${existing}${additions}\n` : `${patterns.join('\n')}\n`
          await writeFile(gitignorePath, content, 'utf-8')
        }

        // An ignore rule has no effect on files that are already tracked. Remove
        // the selected paths from the index while keeping their working-tree
        // contents intact so the requested ignore operation fully takes effect.
        await this.client(directory).raw([
          'rm',
          '-r',
          '--cached',
          '--force',
          '--ignore-unmatch',
          '--',
          ...safePaths
        ])
      })
      return this.readStatus(directory)
    })
  }

  /** Discard working-tree changes for the given paths. Tracked files are
   *  restored from HEAD; untracked files are deleted. */
  async discard(projectPath: string, paths: string[]): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      await this.wrapError(directory, 'mutation', async () => {
        const safePaths = paths.map((path) => this.assertRelativePath(directory, path))
        if (safePaths.length === 0) return
        const git = this.client(directory)
        const status = await git.status()
        const tracked: string[] = []
        const untracked: string[] = []
        for (const path of safePaths) {
          if (
            status.not_added.includes(path) ||
            status.not_added.some((p) => p.startsWith(`${path}/`))
          ) {
            untracked.push(path)
          } else {
            tracked.push(path)
          }
        }
        if (tracked.length > 0) {
          await git.checkout(['--', ...tracked])
        }
        for (const path of untracked) {
          const absolute = resolve(directory, path)
          await this.removePath(absolute)
        }
      })
      return this.readStatus(directory)
    })
  }

  /** True when the path resolves to a directory inside the repository. */
  private async isDirectory(directory: string, path: string): Promise<boolean> {
    try {
      const info = await stat(resolve(directory, path))
      return info.isDirectory()
    } catch {
      return false
    }
  }

  /** Recursively remove a file or directory that is not tracked by git. */
  private async removePath(absolute: string): Promise<void> {
    try {
      const info = await stat(absolute)
      if (info.isDirectory()) {
        await rm(absolute, { recursive: true, force: true })
      } else {
        await unlink(absolute)
      }
    } catch {
      // Nothing to remove — treat as already gone.
    }
  }

  /** List stashes newest-first, e.g. `stash@{0}` → `stash@{n}`. */
  async listStashes(projectPath: string): Promise<GitStashEntry[]> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      return this.wrapError(projectPath, 'read', async () => {
        const git = this.client(directory)
        const output = await git.raw(['stash', 'list', '--format=%gd%x00%gs%x00%ct%x00'])
        const raw = String(output)
        if (!raw.trim()) return []
        return raw
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => {
            const [id, message, date, ...rest] = line.split('\0')
            if (!id) return null
            const fullMessage = message ?? (rest.length > 0 ? rest.join('\0') : '')
            const branchMatch = /^(?:WIP on|On) ([^:\s]+):/u.exec(fullMessage)
            return {
              id,
              message: fullMessage,
              branch: branchMatch?.[1] ?? null,
              date: Number.parseInt(date ?? '0', 10) * 1000 || Date.now()
            } satisfies GitStashEntry
          })
          .filter((entry): entry is GitStashEntry => entry !== null)
      })
    })
  }

  /** Restore a stash (defaults to the newest) and drop it when it applies cleanly. */
  async popStash(projectPath: string, id?: string): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      await this.wrapError(projectPath, 'mutation', async () => {
        const args = id ? ['pop', id] : ['pop']
        await this.client(directory).stash(args)
      })
      return this.readStatus(directory)
    })
  }

  /** Discard a stash (defaults to the newest). */
  async dropStash(projectPath: string, id?: string): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      await this.wrapError(projectPath, 'mutation', async () => {
        const args = id ? ['drop', id] : ['drop']
        await this.client(directory).stash(args)
      })
      return this.readStatus(directory)
    })
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  /** Files changed by any commit-like ref (hash or `stash@{n}`), vs its first parent. */
  private async diffVsParent(git: SimpleGit, ref: string): Promise<GitFileChange[]> {
    const safeRef = ref.trim()
    const result = await git.show([`${safeRef}^!`, '--stat', '--format='])
    const lines = result.split('\n').filter((line) => line.trim())
    const changes: GitFileChange[] = []
    for (const line of lines) {
      const match = /^(.+?)\s+\|\s+(\d+)\s+([+-]+)/u.exec(line)
      if (match) {
        const path = match[1]?.trim() ?? ''
        const statusChar = match[3]?.[0] ?? 'M'
        const status: GitFileStatus =
          statusChar === '+' ? 'added' : statusChar === '-' ? 'deleted' : 'modified'
        changes.push({ path, status, staged: false })
      }
    }
    return changes
  }

  /** Per-file diff for any commit-like ref (hash or `stash@{n}`), vs its first parent. */
  private async fileDiffVsParent(
    git: SimpleGit,
    directory: string,
    ref: string,
    relativePath: string
  ): Promise<GitDiff> {
    const safeRef = ref.trim()
    const safePath = this.assertRelativePath(directory, relativePath)
    const parentRef = `${safeRef}^`
    const parentExists = await this.refExists(git, parentRef)
    if (!parentExists) {
      // Root commit: the whole file is new, reuse the untracked/added shape.
      const blob = await this.readBlob(git, `${safeRef}:${safePath}`)
      if (!blob) return this.emptyDiff(safePath, false)
      const additions = blob.content.length === 0 ? 0 : blob.content.split('\n').length
      return {
        path: safePath,
        staged: false,
        content: blob.content
          .split('\n')
          .map((line) => `+${line}`)
          .join('\n'),
        before: '',
        after: blob.content,
        binary: blob.content.includes('\0'),
        additions,
        deletions: 0,
        truncated: blob.truncated
      }
    }
    const content = await git.diff([parentRef, safeRef, '--', safePath])
    const summary = await git.diffSummary([parentRef, safeRef, '--', safePath])
    const file = summary.files[0]
    const additions =
      file && 'insertions' in file && typeof file.insertions === 'number' ? file.insertions : 0
    const deletions =
      file && 'deletions' in file && typeof file.deletions === 'number' ? file.deletions : 0
    const binary = file?.binary ?? false
    const truncated = Buffer.byteLength(content, 'utf-8') > MAX_DIFF_BYTES
    const boundedContent = truncated
      ? `${content.slice(0, MAX_DIFF_BYTES)}\n… (diff truncated to ${MAX_DIFF_BYTES} bytes)`
      : content

    let before: string | undefined
    let after: string | undefined
    let sideTruncated = false
    if (!binary) {
      const beforeBlob = await this.readBlob(git, `${parentRef}:${safePath}`)
      const afterBlob = await this.readBlob(git, `${safeRef}:${safePath}`)
      before = beforeBlob?.content
      after = afterBlob?.content
      sideTruncated = (beforeBlob?.truncated ?? false) || (afterBlob?.truncated ?? false)
    }

    return {
      path: safePath,
      staged: false,
      content: boundedContent,
      binary,
      additions,
      deletions,
      truncated: truncated || sideTruncated,
      before,
      after
    }
  }

  /** Resolve a project-relative path and forbid escaping the repository root. */
  private assertRelativePath(directory: string, path: string): string {
    const candidate = path.trim()
    if (!candidate || candidate.includes('\0')) {
      throw new TypeError('Invalid repository path')
    }
    const absolute = isAbsolute(candidate) ? candidate : resolve(directory, candidate)
    const relativePath = relative(directory, absolute)
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new TypeError('Repository path escapes the project root')
    }
    return relativePath.split(sep).join('/')
  }

  private async isUntracked(git: SimpleGit, path: string): Promise<boolean> {
    const status = await git.status()
    return status.not_added.includes(path)
  }

  /** True when a rev (e.g. `abc123^`) resolves to an existing commit. */
  private async refExists(git: SimpleGit, rev: string): Promise<boolean> {
    try {
      await git.raw(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
      return true
    } catch {
      return false
    }
  }

  private async mapStatus(directory: string, status: StatusResult): Promise<GitStatus> {
    const conflictState = await this.detectConflictState(directory)
    const conflicted = status.conflicted
    const changes: GitFileChange[] = []
    for (const file of status.files) {
      const path = file.path.split(sep).join('/')
      const indexMarker = file.index?.trim() ?? ''
      const workMarker = file.working_dir?.trim() ?? ''
      const staged = indexMarker.length > 0 && indexMarker !== '?'
      const untracked = workMarker === '?' || status.not_added.includes(path)

      const push = (entry: GitFileChange): void => {
        changes.push(entry)
      }

      if (conflicted.includes(path)) {
        push({
          path,
          ...(file.from ? { oldPath: file.from.split(sep).join('/') } : {}),
          status: 'conflicted',
          staged
        })
        continue
      }
      if (untracked) {
        push({ path, status: 'untracked', staged: false })
        continue
      }

      const statusKind: GitFileStatus = file.from
        ? 'renamed'
        : file.index === 'D' || file.working_dir === 'D'
          ? 'deleted'
          : staged
            ? 'added'
            : 'modified'
      push({
        path,
        ...(file.from ? { oldPath: file.from.split(sep).join('/') } : {}),
        status: statusKind,
        staged
      })
      // git reports a file staged AND modified again as one entry with both
      // index and worktree markers ("MM"). Surface the unstaged half too so the
      // panel shows both the staged snapshot and the further modifications.
      if (staged && workMarker.length > 0 && workMarker !== '?' && workMarker !== 'D') {
        push({ path, status: 'modified', staged: false })
      }
    }

    const stagedChanges = changes.filter(
      (change) => change.staged && change.status !== 'conflicted'
    ).length
    const untrackedChanges = changes.filter((change) => change.status === 'untracked').length
    const unstagedChanges = changes.filter(
      (change) => !change.staged && change.status !== 'untracked' && change.status !== 'conflicted'
    ).length

    return {
      repositoryRoot: directory,
      branch: status.current ? status.current : null,
      detached: Boolean(status.current && status.current === 'HEAD'),
      upstream: status.tracking ?? null,
      conflictState,
      clean: status.isClean(),
      changes,
      stagedChanges,
      unstagedChanges,
      untrackedChanges,
      conflicted,
      ahead: status.ahead ?? 0,
      behind: status.behind ?? 0
    }
  }

  private async branchTracking(
    git: SimpleGit
  ): Promise<Map<string, { remote: string; ahead: number; behind: number }>> {
    const output = await git.raw([
      'for-each-ref',
      '--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)',
      'refs/heads'
    ])
    const raw = Array.isArray(output) ? output.join('\n') : output
    const tracking = new Map<string, { remote: string; ahead: number; behind: number }>()
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      const [branch, upstream, drift] = line.split('\t')
      if (!branch || !upstream) continue
      const ahead = /ahead (\d+)/u.exec(drift ?? '')?.[1] ?? '0'
      const behind = /behind (\d+)/u.exec(drift ?? '')?.[1] ?? '0'
      tracking.set(branch, {
        remote: upstream,
        ahead: Number.parseInt(ahead, 10) || 0,
        behind: Number.parseInt(behind, 10) || 0
      })
    }
    return tracking
  }

  private emptyDiff(path: string, staged: boolean): GitDiff {
    return {
      path,
      staged,
      content: '',
      binary: false,
      additions: 0,
      deletions: 0,
      truncated: false,
      before: '',
      after: ''
    }
  }

  /**
   * Read a git blob (e.g. `HEAD:src/a.ts` or `:src/a.ts`) with a payload cap.
   * Returns null when the path does not exist in that ref (new/deleted files).
   * Blobs larger than 8x the diff bound are skipped rather than buffered whole.
   */
  private async readBlob(
    git: SimpleGit,
    ref: string
  ): Promise<{ content: string; truncated: boolean } | null> {
    let size: number | null
    try {
      const sizeOutput = await git.raw(['cat-file', '-s', ref])
      size = Number.parseInt(String(sizeOutput).trim(), 10)
    } catch {
      return null
    }
    if (size === null || !Number.isFinite(size) || size < 0) return null
    if (size === 0) return { content: '', truncated: false }
    if (size > MAX_DIFF_BYTES * 8) return { content: '', truncated: true }
    let output: unknown
    try {
      output = await git.raw(['cat-file', 'blob', ref])
    } catch {
      return null
    }
    const text = String(output ?? '')
    const truncated = size > MAX_DIFF_BYTES
    return { content: truncated ? text.slice(0, MAX_DIFF_BYTES) : text, truncated }
  }

  /**
   * Read a working-tree file bounded to the diff payload cap, detecting binary
   * content via NUL bytes (mirrors the old untracked-diff probe).
   */
  private async workingFileContent(
    directory: string,
    path: string
  ): Promise<{ content: string; truncated: boolean; binary: boolean } | null> {
    const filePath = resolve(directory, path)
    const metadata = await stat(filePath).catch(() => null)
    if (!metadata) return null

    const readHead = async (): Promise<string | null> => {
      const size = Math.min(metadata.size, MAX_DIFF_BYTES + 1)
      const buffer = Buffer.alloc(size)
      try {
        const handle = await open(filePath, 'r')
        try {
          await handle.read(buffer, 0, size, 0)
        } finally {
          await handle.close()
        }
      } catch {
        return null
      }
      return buffer.toString('utf-8')
    }

    const head = await readHead()
    if (head === null) return null
    const truncated = metadata.size > MAX_DIFF_BYTES
    return {
      content: truncated ? head.slice(0, MAX_DIFF_BYTES) : head,
      truncated,
      binary: head.includes('\0')
    }
  }

  /** Build a bounded `+` diff for an untracked file, detecting binary content. */
  private async untrackedDiff(directory: string, path: string): Promise<GitDiff> {
    const file = await this.workingFileContent(directory, path)
    if (!file) return this.emptyDiff(path, false)
    if (file.binary) return { ...this.emptyDiff(path, false), binary: true }
    const additions = file.content.split('\n').length
    return {
      path,
      staged: false,
      content: file.content
        .split('\n')
        .map((line) => `+${line}`)
        .join('\n'),
      before: '',
      after: file.content,
      binary: false,
      additions,
      deletions: 0,
      truncated: file.truncated
    }
  }

  /** Detect an in-progress merge or rebase from git's control files. */
  private async detectConflictState(directory: string): Promise<'merge' | 'rebase' | 'none'> {
    const gitDir = resolve(directory, '.git')
    const probe = async (candidate: string): Promise<boolean> => {
      try {
        await access(candidate)
        return true
      } catch {
        return false
      }
    }
    if (await probe(resolve(gitDir, 'MERGE_HEAD'))) return 'merge'
    if (
      (await probe(resolve(gitDir, 'rebase-merge'))) ||
      (await probe(resolve(gitDir, 'rebase-apply')))
    ) {
      return 'rebase'
    }
    return 'none'
  }

  private mapMergeResult(result: {
    conflicts?: Array<{ file?: string | null; reason?: string }>
    result?: string
    conflicted?: boolean
  }): MergeSummary {
    const conflicts = result.conflicts ?? []
    const conflictedFiles = conflicts
      .map((conflict) => ({
        path: conflict.file ?? '',
        ...(conflict.reason ? { reason: conflict.reason } : {})
      }))
      .filter((entry) => entry.path.length > 0)
    const resultText = result.result ?? 'Merge completed.'
    const conflicted = result.conflicted ?? conflictedFiles.length > 0
    return {
      conflicted: conflictedFiles,
      merged: [],
      result: conflicted ? `${resultText} (${conflictedFiles.length} conflicted)` : resultText,
      aborted: false
    }
  }

  private emptyMergeResult(result: string): MergeSummary {
    return { conflicted: [], merged: [], result, aborted: false }
  }

  /** Transient auth header via per-command `-c` config — never persisted, never logged. */
  private withAuthHeader(directory: string, token: string): SimpleGit {
    return simpleGit(directory, {
      maxConcurrentProcesses: 1,
      config: [`http.extraheader=Authorization: Bearer ${token}`]
    })
  }
}

/**
 * True when a text file still contains git conflict markers. A resolved file
 * has none of the `<<<<<<<`, `=======`, or `>>>>>>>` marker lines, so presence
 * of any of them means resolution is not complete.
 */
function hasConflictMarkers(content: string): boolean {
  return /^(?:<<<<<<<[ \t].*|=======$|>>>>>>>[ \t].*)$/mu.test(content)
}

/**
 * Parse the well-formed conflict blocks (`<<<<<<<` … `>>>>>>>`) out of a
 * working file so the resolution panel can render each one. Handles both the
 * classic two-way shape and the diff3 shape (a `|||||||` base block between
 * ours and theirs). Returns hunks with 1-based inclusive line spans covering
 * the whole block including its markers.
 */
function parseConflictHunks(content: string): GitConflictHunk[] {
  const lines = content.split('\n')
  const hunks: GitConflictHunk[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (!line.startsWith('<<<<<<<')) {
      i += 1
      continue
    }
    const startLine = i + 1
    const oursLabel = line.replace(/^<{7,}(?: |$)/u, '') || 'ours'
    const ours: string[] = []
    let base: string[] | null = null
    const theirs: string[] = []
    let j = i + 1
    // Ours side: everything up to `=======` or a diff3 `|||||||` base marker.
    while (
      j < lines.length &&
      !(lines[j] ?? '').startsWith('=======') &&
      !(lines[j] ?? '').startsWith('|||||||')
    ) {
      ours.push(lines[j] ?? '')
      j += 1
    }
    // Diff3 base: between `|||||||` and `=======`.
    if (j < lines.length && (lines[j] ?? '') !== '=======') {
      j += 1
      const baseLines: string[] = []
      while (j < lines.length && !(lines[j] ?? '').startsWith('=======')) {
        baseLines.push(lines[j] ?? '')
        j += 1
      }
      base = baseLines
    }
    if (j >= lines.length) {
      i = startLine
      continue // Malformed block — skip forward so we never loop forever.
    }
    j += 1 // consume `=======`
    while (j < lines.length && !(lines[j] ?? '').startsWith('>>>>>>>')) {
      theirs.push(lines[j] ?? '')
      j += 1
    }
    if (j >= lines.length) {
      i = startLine
      continue // Unclosed block — not a usable hunk.
    }
    const endLine = j + 1
    const theirsLabel = (lines[j] ?? '').replace(/^>{7,}(?: |$)/u, '') || 'theirs'
    hunks.push({
      startLine,
      endLine,
      oursLabel,
      theirsLabel,
      ours: ours.join('\n'),
      theirs: theirs.join('\n'),
      base: base === null ? null : base.join('\n')
    })
    i = j + 1
  }
  return hunks
}
