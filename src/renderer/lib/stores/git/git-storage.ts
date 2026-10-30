import type { IssueReference } from '$shared/types'
import type { GitState } from '../git.svelte'

/** GitState storage: one concern, moved verbatim from the composition root. */
export class GitStateStorage {
  constructor(private readonly host: GitState) {}

  clearProjectState(): void {
    this.host.status = null
    this.host.branches = []
    this.host.remotes = []
    this.host.identity = null
    this.host.credentialStatus = null
    this.host.stashes = []
    this.host.error = null
    this.host.githubPermission = null
    this.host.conflictsMode = false
    this.host.statusReadAt = 0
    this.host.cachedStatus = false
    this.host.statusError = null
  }

  /** What a merged pull request's head branch is as far as deleting it goes. */
  branchDeletionState(projectId: string, owner: string, repo: string, branch: string) {
    return this.host.prOps.branchDeletionState(projectId, owner, repo, branch)
  }

  setIssueState(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    state: 'open' | 'closed',
    stateReason?: 'completed' | 'not_planned'
  ): Promise<IssueReference | null> {
    return this.host.issueOps.setIssueState(projectId, owner, repo, issueNumber, state, stateReason)
  }
}
