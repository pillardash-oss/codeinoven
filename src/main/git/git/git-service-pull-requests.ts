import type { GitStatus, PrComposeInput, PullRequestCompare } from '../../../lib/types'
import type { GitServiceCore } from './git-service-core'
import type { PullRequestComposeContext } from './git-service-pull-request'
import {
  buildPullRequestComposeContext,
  comparePullRequestBranches as comparePullRequestRefs
} from './git-service-pull-request'

/**
 * The pull-request concern: comparing the two branches a PR is opened between,
 * the bounded evidence a PR-writing task reads, and the local round trip that
 * reproduces and then publishes a PR's resolved conflicts.
 */
export class GitServicePullRequests {
  constructor(private readonly core: GitServiceCore) {}

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
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      return this.core.wrapError(projectPath, 'read', async () =>
        comparePullRequestRefs(this.core.client(directory), base, head)
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
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      return this.core.wrapError(projectPath, 'read', async () =>
        buildPullRequestComposeContext(this.core.client(directory), directory, input)
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
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      const git = this.core.client(directory)
      const localBranch = `pr-${options.pullNumber}`
      const baseRef = `${options.remote}/${options.baseBranch}`
      // The whole sequence is one remote-owned transaction: a `fetch --prune`
      // landing between the head fetch and the base fetch could drop the
      // remote-tracking ref the merge is about to integrate.
      await this.core.enqueueRemote(projectPath, () =>
        this.core.wrapError(projectPath, 'mutation', async () => {
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
      return this.core.readStatus(directory)
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
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      const localBranch = `pr-${options.pullNumber}`
      // The push publishes to the PR's head branch, so it takes the remote lane;
      // checking the original branch back out and dropping the temporary one are
      // local writes and stay on this lane.
      await this.core.enqueueRemote(projectPath, () =>
        this.core.wrapError(projectPath, 'mutation', async () => {
          const pushClient = options.token
            ? this.core.withAuthHeader(directory, options.token)
            : this.core.client(directory)
          await pushClient.push([options.remote, `${localBranch}:${options.headBranch}`])
        })
      )
      await this.core.wrapError(projectPath, 'mutation', async () => {
        const git = this.core.client(directory)
        await git.checkout(options.returnBranch)
        await git.deleteLocalBranch(localBranch, true)
      })
      return this.core.readStatus(directory)
    })
  }
}
