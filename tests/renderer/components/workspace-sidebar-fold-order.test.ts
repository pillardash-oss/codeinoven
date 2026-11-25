// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'

/**
 * Where a status group sits once it is folded, and where it sits once it is
 * unfolded again.
 *
 * Folding moves a group to the foot of the list. Unfolding it must not move it
 * back: the reader opened the group to reach the rows the heading hid, so those
 * rows have to appear where the heading was, not somewhere above the list they
 * were reading. The group only returns to its own slot in the status order when
 * a thread inside it becomes the one being worked in.
 *
 * That rule only exists as list order, so it is asserted on the DOM order of the
 * sections the sidebar draws, through the sidebar's own fold toggle.
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
vi.mock('$lib/components/threads/PinnedSection.svelte', async () => {
  const { default: PinnedSectionStub } = await import('./stubs/PinnedSectionGroupStub.svelte')
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

import SidebarFoldHarness from './stubs/SidebarFoldHarness.svelte'
import { sidebarState } from '$lib/stores/sidebar.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import {
  THREAD_GROUPS,
  threadGroupingState,
  type ThreadGroup
} from '$lib/stores/thread-grouping.svelte'
import { WorkspaceSidebarController } from '$lib/components/workspace/WorkspaceSidebarController.svelte'
import { WorkspaceProjectDialogs } from '$lib/components/workspace/WorkspaceProjectDialogs.svelte'
import { ScopeActionsController } from '$lib/components/scope/ScopeActionsController.svelte'
import { SvelteMap } from 'svelte/reactivity'
import type { Project, Thread } from '$shared/types'

function thread(id: string, projectId: string, status: Thread['status']): Thread {
  return {
    id,
    projectId,
    providerId: 'pi',
    title: id,
    titleSource: 'manual',
    status,
    pinned: false,
    archived: false,
    read: true,
    createdAt: 1,
    updatedAt: 1,
    lastActivity: 1,
    workingDirectory: `/tmp/${projectId}`
  }
}

const alpha: Project = {
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

// One thread per status group, so the list draws three sections in the order a
// fresh install arranges them: Errors, Working, Done.
const failedThread = thread('failed-1', 'alpha', 'failed')
const workingThread = thread('working-1', 'alpha', 'working-paused')
const doneThread = thread('done-1', 'alpha', 'completed')
const timelineThreads = [failedThread, workingThread, doneThread]

function props(activeThreadId: string | null) {
  const projects = [alpha]
  const projectIcons = new SvelteMap<string, string>()
  return {
    activeThreadId,
    sidebarProps: {
      active: true,
      scroller: null,
      projects,
      visibleProjects: projects,
      projectIcons,
      loading: false,
      threadsByProject: new SvelteMap([['alpha', timelineThreads]]),
      pinnedThreads: [],
      pinnedProjects: [],
      regularProjects: projects,
      pinnedInboxThreads: [],
      standaloneThreads: [],
      pinnedTimelineThreads: [],
      unpinnedTimelineThreads: timelineThreads,
      draftThreadKeys: new Set<string>(),
      typingThreadKeys: new Set<string>(),
      hasMoreHistory: false,
      historyLoading: false,
      historyPaged: false,
      historyFolded: false,
      projectPageLoading: null,
      sidebar: new WorkspaceSidebarController(),
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
      onThreadMove: vi.fn(),
      onThreadDrop: vi.fn(async () => {}),
      onPinnedThreadMove: vi.fn(),
      onTimelinePinnedMove: vi.fn(),
      onProjectMove: vi.fn(),
      onCreateThread: vi.fn(),
      onOpenScopedThread: vi.fn(),
      onSwitchScopedProject: vi.fn(async () => {}),
      onLoadProjectThreadsPage: vi.fn(async () => {}),
      onShowMoreHistory: vi.fn(async () => {}),
      onCollapseHistory: vi.fn(),
      projectHasMoreInDb: () => false,
      onSelectMode: () => {},
      panelActions: () => []
    }
  }
}

function renderSidebar(activeThreadId: string | null) {
  const target = document.createElement('div')
  document.body.append(target)
  const component = mount(SidebarFoldHarness, {
    target,
    props: {
      ...props(activeThreadId),
      initialMode: 'threads',
      initialActiveThreadId: activeThreadId
    }
  })
  return { target, component }
}

/** The status groups the timeline draws, in the order it draws them. */
const drawnGroups = (pane: Element): (string | null)[] =>
  [...pane.querySelectorAll('[data-group-heading]')].map((heading) =>
    heading.getAttribute('data-group-heading')
  )

