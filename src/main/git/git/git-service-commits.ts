import type { LogOptions, SimpleGit } from 'simple-git'
import type {
  GitCommitInfo,
  GitDiff,
  GitFileChange,
  GitResetMode,
  GitStatus
} from '../../../lib/types'
import { Logger } from '../../system/logger'
import { GitRefusal, isUncommittedChangesRefusal } from '../git-refusal'
import { removeCommitPathChanges } from './git-service-commit-rewrite'
import type { GitServiceCore } from './git-service-core'
import { assertTreeIsh, diffVsParent, fileDiffVsParent } from './git-service-diffs'
import { rebaseFailureDetail } from './git-service-rebase-failure'
import type { HistoryLogFields } from './git-service-status'
import {
  DEFAULT_LOG_LIMIT,
  isUnbornBranchLogError,
  mapCommit,
  parseCommitParents,
  parseCommitRefs
} from './git-service-status'

/**
 * History: reading it, and rewriting it.
 *
 * Everything that changes an existing commit lives here   `amend`, dropping
 * paths out of a commit, reset, and deleting a commit outright   because each of
 * them replays history and each of them has to say what happened when git stops
 * halfway.
 */
export class GitServiceCommits {
  constructor(private readonly core: GitServiceCore) {}

  async commit(projectPath: string, message: string): Promise<GitStatus> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      await this.core.wrapError(projectPath, 'mutation', async () => {
        const cleanMessage = message.replace(/\r\n/gu, '\n')
        await this.core.client(directory).commit(cleanMessage)
      })
      return this.core.readStatus(directory)
    })
  }

  /** `offset` skips the N newest commits   pages in older history for infinite scroll. */
  async log(
    projectPath: string,
    limit = DEFAULT_LOG_LIMIT,
    offset = 0,
    query?: string
  ): Promise<GitCommitInfo[]> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      return this.core.wrapError(projectPath, 'read', async () => {
        const git = this.core.client(directory)
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
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      return this.core.wrapError(projectPath, 'read', async () =>
        diffVsParent(this.core.client(directory), hash)
      )
    })
  }

  /** Full per-file diff of one file within a commit, compared against its parent. */
  async commitFileDiff(projectPath: string, hash: string, relativePath: string): Promise<GitDiff> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      return this.core.wrapError(projectPath, 'read', async () =>
        fileDiffVsParent(this.core.client(directory), directory, hash, relativePath)
      )
    })
  }

  /** Files changed by a stash (e.g. `stash@{0}`), compared against its parent. */
  async stashDiff(projectPath: string, id: string): Promise<GitFileChange[]> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      return this.core.wrapError(projectPath, 'read', async () =>
        diffVsParent(this.core.client(directory), id)
      )
    })
  }

  /** Full per-file diff of one file within a stash, compared against its parent. */
  async stashFileDiff(projectPath: string, id: string, relativePath: string): Promise<GitDiff> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      return this.core.wrapError(projectPath, 'read', async () =>
        fileDiffVsParent(this.core.client(directory), directory, id, relativePath)
      )
    })
  }

  /** Amend the most recent commit, folding staged changes into the new commit. */
  async amend(projectPath: string, message: string): Promise<GitStatus> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      await this.core.wrapError(projectPath, 'mutation', async () => {
        const cleanMessage = message.replace(/\r\n/gu, '\n')
        await this.core.client(directory).raw(['commit', '--amend', '-m', cleanMessage])
      })
      return this.core.readStatus(directory)
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
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      const safeHash = assertTreeIsh(hash)
      const safePaths = paths.map((path) => this.core.assertRelativePath(directory, path))
      await this.core.wrapError(projectPath, 'mutation', async () => {
        await removeCommitPathChanges({ directory, target: safeHash, paths: safePaths })
      })
      return this.core.readStatus(directory)
    })
  }

  /** Reset the current branch to a target commit (defaults to HEAD). */
  async reset(projectPath: string, mode: GitResetMode, target?: string): Promise<GitStatus> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      await this.core.wrapError(projectPath, 'mutation', async () => {
        const args = ['reset', `--${mode}`]
        if (target) args.push(target)
        await this.core.client(directory).raw(args)
      })
      return this.core.readStatus(directory)
    })
  }

  /**
   * Delete a commit by dropping it from history (interactive-rebase semantics).
   * `git rebase --onto <target>^ <target>` replays every commit after `target`
   * onto its parent, skipping `target` itself. Only safe for unpushed commits;
   * pushed commits need a force-push afterwards.
   *
   * A replay that conflicts stops the rebase, and that stop is where the drop is
   * finished from: the conflicts land in this checkout, the panel's Rebase in
   * progress notice offers Continue, Skip and Abort, and continuing the rebase
   * completes the drop. It is reported as the step the user owes rather than as
   * git's own output, which is a summary of every commit it replayed plus three
   * hints, and a refusal that never started the rebase says so instead of leaving
   * the panel to guess.
   */
  async deleteCommit(projectPath: string, target: string): Promise<GitStatus> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      const short = target.slice(0, 7)
      let failure: unknown = null
      try {
        await this.core.wrapError(projectPath, 'mutation', async () => {
          await this.core.client(directory).raw(['rebase', '--onto', `${target}^`, target])
        })
      } catch (error) {
        failure = error
      }
      const status = await this.core.readStatus(directory)
      if (failure === null) return status
      Logger.error(`Deleting ${short} for ${projectPath} failed: ${rebaseFailureDetail(failure)}`)
      if (status.conflictState === 'rebase') {
        throw new GitRefusal(
          `Deleting ${short} stopped on a conflict in the commits after it. Resolve and continue the rebase to finish the drop, or abort the rebase to keep the commit`
        )
      }
      throw new GitRefusal(
        isUncommittedChangesRefusal(failure)
          ? `Deleting ${short} needs a clean working tree. Commit or stash the uncommitted changes, then try again`
          : `Deleting ${short} could not start, so nothing was changed`
      )
    })
  }
}
