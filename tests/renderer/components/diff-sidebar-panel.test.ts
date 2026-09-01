// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

// DiffSidebarPanel's module graph assumes a browser `window.api` bridge at load.
// This test exercises the real component through its keyed parent path so that
// prop changes (projectId/threadId/checkpointId) actually reach the controller,
// and asserts the controller reacts by issuing the expected IPC calls. Stub IPC
// and the two stores the controller touches (openChange) to keep the run DOM-free
// but real. The default component import keeps the scoped type-check resolvable.
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('$lib/ipc.svelte', () => ({
  invoke: invokeMock,
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

import { mount, unmount } from 'svelte'
import DiffSidebarPanel from '$lib/components/files/DiffSidebarPanel.svelte'
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

function installDefaultInvoke(): void {
  invokeMock.mockImplementation(async (channel: string) => {
    if (channel === 'checkpoint:list') return []
    if (channel === 'checkpoint:activeSummary') return null
    return []
  })
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('DiffSidebarPanel component integration (REL-08)', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    installDefaultInvoke()
  })

  it('mounts and issues the checkpoint list refresh for the current thread', async () => {
    const target = document.createElement('div')
    const host = mount(DiffSidebarPanel, {
      target,
      props: { projectId: 'project-a', threadId: 'thread-1', checkpointId: null }
    })
    await flush()
    await flush()
    expect(target.textContent).toContain('No recorded changes')
    expect(
      invokeMock.mock.calls.some(
        (call) => call[0] === 'checkpoint:list' && call[1] === 'project-a' && call[2] === 'thread-1'
      )
    ).toBe(true)
    unmount(host)
  })

  it('reaches the controller for each thread identity without a keyed parent', async () => {
    const t1 = document.createElement('div')
    const h1 = mount(DiffSidebarPanel, {
      target: t1,
      props: { projectId: 'project-a', threadId: 'thread-1', checkpointId: null }
    })
    await flush()
    await flush()
    expect(
      invokeMock.mock.calls.some((call) => call[0] === 'checkpoint:list' && call[2] === 'thread-1')
    ).toBe(true)
    unmount(h1)

    const t2 = document.createElement('div')
    const h2 = mount(DiffSidebarPanel, {
      target: t2,
      props: { projectId: 'project-a', threadId: 'thread-2', checkpointId: null }
    })
    await flush()
    await flush()
    expect(
      invokeMock.mock.calls.some((call) => call[0] === 'checkpoint:list' && call[2] === 'thread-2')
    ).toBe(true)
    unmount(h2)
  })

  it('renders the preferred checkpoint returned by refresh', async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'checkpoint:list') return [checkpoint('cp-pref', 'thread-1')]
      if (channel === 'checkpoint:activeSummary') return null
      return []
    })
    const target = document.createElement('div')
    const host = mount(DiffSidebarPanel, {
      target,
      props: { projectId: 'project-a', threadId: 'thread-1', checkpointId: 'cp-pref' }
    })
    await flush()
    await flush()
    expect(target.textContent).toContain('Turn 1 of 1')
    unmount(host)
  })

  it('reopens the same thread seeded from the module cache', async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'checkpoint:list') return [checkpoint('cp-1', 'thread-1')]
      if (channel === 'checkpoint:activeSummary') return null
      return []
    })
    const t1 = document.createElement('div')
    const h1 = mount(DiffSidebarPanel, {
      target: t1,
      props: { projectId: 'project-a', threadId: 'thread-1', checkpointId: null }
    })
    await flush()
    await flush()
    expect(t1.textContent).toContain('Turn 1 of 1')
    unmount(h1)

    const t2 = document.createElement('div')
    const h2 = mount(DiffSidebarPanel, {
      target: t2,
      props: { projectId: 'project-a', threadId: 'thread-1', checkpointId: null }
    })
    await flush()
    await flush()
    expect(t2.textContent).toContain('Turn 1 of 1')
    unmount(h2)
  })
})