const timelineRows = (pane: Element): Set<string> =>
  new Set(
    [...pane.querySelectorAll<HTMLElement>('[data-thread-row]')].map(
      (row) => row.dataset.threadRow ?? ''
    )
  )

function foldToggler(pane: Element, group: ThreadGroup): HTMLButtonElement {
  const heading = pane.querySelector<HTMLButtonElement>(`[data-group-heading="${group}"]`)
  if (!heading) throw new Error(`no heading drawn for ${group}`)
  return heading
}

beforeEach(() => {
  document.body.innerHTML = ''
  sidebarState.collapsed = false
  scopeState.clearSidebarContext()
  // The grouping preference is persisted, so every test starts from the inbox a
  // fresh install shows, with no group folded.
  threadGroupingState.restoreDefaultOrder()
  threadGroupingState.setAllVisible(true)
  for (const group of THREAD_GROUPS) {
    if (threadGroupingState.isFolded(group)) threadGroupingState.toggleFold(group)
  }
  if (!threadGroupingState.enabled) threadGroupingState.toggleEnabled()
})

describe('folded thread groups keep their place in the list', () => {
  it('unfolds a group where it was folded and returns it only when a thread in it is opened', async () => {
    const { target, component } = renderSidebar('done-1')
    await tick()

    const pane = target.querySelector('[data-sidebar-pane="threads"]')
    expect(pane).not.toBeNull()
    if (!pane) throw new Error('the threads pane did not render')
    expect(drawnGroups(pane)).toEqual(['Errors', 'Working', 'Done'])

    // Folding sinks the group to the foot of the list, where the folded block
    // lives, and takes its rows off screen.
    foldToggler(pane, 'Working').click()
    flushSync()
    expect(drawnGroups(pane)).toEqual(['Errors', 'Done', 'Working'])
    expect(timelineRows(pane).has('working-1')).toBe(false)

    // Unfolding brings the rows back exactly where the heading was. It must not
    // slide the group back up under a heading the reader is no longer looking
    // at.
    foldToggler(pane, 'Working').click()
    flushSync()
    expect(drawnGroups(pane)).toEqual(['Errors', 'Done', 'Working'])
    expect(timelineRows(pane).has('working-1')).toBe(true)

    // Opening a thread in the group is what puts it back in its own slot.
    component.setActiveThreadId('working-1')
    flushSync()
    expect(drawnGroups(pane)).toEqual(['Errors', 'Working', 'Done'])

    void unmount(component)
  })

  it('leaves an unfolded group at the foot when a thread elsewhere is opened', async () => {
    const { target, component } = renderSidebar('done-1')
    await tick()

    const pane = target.querySelector('[data-sidebar-pane="threads"]')
    if (!pane) throw new Error('the threads pane did not render')
    foldToggler(pane, 'Errors').click()
    flushSync()
    foldToggler(pane, 'Errors').click()
    flushSync()
    expect(drawnGroups(pane)).toEqual(['Working', 'Done', 'Errors'])

    // Done belongs to a different group, so the docked group keeps its place.
    component.setActiveThreadId('done-1')
    flushSync()
    expect(drawnGroups(pane)).toEqual(['Working', 'Done', 'Errors'])

    void unmount(component)
  })
})
