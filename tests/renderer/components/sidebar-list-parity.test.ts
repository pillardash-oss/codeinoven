// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'
import type { Assistant, Project, Thread } from '$shared/types'

/**
 * The list work is shared, and these tests are what keep it shared.
 *
 * The threads timeline got bounded mounting (`RowPageBudget`), a measured reflow
 * (`ListRowReflow` over `SidebarListRow`'s `data-row-key`), and an order settle.
 * Chats and the assistant sidebar must get the same, and these tests mount the
 * real sidebars to prove they do: each list caps its mounted rows at one page,
 * every row sits on the reflow grid, and the rest is one click away.
 *
 * A new list that forgets the shared layer fails here, which is the whole point:
 * the memory and the motion are supposed to be a property of "a sidebar list",
 * not something each list author remembers.
 */

const invokeMock = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('$lib/ipc.svelte', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/ipc.svelte')>()
  return { ...actual, invoke: invokeMock, subscribe: vi.fn(() => () => {}) }
})

// Leaf components are stubbed so the tests exercise the list structure, not the
// rows' own contents. Each stub draws the marker the test reads.
vi.mock('$lib/components/threads/ThreadRow.svelte', async () => {
  const { default: ThreadRowStub } = await import('./stubs/ThreadRowStub.svelte')
  return { default: ThreadRowStub }
})
vi.mock('$lib/components/threads/PinnedSection.svelte', async () => {
  const { default: PinnedSectionStub } = await import('./stubs/PinnedSectionStub.svelte')
  return { default: PinnedSectionStub }
})
vi.mock('$lib/components/assistant/AssistantRow.svelte', async () => {
  const { default: AssistantRowStub } = await import('./stubs/AssistantRowStub.svelte')
  return { default: AssistantRowStub }
})
vi.mock('$lib/components/assistant/AssistantTaskRow.svelte', async () => {
  const { default: AssistantTaskRowStub } = await import('./stubs/AssistantTaskRowStub.svelte')
  return { default: AssistantTaskRowStub }
})
vi.mock('$lib/components/workspace/FolderRow.svelte', async () => {
  const { default: EmptyStub } = await import('./stubs/EmptyStub.svelte')
  return { default: EmptyStub }
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
vi.mock('$lib/components/assistant/AssistantEditModal.svelte', async () => {
  const { default: EmptyStub } = await import('./stubs/EmptyStub.svelte')
  return { default: EmptyStub }
})

import SidebarHarness from './stubs/SidebarHarness.svelte'
import AssistantSidebar from '$lib/components/assistant/AssistantSidebar.svelte'
import { sidebarState } from '$lib/stores/sidebar.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { WorkspaceSidebarController } from '$lib/components/workspace/WorkspaceSidebarController.svelte'
import { WorkspaceProjectDialogs } from '$lib/components/workspace/WorkspaceProjectDialogs.svelte'
import { ScopeActionsController } from '$lib/components/scope/ScopeActionsController.svelte'
import { THREAD_LIST_PAGE_SIZE } from '$lib/components/shared/RowPageBudget.svelte'
import { SvelteMap } from 'svelte/reactivity'

function thread(id: string, projectId: string, extra: Partial<Thread> = {}): Thread {
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
    workingDirectory: `/tmp/${projectId}`,
    ...extra
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

function assistant(id: string, name: string): Assistant {
  return {
    id,
    name,
    knowledge: '',
    connections: [],
    createdAt: 1,
    updatedAt: 1
  }
}

/** The row wrapper `SidebarListRow` draws, which the reflow measures by. */
const reflowRows = (scope: ParentNode): HTMLElement[] => [
  ...scope.querySelectorAll<HTMLElement>('[data-row-key]')
]

/** The show-more / show-less control a paged list draws under its rows. */
const pageControl = (scope: ParentNode, label: 'more' | 'less'): HTMLButtonElement | undefined =>
  [...scope.querySelectorAll('button')].find((button) =>
    button.textContent
      ?.trim()
      .toLowerCase()
      .includes(label === 'more' ? ' more' : 'show less')
  )

beforeEach(() => {
  document.body.innerHTML = ''
  sidebarState.collapsed = false
  scopeState.clearSidebarContext()
})

describe('chats list parity', () => {
  const chats = Array.from({ length: 20 }, (_, index) => thread(`chat-${index}`, 'inbox'))

  function renderSidebar(
    mode: 'chats' | 'threads',
    lists: { standaloneThreads?: Thread[]; unpinnedTimelineThreads?: Thread[] }
  ): { target: HTMLElement; close: () => void } {
    const target = document.createElement('div')
    document.body.append(target)
    const projects = [project('alpha', 'Alpha')]
    const projectIcons = new SvelteMap<string, string>()
    const component = mount(SidebarHarness, {
      target,
      props: {
        initialMode: mode,
        sidebarProps: {
          active: true,
          scroller: null,
          projects,
          visibleProjects: projects,
          projectIcons,
          loading: false,
          activeThreadId: null,
          threadsByProject: new SvelteMap(),
          pinnedThreads: [],
          pinnedProjects: [],
          regularProjects: projects,
          pinnedInboxThreads: [],
          standaloneThreads: lists.standaloneThreads ?? [],
          pinnedTimelineThreads: [],
          unpinnedTimelineThreads: lists.unpinnedTimelineThreads ?? [],
          draftThreadKeys: new Set<string>(),
          typingThreadKeys: new Set<string>(),
          hasMoreHistory: false,
          historyLoading: false,
          projectPageLoading: null,
          sidebar: new WorkspaceSidebarController(),
          projectDialogs: new WorkspaceProjectDialogs({
            getProjects: () => projects,
            setProjects: vi.fn(),
            getProjectIcons: () => projectIcons,
            deleteProject: vi.fn(async () => {})
          }),
          scopeActions: new ScopeActionsController({ getProjectId: () => 'alpha' }),
          onSetProjects: vi.fn(),
          onOpenThread: vi.fn(),
          onRename: vi.fn(async () => {}),
          onTogglePin: vi.fn(),
          onDelete: vi.fn(async () => {}),
          onFork: vi.fn(),
          onThreadDrop: vi.fn(async () => {}),
          onPinnedThreadMove: vi.fn(),
          onTimelinePinnedMove: vi.fn(),
          onProjectMove: vi.fn(),
          onCreateThread: vi.fn(async () => {}),
          onOpenScopedThread: vi.fn(async () => {}),
          onSwitchScopedProject: vi.fn(async () => {}),
          onLoadProjectThreadsPage: vi.fn(async () => {}),
          onLoadHistoryPage: vi.fn(async () => {}),
          projectHasMoreInDb: () => false
        }
      }
    })
    return { target, close: () => void unmount(component) }
  }

  it('mounts one page of chats and puts every row on the reflow grid', async () => {
    const { target, close } = renderSidebar('chats', { standaloneThreads: chats })
    await tick()

    const pane = target.querySelector('[data-sidebar-pane="chats"]')
    expect(pane).not.toBeNull()
    const rows = reflowRows(pane!)
    expect(rows).toHaveLength(THREAD_LIST_PAGE_SIZE)
    // The wrapper is what the reflow measures; a bare row cannot travel.
    for (const row of pane!.querySelectorAll('[data-thread-row]')) {
      expect(row.closest('[data-row-key]')).not.toBeNull()
    }
    close()
  })

  it('reveals the rest one page at a time and can drop back', async () => {
    const { target, close } = renderSidebar('chats', { standaloneThreads: chats })
    await tick()

    const pane = target.querySelector('[data-sidebar-pane="chats"]')!
    const showMore = pageControl(pane, 'more')
    expect(showMore?.textContent).toContain('5')

    showMore!.click()
    flushSync()
    expect(reflowRows(pane)).toHaveLength(chats.length)
    expect(pageControl(pane, 'more')).toBeUndefined()

    pageControl(pane, 'less')!.click()
    flushSync()
    expect(reflowRows(pane)).toHaveLength(THREAD_LIST_PAGE_SIZE)
    close()
  })

  it('keeps the threads timeline on the same reflow grid', async () => {
    const timeline = Array.from({ length: 20 }, (_, index) =>
      thread(`timeline-${index}`, 'alpha', { lastActivity: 20 - index })
    )
    const { target, close } = renderSidebar('threads', { unpinnedTimelineThreads: timeline })
    await tick()

    const pane = target.querySelector('[data-sidebar-pane="threads"]')!
    const rows = pane.querySelectorAll('[data-thread-row]')
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.closest('[data-row-key]')).not.toBeNull()
    }
    close()
  })
})

describe('assistant sidebar parity', () => {
  const a1 = assistant('a1', 'Triage')
  const tasks = Array.from({ length: 20 }, (_, index) =>
    thread(`task-${index}`, 'assistant', { assistantId: 'a1' })
  )

  function renderAssistant(): { target: HTMLElement; close: () => void } {
    const target = document.createElement('div')
    document.body.append(target)
    const noop = vi.fn(async () => {})
    const component = mount(AssistantSidebar, {
      target,
      props: {
        assistants: [a1],
        tasks,
        runsByTask: new Map(),
        runsByAssistant: new Map(),
        // Selecting a task opens its assistant, so the rows below are on screen.
        selectedThreadId: tasks[0].id,
        onOpenTask: vi.fn(),
        onOpenTaskKnowledge: vi.fn(),
        onOpenAssistantKnowledge: vi.fn(),
        onCreateTaskInAssistant: vi.fn(),
        onRenameTask: noop,
        onTogglePinTask: vi.fn(),
        onDeleteTask: noop,
        onForkTask: vi.fn(),
        onOpenTaskNotes: vi.fn(),
        onHandedOffTask: vi.fn(),
        onHideKnowledge: vi.fn(),
        onDeleteAssistant: noop,
        onHasAssistantRunsToday: vi.fn(async () => false),
        onSkipNextAssistantRun: noop,
        onSkipAssistantRunsToday: noop,
        onTogglePinAssistant: vi.fn(),
        onMoveAssistant: vi.fn(),
        onAssignTask: vi.fn()
      }
    })
    return { target, close: () => void unmount(component) }
  }

  it('mounts one page of an assistant\u2019s tasks and puts every row on the reflow grid', async () => {
    const { target, close } = renderAssistant()
    await tick()

    const rows = reflowRows(target)
    expect(rows).toHaveLength(THREAD_LIST_PAGE_SIZE)
    for (const row of target.querySelectorAll('[data-assistant-task-row]')) {
      expect(row.closest('[data-row-key]')).not.toBeNull()
    }
    close()
  })

  it('reveals the rest of an assistant\u2019s tasks one page at a time', async () => {
    const { target, close } = renderAssistant()
    await tick()

    const showMore = pageControl(target, 'more')
    expect(showMore?.textContent).toContain('5')

    showMore!.click()
    flushSync()
    expect(reflowRows(target)).toHaveLength(tasks.length)

    pageControl(target, 'less')!.click()
    flushSync()
    expect(reflowRows(target)).toHaveLength(THREAD_LIST_PAGE_SIZE)
    close()
  })
})
