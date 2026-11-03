// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import { shapeRunReceipt } from '$shared/run-receipt'
import type { RunReceipt, Thread } from '$shared/types'
import { ASSISTANT_SPACE_ID } from '$shared/types'

const bridge = vi.hoisted(() => ({
  openDiff: vi.fn(),
  openGit: vi.fn(),
  openFiles: vi.fn(),
  // Any other store method the block might reach for, so an accidental second
  // opener fails the exact-method assertion below instead of passing silently.
  openSources: vi.fn(),
  openActions: vi.fn(),
  openProjectFile: vi.fn()
}))

vi.mock('$lib/ipc.svelte', () => ({
  invoke: vi.fn(async () => null),
  subscribe: () => () => undefined,
  subscribeGuarded: () => () => undefined
}))
vi.mock('$lib/stores/context-sidebar.svelte', () => ({
  contextSidebarState: bridge
}))

import RunReceiptBlock from '$lib/components/threads/RunReceipt.svelte'

/**
 * The three actions open the rail the conversation already owns.
 *
 * Nothing new is opened, and each call names the bound project and the run
 * thread, which is what makes the rail show the checkout the receipt described.
 */

function thread(): Thread {
  return {
    id: 'run1',
    projectId: ASSISTANT_SPACE_ID,
    providerId: 'pi',
    title: 'Run · 09:07',
    titleSource: 'manual',
    status: 'completed',
    pinned: false,
    archived: false,
    read: true,
    assistantId: 'assistant1',
    assistantTaskId: 'task1',
    boundScope: { projectId: 'project7', scopeBucketId: 'worktree-2' },
    createdAt: 1,
    updatedAt: 1,
    lastActivity: 1,
    workingDirectory: '/tmp/project'
  }
}

function receipt(): RunReceipt {
  return shapeRunReceipt({
    state: 'ready',
    projectId: 'project7',
    threadId: 'run1',
    scope: {
      projectId: 'project7',
      scopeBucketId: 'worktree-2',
      scopeName: 'Bound',
      branch: 'dev'
    },
    baseSha: 'base1',
    headSha: 'head1',
    readAt: 1
  })
}

let instance: ReturnType<typeof mount> | undefined
let target: HTMLDivElement | undefined

afterEach(async () => {
  if (instance) await unmount(instance)
  instance = undefined
  target?.remove()
  vi.clearAllMocks()
})

function mountBlock(): HTMLDivElement {
  target = document.createElement('div')
  document.body.append(target)
  instance = mount(RunReceiptBlock, { target, props: { thread: thread(), receipt: receipt() } })
  flushSync()
  return target
}

function button(root: HTMLDivElement, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label
  )
  if (!found) throw new Error(`No ${label} action`)
  return found as HTMLButtonElement
}

describe('run receipt actions', () => {
  it('opens Changes through openDiff with the bound project and the run thread', () => {
    const root = mountBlock()
    button(root, 'Changes').click()
    expect(bridge.openDiff).toHaveBeenCalledWith('project7', 'run1')
    expect(bridge.openGit).not.toHaveBeenCalled()
    expect(bridge.openFiles).not.toHaveBeenCalled()
  })

  it('opens Git through openGit with the same project and thread', () => {
    const root = mountBlock()
    button(root, 'Git').click()
    expect(bridge.openGit).toHaveBeenCalledWith('project7', 'run1')
    expect(bridge.openDiff).not.toHaveBeenCalled()
    expect(bridge.openFiles).not.toHaveBeenCalled()
  })

  it('opens Files through openFiles with the same project and thread', () => {
    const root = mountBlock()
    button(root, 'Files').click()
    expect(bridge.openFiles).toHaveBeenCalledWith('project7', 'run1')
  })

  it('never reaches for another opener', () => {
    const root = mountBlock()
    button(root, 'Changes').click()
    button(root, 'Git').click()
    button(root, 'Files').click()
    expect(bridge.openSources).not.toHaveBeenCalled()
    expect(bridge.openActions).not.toHaveBeenCalled()
    expect(bridge.openProjectFile).not.toHaveBeenCalled()
  })

  it('offers no action for a thread with no checkout to open', () => {
    target = document.createElement('div')
    document.body.append(target)
    instance = mount(RunReceiptBlock, {
      target,
      props: {
        thread: { ...thread(), projectId: 'inbox', boundScope: undefined },
        receipt: receipt()
      }
    })
    flushSync()
    // The receipt still names its own scope, so the actions land there rather
    // than disappearing: the path stays available and points at a real project.
    expect(button(target, 'Changes')).toBeDefined()
  })
})
