// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'

/**
 * The sidebar keeps one list per view mounted, so switching views is a
 * visibility flip rather than a rebuild. These tests lock that in: they mount
 * the real sidebar, flip the shell mode, and assert the row elements the reader
 * was looking at are the same DOM nodes afterwards.
 *
 * Without this, a mode-gated `{#if}` around a list looks harmless in review (it
 * is how the sidebar used to work) and silently puts the switch cost back:
 * tearing down and rebuilding a few hundred rows per switch is what made
 * Projects > Threads take around a second with a few hundred threads.
 */

const invokeMock = vi.hoisted(() => vi.fn(async () => undefined))
// jsdom has no `matchMedia`; the sidebar's reduced-motion query needs it before
// the module graph loads (imports run after the hoisted block).
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false
    })
  })
})
vi.mock('$lib/ipc.svelte', () => ({
  invoke: invokeMock,
  subscribe: vi.fn(() => () => {})
}))

// Leaf components the sidebar composes. Each renders a marker element so the
// test can prove node identity across a mode flip; nothing here stubs panes.
vi.mock('$lib/components/threads/ThreadRow.svelte', async () => {
  const { default: ThreadRowStub } = await import('./stubs/ThreadRowStub.svelte')
  return { default: ThreadRowStub }
})
vi.mock('$lib/components/threads/PinnedSection.svelte', async () => {
  const { default: PinnedSectionStub } = await import('./stubs/PinnedSectionStub.svelte')
  return { default: PinnedSectionStub }
})
vi.mock('$lib/components/workspace/FolderRow.svelte', async () => {
  const { default: FolderRowStub } = await import('./stubs/FolderRowStub.svelte')
  return { default: FolderRowStub }
})
vi.mock('$lib/components/shared/ScopeActionsMenu.svelte', async () => {
  const { default: EmptyStub } = await import('./stubs/EmptyStub.svelte')
  return { default: EmptyStub }
})
vi.mock('$lib/components/shared/ProjectSwitch.svelte', async () => {
  const { default: EmptyStub } = await import('./stubs/EmptyStub.svelte')
  return { default: EmptyStub }
})
vi.mock('$lib/components/shared/ProjectIdentity.svelte', async () => {
  const { default: EmptyStub } = await import('./stubs/EmptyStub.svelte')
  return { default: EmptyStub }
})
vi.mock('$lib/components/shared/StatusBadge.svelte', async () => {
  const { default: EmptyStub } = await import('./stubs/EmptyStub.svelte')
  return { default: EmptyStub }
})
vi.mock('$lib/components/shared/ThreadSearchResultRow.svelte', async () => {
  const { default: EmptyStub } = await import('./stubs/EmptyStub.svelte')
  return { default: EmptyStub }
})
vi.mock('$lib/components/specs/SpecConversationSidebar.svelte', async () => {
  const { default: EmptyStub } = await import('./stubs/EmptyStub.svelte')
  return { default: EmptyStub }
})

import SidebarHarness from './stubs/SidebarHarness.svelte'
import { sidebarState } from '$lib/stores/sidebar.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { WorkspaceSidebarController } from '$lib/components/workspace/WorkspaceSidebarController.svelte'
import type { Project, Thread } from '$shared/types'

function thread(id: string, projectId: string): Thread {
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
    createdAt: 1,
    updatedAt: 1,
    lastActivity: 1,
    workingDirectory: `/tmp/${projectId}`
  }
}

function project(id: string, name: string): Project {
  return {
    id,
    name,
    path: `/tmp/${id}`,
    source: 'local',
    providerId: 'pi',
    workflowId: 'default',
    threadLimit: 70,
    createdAt: 1,
    updatedAt: 1
  }
}

const alpha = project('alpha', 'Alpha')
const beta = project('beta', 'Beta')
const alphaThreads = [thread('alpha-1', 'alpha'), thread('alpha-2', 'alpha')]
const betaThreads = [thread('beta-1', 'beta')]
const timelineThreads = [...alphaThreads, ...betaThreads]

function props(mode: 'projects' | 'chats' | 'threads') {
  const projects = [alpha, beta]
  return {
    mode,
    active: true,
    scroller: null,
    projects,
    visibleProjects: projects,
    projectIcons: new Map<string, string>(),
    loading: false,
    activeThreadId: 'alpha-1',
    threadsByProject: new Map([
      ['alpha', alphaThreads],
      ['beta', betaThreads]
    ]),
    pinnedThreads: [],
    pinnedProjects: [],
    regularProjects: projects,
    pinnedInboxThreads: [],
    standaloneThreads: [],
    pinnedTimelineThreads: [],
    unpinnedTimelineThreads: timelineThreads,
    draftThreadKeys: new Set<string>(),
    hasMoreHistory: false,
    historyLoading: false,
    projectPageLoading: null,
    sidebar: new WorkspaceSidebarController(),
    projectDialogs: {
      askEditProject: vi.fn(),
      askRemoveProject: vi.fn()
    },
    scopeActions: { error: null },
    onSetProjects: vi.fn(),
    onOpenThread: vi.fn(),
    onRename: vi.fn(async () => {}),
    onTogglePin: vi.fn(),
    onDelete: vi.fn(async () => {}),
    onFork: vi.fn(),
    onThreadMove: vi.fn(),
    onPinnedThreadMove: vi.fn(),
    onTimelinePinnedMove: vi.fn(),
    onProjectMove: vi.fn(),
    onCreateThread: vi.fn(),
    onOpenScopedThread: vi.fn(),
    onSwitchScopedProject: vi.fn(async () => {}),
    onLoadProjectThreadsPage: vi.fn(async () => {}),
    onLoadHistoryPage: vi.fn(async () => {}),
    projectHasMoreInDb: () => false
  }
}

