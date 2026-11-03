// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import {
  CONTEXT_SIDEBAR_MAIN_MIN_WIDTH,
  contextSidebarMaxWidth
} from '$lib/stores/context-sidebar.svelte'
import { shapeRunReceipt } from '$shared/run-receipt'
import type { RunReceipt, Thread } from '$shared/types'
import { ASSISTANT_SPACE_ID } from '$shared/types'

vi.mock('$lib/ipc.svelte', () => ({
  invoke: vi.fn(async () => null),
  subscribe: () => () => undefined,
  subscribeGuarded: () => () => undefined
}))

import RunReceiptBlock from '$lib/components/threads/RunReceipt.svelte'

/**
 * The bound rail introduces no new window behaviour.
 *
 * The rail's clamp is a pure function of the viewport, so the conversation's
 * floor can be proven for the three widths the specification names rather than
 * eyeballed: the ceiling is `viewport - 360`, so a clamped rail can never squeeze
 * the conversation below its own floor.
 *
 * The second half is the surface rule: opening verification from a receipt must
 * not add a dialog, drawer or overlay. The receipt is inline, and this asserts it.
 */

describe('rail width at the specification viewports', () => {
  for (const viewport of [1280, 1024, 800]) {
    it(`keeps the conversation at least 360px wide at ${viewport}px`, () => {
      const rail = contextSidebarMaxWidth(viewport)
      expect(rail).toBeLessThanOrEqual(viewport - CONTEXT_SIDEBAR_MAIN_MIN_WIDTH)
      expect(viewport - rail).toBeGreaterThanOrEqual(CONTEXT_SIDEBAR_MAIN_MIN_WIDTH)
    })
  }

  it('records the measured ceilings for the evidence file', () => {
    expect([1280, 1024, 800].map((viewport) => contextSidebarMaxWidth(viewport))).toEqual([
      920, 664, 440
    ])
  })
})

describe('the bound receipt adds no dialog surface', () => {
  let instance: ReturnType<typeof mount> | undefined
  let target: HTMLDivElement | undefined

  afterEach(async () => {
    if (instance) await unmount(instance)
    instance = undefined
    target?.remove()
  })

  it('renders inline, with no dialog role, drawer or overlay', () => {
    const thread: Thread = {
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
    const receipt: RunReceipt = shapeRunReceipt({
      state: 'ready',
      projectId: 'project1',
      threadId: 'run1',
      scope: {
        projectId: 'project1',
        scopeBucketId: 'default',
        scopeName: 'Default',
        branch: 'dev'
      },
      baseSha: 'base1',
      headSha: 'head1',
      readAt: 1
    })
    target = document.createElement('div')
    document.body.append(target)
    instance = mount(RunReceiptBlock, { target, props: { thread, receipt } })
    flushSync()
    expect(target.querySelector('[role="dialog"]')).toBeNull()
    expect(target.querySelector('[role="alertdialog"]')).toBeNull()
    expect(target.querySelector('dialog')).toBeNull()
  })
})
