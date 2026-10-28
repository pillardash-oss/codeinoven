import type { GitHubProvider } from '../github-provider'
import { GitHubProviderPullRequests } from './github-provider-pull-requests'
import { GitHubProviderBranches } from './github-provider-branches'
import { GitHubProviderIssues } from './github-provider-issues'
import { GitHubProviderIssueRelationships } from './github-provider-issue-relationships'
import { GitHubProviderApiCore } from './github-provider-api-core'
import { GitHubProviderPullRequestComments } from './github-provider-pull-request-comments'
import { GitHubProviderReactions } from './github-provider-reactions'
import { GitHubProviderChecks } from './github-provider-checks'
import { GitHubProviderRepositoryMetadata } from './github-provider-repository-metadata'
import { GitHubProviderWorkflows } from './github-provider-workflows'
import { GitHubProviderMappers } from './github-provider-mappers'

/** The concern units a GitHubProvider delegates to, keyed by concern name. */
export const githubproviderUnitNames = [
  'pull-requests',
  'branches',
  'issues',
  'issue-relationships',
  'api-core',
  'pull-request-comments',
  'reactions',
  'checks',
  'repository-metadata',
  'workflows',
  'mappers'
] as const

export type GitHubProviderUnitName = (typeof githubproviderUnitNames)[number]

export function buildGitHubProviderUnits(engine: GitHubProvider) {
  return {
    ['pull-requests']: new GitHubProviderPullRequests(engine),
    ['branches']: new GitHubProviderBranches(engine),
    ['issues']: new GitHubProviderIssues(engine),
    ['issue-relationships']: new GitHubProviderIssueRelationships(engine),
    ['api-core']: new GitHubProviderApiCore(engine),
    ['pull-request-comments']: new GitHubProviderPullRequestComments(engine),
    ['reactions']: new GitHubProviderReactions(engine),
    ['checks']: new GitHubProviderChecks(engine),
    ['repository-metadata']: new GitHubProviderRepositoryMetadata(engine),
    ['workflows']: new GitHubProviderWorkflows(engine),
    ['mappers']: new GitHubProviderMappers(engine)
  } as const
}

export type GitHubProviderUnits = ReturnType<typeof buildGitHubProviderUnits>
