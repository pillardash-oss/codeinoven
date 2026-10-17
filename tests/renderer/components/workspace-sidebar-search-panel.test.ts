// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'

/**
 * The Threads-view search panel must not empty the sidebar on the keystroke.
 *
 * The panel replaces the whole list, so it may only take over once a search has
 * answered. Mounting it as soon as the query was typed left the reader looking
 * at `Searching…` instead of their threads for the whole wait, and at that same
 * empty panel forever when the search never answered at all.
 */

const invokeMock = vi.hoisted(() =>
  vi.fn(async (_channel: string, ..._args: unknown[]): Promise<unknown> => undefined)
)
vi.mock('$lib/ipc.svelte', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/ipc.svelte')>()
  return { ...actual, invoke: invokeMock, subscribe: vi.fn(() => () => {}) }
})

vi.mock('$lib/components/threads/ThreadRow.svelte', async () => {
  const { default: ThreadRowStub } = await import('./stubs/ThreadRowStub.svelte')
  return { default: ThreadRowStub }
})
vi.mock('$lib/components/shared/ThreadSearchResultRow.svelte', async () => {
  const { default: ThreadSearchResultRowStub } =
    await import('./stubs/ThreadSearchResultRowStub.svelte')
  return { default: ThreadSearchResultRowStub }
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
vi.mock('$lib/components/specs/SpecConversationSidebar.svelte', async () => {
  const { default: EmptyStub } = await import('./stubs/EmptyStub.svelte')
  return { default: EmptyStub }
})

import SidebarHarness from './stubs/SidebarHarness.svelte'
import { sidebarState } from '$lib/stores/sidebar.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { WorkspaceSidebarController } from '$lib/components/workspace/WorkspaceSidebarController.svelte'
import { WorkspaceProjectDialogs } from '$lib/components/workspace/WorkspaceProjectDialogs.svelte'
import { ScopeActionsController } from '$lib/components/scope/ScopeActionsController.svelte'
import { SvelteMap } from 'svelte/reactivity'
import type { ComponentProps } from 'svelte'
import type WorkspaceSidebar from '$lib/components/workspace/WorkspaceSidebar.svelte'
import type { Project, Thread, ThreadSearchResult } from '$shared/types'

// The harness owns `mode`, so the props the test supplies are everything else.
type SidebarProps = Omit<ComponentProps<typeof WorkspaceSidebar>, 'mode'>

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
const timelineThreads = [
  thread('alpha-1', 'alpha'),
  thread('alpha-2', 'alpha'),
  thread('beta-1', 'beta')
]

function searchResult(id: string): ThreadSearchResult {
  return { thread: thread(id, 'alpha'), kind: 'title' }
}

/** A search the test holds open, so the in-flight state can be inspected. */
interface HeldSearch {
  resolve: (results: ThreadSearchResult[]) => void
  reject: (reason: unknown) => void
}

/** Searches the controller dispatched, in dispatch order, awaiting an answer. */
const dispatchedSearches: HeldSearch[] = []

/** The search the controller dispatches next, for the test to answer. */
function nextSearch(): HeldSearch {
  const pending = dispatchedSearches.shift()
  if (!pending) throw new Error('No thread search was dispatched')
  return pending
}

/**
 * Every channel answers with nothing; thread search answers only when the test
 * says so, which is what makes the in-flight state observable.
 */
function installInvokeMock(): void {
  invokeMock.mockImplementation(async (channel: string) => {
    if (channel !== 'threads:search') return undefined
    return new Promise<ThreadSearchResult[]>((resolve, reject) => {
      dispatchedSearches.push({ resolve, reject })
    })
  })
}

/** Past the controller's 120 ms debounce, so the search has been dispatched. */
const afterDebounce = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 200)
  })

async function settleRender(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
  flushSync()
}

