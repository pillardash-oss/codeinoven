import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { dirname, relative, resolve } from 'path'
import { toPosixPath } from '../../lib/paths'
import { DEFAULT_MAX_CONFLICT_FILE_BYTES } from '../../lib/types'
import type { LogOptions, SimpleGit } from 'simple-git'
import type {
  GitBranchInfo,
  GitCommitInfo,
  GitConflictAnalysis,
  GitConflictSide,
  GitConflictWorkFile,
  GitDiff,
  GitFileChange,
  GitIdentity,
  GitIntegrationProbe,
  GitPullStrategy,
  GitRebaseAction,
  GitRemoteInfo,
  GitRemoteUpdate,
  GitRestoreTarget,
  GitResetMode,
  GitStashEntry,
  GitStatus,
  GitSyncDirection,
  GitSyncPeerTarget,
  GitSyncResult,
  GitSyncSummary,
  MergeSummary,
  PullRequestCompare,
  PrComposeInput
} from '../../lib/types'
import { Logger } from '../system/logger'
import { GitRefusal, isUncommittedChangesRefusal } from './git-refusal'
import {
  createAuthenticatedGitClient,
  createGitClient,
  createGitClientWithoutEditor,
  runGitCommand,
  validateRepositoryDirectory,
  withIndexLockRetry
} from './git/git-service-runtime'
import type { CommandKind } from './git/git-service-runtime'
import type { PullRequestComposeContext } from './git/git-service-pull-request'
import {
  buildPullRequestComposeContext,
  comparePullRequestBranches as comparePullRequestRefs
} from './git/git-service-pull-request'
import type { ConflictWorkMetadata } from './git/git-service-conflicts'
import {
  REMOTE_REF_PREFIX,
  REMOTE_UPDATE_FORMAT,
  REMOTE_UPDATE_LIMIT,
  parseRemoteUpdates
} from './git/git-service-remote-updates'
import {
  buildInitialConflictWorkFile,
  conflictSourceHash,
  hasConflictMarkers,
  parseConflictHunks,
  parseConflictWorkMetadata,
  parseConflictWorkState
} from './git/git-service-conflicts'
import {
  MAX_DIFF_BYTES,
  assertRelativePath as assertRepositoryRelativePath,
  assertTreeIsh,
  diffVsParent,
  fileDiffVsParent,
  isAncestor,
  isDirectory,
  isUntracked,
  pathExists,
  readBlob as readGitBlob,
  refExists as gitRefExists,
  removePath,
  untrackedDiff,
  workingFileContent as readWorkingFileContent
} from './git/git-service-diffs'
import type { HistoryLogFields } from './git/git-service-status'
import {
  DEFAULT_LOG_LIMIT,
  detectConflictState,
  emptyMergeResult,
  isUnbornBranchLogError,
  mapCommit,
  mapMergeResult,
  mapStatus,
  parseBranchRefs,
  parseCommitParents,
  parseCommitRefs,
  worktreeBranchPaths
} from './git/git-service-status'
import { removeCommitPathChanges } from './git/git-service-commit-rewrite'

// Git read commands opportunistically refresh the index, which takes
// `.git/index.lock`. This service shares the repository with agent git CLIs,
// so every polling status read used to race real writes and occasionally
// fail them with "index.lock: File exists". Disabling the opportunistic
// refresh keeps our reads lock-free; index writes (add, commit) still take
// the lock when they must, and `withIndexLockRetry` backstops those races.
// simple-git spawns inherit the main process environment, so this covers
// every git command this service runs. (Harness processes get the same
// default via buildProcessEnvironment.)
process.env.GIT_OPTIONAL_LOCKS = process.env.GIT_OPTIONAL_LOCKS ?? '0'

export type { PullRequestComposeContext } from './git/git-service-pull-request'

/**
 * Tracked, not-yet-committed files in a checkout: what a rebase refuses and a
 * merge only tolerates while nothing would be overwritten. Untracked files are
 * excluded because no integration ever touches them.
 */
function uncommittedCount(status: GitStatus): number {
  return status.changes.filter((change) => change.status !== 'untracked').length
}

/**
 * How much of git's own output a failed rebase step keeps in the error log. The
 * reason the sequencer refused is its last words, while the summary of every
 * commit it replayed comes first, so the tail is the part worth keeping and the
 * whole thing would bury the log line.
 */
const REBASE_FAILURE_LOG_CHARS = 2000

/**
 * The tail of git's own output for a rebase step git could not move, for the
 * error log. A rebase prints a summary for every commit it replayed before the
 * lines that say why it stopped, so this reads from the end and never hands the
 * panel the wall of output it would have to render as a message.
 */
function rebaseFailureDetail(failure: unknown): string {
  const text = failure instanceof Error ? failure.message : String(failure)
  return text.length > REBASE_FAILURE_LOG_CHARS
    ? `...${text.slice(-REBASE_FAILURE_LOG_CHARS)}`
    : text
}

/**
 * Main-process git runtime built on `simple-git`   the same thin wrapper over
 * the system `git` binary the app already execs in `repository-service`,
 * `change-tracking-service`, and `project-file-index-service`.
 *
 * All repository mutations are serialized per project through a promise queue
 * (the `project-files-service` pattern) so concurrent IPC-driven operations can
 * never interleave and corrupt the working tree. Operations that talk to a
 * remote get a second lane of their own; see `enqueueRemote`.
 */
export interface GitServiceOptions {
  /**
   * Byte cap on a conflicted file the service reads and writes, resolved per
   * call so a settings change applies without a restart. Defaults to
   * {@link DEFAULT_MAX_CONFLICT_FILE_BYTES}.
   */
  conflictFileLimit?: () => Promise<number>
}

export class GitService {
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly conflictFileLimit: () => Promise<number>

  constructor(options: GitServiceOptions = {}) {
    this.conflictFileLimit =
      options.conflictFileLimit ?? (async () => DEFAULT_MAX_CONFLICT_FILE_BYTES)
  }

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

