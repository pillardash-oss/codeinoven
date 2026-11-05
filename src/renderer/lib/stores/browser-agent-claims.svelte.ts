/**
 * Which browser tabs an agent is working on, and which thread holds each one.
 *
 * The tab strip reads this to name the thread behind a tab the user did not open:
 * the tab an agent opened for itself and the page a conversation was assigned are
 * both claimed. Main owns the claims (they are its `agentTabIds` and
 * `agentUserPageTabIds` maps), pushes them whenever an agent takes a tab, and
 * answers once for the strip that mounts later, so nothing here polls.
 *
 * A claim is a fact about a tab rather than about the turn, so a claim outlives the
 * turn that made it and leaves only when the tab does. That is what the strip says:
 * this tab is a conversation's work, not merely a page somebody read once.
 */
import { invoke, subscribe } from '$lib/ipc.svelte'
import type { BrowserAgentTabClaim } from '$shared/ipc/browser'

class BrowserAgentClaimsState {
  private claims = $state<BrowserAgentTabClaim[]>([])
  private initialized = false

  /** Subscribe to claim changes and load the current set. Idempotent. */
  init(): void {
    if (this.initialized) return
    this.initialized = true
    void invoke('browser:agentTabClaims')
      .then((claims) => {
        this.claims = claims
      })
      .catch(() => {})
    const unsubscribe = subscribe('browser:agentTabClaimsChanged', (claims) => {
      this.claims = claims
    })
    // Subscriptions live for the whole renderer; the reference keeps this one from
    // being collected while it is still wanted.
    this.dispose = () => unsubscribe()
  }

  /** The claim on one tab, or null when no agent is working on it. */
  claimFor(tabId: string): BrowserAgentTabClaim | null {
    return this.claims.find((claim) => claim.tabId === tabId) ?? null
  }

  dispose: (() => void) | null = null
}

export const browserAgentClaims = new BrowserAgentClaimsState()
