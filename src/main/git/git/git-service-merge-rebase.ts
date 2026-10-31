import type { GitRebaseAction, GitStatus, MergeSummary } from '../../../lib/types'
import { Logger } from '../../system/logger'
import { GitRefusal } from '../git-refusal'
import type { GitServiceCore } from './git-service-core'
import { rebaseFailureDetail } from './git-service-rebase-failure'
import { emptyMergeResult, mapMergeResult } from './git-service-status'

/**
 * Merge and rebase: starting one, aborting one, and moving a stopped rebase
 * along.
 *
 * A stop on a conflict is a state the panel renders, not a failure, so the
 * refreshed status is what these return; only a step that could not happen at
 * all is reported as a refusal.
 */
export class GitServiceMergeRebase {
  constructor(private readonly core: GitServiceCore) {}

  // ─── Merge / rebase / stash (Phase 4) ────────────────────────────────────

  async merge(projectPath: string, target: string): Promise<MergeSummary> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      return this.core.wrapError(projectPath, 'mutation', async () => {
        interface MergeFailure {
          conflicts?: Array<{ file?: string; reason?: string }>
          result?: string
        }
        const result = await this.core
          .client(directory)
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
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      return this.core.wrapError(projectPath, 'mutation', async () => {
        const git = this.core.client(directory)
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
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      await this.core.wrapError(projectPath, 'mutation', async () => {
        await this.core.client(directory).raw(['merge', '--abort'])
      })
      return this.core.readStatus(directory)
    })
  }

  async abortRebase(projectPath: string): Promise<GitStatus> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      await this.core.wrapError(projectPath, 'mutation', async () => {
        await this.core.client(directory).raw(['rebase', '--abort'])
      })
      return this.core.readStatus(directory)
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
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      const before = await this.core.readStatus(directory)
      const unresolved = before.conflicted.length
      if (action === 'continue' && unresolved > 0) {
        throw new GitRefusal(
          `Resolve and stage ${unresolved === 1 ? 'the remaining conflicted file' : `the ${String(unresolved)} remaining conflicted files`}, then continue the rebase`
        )
      }
      const verb = action === 'continue' ? 'continue' : 'skip'
      let failure: unknown = null
      try {
        await this.core.wrapError(projectPath, 'mutation', async () => {
          await this.core
            .clientWithoutEditor(directory)
            .raw(['rebase', action === 'continue' ? '--continue' : '--skip'])
        })
      } catch (error) {
        failure = error
      }
      // Read the state back either way: it is what says whether the action moved
      // the rebase on, stopped it again, or left nothing to continue.
      const status = await this.core.readStatus(directory)
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
}
