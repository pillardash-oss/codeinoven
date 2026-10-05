// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Thread } from '$shared/types'

/**
 * Scoped is a view of its own: entering it marks the rail and docks its sidebar
 * on the same tick (never painting the plain projects state on the way in), and
 * its rail item toggles that sidebar instead of bouncing the user back to
 * Projects. These tests pin the controller's sequencing, which is what made the
 * view look like Projects-with-a-property: the dock used to happen only after
 * `thread:listAll` and `activateProject` resolved, and re-selecting the view
 * navigated away.
 */

const hoisted = vi.hoisted(() => {
  const scopeState = {
    sidebarContext: null as null | {
      projectId: string
      bucketId: string
      stage: string
      threadId: string
    },
    stashedSidebarContext: null as null | { projectId: string },
    stashedProjectThreadId: null as string | null,
    stashedChatThreadId: null as string | null,
    projectRecords: [] as Array<{ id: string }>,
    allScopeThreads: [] as Array<{ id: string; projectId: string; archived: boolean }>,
    cacheBoardForLookup: vi.fn(async () => {}),
    ensureBoardLoaded: vi.fn(async () => {}),
    ensureProjectThreadsLoaded: vi.fn(async () => {}),
    showSidebarForThread: vi.fn(),
    showSidebarForProject: vi.fn(),
    activateProject: vi.fn(async () => {}),
    setThreads: vi.fn(),
    lastBucketForProject: vi.fn(() => 'default'),
    setSidebarBucket: vi.fn(),
    restoreStashedSidebarContext: vi.fn(),
    clearSidebarContext: vi.fn()
  }
  const workspaceState = {
    selectedThread: null as Thread | null,
    activeProject: null as { id: string } | null,
    recentThreadVisits: [] as string[],
    contentViewThreadRef: vi.fn(() => null as { projectId: string; threadId: string } | null),
    openThread: vi.fn(),
    clearThread: vi.fn()
  }
  const threadMessages = { preload: vi.fn(async () => {}) }
  return { scopeState, workspaceState, threadMessages }
})

vi.mock('$lib/ipc.svelte', () => ({ invoke: vi.fn(async () => []) }))
vi.mock('$lib/keymap/keymap-state.svelte', () => ({ keymapState: { keysFor: () => [] } }))
vi.mock('$lib/stores/thread-messages.svelte', () => ({ threadMessages: hoisted.threadMessages }))
vi.mock('$lib/stores/scope.svelte', () => ({ scopeState: hoisted.scopeState }))
vi.mock('$lib/stores/workspace.svelte', () => ({
  workspaceState: hoisted.workspaceState,
  threadVisitKey: (thread: { projectId: string; id: string }) => `${thread.projectId}:${thread.id}`
}))

import { mount, unmount } from 'svelte'
import type { AppHeaderNavigationController } from '$lib/components/layout/AppHeaderNavigationController.svelte'
import { viewShowsScopedSidebar } from '$lib/content-view-projects'
import { sidebarState } from '$lib/stores/sidebar.svelte'
import type { MainView } from '$lib/stores/renderer-recovery'
import NavigationHarness from './stubs/NavigationHarness.svelte'

function makeThread(id: string, projectId: string): Thread {
  return {
    id,
    projectId,
    providerId: 'pi',
    title: id,
    titleSource: 'manual',
    status: 'completed',
    pinned: false,
    archived: false,
    read: true,
    createdAt: 0,
    updatedAt: 0,
    lastActivity: 0,
    workingDirectory: '/tmp'
  }
}

/** Mounted harnesses, unmounted after each test so the effects do not leak. */
const hosts: Array<Record<string, unknown>> = []

function makeController(activeView: MainView): {
  controller: AppHeaderNavigationController
  navigated: MainView[]
} {
  const navigated: MainView[] = []
  let controller!: AppHeaderNavigationController
  const host = mount(NavigationHarness, {
    target: document.createElement('div'),
    props: {
      activeView,
      onNavigate: (view: MainView) => navigated.push(view),
      onReady: (ready: AppHeaderNavigationController) => (controller = ready)
    }
  })
  hosts.push(host)
  return { controller, navigated }
}

afterEach(() => {
  while (hosts.length > 0) unmount(hosts.pop()!)
})

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.scopeState.sidebarContext = null
  hoisted.scopeState.stashedSidebarContext = null
  hoisted.scopeState.stashedProjectThreadId = null
  hoisted.scopeState.stashedChatThreadId = null
  hoisted.scopeState.projectRecords = [{ id: 'p1' }]
  hoisted.scopeState.allScopeThreads = []
  hoisted.workspaceState.selectedThread = null
  hoisted.workspaceState.activeProject = null
  hoisted.workspaceState.recentThreadVisits = []
  hoisted.workspaceState.contentViewThreadRef.mockReturnValue(null)
  sidebarState.collapsed = false
})

