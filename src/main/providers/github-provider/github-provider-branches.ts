import type { BranchDeletionOutcome, BranchDeletionState } from '../../../lib/types'
import type { BranchTarget } from '../../git/git-provider.interface'
import { ProviderHttpError, branchPath, isMissingRefRefusal } from '../github-provider'
import type { GitHubProvider } from '../github-provider'

/**  branches */
export class GitHubProviderBranches {
  constructor(private readonly host: GitHubProvider) {}

  /**
   * What a branch is as far as deleting it goes.
   *
   * The branch endpoint reports protection beside the commit it points at, and a
   * branch GitHub cannot find comes back 404. The three answers are kept apart
   * rather than collapsed into "may delete": a missing branch reading as
   * deletable is exactly the race that offers an action which cannot land.
   */
  async readBranchDeletionState(input: BranchTarget): Promise<BranchDeletionState> {
    try {
      const response = await this.host.request(
        `${this.host.repoPath(input)}/branches/${branchPath(input)}`,
        {
          method: 'GET'
        }
      )
      const record = Array.isArray(response) ? {} : response
      return record['protected'] === true ? 'protected' : 'deletable'
    } catch (failure) {
      if (failure instanceof ProviderHttpError && failure.status === 404) return 'missing'
      throw failure
    }
  }

  /**
   * Delete a branch from the repository.
   *
   * A branch that is already gone reports `missing`: GitHub answers a delete for
   * an absent ref with a 422 "Reference does not exist", and that is the outcome
   * the caller asked for, not a failure to report. A protected branch answers
   * with a different 422, which stays an error, so the refusal is never mistaken
   * for success.
   */

  /**
   * Delete a branch from the repository.
   *
   * A branch that is already gone reports `missing`: GitHub answers a delete for
   * an absent ref with a 422 "Reference does not exist", and that is the outcome
   * the caller asked for, not a failure to report. A protected branch answers
   * with a different 422, which stays an error, so the refusal is never mistaken
   * for success.
   */
  async deleteBranch(input: BranchTarget): Promise<BranchDeletionOutcome> {
    try {
      await this.host.request(`${this.host.repoPath(input)}/git/refs/heads/${branchPath(input)}`, {
        method: 'DELETE'
      })
      return 'deleted'
    } catch (failure) {
      if (failure instanceof ProviderHttpError && isMissingRefRefusal(failure)) return 'missing'
      throw failure
    }
  }

  /** Update an open pull request's title and/or description, mirroring GitHub's edit. */
}
