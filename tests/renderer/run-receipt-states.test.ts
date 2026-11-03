// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import { shapeRunReceipt } from '$shared/run-receipt'
import type { RunReceipt, RunReceiptState, Thread } from '$shared/types'
import { ASSISTANT_SPACE_ID } from '$shared/types'

vi.mock('$lib/ipc.svelte', () => ({
  invoke: vi.fn(async () => null),
  subscribe: () => () => undefined,
  subscribeGuarded: () => () => undefined
}))

import RunReceiptBlock from '$lib/components/threads/RunReceipt.svelte'

/**
 * Every state that is not a finished run says so, and none of them fills in a
 * zero. A zero where nobody looked reads as "nothing changed", which is the one
 * claim a receipt must never make by accident.
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
    boundScope: { projectId: 'project1', scopeBucketId: 'default' },
    createdAt: 1,
    updatedAt: 1,
    lastActivity: 1,
    workingDirectory: '/tmp/project'
  }
}

function receipt(state: RunReceiptState, reason?: string): RunReceipt {
  return shapeRunReceipt({
    state,
    projectId: 'project1',
    threadId: 'run1',
    scope: { projectId: 'project1', scopeBucketId: 'default', scopeName: 'Default', branch: null },
    baseSha: state === 'no-base' ? null : 'base1',
    headSha: null,
    ...(reason === undefined ? {} : { reason }),
    readAt: 1
  })
}

let instance: ReturnType<typeof mount> | undefined
let target: HTMLDivElement | undefined

afterEach(async () => {
  if (instance) await unmount(instance)
  instance = undefined
  target?.remove()
  window.localStorage.clear()
})

function mountState(state: RunReceiptState, reason?: string): HTMLDivElement {
  target = document.createElement('div')
  document.body.append(target)
  instance = mount(RunReceiptBlock, {
    target,
    props: { thread: thread(), receipt: receipt(state, reason) }
  })
  flushSync()
  return target
}

describe('run receipt states', () => {
  it('states a still-running run as running, with no figures', () => {
    const root = mountState('running')
    expect(root.textContent).toContain('has not settled yet')
    expect(root.textContent).toContain('Run in progress')
    expect(root.textContent).not.toContain('Changed in this run')
  })

  it('states a parked run with its reason', () => {
    const root = mountState('parked', 'The managed checkout directory is gone.')
    expect(root.textContent).toContain('The managed checkout directory is gone.')
  })

  it('states a run with no base and explains why it cannot be known', () => {
    const root = mountState('no-base')
    expect(root.textContent).toContain('recorded no starting commit')
    expect(root.textContent).toContain('No starting commit recorded')
    expect(root.textContent).not.toContain('Changed in this run')
  })

  it('states an unreadable receipt with the reason main gave', () => {
    const root = mountState('error', 'fatal: not a git repository')
    expect(root.textContent).toContain('fatal: not a git repository')
    expect(root.textContent).toContain('Could not read')
  })

  it('marks a truncated file list instead of presenting it as complete', () => {
    const truncated = shapeRunReceipt({
      state: 'ready',
      projectId: 'project1',
      threadId: 'run1',
      scope: { projectId: 'project1', scopeBucketId: 'default', scopeName: 'Default', branch: null },
      baseSha: 'base1',
      headSha: 'head1',
      files: [
        { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, binary: false }
      ],
      truncated: { files: true },
      readAt: 1
    })
    target = document.createElement('div')
    document.body.append(target)
    instance = mount(RunReceiptBlock, {
      target,
      props: { thread: thread(), receipt: truncated }
    })
    flushSync()
    expect(target.textContent).toContain('More files than this receipt keeps')
    expect(target.textContent).toContain('1+')
  })

  it('shows no zero-filled placeholders for any non-ready state', () => {
    for (const state of ['running', 'no-base', 'parked', 'error'] as const) {
      const root = mountState(state, 'reason')
      expect(root.textContent).not.toContain('0 files')
      expect(root.textContent).not.toContain('0 commits')
    }
  })
})
