import type { GitCommitInfo, GitStashEntry, PullRequestSummary } from '$shared/types'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'

export type GitPanelTabId = 'changes' | 'history' | 'branches' | 'pulls' | 'deployments' | 'stashes'

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

/**
 * Remembers each git panel's tab/selection state across the sidebar's
 * hide/show toggle and thread switches. Git is repository context, so one
 * project owns one view state regardless of which of its threads is active.
 */
const states = new SvelteMap<string, GitPanelViewState>()
type PullRequestOpenListener = (
  projectId: string,
  threadId: string,
  pullRequest: PullRequestSummary
) => void
const pullRequestOpenListeners = new SvelteSet<PullRequestOpenListener>()

export const gitPanelView = {
  get(projectId: string, _threadId: string): GitPanelViewState {
    const existing = states.get(projectId)
    return existing ? { ...existing } : defaultState()
  },
  set(projectId: string, _threadId: string, state: GitPanelViewState): void {
    states.set(projectId, { ...state })
  },
  /** Persist and publish direct PR navigation for both mounted and remounting Git panels. */
  openPullRequest(projectId: string, threadId: string, pullRequest: PullRequestSummary): void {
    const current = this.get(projectId, threadId)
    this.set(projectId, threadId, {
      ...current,
      activeTab: 'pulls',
      selectedPullRequest: pullRequest
    })
    for (const listener of pullRequestOpenListeners) {
      listener(projectId, threadId, pullRequest)
    }
  },
  onPullRequestOpen(listener: PullRequestOpenListener): () => void {
    pullRequestOpenListeners.add(listener)
    return () => pullRequestOpenListeners.delete(listener)
  }
}
