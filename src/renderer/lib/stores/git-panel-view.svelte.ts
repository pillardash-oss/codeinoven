import type { GitCommitInfo, GitStashEntry, PullRequestSummary } from '$shared/types'

export type GitPanelTabId =
  | 'changes'
  | 'history'
  | 'branches'
  | 'pulls'
  | 'deployments'
  | 'stashes'

export interface GitPanelViewState {
  activeTab: GitPanelTabId
  changesView: 'list' | 'tree'
  selectedCommit: GitCommitInfo | null
  selectedPullRequest: PullRequestSummary | null
  selectedStash: GitStashEntry | null
}

function defaultState(): GitPanelViewState {
  return {
    activeTab: 'changes',
    changesView: 'list',
    selectedCommit: null,
    selectedPullRequest: null,
    selectedStash: null
  }
}

function key(projectId: string, threadId: string): string {
  return `${projectId}:${threadId}`
}

/**
 * Remembers each git panel's tab/selection state across the sidebar's
 * hide/show toggle, which destroys and recreates GitStatusPanel (its local
 * $state is not preserved by Svelte across that remount).
 */
const states = new Map<string, GitPanelViewState>()

export const gitPanelView = {
  get(projectId: string, threadId: string): GitPanelViewState {
    const existing = states.get(key(projectId, threadId))
    return existing ? { ...existing } : defaultState()
  },
  set(projectId: string, threadId: string, state: GitPanelViewState): void {
    states.set(key(projectId, threadId), { ...state })
  }
}
