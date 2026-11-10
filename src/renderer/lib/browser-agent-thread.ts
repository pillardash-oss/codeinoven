/**
 * Which conversation's agent is working on one browser tab.
 *
 * A browser tab is an agent's work when main says so (`browser:agentTabClaims`),
 * which covers both the tab an agent opened for itself and the page a conversation
 * was assigned. The tab's own owner is the fallback for a page an agent opened
 * before its claim arrived, so a strip never shows an agent's tab as if the user had
 * opened it.
 *
 * The name and mark are the thread's own, resolved from the thread list rather than
 * from the tab, so a strip says which conversation holds the page. Both thread
 * browser strips read this: the panel's chips and the full screen strip above the
 * page, so the two surfaces can never disagree about whose tab it is.
 */
import { browserAgentClaims } from '$lib/stores/browser-agent-claims.svelte'
import { scopeState } from '$lib/stores/scope.svelte'

export interface AgentTabThread {
  /** The thread's own title, as its row in the thread list shows it. */
  title: string
  /** The thread's mark, which is its project's icon, or null when it has none. */
  iconUrl: string | null
}

export function agentTabThread(tabId: string, ownerThreadId: string): AgentTabThread | null {
  const claim = browserAgentClaims.claimFor(tabId)
  const threadId = claim?.threadId ?? (tabId.startsWith('browser:agent:') ? ownerThreadId : null)
  if (!threadId) return null
  const thread = scopeState.allScopeThreads.find((candidate) => candidate.id === threadId)
  if (!thread) return null
  const projectId = claim?.projectId ?? thread.projectId
  return {
    title: thread.title,
    iconUrl: scopeState.projects.find((candidate) => candidate.id === projectId)?.iconUrl ?? null
  }
}