  /**
   * Take this repository's turn to talk to a remote.
   *
   * The lane is FIFO, so awaiting it waits for whatever remote round trip is
   * already running or queued, and holding it keeps every later one behind this
   * task. Acquisition is always local lane then remote lane, and a task on this
   * lane never takes the local one, so the two cannot deadlock.
   */
  private enqueueRemote<T>(projectId: string, task: () => Promise<T>): Promise<T> {
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

  private client(directory: string, extraConfig: string[] = []): SimpleGit {
    return createGitClient(directory, extraConfig)
  }

  private clientWithoutEditor(directory: string): SimpleGit {
    return createGitClientWithoutEditor(directory)
  }

  private withAuthHeader(directory: string, token: string): SimpleGit {
    return createAuthenticatedGitClient(directory, token)
  }

  private async wrapError<T>(
    projectId: string,
    kind: CommandKind,
    task: () => Promise<T>
  ): Promise<T> {
    return runGitCommand(projectId, kind, task)
  }

  private async repo(projectPath: string): Promise<string> {
    return validateRepositoryDirectory(projectPath)
  }

  async getStatus(projectPath: string): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      return this.readStatus(directory)
    })
  }

  /** Non-queued status read   only safe inside a queued task. */
  private async readStatus(directory: string): Promise<GitStatus> {
    return this.wrapError(directory, 'read', async () => {
      const status = await this.client(directory).status()
      const conflictState = await detectConflictState(this.client(directory), directory)
      return mapStatus(directory, status, conflictState)
    })
  }

  /** Non-queued remote list   only safe inside a queued task. */
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
        const pathIsUntracked = await isUntracked(git, safePath)
        if (pathIsUntracked && !staged) {
          return untrackedDiff(directory, safePath)
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
          await this.stagePaths(directory, safePaths)
        })
      }
      return this.readStatus(directory)
    })
  }

  /**
   * Stage the given paths, skipping entries with nothing left to stage.
   *
   * `git add <path>` aborts with "pathspec did not match any files" when the
   * path matches neither the working tree nor the index. That happens when a
   * deletion is already staged ("Stage all" and batch selections re-send
   * already-staged paths), and one such entry used to fail the whole batch.
   * A path is stageable when it exists on disk (modified, untracked, or
   * deleted-on-disk-but-tracked resolves through the index match) or it is
   * still an index entry (covers unstaged deletions and unmerged conflicts);
   * anything else is a harmless no-op and is filtered out before the add.
   */
  private async stagePaths(directory: string, safePaths: string[]): Promise<void> {
    const indexEntries = new Set(
      (await this.client(directory).raw(['ls-files', '-z', '--', ...safePaths])).split('\0')
    )
    const stageable = await Promise.all(
      safePaths.map(async (path) => indexEntries.has(path) || (await pathExists(directory, path)))
    )
    const pending = safePaths.filter((_, index) => stageable[index])
    if (pending.length > 0) {
      await this.client(directory).add(pending)
    }
  }

  /**
   * Complete resolution of a single conflicted path.
   *
   * A merge/rebase leaves the path in an unmerged index state until `git add`
   * is run on it. Editing the working file (the editor's Save) removes the
   * conflict markers on disk, but git still reports the path as conflicted. This
   * stages the path so git marks it resolved   but only when the working file no
   * longer contains conflict markers, so a partially-resolved file is never
   * staged. Returns fresh status so the renderer can clear the conflicted list.
   */
  async resolveConflicted(projectPath: string, path: string): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      const safePath = this.assertRelativePath(directory, path)
      const status = await this.client(directory).status()
      if (!status.conflicted.includes(safePath)) return this.readStatus(directory)
      const file = await this.workingFileContent(
        directory,
        safePath,
        await this.conflictFileBytes()
      )
      if (!file || file.binary || file.truncated) return this.readStatus(directory)
      if (hasConflictMarkers(file.content)) return this.readStatus(directory)
      await this.wrapError(directory, 'mutation', async () => {
        await this.client(directory).add([safePath])
      })
      return this.readStatus(directory)
    })
  }

  /**
   * Take one side of every unresolved conflict wholesale and stage it.
   *
   * `incoming` keeps the theirs side (stage 3, the branch being integrated),
   * `current` keeps the ours side (stage 2, what HEAD had)   the same two sides
   * the per-hunk merge editor names. Each path is written and staged so git
   * clears its unmerged entry, and the merge editor's scratch document for that
   * path is removed because it now describes a file that no longer conflicts.
   *
   * Refused while no conflict is open, and the whole set is touched in one
   * queued task so a partial accept can never be observed.
   */
  async acceptConflictSide(projectPath: string, side: GitConflictSide): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      const status = await this.client(directory).status()
      const safePaths = status.conflicted.map((path) => this.assertRelativePath(directory, path))
      if (safePaths.length === 0) return this.readStatus(directory)
      const scratch = await Promise.all(
        safePaths.map((path) => this.conflictWorkPaths(directory, path))
      )
      await this.wrapError(directory, 'mutation', async () => {
        const git = this.client(directory)
        await git.raw(['checkout', side === 'incoming' ? '--theirs' : '--ours', '--', ...safePaths])
        await git.add(safePaths)
        await Promise.all(
          scratch.flatMap(({ document, metadata }) => [
            rm(document, { force: true }),
            rm(metadata, { force: true })
          ])
        )
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
        const working = await this.workingFileContent(
          directory,
          safePath,
          await this.conflictFileBytes()
        )
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
   * Open (or initialize) the marker-free scratch document used by the merge
   * editor. The original conflicted working-tree file is only read here. On the
   * each editor session, an explicitly saved draft is restored when it still
   * matches the original conflict. Otherwise, every marker block is replaced
   * with its current/HEAD side so the scratch file retains the original
   * extension and parses normally for syntax highlighting.
   */
  async prepareConflictWorkFile(
    projectPath: string,
    relativePath: string
  ): Promise<GitConflictWorkFile> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      const safePath = this.assertRelativePath(directory, relativePath)
      return this.wrapError(directory, 'mutation', async () => {
        const working = await this.workingFileContent(
          directory,
          safePath,
          await this.conflictFileBytes()
        )
        const analysis: GitConflictAnalysis = !working
          ? { path: safePath, binary: false, truncated: true, content: '', hunks: [] }
          : working.binary
            ? { path: safePath, binary: true, truncated: false, content: '', hunks: [] }
            : {
                path: safePath,
                binary: false,
                truncated: working.truncated,
                content: working.content,
                hunks: parseConflictHunks(working.content)
              }
        const paths = await this.conflictWorkPaths(directory, safePath)
        const sourceHash = conflictSourceHash(analysis.content)
        try {
          const [content, metadataText] = await Promise.all([
            readFile(paths.document, 'utf-8'),
            readFile(paths.metadata, 'utf-8')
          ])
          const metadata = parseConflictWorkMetadata(
            metadataText,
            sourceHash,
            analysis.hunks.length,
            content.length
          )
          if (metadata?.draftSaved) {
            return {
              analysis,
              scratchPath: toPosixPath(relative(directory, paths.document)),
              content,
              hunks: metadata.hunks
            }
          }
        } catch {
          // Missing or invalid scratch state is initialized below.
        }
        const initial = buildInitialConflictWorkFile(analysis)
        await this.writeConflictScratch(paths, initial.content, {
          version: 1,
          sourceHash,
          draftSaved: false,
          hunks: initial.hunks
        })
        return {
          analysis,
          scratchPath: toPosixPath(relative(directory, paths.document)),
          content: initial.content,
          hunks: initial.hunks
        }
      })
    })
  }

  /** Persist partial conflict progress without changing or staging the original file. */
  async saveConflictDraft(
    projectPath: string,
    relativePath: string,
    content: string,
    stateJson: string
  ): Promise<void> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      const safePath = this.assertRelativePath(directory, relativePath)
      await this.wrapError(directory, 'mutation', async () => {
        const working = await this.workingFileContent(
          directory,
          safePath,
          await this.conflictFileBytes()
        )
        const source = working?.binary ? '' : (working?.content ?? '')
        const hunks = parseConflictWorkState(stateJson, content.length)
        const paths = await this.conflictWorkPaths(directory, safePath)
        await this.writeConflictScratch(paths, content, {
          version: 1,
          sourceHash: conflictSourceHash(source),
          draftSaved: true,
          hunks
        })
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
            'This file still has unresolved conflict markers   resolve every conflict first.'
          )
        }
        const target = resolve(directory, safePath)
        // Atomic write: same directory + rename, so the working file can never be
        // observed half-written.
        const temp = `${target}.resolve-tmp`
        await writeFile(temp, content, 'utf-8')
        await rename(temp, target)
        await this.client(directory).add([safePath])
        const scratch = await this.conflictWorkPaths(directory, safePath)
        await Promise.all([
          rm(scratch.document, { force: true }),
          rm(scratch.metadata, { force: true })
        ])
      })
      return this.readStatus(directory)
    })
  }

  private async conflictWorkPaths(
    directory: string,
    safePath: string
  ): Promise<{ document: string; metadata: string }> {
    let branch = 'HEAD'
    try {
      branch =
        (await this.client(directory).raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'HEAD'
    } catch {
      // Detached or unborn HEAD   fall back to a generic folder.
    }
    const safeBranch = branch.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')
    const document = resolve(
      directory,
      '.cio',
      'git',
      'merge-conflict',
      safeBranch || 'HEAD',
      ...safePath.split('/')
    )
    return { document, metadata: `${document}.merge.json` }
  }

  private async writeConflictScratch(
    paths: { document: string; metadata: string },
    content: string,
    metadata: ConflictWorkMetadata
  ): Promise<void> {
    await mkdir(dirname(paths.document), { recursive: true })
    const documentTemp = `${paths.document}.resolve-tmp`
    const metadataTemp = `${paths.metadata}.resolve-tmp`
    await Promise.all([
      writeFile(documentTemp, content, 'utf-8'),
      writeFile(metadataTemp, JSON.stringify(metadata), 'utf-8')
    ])
    await Promise.all([rename(documentTemp, paths.document), rename(metadataTemp, paths.metadata)])
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

  /**
   * Restore files from a commit-like source (commit hash, `stash@{n}`, branch)
   * into the index and working tree so the user can pull historical content
   * back without reverting the whole commit or popping the whole stash.
   */
  async restoreFiles(
    projectPath: string,
    source: string,
    paths: string[],
    target: GitRestoreTarget
  ): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      const safePaths = paths.map((path) => this.assertRelativePath(directory, path))
      if (safePaths.length === 0) return this.readStatus(directory)
      const safeSource = assertTreeIsh(source)
      const args =
        target === 'staged'
          ? ['restore', '--staged', '--source', safeSource, '--', ...safePaths]
          : ['restore', '--staged', '--worktree', '--source', safeSource, '--', ...safePaths]
      await this.wrapError(directory, 'mutation', async () => {
        await this.client(directory).raw(args)
      })
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
        const [output, remotes, worktreeRaw] = await Promise.all([
          git.raw([
            'for-each-ref',
            '--format=%(refname)%09%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(upstream:remotename)%09%(upstream:track)%09%(symref)',
            'refs/heads',
            'refs/remotes'
          ]),
          git.getRemotes(),
          git.raw(['worktree', 'list', '--porcelain', '-z']).catch(() => '')
        ])
        return parseBranchRefs(
          Array.isArray(output) ? output.join('\n') : output,
          remotes.map(({ name }) => name),
          worktreeBranchPaths(
            Array.isArray(worktreeRaw) ? worktreeRaw.join('\0') : worktreeRaw,
            directory
          )
        )
      })
    })
  }

  /**
   * The remote's actual default branch (e.g. "nightly" instead of "main"),
   * resolved from origin/HEAD rather than guessed from branch names.
   */
  async getDefaultBranch(projectPath: string): Promise<string | null> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      return this.wrapError(projectPath, 'read', async () => {
        const git = this.client(directory)
        try {
          const ref = await git.raw(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
          const name = String(ref).trim()
          const prefix = 'origin/'
          if (name.startsWith(prefix)) return name.slice(prefix.length)
          return name || null
        } catch {
          return null
        }
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

  async createTrackingBranch(
    projectPath: string,
    remote: string,
    branch: string,
    localName: string
  ): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      await this.wrapError(projectPath, 'mutation', async () => {
        await this.client(directory).raw([
          'checkout',
          '--track',
          '-b',
          localName,
          `${remote}/${branch}`
        ])
      })
      return this.readStatus(directory)
    })
  }

  async deleteBranch(projectPath: string, name: string, force = false): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      await this.wrapError(projectPath, 'mutation', async () => {
        const git = this.client(directory)
        // Tolerate git's ambiguous short spelling: when a tag shares the branch
        // name, `refname:short` renders `heads/<name>` and `git branch -d` on
        // that spelling fails with "branch not found".
        const resolves = await git
          .raw(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
          .then(
            () => true,
            () => false
          )
        const branchName =
          resolves || !name.startsWith('heads/') ? name : name.slice('heads/'.length)
        await this.removeWorktreesForBranch(git, branchName)
        await git.deleteLocalBranch(branchName, force)
      })
      return this.readStatus(directory)
    })
  }

  /** `git push <remote> --delete <name>` removes a branch from a remote. */
  async deleteRemoteBranch(projectPath: string, remote: string, name: string): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      // A remote mutation, like a push: it publishes against refs a fetch may be
      // in the middle of pruning, so it takes the remote lane.
      await this.enqueueRemote(projectPath, () =>
        this.wrapError(projectPath, 'mutation', async () => {
          const git = this.client(directory)
          await git.push([remote, '--delete', name])
        })
      )
      return this.readStatus(directory)
    })
  }

  /**
   * Git refuses `branch -d` while the branch is checked out in any worktree.
   * Remove clean owning worktrees and prune stale registrations so the delete
   * succeeds; a dirty live worktree keeps blocking and surfaces git's error.
   */
  private async removeWorktreesForBranch(git: SimpleGit, name: string): Promise<void> {
    let listing: string
    try {
      listing = await git.raw(['worktree', 'list', '--porcelain'])
    } catch {
      return
    }
    const target = `refs/heads/${name}`
    const lines = listing.split('\n')
    const paths: string[] = []
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].startsWith('worktree ')) continue
      const path = lines[index].slice('worktree '.length)
      const branch = lines
        .slice(index + 1, index + 5)
        .find((line) => line.startsWith('branch '))
        ?.slice('branch '.length)
      if (branch === target) paths.push(path)
    }
    for (const path of paths) {
      await git.raw(['worktree', 'remove', path]).catch(async () => {
        // Path already gone or dirty   prune clears stale registrations; a
        // live dirty worktree stays registered and the branch delete reports it.
        await git.raw(['worktree', 'prune']).catch(() => undefined)
      })
    }
  }

  /**
   * Every movement of the current branch's upstream ref, newest first.
   *
   * Read from git's reflog for that remote-tracking ref, which is the only
   * native record of when commits actually reached the remote (a commit's own
   * dates say when it was written, not when it was published). Each entry names
   * the commit the ref moved to, so the history view can draw where one push
   * ended and the next began.
   *
   * Returns an empty list rather than failing whenever the answer is simply
   * unknown: no upstream, an upstream that is not a remote-tracking ref, or a
   * ref whose reflog was never written or has expired.
   */
  async remoteUpdates(projectPath: string): Promise<GitRemoteUpdate[]> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      return this.wrapError(projectPath, 'read', async () => {
        const git = this.client(directory)
        // The full name, so a branch that tracks another *local* branch (where
        // `branch.<name>.remote` is `.`) is not mistaken for a remote. Such a
        // ref's reflog records local commits, which are not pushes at all.
        const upstream = await git
          .raw(['rev-parse', '--symbolic-full-name', '@{upstream}'])
          .catch(() => '')
        const fullRef = upstream.trim()
        if (!fullRef.startsWith(REMOTE_REF_PREFIX)) return []
        const ref = fullRef.slice(REMOTE_REF_PREFIX.length)
        try {
          const raw = await git.raw([
            'reflog',
            'show',
            '-n',
            String(REMOTE_UPDATE_LIMIT),
            '--date=iso-strict',
            `--format=${REMOTE_UPDATE_FORMAT}`,
            fullRef
          ])
          return parseRemoteUpdates(ref, raw)
        } catch {
          // No reflog for this ref: the clone never fetched (or reflog writing
          // is off). The history view then falls back to its plain boundary.
          return []
        }
      })
    })
  }

  /** `offset` skips the N newest commits   pages in older history for infinite scroll. */
  async log(
    projectPath: string,
    limit = DEFAULT_LOG_LIMIT,
    offset = 0,
    query?: string
  ): Promise<GitCommitInfo[]> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      return this.wrapError(projectPath, 'read', async () => {
        const git = this.client(directory)
        const normalizedQuery = query?.trim()
        if (normalizedQuery && normalizedQuery.length > 256) {
          throw new TypeError('Commit search query must be at most 256 characters')
        }
        const options: LogOptions<HistoryLogFields> & {
          '--fixed-strings'?: null
          '--grep'?: string
          '--regexp-ignore-case'?: null
          '--skip'?: number
        } = {
          maxCount: Math.max(1, Math.min(limit, 200)),
          // Passing a `format` replaces simple-git's default field map, so this
          // restates exactly what the defaults fetched and adds `%P` for lanes.
          format: {
            hash: '%H',
            date: '%aI',
            message: '%s',
            refs: '%D',
            body: '%b',
            author_name: '%aN',
            author_email: '%aE',
            parents: '%P'
          }
        }
        if (offset > 0) options['--skip'] = Math.max(0, offset)
        if (normalizedQuery) {
          options['--fixed-strings'] = null
          options['--grep'] = normalizedQuery
          options['--regexp-ignore-case'] = null
        }
        let history
        try {
          history = await git.log<HistoryLogFields>(options)
        } catch (failure) {
          if (isUnbornBranchLogError(failure)) return []
          throw failure
        }
        const matches = history.all.map((entry) => mapCommit(entry))

        // `--grep` searches commit messages, not object IDs. Resolve a hash-like
        // query separately, then pin that exact match above any title matches.
        if (normalizedQuery && /^[0-9a-f]{4,40}$/iu.test(normalizedQuery)) {
          const hashMatch = await this.commitForHash(git, normalizedQuery)
          if (hashMatch) {
            return [hashMatch, ...matches.filter((commit) => commit.hash !== hashMatch.hash)].slice(
              0,
              Math.max(1, Math.min(limit, 200))
            )
          }
        }
        return matches
      })
    })
  }

  private async commitForHash(git: SimpleGit, query: string): Promise<GitCommitInfo | null> {
    try {
      const output = await git.show([
        '--no-patch',
        '--format=%H%x00%P%x00%aI%x00%aN%x00%D%x00%s%x00%b',
        `${query}^{commit}`
      ])
      const [hash, parents, date, author, refs, message, body] = output.trim().split('\0')
      if (!hash || !date || !message) return null
      return {
        hash,
        shortHash: hash.slice(0, 7),
        author: author || 'unknown',
        date: new Date(date).getTime(),
        message,
        body: body ?? '',
        parents: parseCommitParents(parents ?? ''),
        refs: parseCommitRefs(refs ?? '')
      }
    } catch {
      return null
    }
  }

  async commitDiff(projectPath: string, hash: string): Promise<GitFileChange[]> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      return this.wrapError(projectPath, 'read', async () =>
        diffVsParent(this.client(directory), hash)
      )
    })
  }

  /** Full per-file diff of one file within a commit, compared against its parent. */
  async commitFileDiff(projectPath: string, hash: string, relativePath: string): Promise<GitDiff> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      return this.wrapError(projectPath, 'read', async () =>
        fileDiffVsParent(this.client(directory), directory, hash, relativePath)
      )
    })
  }

  /** Files changed by a stash (e.g. `stash@{0}`), compared against its parent. */
  async stashDiff(projectPath: string, id: string): Promise<GitFileChange[]> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      return this.wrapError(projectPath, 'read', async () =>
        diffVsParent(this.client(directory), id)
      )
    })
  }

  /** Full per-file diff of one file within a stash, compared against its parent. */
  async stashFileDiff(projectPath: string, id: string, relativePath: string): Promise<GitDiff> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      return this.wrapError(projectPath, 'read', async () =>
        fileDiffVsParent(this.client(directory), directory, id, relativePath)
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

  /**
   * Take the given paths' changes out of one commit. The commit is rewritten so
   * it holds each path at its parent's version, every commit after it is
   * replayed with new hashes, and the working tree is left exactly as it was,
   * so a file that is still on disk keeps its content and its change shows up
   * as an ordinary unstaged one (untracked when the commit had added the file).
   */
  async removeCommitChanges(
    projectPath: string,
    hash: string,
    paths: string[]
  ): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      const safeHash = assertTreeIsh(hash)
      const safePaths = paths.map((path) => this.assertRelativePath(directory, path))
      await this.wrapError(projectPath, 'mutation', async () => {
        await removeCommitPathChanges({ directory, target: safeHash, paths: safePaths })
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

  /** Non-queued identity read   only safe inside a queued task. */
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

  /** `git remote set-url <name> <url>`   update an existing remote's URL. */
  async setRemoteUrl(projectPath: string, name: string, url: string): Promise<GitRemoteInfo[]> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      await this.wrapError(projectPath, 'mutation', async () => {
        await this.client(directory).remote(['set-url', name, url])
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

  /**
   * Refresh every remote-tracking ref. Runs on the remote lane, so it is queued
   * behind other remote round trips and behind nothing else: the status read at
   * the end of this task is the only local git it does, and that read never
   * takes a lock.
   */
  async fetch(projectPath: string): Promise<GitStatus> {
    return this.enqueueRemote(projectPath, async () => {
      const directory = await this.repo(projectPath)
      await this.wrapError(projectPath, 'mutation', async () => {
        // Prune so remote-tracking refs for branches deleted on the server
        // disappear here too. A plain fetch only ever adds refs, which left
        // deleted branches listed under Remote forever.
        await this.client(directory).fetch(['--prune'])
      })
      return this.readStatus(directory)
    })
  }

  /** Updates just one branch's remote-tracking ref   doesn't touch the working tree. */
  async fetchBranch(projectPath: string, remote: string, branch: string): Promise<GitStatus> {
    return this.enqueueRemote(projectPath, async () => {
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
      // A pull fetches before it integrates, so it takes the remote lane for the
      // round trip rather than running beside a fetch that is moving the same
      // remote-tracking refs.
      await this.enqueueRemote(projectPath, () =>
        this.wrapError(projectPath, 'mutation', async () => {
          await this.client(directory).pull()
        })
      )
      return this.readStatus(directory)
    })
  }

  /**
   * Pull a specific remote branch with an explicit reconciliation strategy and
   * return the refreshed status even when the integration stops on conflicts.
   *
   * The push-recovery flow needs to distinguish "pulled cleanly, safe to push"
   * from "stopped on conflicts, hand over to the conflict UI". A conflicted
   * pull is not an error   it returns the conflicted status so the renderer
   * can show the merge/rebase conflict banner and never auto-push a half-merged
   * tree. Only genuine failures (network, auth, no upstream) throw.
   */
  async pullIntegrate(
    projectPath: string,
    options: {
      remote?: string
      branch?: string
      strategy: GitPullStrategy
      token?: string
    }
  ): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      const args: string[] = []
      if (options.strategy === 'rebase') args.push('--rebase')
      else if (options.strategy === 'ff-only') args.push('--ff-only')
      else args.push('--no-rebase')
      if (options.remote) args.push(options.remote)
      if (options.branch) args.push(options.branch)
      const git = options.token
        ? this.withAuthHeader(directory, options.token)
        : this.client(directory)
      try {
        // The round trip is the only part that talks to the remote, so it takes
        // the remote lane; the conflicted-status read and the error mapping in
        // the catch below are local and stay on this lane.
        await this.enqueueRemote(projectPath, () => git.pull(args))
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
      // Push decides from the remote-tracking refs whether it is a fast-forward
      // and whether there is anything to send at all, so it takes the remote
      // lane: a fetch in flight finishes first, and one asked for now waits for
      // this push. This is the one local operation the panel blocks on a fetch.
      await this.enqueueRemote(projectPath, () =>
        this.wrapError(projectPath, 'mutation', async () => {
          const args: string[] = []
          if (options.setUpstream) args.push('--set-upstream')
          if (options.remote) args.push(options.remote)
          if (options.branch) args.push(options.branch)
          const git = options.token
            ? this.withAuthHeader(directory, options.token)
            : this.client(directory)
          await git.push(args)
        })
      )
      return this.readStatus(directory)
    })
  }

  /**
   * Sync this checkout with another end, in either direction. The other end is a
   * peer: another checkout (the project root, or a managed worktree) or a named
   * local branch. "Sync with main" is the peer that is the project root, so both
   * of those flows share this one implementation instead of drifting apart.
   *
   * `from` reads the peer and writes this checkout: the peer branch's
   * remote-tracking ref is refreshed first, then integrated. The remote-tracking
   * ref is preferred only when it strictly contains the local branch - i.e. the
   * other checkout has not pulled yet. Otherwise the local branch wins, so
   * commits that exist only in the other checkout are never silently skipped. A
   * failed remote refresh is reported through `fetched: false`, never treated as
   * fatal: the local branch is still the repository's authoritative state when
   * the network is unavailable.
   *
   * `to` reads this checkout and writes the peer: this branch's commits are
   * folded into the branch the peer has checked out. It needs a real checkout to
   * receive them, and nothing is ever pushed - publishing stays an explicit user
   * action.
   *
   * Both directions fail closed instead of guessing: a peer that is this very
   * checkout, a detached HEAD, or an integration already in progress all throw
   * before a single ref moves. A conflicted integration is not an error - the
   * refreshed status is returned so the renderer hands over to the conflict UI.
   *
   * The whole operation holds this checkout's queue, and both ends are mutated
   * under it; two cross-syncs in opposite directions would still serialise, which
   * is why a nested acquisition of the peer's queue is deliberately not taken.
   */
  async syncWith(
    projectPath: string,
    options: {
      direction: GitSyncDirection
      /** The other end of the sync, already resolved by the caller. */
      peer: GitSyncPeerTarget
      strategy: GitPullStrategy
      remote?: string
      token?: string
    }
  ): Promise<GitSyncResult> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      const peerDirectory = options.peer.path ? await this.repo(options.peer.path) : null
      const toward = options.direction === 'from' ? 'from' : 'to'
      if (peerDirectory === directory) {
        throw new GitRefusal(
          options.direction === 'from'
            ? `This checkout is ${options.peer.label}, so there is nothing to sync from`
            : `This checkout is ${options.peer.label}, so it cannot be synced to itself`
        )
      }

      const before = await this.readStatus(directory)
      // The in-progress integration is reported first because a rebase leaves
      // HEAD detached: checking the branch first answers a user who is sitting
      // on a conflict in a branch they do have with "check out a branch", which
      // is the dead end, and the branch name is recoverable from the rebase's
      // own state. A merge keeps HEAD on the branch, so for it the two checks
      // agree either way.
      if (before.conflictState !== 'none') {
        throw new GitRefusal(
          `Finish or abort the in-progress ${before.conflictState} before syncing ${toward} ${options.peer.label}`
        )
      }
      if (before.detached || !before.branch) {
        throw new GitRefusal(
          `Check out a branch in this worktree before syncing ${toward} ${options.peer.label}`
        )
      }
      const branch = before.branch

      if (options.direction === 'to') {
        if (!peerDirectory) {
          throw new GitRefusal(
            `${options.peer.label} is not a checkout, so it cannot receive commits. Pick a worktree or the project root to sync to`
          )
        }
        return await this.foldIntoPeer(directory, peerDirectory, before, branch, options)
      }

      const sourceBranch = peerDirectory
        ? await this.branchOfCheckout(peerDirectory, options.peer.label)
        : options.peer.branch
      if (!sourceBranch) {
        throw new GitRefusal(`${options.peer.label} has no branch to sync from`)
      }
      if (!peerDirectory) {
        const exists = await this.wrapError(projectPath, 'read', () =>
          this.refExists(this.client(directory), `refs/heads/${sourceBranch}`)
        )
        if (!exists) {
          throw new GitRefusal(`The branch ${sourceBranch} does not exist in this repository`)
        }
      }

      const remoteName = options.remote ?? (await this.primaryRemoteName(directory))
      let fetched = false
      if (remoteName) {
        try {
          const git = options.token
            ? this.withAuthHeader(directory, options.token)
            : this.client(directory)
          // Through the remote lane, so this refresh cannot overlap a fetch the
          // panel started. The integration that follows is local and stays on
          // this lane.
          await this.enqueueRemote(projectPath, () =>
            withIndexLockRetry(directory, () => git.fetch(remoteName, sourceBranch))
          )
          fetched = true
        } catch (failure) {
          // Reported as `fetched: false` - the local branch is still synced.
          Logger.dev(
            `Sync ${toward} ${options.peer.label}: refreshing ${remoteName}/${sourceBranch} failed: ${
              failure instanceof Error ? failure.message : String(failure)
            }`
          )
        }
      }

      const localRef = `refs/heads/${sourceBranch}`
      const remoteRef = remoteName ? `refs/remotes/${remoteName}/${sourceBranch}` : null
      const ref = await this.pickSyncSourceRef(directory, projectPath, localRef, remoteRef)
      const incoming = await this.countCommitsAhead(directory, projectPath, ref)
      let probe: GitIntegrationProbe = {
        danglingReferences: [],
        changedDependencyManifests: []
      }
      if (incoming > 0) {
        const uncommitted = uncommittedCount(before)
        // A rebase refuses any tracked change outright, so answer before git
        // does: its own wording ("cannot rebase: You have unstaged changes...")
        // names the mechanism instead of what the user has to do about it.
        if (options.strategy === 'rebase' && uncommitted > 0) {
          throw new GitRefusal(
            `This checkout has ${uncommitted} uncommitted file${uncommitted === 1 ? '' : 's'}. Commit or stash ${uncommitted === 1 ? 'it' : 'them'} before syncing from ${options.peer.label}`
          )
        }
        const beforeSha = await this.headSha(directory)
        let outcome: 'done' | 'conflicted'
        try {
          outcome = await this.integrateFromRef(directory, projectPath, ref, options.strategy)
        } catch (failure) {
          // A merge or fast-forward only refuses for local changes that would
          // be overwritten, and git answers with the same advice in its own
          // words. Report the count the refusal is about in the panel's voice.
          if (uncommitted > 0 && isUncommittedChangesRefusal(failure)) {
            throw new GitRefusal(
              `This checkout has ${uncommitted} uncommitted file${uncommitted === 1 ? '' : 's'} that would be overwritten. Commit or stash ${uncommitted === 1 ? 'it' : 'them'} before syncing from ${options.peer.label}`
            )
          }
          throw failure
        }
        // A conflicted integration is reconciled by hand first, and probing a
        // half-applied tree would describe the mess rather than the result.
        if (outcome === 'done') {
          probe = await this.probeIntegration(directory, projectPath, beforeSha)
        }
      }

      return {
        status: await this.readStatus(directory),
        direction: 'from',
        branch,
        peerBranch: sourceBranch,
        peerLabel: options.peer.label,
        ref: ref === remoteRef && remoteName ? `${remoteName}/${sourceBranch}` : sourceBranch,
        fetched,
        remote: remoteName ?? null,
        incoming,
        peerAhead: 0,
        danglingReferences: probe.danglingReferences,
        changedDependencyManifests: probe.changedDependencyManifests
      }
    })
  }

  /** The branch a peer checkout has checked out, refusing a detached HEAD. */
  private async branchOfCheckout(directory: string, label: string): Promise<string> {
    const resolved = (
      await this.client(directory).raw(['rev-parse', '--abbrev-ref', 'HEAD'])
    ).trim()
    if (!resolved || resolved === 'HEAD') {
      throw new GitRefusal(`${label} is not on a branch, so there is nothing to sync from`)
    }
    return resolved
  }

  /**
   * Fold this worktree's branch into the branch the peer checkout has checked
   * out ("Sync to" the peer).
   *
   * Both checkouts must be committed and idle first: only committed work can
   * move, so uncommitted work would silently stay behind, and a clean target is
   * what makes rolling a refused merge back exact.
   *
   * `rebase` keeps the peer linear without rewriting it: this branch's commits
   * are replayed on top of the peer's branch (a conflict stays here, in the
   * checkout the panel shows, just like `from`), then the peer branch
   * fast-forwards onto the rebased branch. `merge`/`ff-only` integrate directly
   * in the peer, and a merge that conflicts is rolled back before the error
   * surfaces - a one-click action run from a worktree scope must never leave
   * another checkout mid-merge where the user is not looking.
   */
  private async foldIntoPeer(
    directory: string,
    peerDirectory: string,
    before: GitStatus,
    branch: string,
    options: { direction: GitSyncDirection; peer: GitSyncPeerTarget; strategy: GitPullStrategy }
  ): Promise<GitSyncResult> {
    const label = options.peer.label
    const dirty = uncommittedCount(before)
    if (dirty > 0) {
      throw new GitRefusal(
        `This checkout has ${dirty} uncommitted file${dirty === 1 ? '' : 's'}. Commit or stash ${dirty === 1 ? 'it' : 'them'} before syncing to ${label}`
      )
    }

    const peerStatus = await this.readStatus(peerDirectory)
    // Same order as the worktree's own check: a rebase in the peer also detaches
    // its HEAD, and "not on a branch" is not what the user needs to hear while
    // its rebase is sitting half-finished.
    if (peerStatus.conflictState !== 'none') {
      throw new GitRefusal(
        `Finish or abort the in-progress ${peerStatus.conflictState} in ${label} before syncing to it`
      )
    }
    if (peerStatus.detached || !peerStatus.branch) {
      throw new GitRefusal(`${label} is not on a branch, so there is nothing to sync to`)
    }
    const peerBranch = peerStatus.branch
    const peerDirty = uncommittedCount(peerStatus)
    if (peerDirty > 0) {
      throw new GitRefusal(
        `${label} has ${peerDirty} uncommitted file${peerDirty === 1 ? '' : 's'}. Commit or stash ${peerDirty === 1 ? 'it' : 'them'} there before syncing to it`
      )
    }

    const incoming = await this.countCommitsAhead(
      peerDirectory,
      options.peer.path ?? peerDirectory,
      branch
    )
    // The commits land in the peer, so the peer is the checkout to probe.
    const peerBeforeSha = await this.headSha(peerDirectory)
    let conflicted = false
    if (incoming > 0) {
      if (options.strategy === 'rebase') {
        const outcome = await this.integrateFromRef(
          directory,
          options.peer.path ?? directory,
          `refs/heads/${peerBranch}`,
          'rebase'
        )
        conflicted = outcome === 'conflicted'
        if (!conflicted) {
          await this.foldIntoPeerBranch(peerDirectory, branch, peerBranch, label, 'ff-only')
        }
      } else {
        await this.foldIntoPeerBranch(peerDirectory, branch, peerBranch, label, options.strategy)
      }
    }

    const probe: GitIntegrationProbe =
      incoming > 0 && !conflicted
        ? await this.probeIntegration(
            peerDirectory,
            options.peer.path ?? peerDirectory,
            peerBeforeSha
          )
        : { danglingReferences: [], changedDependencyManifests: [] }
    return {
      status: await this.readStatus(directory),
      direction: 'to',
      branch,
      peerBranch,
      peerLabel: label,
      ref: branch,
      fetched: false,
      remote: null,
      incoming,
      peerAhead:
        incoming > 0 && !conflicted
          ? (await this.readStatus(peerDirectory)).ahead
          : peerStatus.ahead,
      danglingReferences: probe.danglingReferences,
      changedDependencyManifests: probe.changedDependencyManifests
    }
  }

  /**
   * Integrate `branch` into the branch checked out in the peer checkout. The
   * caller guarantees a clean, idle target, so a conflicted merge can be rolled
   * back exactly instead of stranding the peer mid-merge.
   */
  private async foldIntoPeerBranch(
    peerDirectory: string,
    branch: string,
    peerBranch: string,
    label: string,
    strategy: 'merge' | 'ff-only'
  ): Promise<void> {
    const git = this.client(peerDirectory)
    const args = strategy === 'ff-only' ? ['--no-edit', '--ff-only', branch] : ['--no-edit', branch]
    const failure = await git.merge(args).then(
      () => null,
      (error: unknown) => error
    )
    if (!failure) return

    const conflicted = await git.status().then(
      (status) => status.conflicted.length > 0,
      () => false
    )
    if (conflicted) {
      const rolledBack = await git.raw(['merge', '--abort']).then(
        () => true,
        () => false
      )
      throw new GitRefusal(
        rolledBack
          ? `Merging ${branch} into ${peerBranch} would conflict. Sync from ${label} in this worktree, resolve the conflicts here, then sync to it again`
          : `Merging ${branch} into ${peerBranch} conflicted and could not be rolled back. Resolve it in ${label} first`
      )
    }
    if (strategy === 'ff-only') {
      throw new GitRefusal(
        `${peerBranch} has diverged from ${branch}, so it cannot fast-forward. Merge instead`
      )
    }
    await this.wrapError(peerDirectory, 'mutation', async () => {
      throw failure
    })
  }

  /** `origin` when present, else the repository's first configured remote. */
  private async primaryRemoteName(directory: string): Promise<string | null> {
    const remotes = await this.readRemotes(directory).catch(() => [] as GitRemoteInfo[])
    return remotes.find((remote) => remote.name === 'origin')?.name ?? remotes[0]?.name ?? null
  }

  /**
   * The exact ref to integrate: the remote-tracking ref when it strictly
   * contains the local branch, else the local branch itself.
   */
  private async pickSyncSourceRef(
    directory: string,
    projectPath: string,
    localRef: string,
    remoteRef: string | null
  ): Promise<string> {
    if (!remoteRef) return localRef
    const git = this.client(directory)
    return this.wrapError(projectPath, 'read', async () => {
      if (!(await this.refExists(git, remoteRef))) return localRef
      if (!(await this.refExists(git, localRef))) return remoteRef
      return (await isAncestor(git, localRef, remoteRef)) ? remoteRef : localRef
    })
  }

  /** Commits reachable from `ref` that this checkout does not have yet. */
  private async countCommitsAhead(
    directory: string,
    projectPath: string,
    ref: string
  ): Promise<number> {
    return this.wrapError(projectPath, 'read', async () => {
      const output = await this.client(directory).raw(['rev-list', '--count', `HEAD..${ref}`])
      const parsed = Number.parseInt(output.trim(), 10)
      return Number.isInteger(parsed) && parsed > 0 ? parsed : 0
    })
  }

  /** The commit a checkout is on, or null when it has no commit to read. */
  private async headSha(directory: string): Promise<string | null> {
    return await this.client(directory)
      .raw(['rev-parse', 'HEAD'])
      .then((sha) => sha.trim() || null)
      .catch(() => null)
  }

  /**
   * Ask what an integration just did to `directory`, beyond whether git was
   * happy with it: does anything still import a module it removed, and did it
   * rewrite a dependency manifest without installing anything?
   *
   * Read-only and best-effort. A probe that fails must never turn a completed
   * sync into an error, so it degrades to an empty result and says why in the
   * dev log.
   */
  private async probeIntegration(
    directory: string,
    projectPath: string,
    beforeSha: string | null
  ): Promise<GitIntegrationProbe> {
    const nothing: GitIntegrationProbe = {
      danglingReferences: [],
      changedDependencyManifests: []
    }
    if (!beforeSha) return nothing
    try {
      // The probe reads every tracked source file of the checkout, so its module
      // is imported only once an integration actually removed something, instead
      // of sitting in the always-loaded feature-IPC graph. That also keeps the
      // feature-IPC graph emit-able: with this probe inside it, Vite 8's
      // rolldown rendered the whole graph as an empty chunk (see
      // refuseEmptyChunks in electron.vite.config.ts).
      const { changedDependencyManifests, findDanglingReferences, integrationChanges } =
        await import('./git/git-service-references')
      const git = this.client(directory)
      const changes = await integrationChanges(git, beforeSha, await this.headSha(directory))
      return {
        danglingReferences:
          changes.deleted.length === 0
            ? []
            : await findDanglingReferences(directory, changes.deleted, git),
        changedDependencyManifests: changedDependencyManifests(changes)
      }
    } catch (failure) {
      Logger.dev(
        `Post-integration probe for ${projectPath} failed: ${
          failure instanceof Error ? failure.message : String(failure)
        }`
      )
      return nothing
    }
  }

  /**
   * Integrate `ref` with the requested strategy. A conflicted merge/rebase is
   * left in the working tree for the conflict UI (never aborted) and reported
   * as `conflicted`; a diverged fast-forward fails with an actionable message
   * instead of raw git output.
   */
  private async integrateFromRef(
    directory: string,
    projectPath: string,
    ref: string,
    strategy: GitPullStrategy
  ): Promise<'done' | 'conflicted'> {
    const git = this.client(directory)
    const conflicted = async (): Promise<boolean> =>
      await git
        .status()
        .then((status) => status.conflicted.length > 0)
        .catch(() => false)

    if (strategy === 'rebase') {
      const failure = await git.rebase([ref]).then(
        () => null,
        (error: unknown) => error
      )
      if (!failure) return 'done'
      if (await conflicted()) return 'conflicted'
      return await this.failIntegration(projectPath, failure)
    }

    const args = strategy === 'ff-only' ? ['--no-edit', '--ff-only', ref] : ['--no-edit', ref]
    const failure = await git.merge(args).then(
      () => null,
      (error: unknown) => error
    )
    if (!failure) return 'done'
    if (await conflicted()) return 'conflicted'
    if (strategy === 'ff-only') {
      throw new GitRefusal(
        `This branch has diverged from ${ref}, so it cannot fast-forward. Merge or rebase instead`
      )
    }
    return await this.failIntegration(projectPath, failure)
  }

  /** Re-report a failed integration through the standard error path. */
  private async failIntegration(label: string, failure: unknown): Promise<never> {
    return this.wrapError(label, 'mutation', async (): Promise<never> => {
      throw failure
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
      return this.wrapError(projectPath, 'read', async () =>
        comparePullRequestRefs(this.client(directory), base, head)
      )
    })
  }

  /**
   * Build bounded, read-only evidence for a PR writing task. This never fetches,
   * checks out, stages, or otherwise changes repository state. Remote composition
   * uses cached origin refs. Local composition adds the commits and worktree delta
   * that the next push will publish.
   */
  async pullRequestComposeContext(
    projectPath: string,
    input: PrComposeInput
  ): Promise<PullRequestComposeContext> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      return this.wrapError(projectPath, 'read', async () =>
        buildPullRequestComposeContext(this.client(directory), directory, input)
      )
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
        return mapMergeResult(result)
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
          return mapMergeResult({
            conflicts: status.conflicted.map((path) => ({ file: path })),
            result: 'Rebase stopped due to conflicts.'
          })
        }
        return emptyMergeResult('Rebase completed.')
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
   * Move a stopped rebase along: `continue` applies the commit git stopped on
   * and replays the rest, `skip` drops that commit and replays the rest. Either
   * can stop again on the next commit's conflict, which is not an error   the
   * refreshed status carries the new conflict state for the panel to show.
   *
   * git exits non-zero with the conflict in its output when it stops again, so
   * that failure is caught here instead of reported: a stop that left conflicted
   * files is the same state the first stop was, and the panel renders it from
   * the refreshed status. Only a failure that left no conflict to resolve is
   * reported, and then as the step the user owes, because git's own output for a
   * rebase is a summary of every commit it replayed followed by three hints.
   *
   * Unresolved conflicts are refused here rather than left to git: `rebase
   * --continue` reports them on stdout with an empty stderr, and simple-git only
   * raises a task error when stderr has something in it, so git's refusal would
   * arrive as a resolved promise and the button would look like it did nothing.
   * The refusal also names the step the user owes, which git's own three lines
   * only imply.
   *
   * Both run through `clientWithoutEditor`: `--continue` finishes a conflicted
   * commit by committing it, and committing runs the configured editor   see that
   * helper for what git does without one.
   */
  async rebaseAction(projectPath: string, action: GitRebaseAction): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      const before = await this.readStatus(directory)
      const unresolved = before.conflicted.length
      if (action === 'continue' && unresolved > 0) {
        throw new GitRefusal(
          `Resolve and stage ${unresolved === 1 ? 'the remaining conflicted file' : `the ${String(unresolved)} remaining conflicted files`}, then continue the rebase`
        )
      }
      const verb = action === 'continue' ? 'continue' : 'skip'
      let failure: unknown = null
      try {
        await this.wrapError(projectPath, 'mutation', async () => {
          await this.clientWithoutEditor(directory).raw([
            'rebase',
            action === 'continue' ? '--continue' : '--skip'
          ])
        })
      } catch (error) {
        failure = error
      }
      // Read the state back either way: it is what says whether the action moved
      // the rebase on, stopped it again, or left nothing to continue.
      const status = await this.readStatus(directory)
      if (failure === null) return status
      if (status.conflictState === 'rebase' && status.conflicted.length > 0) return status
      Logger.error(`Rebase ${verb} for ${projectPath} failed: ${rebaseFailureDetail(failure)}`)
      throw new GitRefusal(
        status.conflictState === 'rebase'
          ? `Git could not ${verb} the rebase. Resolve and stage what it is holding, skip this commit, or abort the rebase`
          : `Git could not ${verb} the rebase, and no rebase is in progress any more`
      )
    })
  }

  /**
   * Prepare to resolve a PR's online merge conflicts locally: check out the PR
   * head as a local branch (`pr-<number>`) and merge the current base into it
   * so the conflicts land in the working tree for the conflict UI to resolve.
   *
   * A conflicted merge is a normal, expected state   not an error   so the
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
      // The whole sequence is one remote-owned transaction: a `fetch --prune`
      // landing between the head fetch and the base fetch could drop the
      // remote-tracking ref the merge is about to integrate.
      await this.enqueueRemote(projectPath, () =>
        this.wrapError(projectPath, 'mutation', async () => {
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
      )
      return this.readStatus(directory)
    })
  }

  /**
   * Finish a PR conflict resolution in one shot: push the resolved merge commit
   * from the temporary `pr-<n>` branch back to the PR's head branch (which
   * updates the PR), check the user's original branch back out, and delete the
   * now-useless temporary branch. The temporary branch exists only to stage
   * the conflict resolution, so nothing is left for the user to do by hand.
   *
   * The push resolves credentials the same way `push` does: the caller passes
   * the vaulted PAT, so finishing works on a repository whose remote the panel
   * authenticates for rather than depending on ambient git credentials.
   */
  async finishPrResolve(
    projectPath: string,
    options: {
      remote: string
      pullNumber: number
      headBranch: string
      returnBranch: string
      token?: string
    }
  ): Promise<GitStatus> {
    return this.enqueue(projectPath, async () => {
      const directory = await this.repo(projectPath)
      const localBranch = `pr-${options.pullNumber}`
      // The push publishes to the PR's head branch, so it takes the remote lane;
      // checking the original branch back out and dropping the temporary one are
      // local writes and stay on this lane.
      await this.enqueueRemote(projectPath, () =>
        this.wrapError(projectPath, 'mutation', async () => {
          const pushClient = options.token
            ? this.withAuthHeader(directory, options.token)
            : this.client(directory)
          await pushClient.push([options.remote, `${localBranch}:${options.headBranch}`])
        })
      )
      await this.wrapError(projectPath, 'mutation', async () => {
        const git = this.client(directory)
        await git.checkout(options.returnBranch)
        await git.deleteLocalBranch(localBranch, true)
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
          // No .gitignore yet   a new one is created below.
        }
        const lines = existing ? existing.replace(/\r\n/gu, '\n').split('\n') : []
        const patterns: string[] = []
        for (const path of safePaths) {
          const pathIsDirectory = await isDirectory(directory, path)
          const pattern = pathIsDirectory ? `${path}/` : path
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
          await removePath(absolute)
        }
      })
      return this.readStatus(directory)
    })
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

  // ─── Private helpers ─────────────────────────────────────────────────────

  /** Resolve a project-relative path and forbid escaping the repository root. */
  private assertRelativePath(directory: string, path: string): string {
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
  private async refExists(git: SimpleGit, rev: string): Promise<boolean> {
    return gitRefExists(git, rev)
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
    return readGitBlob(git, ref)
  }

  /**
   * Read a working-tree file bounded to `maximumBytes`, detecting binary
   * content via NUL bytes (mirrors the old untracked-diff probe). The diff
   * bound is the default; the conflict path passes the configured cap.
   */
  private async workingFileContent(
    directory: string,
    path: string,
    maximumBytes?: number
  ): Promise<{ content: string; truncated: boolean; binary: boolean } | null> {
    return readWorkingFileContent(directory, path, maximumBytes)
  }

  /**
   * The configured byte cap on a conflicted file, resolved per call so a
   * settings change applies without a restart. A missing or nonsensical
   * provider value falls back to the shipped default rather than refusing every
   * conflict the app can still handle.
   */
  private async conflictFileBytes(): Promise<number> {
    const limit = await this.conflictFileLimit().catch(() => DEFAULT_MAX_CONFLICT_FILE_BYTES)
    return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_MAX_CONFLICT_FILE_BYTES
  }
}
