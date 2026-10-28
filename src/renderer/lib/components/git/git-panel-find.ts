import type {
  GitBranchInfo,
  GitCommitInfo,
  GitStashEntry,
  GitHubDeployment,
  GitHubNotification,
  GitHubWorkflowRun,
  IssueSummary,
  PullRequestSummary
} from '$shared/types'
import type { GitPanelTabId } from '$lib/stores/git-panel-view.svelte'

/**
 * What the Git panel's find bar searches.
 *
 * The subject follows the view, because a bar that searches commits while the
 * reader is looking at pull requests answers a question nobody asked. Changes and
 * History share one scope: both draw the repository's commits, so both search them.
 */
export type GitFindScope =
  'commits' | 'branches' | 'pulls' | 'issues' | 'notifications' | 'stashes' | 'deployments'

/** The words each scope's bar uses, so no label is written twice. */
export interface GitFindScopeWords {
  /** Accessible name and tooltip of the header control. */
  label: string
  /** The bar's own placeholder. */
  placeholder: string
  /** What is said while the query runs. */
  busy: string
  /** What an answer with no rows says. */
  empty: string
}

export const GIT_FIND_WORDS: Record<GitFindScope, GitFindScopeWords> = {
  commits: {
    label: 'Search commits',
    placeholder: 'Search commit title or hash…',
    busy: 'Searching commits…',
    empty: 'No matching commits'
  },
  branches: {
    label: 'Search branches',
    placeholder: 'Search branch names…',
    busy: 'Searching branches…',
    empty: 'No matching branches'
  },
  pulls: {
    label: 'Search pull requests',
    placeholder: 'Search pull requests…',
    busy: 'Searching pull requests…',
    empty: 'No matching pull requests'
  },
  issues: {
    label: 'Search issues',
    placeholder: 'Search issues…',
    busy: 'Searching issues…',
    empty: 'No matching issues'
  },
  notifications: {
    label: 'Search notifications',
    placeholder: 'Search notification threads…',
    busy: 'Searching notifications…',
    empty: 'No matching notifications'
  },
  stashes: {
    label: 'Search stashes',
    placeholder: 'Search stash messages…',
    busy: 'Searching stashes…',
    empty: 'No matching stashes'
  },
  deployments: {
    label: 'Search deploys',
    placeholder: 'Search runs and deployments…',
    busy: 'Searching deploys…',
    empty: 'No matching runs or deployments'
  }
}

/**
 * The scope a view gives the find bar.
 *
 * Everything the panel can search falls in one of these; a view with no listing of
 * its own (Changes) still speaks for the commits it draws.
 */
export function gitFindScopeFor(tab: GitPanelTabId): GitFindScope {
  switch (tab) {
    case 'branches':
      return 'branches'
    case 'pulls':
      return 'pulls'
    case 'issues':
      return 'issues'
    case 'notifications':
      return 'notifications'
    case 'stashes':
      return 'stashes'
    case 'deployments':
      return 'deployments'
    case 'changes':
    case 'history':
      return 'commits'
  }
}

/**
 * One row the bar offers.
 *
 * The target is a discriminated union rather than a bag of optional fields, so the
 * panel has to handle every kind it can be handed and the row component never has
 * to guess what it is drawing. `title` and `detail` are written once, here, because
 * a row's two lines read the same whichever view the search started from.
 */
export type GitFindRow = GitFindDisplay &
  (
    | { kind: 'commit'; commit: GitCommitInfo }
    | { kind: 'branch'; branch: GitBranchInfo }
    | { kind: 'pull'; pull: PullRequestSummary }
    | { kind: 'issue'; issue: IssueSummary }
    | { kind: 'notification'; notification: GitHubNotification }
    | { kind: 'run'; run: GitHubWorkflowRun }
    | { kind: 'deployment'; deployment: GitHubDeployment }
    | { kind: 'stash'; stash: GitStashEntry }
  )

interface GitFindDisplay {
  /** Stable key for the row: what the scope addresses the item by. */
  key: string
  /** The row's first line. */
  title: string
  /** The row's second line: what names it beyond its title. */
  detail: string
  /** A short state word the row shows on the right, when it has one. */
  badge?: string
}