describe('Scoped entry', () => {
  it('docks on the Projects page in the same tick, never painting the plain projects state', async () => {
    const thread = makeThread('t1', 'p1')
    hoisted.workspaceState.selectedThread = thread
    const { controller, navigated } = makeController('projects')

    const opening = controller.toggleScopedThreads()

    // The rail move and the sidebar dock are synchronous: no IPC round trip
    // stands between the click and the scoped pane.
    expect(navigated).toEqual(['projects-scope'])
    expect(hoisted.scopeState.showSidebarForThread).toHaveBeenCalledWith(thread)
    await opening
    expect(navigated).not.toContain('projects')
  })

  it('lands straight on the scoped view from another family', async () => {
    const thread = makeThread('t1', 'p1')
    hoisted.workspaceState.selectedThread = thread
    const { controller, navigated } = makeController('threads')

    await controller.toggleScopedThreads()

    expect(navigated).toEqual(['projects-scope'])
    expect(hoisted.scopeState.showSidebarForThread).toHaveBeenCalledWith(thread)
    expect(navigated).not.toContain('projects')
  })

  it('brings a collapsed sidebar back when Scoped is selected', async () => {
    hoisted.workspaceState.selectedThread = makeThread('t1', 'p1')
    sidebarState.collapsed = true
    const { controller, navigated } = makeController('projects')

    await controller.toggleScopedThreads()

    expect(navigated).toEqual(['projects-scope'])
    expect(sidebarState.collapsed).toBe(false)
  })

  it('falls back to the plain projects view only when there is no project to dock', async () => {
    const { controller, navigated } = makeController('threads')

    await controller.toggleScopedThreads()

    expect(navigated).toEqual(['projects'])
  })
})

describe('Scoped toggle', () => {
  it('toggles the docked sidebar instead of leaving the view', async () => {
    hoisted.scopeState.sidebarContext = {
      projectId: 'p1',
      bucketId: 'default',
      stage: 'todo',
      threadId: ''
    }
    const { controller, navigated } = makeController('projects-scope')

    await controller.toggleScopedThreads()
    expect(navigated).toEqual([])
    expect(sidebarState.collapsed).toBe(true)

    await controller.toggleScopedThreads()
    expect(navigated).toEqual([])
    expect(sidebarState.collapsed).toBe(false)
  })

  it('toggles the same sidebar in the projects view spelling of the scoped state', async () => {
    hoisted.scopeState.sidebarContext = {
      projectId: 'p1',
      bucketId: 'default',
      stage: 'todo',
      threadId: ''
    }
    const { controller, navigated } = makeController('projects')

    await controller.toggleScopedThreads()

    expect(navigated).toEqual([])
    expect(sidebarState.collapsed).toBe(true)
  })
})

describe('Scoped hover warm-up', () => {
  it('warms the dock without changing the view', () => {
    hoisted.workspaceState.selectedThread = makeThread('t1', 'p1')
    hoisted.workspaceState.contentViewThreadRef.mockReturnValue({ projectId: 'p1', threadId: 't1' })
    hoisted.scopeState.allScopeThreads = [{ id: 't1', projectId: 'p1', archived: false }]
    const { controller, navigated } = makeController('projects')

    controller.preloadScopedThreads()

    expect(navigated).toEqual([])
    expect(hoisted.scopeState.cacheBoardForLookup).toHaveBeenCalledWith('p1')
    expect(hoisted.scopeState.ensureProjectThreadsLoaded).toHaveBeenCalledWith('p1')
    expect(hoisted.threadMessages.preload).toHaveBeenCalledWith('p1', 't1')
  })
})

describe('viewShowsScopedSidebar', () => {
  it('answers the one question the switcher, the sidebar and the palette share', () => {
    expect(viewShowsScopedSidebar('projects-scope', true)).toBe(true)
    expect(viewShowsScopedSidebar('projects-scope', false)).toBe(true)
    expect(viewShowsScopedSidebar('projects', true)).toBe(true)
    expect(viewShowsScopedSidebar('projects', false)).toBe(false)
    expect(viewShowsScopedSidebar('threads', true)).toBe(false)
    expect(viewShowsScopedSidebar('chats', false)).toBe(false)
    expect(viewShowsScopedSidebar('scope', true)).toBe(false)
  })
})