// `scopeState.sidebarContext` decides which of the two projects panes is shown,
// so every test starts with no docked scope (the Projects tree).
function renderSidebar(mode: 'projects' | 'chats' | 'threads') {
  const target = document.createElement('div')
  document.body.append(target)
  const component = mount(SidebarHarness, {
    target,
    props: { sidebarProps: props(mode), initialMode: mode }
  })
  return { target, component }
}

const rowsById = (target: HTMLElement) =>
  new Map(
    [...target.querySelectorAll<HTMLElement>('[data-thread-row]')].map((row) => [
      row.dataset.threadRow ?? '',
      row
    ])
  )

/** The projects tree renders a row per project even while its folders are folded. */
const projectRowsById = (target: HTMLElement) =>
  new Map(
    [...target.querySelectorAll<HTMLElement>('[data-project-row]')].map((row) => [
      row.dataset.projectRow ?? '',
      row
    ])
  )

beforeEach(() => {
  document.body.innerHTML = ''
  // The sidebar's own store persists width/collapse; keep each test on defaults.
  sidebarState.collapsed = false
  scopeState.clearSidebarContext()
})

describe('workspace sidebar panes', () => {
  it('keeps the timeline rows mounted when the shell moves to another view', async () => {
    const { target, component } = renderSidebar('threads')
    await tick()

    const threadsPane = target.querySelector('[data-sidebar-pane="threads"]')
    const projectsPane = target.querySelector('[data-sidebar-pane="projects"]')
    expect(threadsPane).not.toBeNull()
    expect(projectsPane).not.toBeNull()
    expect(threadsPane?.hasAttribute('hidden')).toBe(false)
    expect(projectsPane?.hasAttribute('hidden')).toBe(true)

    const timelineRows = rowsById(target)
    expect([...timelineRows.keys()].sort()).toEqual(['alpha-1', 'alpha-2', 'beta-1'])

    // Flip to Projects and back, twice, through the same path the shell uses.
    for (const mode of ['projects', 'threads', 'projects', 'threads'] as const) {
      component.setMode(mode)
      flushSync()
    }

    const afterFlip = rowsById(target)
    for (const [id, row] of timelineRows) {
      expect(afterFlip.get(id), `row ${id} survived the round trip`).toBe(row)
    }
    expect(target.querySelector('[data-sidebar-pane="threads"]')).toBe(threadsPane)
    expect(target.querySelector('[data-sidebar-pane="projects"]')).toBe(projectsPane)
    expect(threadsPane?.hasAttribute('hidden')).toBe(false)
    expect(projectsPane?.hasAttribute('hidden')).toBe(true)

    void unmount(component)
  })

  it('mounts a never-shown list off the switch frame and then keeps it', async () => {
    const { target, component } = renderSidebar('projects')
    await tick()

    const threadsPane = target.querySelector('[data-sidebar-pane="threads"]')
    expect(threadsPane).not.toBeNull()
    expect(threadsPane?.hasAttribute('hidden')).toBe(true)
    // Never shown, so the shell has not paid for its rows yet.
    expect(rowsById(target).size).toBe(0)

    // The pane mounts its list in the shell's first idle window instead. Poll
    // rather than assume a frame count: the scheduler waits for two frames and
    // then an idle slot, and jsdom serves both from timers.
    const deadline = Date.now() + 1000
    while (rowsById(target).size === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const preloaded = rowsById(target)
    expect([...preloaded.keys()].sort()).toEqual(['alpha-1', 'alpha-2', 'beta-1'])

    component.setMode('threads')
    flushSync()
    expect(threadsPane?.hasAttribute('hidden')).toBe(false)
    for (const [id, row] of preloaded) {
      expect(rowsById(target).get(id), `row ${id} survived the first switch`).toBe(row)
    }

    component.setMode('projects')
    flushSync()
    for (const [id, row] of preloaded) {
      expect(rowsById(target).get(id), `row ${id} stays mounted`).toBe(row)
    }

    void unmount(component)
  })

  it('shows the scoped pane for a docked scope without unmounting the projects tree', async () => {
    const { target, component } = renderSidebar('projects')
    await tick()

    const projectsPane = target.querySelector('[data-sidebar-pane="projects"]')
    const scopedPane = target.querySelector('[data-sidebar-pane="scoped"]')
    expect(projectsPane?.hasAttribute('hidden')).toBe(false)
    expect(scopedPane?.hasAttribute('hidden')).toBe(true)

    const projectRows = projectRowsById(target)
    expect(projectRows.size).toBeGreaterThan(0)

    // The scoped state is the same shell mode as the projects tree, so docking a
    // scope swaps the two panes without touching the tree behind them.
    scopeState.sidebarContext = {
      projectId: 'alpha',
      bucketId: 'default',
      stage: 'todo',
      threadId: 'alpha-1'
    }
    flushSync()
    expect(projectsPane?.hasAttribute('hidden')).toBe(true)
    expect(scopedPane?.hasAttribute('hidden')).toBe(false)

    scopeState.clearSidebarContext()
    flushSync()
    expect(projectsPane?.hasAttribute('hidden')).toBe(false)
    for (const [id, row] of projectRows) {
      expect(projectRowsById(target).get(id), `row ${id} survived the scope flip`).toBe(row)
    }

    void unmount(component)
  })
})
