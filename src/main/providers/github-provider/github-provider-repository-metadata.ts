import type {
  PullRequestFile,
  PullRequestLabel,
  PullRequestMilestone,
  RepositoryMentionUser
} from '../../../lib/types'
import type { PullRequestTarget } from '../../git/git-provider.interface'
import type { GitHubProvider } from '../github-provider'

/**  repository-metadata */
export class GitHubProviderRepositoryMetadata {
  constructor(private readonly host: GitHubProvider) {}

  /** Files and patches for one commit   powers commit drill-down in the sidebar. */
  async getCommitFiles(
    input: { owner: string; repo: string },
    sha: string
  ): Promise<PullRequestFile[]> {
    const response = await this.host.request(
      `${this.host.repoPath(input)}/commits/${encodeURIComponent(sha)}`,
      {
        method: 'GET'
      }
    )
    const record = Array.isArray(response) ? {} : response
    return this.host.toFiles(record['files'])
  }

  /**
   * Assignable repository accounts, for @-mention autocomplete in PR conversations.
   *
   * `/assignees` is deliberate: `/collaborators` requires push access and 403s for
   * a read-only contributor, while `/assignees` is readable with a read token and
   * is the same list GitHub's own assignee picker uses.
   */

  /**
   * Assignable repository accounts, for @-mention autocomplete in PR conversations.
   *
   * `/assignees` is deliberate: `/collaborators` requires push access and 403s for
   * a read-only contributor, while `/assignees` is readable with a read token and
   * is the same list GitHub's own assignee picker uses.
   */
  async listRepositoryMentionUsers(input: {
    owner: string
    repo: string
  }): Promise<RepositoryMentionUser[]> {
    const response = await this.host.request(
      `${this.host.repoPath(input)}/assignees?per_page=100`,
      {
        method: 'GET'
      }
    )
    const items = Array.isArray(response) ? response : []
    const seen = new Set<string>()
    return items.flatMap((item): RepositoryMentionUser[] => {
      if (typeof item !== 'object' || item === null) return []
      const record = item as Record<string, unknown>
      const login = this.host.readString(record, 'login')?.trim()
      if (!login) return []
      const key = login.toLowerCase()
      if (seen.has(key)) return []
      seen.add(key)
      const name = this.host.readString(record, 'name')?.trim()
      return [
        {
          login,
          name: name ? name : null,
          avatarUrl: this.host.readString(record, 'avatar_url'),
          bot: this.host.readString(record, 'type') === 'Bot' || login.endsWith('[bot]')
        }
      ]
    })
  }

  /** Replace the labels a pull request carries, answering with the labels it now has. */

  /** Replace the labels a pull request carries, answering with the labels it now has. */
  async setPullRequestLabels(
    input: PullRequestTarget & { labels: string[] }
  ): Promise<PullRequestLabel[]> {
    const response = await this.host.request(
      `${this.host.repoPath(input)}/issues/${input.pullNumber}/labels`,
      { method: 'PUT', body: JSON.stringify({ labels: input.labels }) }
    )
    return this.host.toLabels(response)
  }

  /**
   * Replace a pull request's assignees.
   *
   * The issues endpoint rather than the pulls one: assignees are an issue field,
   * and it is also the only shape that answers with the resulting accounts, so the
   * caller never has to reconstruct what the provider decided.
   */

  /**
   * Replace a pull request's assignees.
   *
   * The issues endpoint rather than the pulls one: assignees are an issue field,
   * and it is also the only shape that answers with the resulting accounts, so the
   * caller never has to reconstruct what the provider decided.
   */
  async setPullRequestAssignees(
    input: PullRequestTarget & { logins: string[] }
  ): Promise<RepositoryMentionUser[]> {
    const response = await this.host.request(
      `${this.host.repoPath(input)}/issues/${input.pullNumber}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ assignees: input.logins })
      }
    )
    const record = Array.isArray(response) ? {} : response
    return this.host.toAssignees(record)
  }

  /** Attach or clear a pull request's milestone. An explicit null detaches it. */

  /** Attach or clear a pull request's milestone. An explicit null detaches it. */
  async setPullRequestMilestone(
    input: PullRequestTarget & { milestone: number | null }
  ): Promise<PullRequestMilestone | null> {
    const response = await this.host.request(
      `${this.host.repoPath(input)}/issues/${input.pullNumber}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ milestone: input.milestone })
      }
    )
    const record = Array.isArray(response) ? {} : response
    return this.host.toMilestone(record['milestone'])
  }

  /** The repository's own label catalog, which a label picker draws its chips from. */

  /** The repository's own label catalog, which a label picker draws its chips from. */
  async listRepositoryLabels(input: { owner: string; repo: string }): Promise<PullRequestLabel[]> {
    const response = await this.host.request(`${this.host.repoPath(input)}/labels?per_page=100`, {
      method: 'GET'
    })
    return this.host.toLabels(response)
  }

  /** The repository's open milestones. Closed ones are history, not a choice. */

  /** The repository's open milestones. Closed ones are history, not a choice. */
  async listRepositoryMilestones(input: {
    owner: string
    repo: string
  }): Promise<PullRequestMilestone[]> {
    const response = await this.host.request(
      `${this.host.repoPath(input)}/milestones?state=open&per_page=100`,
      {
        method: 'GET'
      }
    )
    const items = Array.isArray(response) ? response : []
    return items.flatMap((item): PullRequestMilestone[] => {
      const milestone = this.host.toMilestone(item)
      return milestone ? [milestone] : []
    })
  }

  /**
   * One page of the repository's workflow runs, newest first.
   *
   * Asks for one row beyond the page on purpose: a page-numbered listing can read
   * that extra row without moving anything, so `hasMore` is the server's answer
   * rather than a guess from a page that came back exactly full.
   */
}
