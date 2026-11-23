import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemoryProposal } from '$shared/types'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('$lib/ipc.svelte', () => ({ invoke }))

type ProposalState = (typeof import('$lib/stores/memory-proposals.svelte'))['memoryProposalState']

function proposal(overrides: Partial<MemoryProposal> = {}): MemoryProposal {
  const now = Date.now()
  return {
    id: `proposal-${Math.random().toString(36).slice(2)}`,
    label: 'Proposed memory',
    content: 'Maybe remember this.',
    category: 'preference',
    priority: 'medium',
    scopes: ['projects'],
    createdAt: now,
    expiresAt: now + 60_000,
    status: 'pending',
    ...overrides
  }
}

/** Serve the two queues the badge reads: the root file and the container file. */
function serveQueues(root: MemoryProposal[], container: MemoryProposal[]): void {
  invoke.mockImplementation((_channel: string, projectId?: string) =>
    Promise.resolve(projectId === undefined ? root : container)
  )
}

let state: ProposalState

beforeEach(async () => {
  invoke.mockReset()
  vi.resetModules()
  const module = await import('$lib/stores/memory-proposals.svelte')
  state = module.memoryProposalState
})

describe('memory proposal badge', () => {
  it('ignores a thread-scoped proposal from another conversation', async () => {
    serveQueues(
      [],
      [
        proposal({
          scopes: ['thread'],
          projectId: 'project-1',
          threadId: 'thread-other'
        })
      ]
    )

    state.setContext({ projectId: 'project-1', threadId: 'thread-open' })
    await state.refreshCurrent()

    expect(state.pendingCount).toBe(0)
    expect(state.hasPending).toBe(false)
  })

  it('counts the proposals the open conversation can review', async () => {
    serveQueues(
      [proposal({ scopes: ['projects'] })],
      [
        proposal({ scopes: ['thread'], projectId: 'project-1', threadId: 'thread-open' }),
        proposal({ scopes: ['thread'], projectId: 'project-1', threadId: 'thread-other' })
      ]
    )

    state.setContext({ projectId: 'project-1', threadId: 'thread-open' })
    await state.refreshCurrent()

    expect(state.pendingCount).toBe(2)
    expect(state.hasPending).toBe(true)
  })

  it('drops the badge when the context closes', async () => {
    serveQueues([proposal({ scopes: ['projects'] })], [])

    state.setContext({ projectId: 'project-1', threadId: 'thread-open' })
    await state.refreshCurrent()
    expect(state.pendingCount).toBe(1)

    state.setContext(null)
    expect(state.pendingCount).toBe(0)
  })

  it('re-reads when only the open thread changes', async () => {
    serveQueues(
      [],
      [proposal({ scopes: ['thread'], projectId: 'project-1', threadId: 'thread-other' })]
    )

    state.setContext({ projectId: 'project-1', threadId: 'thread-open' })
    await state.refreshCurrent()
    expect(state.pendingCount).toBe(0)

    state.setContext({ projectId: 'project-1', threadId: 'thread-other' })
    await state.refreshCurrent()
    expect(state.pendingCount).toBe(1)
  })
})
