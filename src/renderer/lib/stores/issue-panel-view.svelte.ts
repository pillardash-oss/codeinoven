import type { IssueListFilter, IssueListSort, IssueSummary, PrState } from '$shared/types'
import { SvelteMap } from 'svelte/reactivity'

/**
 * What the Issues tab remembers for one project.
 *
 * Deliberately its own store rather than fields on `GitPanelViewState`: the Git
 * panel rewrites that state from its own local values on every change, so issue
 * fields living there would be reset to their defaults the moment anything else in
 * the panel moved. Keeping them apart lets the tab hold its listing choice and the
 * issue it was reading across a tab switch without touching the panel's sync.
 */
export interface IssuePanelViewState {
  /** The issue the reader shows, or null while the listing is up. */
  selectedIssue: IssueSummary | null
  listState: PrState
  listFilter: IssueListFilter
  listSort: IssueListSort
}

function defaultState(): IssuePanelViewState {
  return { selectedIssue: null, listState: 'open', listFilter: 'all', listSort: 'updated' }
}

/** Keyed by project, because Git context belongs to the repository, not a thread. */
const states = new SvelteMap<string, IssuePanelViewState>()

export const issuePanelView = {
  get(projectId: string): IssuePanelViewState {
    const existing = states.get(projectId)
    return existing ? { ...defaultState(), ...existing } : defaultState()
  },
  set(projectId: string, state: IssuePanelViewState): void {
    states.set(projectId, { ...state })
  }
}
