import { stat, open, access } from 'fs/promises'
import { resolve, relative, isAbsolute, sep } from 'path'
import { simpleGit } from 'simple-git'
import type { SimpleGit, StatusResult } from 'simple-git'
import type {
  GitBranchInfo,
  GitCommitInfo,
  GitDiff,
  GitFileChange,
  GitFileStatus,
  GitIdentity,
  GitRemoteInfo,
  GitStatus,
  GitSyncSummary,
  MergeSummary
} from '../lib/types'
import { Logger } from './logger'

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
        return {
          path: safePath,
          staged,
          content: boundedContent,
          binary: file?.binary ?? false,
          additions,
          deletions,
          truncated
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
        await this.client(directory).init()
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

  async log(projectPath: string, limit = DEFAULT_LOG_LIMIT): Promise<GitCommitInfo[]> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      return this.wrapError(projectPath, 'read', async () => {
        const git = this.client(directory)
        const history = await git.log({ maxCount: Math.max(1, Math.min(limit, 200)) })
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

  async pull(projectPath: string): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      await this.wrapError(projectPath, 'mutation', async () => {
        await this.client(directory).pull()
      })
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

  async stash(projectPath: string, message?: string): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      await this.wrapError(projectPath, 'mutation', async () => {
        const args = message ? ['push', '-m', message] : ['push']
        await this.client(directory).stash(args)
      })
      return this.readStatus(directory)
    })
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

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

  private async mapStatus(directory: string, status: StatusResult): Promise<GitStatus> {
    const conflictState = await this.detectConflictState(directory)
    const conflicted = status.conflicted
    const changes: GitFileChange[] = status.files.map((file): GitFileChange => {
      const path = file.path.split(sep).join('/')
      const indexMarker = file.index?.trim() ?? ''
      const staged = indexMarker.length > 0 && indexMarker !== '?'
      const statusKind: GitFileStatus = conflicted.includes(path)
        ? 'conflicted'
        : file.working_dir === '?' || status.not_added.includes(path)
          ? 'untracked'
          : file.from
            ? 'renamed'
            : file.index === 'D' || file.working_dir === 'D'
              ? 'deleted'
              : staged
                ? 'added'
                : 'modified'
      return {
        path,
        ...(file.from ? { oldPath: file.from.split(sep).join('/') } : {}),
        status: statusKind,
        staged
      }
    })

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
      truncated: false
    }
  }

  /** Build a bounded `+` diff for an untracked file, detecting binary content. */
  private async untrackedDiff(directory: string, path: string): Promise<GitDiff> {
    const filePath = resolve(directory, path)
    const metadata = await stat(filePath).catch(() => null)
    if (!metadata) return this.emptyDiff(path, false)

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
    if (head === null) return this.emptyDiff(path, false)
    if (head.includes('\0')) {
      return { ...this.emptyDiff(path, false), binary: true }
    }
    const truncated = metadata.size > MAX_DIFF_BYTES
    const bounded = truncated ? head.slice(0, MAX_DIFF_BYTES) : head
    const additions = bounded.split('\n').length
    return {
      path,
      staged: false,
      content: bounded
        .split('\n')
        .map((line) => `+${line}`)
        .join('\n'),
      binary: false,
      additions,
      deletions: 0,
      truncated
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