function sidebarProps(sidebar: WorkspaceSidebarController): SidebarProps {
  const projects = [alpha, beta]
  const projectIcons = new SvelteMap<string, string>()
  return {
    active: true,
    scroller: null,
    projects,
    visibleProjects: projects,
    projectIcons,
    loading: false,
    activeThreadId: 'alpha-1',
    threadsByProject: new SvelteMap([
      ['alpha', [thread('alpha-1', 'alpha'), thread('alpha-2', 'alpha')]],
      ['beta', [thread('beta-1', 'beta')]]
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
    sidebar,
    projectDialogs: new WorkspaceProjectDialogs({
      getProjects: () => projects,
      setProjects: vi.fn(),
      getProjectIcons: () => projectIcons,
      deleteProject: vi.fn(async () => {})
    }),
    scopeActions: new ScopeActionsController({ getProjectId: () => projects[0]?.id ?? null }),
    onSetProjects: vi.fn(),
    onOpenThread: vi.fn(),
    onRename: vi.fn(async () => {}),
    onTogglePin: vi.fn(),
    onDelete: vi.fn(async () => {}),
    onFork: vi.fn(),
    onThreadDrop: vi.fn(async () => {}),
    onPinnedThreadMove: vi.fn(),
    onTimelinePinnedMove: vi.fn(),
    onProjectMove: vi.fn(async () => {}),
    onCreateThread: vi.fn(async () => {}),
    onOpenScopedThread: vi.fn(async () => {}),
    onSwitchScopedProject: vi.fn(async () => {}),
    onLoadProjectThreadsPage: vi.fn(async () => {}),
    onLoadHistoryPage: vi.fn(async () => {}),
    projectHasMoreInDb: () => false
  }
}

function renderSidebar(): {
  target: HTMLElement
  sidebar: WorkspaceSidebarController
  component: ReturnType<typeof mount>
} {
  const sidebar = new WorkspaceSidebarController()
  const target = document.createElement('div')
  document.body.append(target)
  const component = mount(SidebarHarness, {
    target,
    props: { initialMode: 'threads', sidebarProps: sidebarProps(sidebar) }
  })
  return { target, sidebar, component }
}

const timelineRowIds = (target: HTMLElement): string[] =>
  [...target.querySelectorAll<HTMLElement>('[data-thread-row]')].map(
    (row) => row.dataset.threadRow ?? ''
  )

const searchRowIds = (target: HTMLElement): string[] =>
  [...target.querySelectorAll<HTMLElement>('[data-search-result]')].map(
    (row) => row.dataset.searchResult ?? ''
  )

beforeEach(() => {
  document.body.innerHTML = ''
  sidebarState.collapsed = false
  scopeState.clearSidebarContext()
  dispatchedSearches.length = 0
  installInvokeMock()
})

describe('threads-view search panel', () => {
  it('keeps the timeline up until the first result set is ready', async () => {
    const { target, sidebar, component } = renderSidebar()
    await tick()
    expect(timelineRowIds(target)).toEqual(['alpha-1', 'alpha-2', 'beta-1'])

    sidebar.threadsSearchOpen = true
    sidebar.runThreadsSearch('alpha')
    await afterDebounce()
    flushSync()

    // In flight: the rows the reader was on are still the rows on screen, and
    // nothing claims to be searching over an empty list.
    expect(sidebar.threadsSearching).toBe(true)
    expect(timelineRowIds(target)).toEqual(['alpha-1', 'alpha-2', 'beta-1'])
    expect(searchRowIds(target)).toEqual([])
    expect(target.textContent).not.toContain('Searching…')

    nextSearch().resolve([searchResult('alpha-1')])
    await settleRender()

    // Ready: now the panel takes the list over.
    expect(searchRowIds(target)).toEqual(['alpha-1'])
    expect(timelineRowIds(target)).toEqual([])
    expect(sidebar.threadsSearching).toBe(false)

    void unmount(component)
  })

  it('keeps the previous results while the next query is still in flight', async () => {
    const { target, sidebar, component } = renderSidebar()
    await tick()

    sidebar.threadsSearchOpen = true
    sidebar.runThreadsSearch('alpha')
    await afterDebounce()
    nextSearch().resolve([searchResult('alpha-1'), searchResult('alpha-2')])
    await settleRender()
    expect(searchRowIds(target)).toEqual(['alpha-1', 'alpha-2'])

    // The next query is dispatched and never answered, so only what the panel
    // does with the rows it already has can be observed.
    sidebar.runThreadsSearch('alph')
    await afterDebounce()
    flushSync()

    expect(sidebar.threadsSearching).toBe(true)
    expect(searchRowIds(target)).toEqual(['alpha-1', 'alpha-2'])
    expect(timelineRowIds(target)).toEqual([])

    void unmount(component)
  })

  it('puts the timeline back when the query is cleared', async () => {
    const { target, sidebar, component } = renderSidebar()
    await tick()

    sidebar.threadsSearchOpen = true
    sidebar.runThreadsSearch('alpha')
    await afterDebounce()
    nextSearch().resolve([searchResult('alpha-1'), searchResult('alpha-2')])
    await settleRender()
    expect(searchRowIds(target)).toEqual(['alpha-1', 'alpha-2'])

    sidebar.runThreadsSearch('')
    flushSync()

    expect(searchRowIds(target)).toEqual([])
    expect(timelineRowIds(target)).toEqual(['alpha-1', 'alpha-2', 'beta-1'])

    void unmount(component)
  })

  it('leaves the list alone when a search fails', async () => {
    const { target, sidebar, component } = renderSidebar()
    await tick()

    sidebar.threadsSearchOpen = true
    sidebar.runThreadsSearch('alpha')
    await afterDebounce()

    nextSearch().reject(new Error('search channel down'))
    await settleRender()

    // A failed search found nothing out; it must not claim it found no matches.
    expect(sidebar.threadsSearching).toBe(false)
    expect(timelineRowIds(target)).toEqual(['alpha-1', 'alpha-2', 'beta-1'])
    expect(searchRowIds(target)).toEqual([])

    void unmount(component)
  })
})
