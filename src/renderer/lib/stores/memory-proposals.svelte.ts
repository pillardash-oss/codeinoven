import { invoke } from '$lib/ipc.svelte'
import { INBOX_PROJECT_ID } from '$shared/types'

class MemoryProposalState {
  pendingCount = $state(0)
  private projectId: string | null = null
  private request = 0

  get hasPending(): boolean {
    return this.pendingCount > 0
  }

  setContext(projectId: string | null): void {
    if (this.projectId === projectId) return
    this.projectId = projectId
    if (!projectId) {
      this.request += 1
      this.pendingCount = 0
      return
    }
    void this.refreshCurrent()
  }

  async refreshCurrent(): Promise<void> {
    const projectId = this.projectId
    if (!projectId) {
      this.pendingCount = 0
      return
    }

    const request = ++this.request
    try {
      const queues =
        projectId === INBOX_PROJECT_ID
          ? await Promise.all([
              invoke('memory:getPendingProposals'),
              invoke('memory:getPendingProposals', INBOX_PROJECT_ID)
            ])
          : await Promise.all([
              invoke('memory:getPendingProposals'),
              invoke('memory:getPendingProposals', projectId)
            ])
      if (request !== this.request || projectId !== this.projectId) return
      this.pendingCount = queues.reduce((total, proposals) => total + proposals.length, 0)
    } catch {
      if (request === this.request && projectId === this.projectId) this.pendingCount = 0
    }
  }
}

export const memoryProposalState = new MemoryProposalState()
