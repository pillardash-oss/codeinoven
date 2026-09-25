import { invoke } from '$lib/ipc.svelte'
import type { ScopeAgentConfirmationRequest } from '$shared/types'

/**
 * Destructive scope actions an agent asked for, waiting on the user.
 *
 * Only an `auto_review` thread creates one of these: main parks the agent's tool
 * call until this store answers, so the queue is drained one dialog at a time
 * and an unanswered request is denied by main's own expiry. Nothing here can
 * destroy anything on its own.
 */
class ScopeConfirmationStore {
  requests = $state<ScopeAgentConfirmationRequest[]>([])
  /** True while an answer is in flight, so the dialog cannot double-submit. */
  responding = $state(false)

  get current(): ScopeAgentConfirmationRequest | null {
    return this.requests[0] ?? null
  }

  enqueue(request: ScopeAgentConfirmationRequest): void {
    // Main mints one request per agent action; a duplicate delivery of the same
    // request must not stack a second identical dialog.
    if (this.requests.some((candidate) => candidate.requestId === request.requestId)) return
    this.requests = [...this.requests, request]
  }

  /** Answer the current request and move on to the next one. */
  async respond(approved: boolean): Promise<void> {
    const request = this.current
    if (!request || this.responding) return
    this.responding = true
    try {
      await invoke('scope:agentConfirmationRespond', request.requestId, approved)
      this.#dismiss(request.requestId)
    } finally {
      this.responding = false
    }
  }

  /** Drop a request that expired before it was answered. */
  dismiss(requestId: string): void {
    this.#dismiss(requestId)
  }

  #dismiss(requestId: string): void {
    this.requests = this.requests.filter((candidate) => candidate.requestId !== requestId)
  }
}

export const scopeConfirmations = new ScopeConfirmationStore()
