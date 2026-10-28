import { readFile, writeFile } from 'fs/promises'
import { resolve } from 'path'
import type { GitDiff, GitRestoreTarget, GitStatus } from '../../../lib/types'
import type { GitServiceCore } from './git-service-core'
import {
  MAX_DIFF_BYTES,
  assertTreeIsh,
  isDirectory,
  isUntracked,
  pathExists,
  removePath,
  untrackedDiff
} from './git-service-diffs'

/**
 * The working tree: per-file diffs for the panel viewer, staging and unstaging,
 * pulling paths back out of history, and the two destructive change actions
 * (`ignore`, `discard`).
 *
 * A plain status read lives in `GitServiceCore` because every other concern here
 * returns one.
 */
export class GitServiceChanges {
  constructor(private readonly core: GitServiceCore) {}

  async getDiff(projectPath: string, relativePath: string, staged: boolean): Promise<GitDiff> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      return this.core.wrapError(projectPath, 'read', async () => {
        const safePath = this.core.assertRelativePath(directory, relativePath)
        const git = this.core.client(directory)
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
            const head = await this.core.readBlob(git, `HEAD:${safePath}`)
            const index = await this.core.readBlob(git, `:${safePath}`)
            before = head?.content
            after = index?.content
            sideTruncated = (head?.truncated ?? false) || (index?.truncated ?? false)
          } else {
            const index = await this.core.readBlob(git, `:${safePath}`)
            const working = await this.core.workingFileContent(directory, safePath)
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
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      const safePaths = paths.map((path) => this.core.assertRelativePath(directory, path))
      if (safePaths.length > 0) {
        await this.core.wrapError(directory, 'mutation', async () => {
          await this.stagePaths(directory, safePaths)
        })
      }
      return this.core.readStatus(directory)
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
      (await this.core.client(directory).raw(['ls-files', '-z', '--', ...safePaths])).split('\0')
    )
    const stageable = await Promise.all(
      safePaths.map(async (path) => indexEntries.has(path) || (await pathExists(directory, path)))
    )
    const pending = safePaths.filter((_, index) => stageable[index])
    if (pending.length > 0) {
      await this.core.client(directory).add(pending)
    }
  }

  async unstage(projectPath: string, paths: string[]): Promise<GitStatus> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      const safePaths = paths.map((path) => this.core.assertRelativePath(directory, path))
      if (safePaths.length > 0) {
        await this.core.wrapError(directory, 'mutation', async () => {
          await this.core.client(directory).raw(['reset', '--', ...safePaths])
        })
      }
      return this.core.readStatus(directory)
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
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      const safePaths = paths.map((path) => this.core.assertRelativePath(directory, path))
      if (safePaths.length === 0) return this.core.readStatus(directory)
      const safeSource = assertTreeIsh(source)
      const args =
        target === 'staged'
          ? ['restore', '--staged', '--source', safeSource, '--', ...safePaths]
          : ['restore', '--staged', '--worktree', '--source', safeSource, '--', ...safePaths]
      await this.core.wrapError(directory, 'mutation', async () => {
        await this.core.client(directory).raw(args)
      })
      return this.core.readStatus(directory)
    })
  }

  /** Stop tracking paths, preserve them on disk, and add them to `.gitignore`. */
  async ignore(projectPath: string, paths: string[]): Promise<GitStatus> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      await this.core.wrapError(directory, 'mutation', async () => {
        const safePaths = paths.map((path) => this.core.assertRelativePath(directory, path))
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
        await this.core
          .client(directory)
          .raw(['rm', '-r', '--cached', '--force', '--ignore-unmatch', '--', ...safePaths])
      })
      return this.core.readStatus(directory)
    })
  }

  /** Discard working-tree changes for the given paths. Tracked files are
   *  restored from HEAD; untracked files are deleted. */
  async discard(projectPath: string, paths: string[]): Promise<GitStatus> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      await this.core.wrapError(directory, 'mutation', async () => {
        const safePaths = paths.map((path) => this.core.assertRelativePath(directory, path))
        if (safePaths.length === 0) return
        const git = this.core.client(directory)
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
      return this.core.readStatus(directory)
    })
  }
}
