import { beforeEach, describe, expect, it, vi } from 'vitest'

// DiffSidebarPanel's module script imports the renderer store graph, which
// assumes a browser `window.api` bridge at load. This focused test only
// exercises the DiffSidebarController lifecycle, so stub the IPC and the
// two stores the controller touches (openChange) to keep it DOM-free.
vi.mock('$lib/ipc.svelte', () => ({
  invoke: vi.fn(),
  subscribe: vi.fn(() => () => {})
}))

vi.mock('$lib/stores/context-sidebar.svelte', () => ({
  contextSidebarState: { openFiles: vi.fn() }
}))

vi.mock('$lib/stores/project-files.svelte', () => ({
  projectFilesWorkspace: {
    loadDirectory: vi.fn(),
    openCheckpointFile: vi.fn()
  }
}))

import { DiffSidebarController } from '$lib/components/files/DiffSidebarPanel.svelte'
import type { TurnCheckpointSummary } from '$shared/types'

function checkpoint(id: string, threadId: string): TurnCheckpointSummary {
  return {
    id,
    projectId: 'project-a',
    threadId,
    label: `Run ${id}`,
    status: 'completed',
    changes: [],
    createdAt: 1_000
  }
}

describe('DiffSidebarController state lifecycle (REL-08)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reuses one owner and re-seeds durable state from the thread cache on identity change', () => {
    const controller = new DiffSidebarController()

    controller.setIdentity('project-a', 'thread-1')
    controller.checkpoints = [checkpoint('cp-1', 'thread-1')]
    controller.selectedCheckpointId = 'cp-1'

    // Same owner, new thread: durable state is isolated (thread-2 has none),
    // and transient fields reset.
    controller.setIdentity('project-a', 'thread-2')
    expect(controller.projectId).toBe('project-a')
    expect(controller.threadId).toBe('thread-2')
    expect(controller.checkpoints).toEqual([])
    expect(controller.selectedCheckpointId).toBeNull()
    expect(controller.fileDiffs).toEqual([])
  })

  it('resets transient state on identity change without relying on a keyed parent', () => {
    const controller = new DiffSidebarController()
    controller.setIdentity('project-a', 'thread-1')

    controller.mode = 'files'
    controller.selections = { 'cp-1': ['a.ts'] }
    controller.expandedDiffs = { 'a.ts': false }
    controller.liveTurn = checkpoint('cp-1', 'thread-1')
    controller.loading = true
    controller.error = 'boom'

    controller.setIdentity('project-a', 'thread-2')
    expect(controller.mode).toBe('diffs')
    expect(controller.selections).toEqual({})
    expect(controller.expandedDiffs).toEqual({})
    expect(controller.liveTurn).toBeNull()
    expect(controller.loading).toBe(false)
    expect(controller.error).toBe('')
  })

  it('rejects stale in-flight async results after the identity changes', async () => {
    const controller = new DiffSidebarController()
    controller.setIdentity('project-a', 'thread-1')

    let resolveList: (value: TurnCheckpointSummary[]) => void = () => {}
    const list = new Promise<TurnCheckpointSummary[]>((resolve) => {
      resolveList = resolve
    })
    let resolveLive: (value: TurnCheckpointSummary | null) => void = () => {}
    const live = new Promise<TurnCheckpointSummary | null>((resolve) => {
      resolveLive = resolve
    })

    const invoke = (await import('$lib/ipc.svelte')).invoke as ReturnType<typeof vi.fn>
    invoke.mockImplementation((channel: string) =>
      channel === 'checkpoint:list'
        ? list
        : channel === 'checkpoint:activeSummary'
          ? live
          : Promise.resolve([])
    )

    const pending = controller.refresh()
    // Identity changes before the refresh resolves.
    controller.setIdentity('project-a', 'thread-2')
    resolveList([checkpoint('cp-stale', 'thread-1')])
    resolveLive(null)
    await pending

    // The stale thread-1 payload must not leak into thread-2.
    expect(controller.checkpoints).toEqual([])
    expect(controller.selectedCheckpointId).toBeNull()
  })
})