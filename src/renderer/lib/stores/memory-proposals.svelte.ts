import { invoke } from '$lib/ipc.svelte'
import {
  proposalVisibleOnSurface,
  surfaceForMemoryProject,
  type MemorySurfaceContext
} from '$lib/components/memory/memory-routing'
import { DEFAULT_SCOPE_BUCKET_ID } from '$shared/types'

/** The open thread a proposal badge is drawn for. A proposal is only reviewable
 *  where its scope reaches, so the badge needs the same coordinates the memory
 *  panel resolves: the conversation, its feature scope and, on assistant tasks,
 *  its assistant. */
export interface MemoryProposalContext {
  projectId: string
  threadId?: string
  scopeBucketId?: string
  assistantId?: string
}

function contextSignature(context: MemoryProposalContext | null): string {
  if (!context) return ''
  return [
    context.projectId,
    context.threadId ?? '',
    context.scopeBucketId ?? '',
    context.assistantId ?? ''
  ].join('|')
}

class MemoryProposalState {
  pendingCount = $state(0)
  private context: MemoryProposalContext | null = null
  private contextKey = ''
  private request = 0

  get hasPending(): boolean {
    return this.pendingCount > 0
  }

  setContext(context: MemoryProposalContext | null): void {
    const key = contextSignature(context)
    if (this.contextKey === key) return
    this.contextKey = key
    this.context = context ? { ...context } : null
    if (!context) {
      this.request += 1
      this.pendingCount = 0
      return
    }
    void this.refreshCurrent()
  }

  /**
   * Count the proposals the memory panel would list in this context.
   *
   * The queues hold every suggestion the container owns, including ones scoped
   * to another thread or another feature scope. Those are not reviewable from
   * the open conversation and the panel hides them, so counting the raw queue
   * would keep the rail lit over an empty "No pending proposals" list.
   */
  async refreshCurrent(): Promise<void> {
    const context = this.context
    if (!context) {
      this.pendingCount = 0
      return
    }

    const surface = surfaceForMemoryProject(context.projectId)
    const surfaceContext: MemorySurfaceContext = {
      surface,
      projectId: context.projectId,
      scopeBucketId:
        surface === 'sidebar-projects'
          ? (context.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID)
          : undefined,
      threadId: context.threadId,
      assistantId: context.assistantId
    }
    const key = this.contextKey
    const request = ++this.request
    try {
      const [rootProposals, containerProposals] = await Promise.all([
        invoke('memory:getPendingProposals'),
        invoke('memory:getPendingProposals', context.projectId)
      ])
      if (request !== this.request || key !== this.contextKey) return
      this.pendingCount = [...rootProposals, ...containerProposals].filter((proposal) =>
        proposalVisibleOnSurface(proposal, surfaceContext)
      ).length
    } catch {
      if (request === this.request && key === this.contextKey) this.pendingCount = 0
    }
  }
}

export const memoryProposalState = new MemoryProposalState()
