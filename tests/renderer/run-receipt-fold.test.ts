// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import { shapeRunReceipt } from '$shared/run-receipt'
import { threadCardFold } from '$lib/stores/thread-card-fold.svelte'
import type { RunReceipt, Thread } from '$shared/types'
import { ASSISTANT_SPACE_ID } from '$shared/types'

vi.mock('$lib/ipc.svelte', () => ({
  invoke: vi.fn(async () => null),
  subscribe: () => () => undefined,
  subscribeGuarded: () => () => undefined
}))

import RunReceiptBlock from '$lib/components/threads/RunReceipt.svelte'

/**
 * The block starts open and remembers a fold.
 *
 * A receipt that starts folded is a receipt nobody reads, so "open" is the
 * default rather than a stored value, and only a choice the reader made is kept.
 */

const THREAD_ID = 'run1'

function thread(): Thread {
  return {
    id: THREAD_ID,
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

function receipt(): RunReceipt {
  return shapeRunReceipt({
    state: 'ready',
    projectId: 'project1',
    threadId: THREAD_ID,
    scope: { projectId: 'project1', scopeBucketId: 'default', scopeName: 'Default', branch: 'dev' },
    baseSha: 'base1',
    headSha: 'head1',
    commits: [{ hash: 'head1', shortHash: 'head1', subject: 'a', author: 'Ada', at: 1 }],
    files: [
      { path: 'src/a.ts', status: 'modified', additions: 2, deletions: 0, binary: false },
      { path: 'src/b.ts', status: 'added', additions: 1, deletions: 0, binary: false }
    ],
    checks: [{ command: 'bun run test', outcome: 'passed' }],
    readAt: 1
  })
}

let instance: ReturnType<typeof mount> | undefined
let target: HTMLDivElement | undefined

beforeEach(() => {
  window.localStorage.clear()
  // The store reads storage once at module load, so a fresh thread id per case
  // keeps each case's fold decision its own.
})

afterEach(async () => {
  if (instance) await unmount(instance)
  instance = undefined
  target?.remove()
})

function mountBlock(threadId = THREAD_ID): HTMLDivElement {
  target?.remove()
  target = document.createElement('div')
  document.body.append(target)
  const props = { thread: { ...thread(), id: threadId }, receipt: { ...receipt(), threadId } }
  instance = mount(RunReceiptBlock, { target, props })
  flushSync()
  return target
}

describe('run receipt fold', () => {
  it('starts open, with the facts on screen', () => {
    const root = mountBlock('fold-default')
    expect(root.querySelector('dl')).not.toBeNull()
    expect(root.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true')
  })

  it('folds to one line that still states the totals', async () => {
    const root = mountBlock('fold-toggle')
    const toggle = root.querySelector<HTMLButtonElement>('button[aria-expanded]')
    toggle?.click()
    flushSync()
    expect(root.querySelector('dl')).toBeNull()
    // The summary line is the fold's whole statement, so it has to carry counts.
    expect(root.textContent).toContain('2 files +3')
    expect(root.textContent).toContain('1 commit')
    expect(root.textContent).toContain('1 check passed')
    // The choice belongs to this thread only.
    expect(threadCardFold.isFolded('fold-toggle', 'run-receipt', false)).toBe(true)
    expect(threadCardFold.isFolded('another-thread', 'run-receipt', false)).toBe(false)
  })

  it('keeps a fold across a remount of the same thread', async () => {
    const root = mountBlock('fold-remount')
    root.querySelector<HTMLButtonElement>('button[aria-expanded]')?.click()
    flushSync()
    await unmount(instance as ReturnType<typeof mount>)
    instance = undefined
    const remounted = mountBlock('fold-remount')
    expect(remounted.querySelector('dl')).toBeNull()
    expect(remounted.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe(
      'false'
    )
  })

  it('opens again when the reader unfolds it', () => {
    const root = mountBlock('fold-reopen')
    root.querySelector<HTMLButtonElement>('button[aria-expanded]')?.click()
    flushSync()
    root.querySelector<HTMLButtonElement>('button[aria-expanded]')?.click()
    flushSync()
    expect(root.querySelector('dl')).not.toBeNull()
    expect(threadCardFold.isFolded('fold-reopen', 'run-receipt', false)).toBe(false)
  })
})
