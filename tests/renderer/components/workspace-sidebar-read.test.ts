// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'

/**
 * Opening an unread thread must take its row out of the Unread heading.
 *
 * The row is grouped by the status it is shown under (see
 * `ThreadOrderSettle.groupingStatuses`), and reading is not a status change, so
 * nothing the settle holds may keep the row where it was. These mount the real
 * sidebar and hand it the next broadcast, the way the workspace does.
 */

const invokeMock = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('$lib/ipc.svelte', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/ipc.svelte')>()
  return { ...actual, invoke: invokeMock, subscribe: vi.fn(() => () => {}) }
})

vi.mock('$lib/components/threads/ThreadRow.svelte', async () => {
  const { default: ThreadRowStub } = await import('./stubs/ThreadRowStub.svelte')
  return { default: ThreadRowStub }
})
// The real section draws a heading and, with `headerOnly`, no rows of its own.
// The stub keeps the heading as a queryable marker so the test can see which
// group a row was drawn under.
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

import SidebarThreadsHarness from './stubs/SidebarThreadsHarness.svelte'
import { sidebarState } from '$lib/stores/sidebar.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { threadGroupingState } from '$lib/stores/thread-grouping.svelte'
import { WorkspaceSidebarController } from '$lib/components/workspace/WorkspaceSidebarController.svelte'
import { WorkspaceProjectDialogs } from '$lib/components/workspace/WorkspaceProjectDialogs.svelte'
import { ScopeActionsController } from '$lib/components/scope/ScopeActionsController.svelte'
import { SvelteMap } from 'svelte/reactivity'
import type { ComponentProps } from 'svelte'
import type WorkspaceSidebar from '$lib/components/workspace/WorkspaceSidebar.svelte'
import type { Project, Thread } from '$shared/types'

type SidebarProps = Omit<ComponentProps<typeof WorkspaceSidebar>, 'mode'>

function thread(id: string, read: boolean): Thread {
  return {
    id,
    projectId: 'alpha',
    providerId: 'pi',
    title: id,
    titleSource: 'manual',
    status: 'completed',
    pinned: false,
    archived: false,
    read,
    createdAt: 1,
    updatedAt: 1,
    lastActivity: 1,
    workingDirectory: '/tmp/alpha'
  }
}

const project: Project = {
  id: 'alpha',
  name: 'Alpha',
  path: '/tmp/alpha',
  source: 'local',
  providerId: 'pi',
  workflowId: 'default',
  threadLimit: 70,
  createdAt: 1,
  updatedAt: 1
}

function props(): SidebarProps {
  const projects = [project]
  const projectIcons = new SvelteMap<string, string>()
  return {
    active: true,
    scroller: null,
    projects,
    visibleProjects: projects,
    projectIcons,
    loading: false,
    activeThreadId: null,
    threadsByProject: new SvelteMap([['alpha', []]]),
    pinnedThreads: [],
    pinnedProjects: [],
    regularProjects: projects,
    pinnedInboxThreads: [],
    standaloneThreads: [],
    pinnedTimelineThreads: [],
    unpinnedTimelineThreads: [],
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
    scopeActions: new ScopeActionsController({ getProjectId: () => project.id }),
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
    onCreateThread: vi.fn(),
    onOpenScopedThread: vi.fn(),
    onSwitchScopedProject: vi.fn(async () => {}),
    onLoadProjectThreadsPage: vi.fn(async () => {}),
    onLoadHistoryPage: vi.fn(async () => {}),
    projectHasMoreInDb: () => false,
    onSelectMode: () => {},
    panelActions: () => []
  }
}

/** The heading each row is drawn under, in the pane's own row order. */
function rowsByHeading(pane: Element | null | undefined): { heading: string; id: string }[] {
  const rows: { heading: string; id: string }[] = []
  if (!pane) return rows
  let heading = ''
  for (const element of pane.querySelectorAll<HTMLElement>(
    '[data-thread-group], [data-thread-row]'
  )) {
    const group = element.dataset.threadGroup
    if (group !== undefined) {
      heading = group
      continue
    }
    rows.push({ heading, id: element.dataset.threadRow ?? '' })
  }
  return rows
}

function render(threads: Thread[]) {
  const target = document.createElement('div')
  document.body.append(target)
  const component = mount(SidebarThreadsHarness, {
    target,
    props: { sidebarProps: props(), threads }
  })
  return {
    target,
    component,
    pane: () => target.querySelector('[data-sidebar-pane="threads"]')
  }
}

beforeEach(() => {
  document.body.innerHTML = ''
  sidebarState.collapsed = false
  scopeState.clearSidebarContext()
  if (!threadGroupingState.enabled) threadGroupingState.toggleEnabled()
  for (const group of [
    'Attention',
    'Drafts',
    'Unread',
    'Errors',
    'Spec',
    'Working',
    'Done'
  ] as const) {
    if (threadGroupingState.isFolded(group)) threadGroupingState.toggleFold(group)
    if (!threadGroupingState.isVisible(group)) threadGroupingState.setVisible(group, true)
  }
})

describe('workspace sidebar: opening an unread thread', () => {
  it('draws it under Done as soon as it is read', async () => {
    const unread = thread('a', false)
    const read = thread('b', true)
    const mounted = render([unread, read])
    await tick()
    flushSync()
    expect(rowsByHeading(mounted.pane())).toEqual([
      { heading: 'Unread', id: 'a' },
      { heading: 'Done', id: 'b' }
    ])

    mounted.component.setThreads([{ ...unread, read: true }, read])
    await tick()
    flushSync()
    expect(rowsByHeading(mounted.pane())).toEqual([
      { heading: 'Done', id: 'a' },
      { heading: 'Done', id: 'b' }
    ])
    unmount(mounted.component)
  })

  it('draws it under Done when the read lands while a retry wait is open', async () => {
    const working = { ...thread('b', true), status: 'executing' as const }
    const unread = thread('a', false)
    const mounted = render([working, unread])
    await tick()
    flushSync()

    // A retry wait holds the list for four seconds; a read is not part of that
    // move and must show the moment it lands.
    threadGroupingState.toggleFold('Done')
    threadGroupingState.toggleFold('Done')
    mounted.component.setThreads([{ ...working, status: 'working-paused' }, unread])
    await tick()
    flushSync()
    mounted.component.setThreads([
      { ...working, status: 'working-paused' },
      { ...unread, read: true }
    ])
    await tick()
    flushSync()
    expect(rowsByHeading(mounted.pane())).toEqual([
      { heading: 'Working', id: 'b' },
      { heading: 'Done', id: 'a' }
    ])
    unmount(mounted.component)
  })
})
