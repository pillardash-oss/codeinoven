// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'

/**
 * The trace hands the viewport over the moment the reader works inside it.
 *
 * A live trace appends a row per step, and its body grows the transcript with
 * it. The tail follower is what re-anchors a reader at the bottom, and it reads
 * a growing scroller as "still following": the reader who opened a tool call
 * mid-run got pulled to the new bottom on the resize their own expansion
 * caused, then again for every step that arrived after it. The card they were
 * reading slid off the top of the screen each time.
 *
 * The trace tells the conversation about the reader's gesture instead, so the
 * scroller can hand the viewport over   and a height-bounded reply body stops
 * following its own tail, which is the same yank inside a group bubble.
 */

const invokeMock = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('$lib/ipc.svelte', () => ({
  invoke: invokeMock,
  subscribe: vi.fn(() => () => {}),
  subscribeGuarded: vi.fn(() => () => {})
}))

// jsdom ships no `ResizeObserver`, which Svelte's `bind:clientHeight` drives.
// The trace never measures anything these assertions read.
if (typeof globalThis.ResizeObserver !== 'function') {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    writable: true,
    configurable: true,
    value: class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  })
}

// jsdom ships no `Element.animate`, which every Svelte `transition:` drives.
if (typeof Element.prototype.animate !== 'function') {
  Object.defineProperty(Element.prototype, 'animate', {
    writable: true,
    configurable: true,
    value: () => ({
      onfinish: null,
      cancel: () => {},
      finish: () => {},
      addEventListener: () => {},
      removeEventListener: () => {}
    })
  })
}

import WorkingTrace from '$lib/components/threads/WorkingTrace.svelte'
import type { AgentPart } from '$shared/types'

const toolPart: AgentPart = {
  type: 'tool',
  id: 'tool-1',
  messageID: 'message-1',
  callID: 'call-1',
  tool: 'bash',
  state: { status: 'completed', input: { command: 'ls' }, output: 'a.txt' }
}

/** A counter that gives every mount its own conversation scope. */
let mountCount = 0

function mountTrace(
  props: {
    onReaderClaimsViewport?: () => void
    bodyMaxHeightRem?: number
    open?: boolean
  } = {}
): { target: HTMLElement; destroy: () => void; toggles: unknown[][] } {
  // Each mount gets its own conversation: step expansion is remembered per
  // scope for the visit, so a shared scope would carry a card's open state from
  // one case into the next.
  const scope = `scope-${(mountCount += 1)}`
  const target = document.createElement('div')
  document.body.append(target)
  const toggles: unknown[][] = []
  const component = mount(WorkingTrace, {
    target,
    props: {
      parts: [toolPart],
      open: props.open ?? true,
      busy: true,
      projectId: 'project-1',
      threadId: scope,
      bodyMaxHeightRem: props.bodyMaxHeightRem,
      onReaderClaimsViewport: props.onReaderClaimsViewport,
      onToggle: (open: boolean, userOpened: boolean, userFolded: boolean) => {
        toggles.push([open, userOpened, userFolded])
      }
    }
  })
  return {
    target,
    toggles,
    destroy: () => {
      void unmount(component)
      target.remove()
    }
  }
}

function toggleButton(target: HTMLElement): HTMLButtonElement {
  const button = target.querySelector<HTMLButtonElement>(
    'button[title="Show tool details"], button[title="Hide tool details"]'
  )
  if (!button) throw new Error('the tool call row is not mounted')
  return button
}

function summaryButton(target: HTMLElement): HTMLButtonElement {
  const button = target.querySelector<HTMLButtonElement>('button[aria-expanded]')
  if (!button) throw new Error('the trace header is not mounted')
  return button
}

describe('WorkingTrace reader interaction', () => {
  beforeEach(() => {
    invokeMock.mockClear()
  })

  it('tells the conversation the reader took the viewport when they open a tool call', async () => {
    const onReaderClaimsViewport = vi.fn()
    const trace = mountTrace({ onReaderClaimsViewport })
    await tick()

    toggleButton(trace.target).click()
    flushSync()

    expect(onReaderClaimsViewport).toHaveBeenCalledTimes(1)
    trace.destroy()
  })

  it('claims the viewport in a height-bounded reply body too', async () => {
    const onReaderClaimsViewport = vi.fn()
    const trace = mountTrace({ onReaderClaimsViewport, bodyMaxHeightRem: 14 })
    await tick()

    toggleButton(trace.target).click()
    flushSync()

    expect(onReaderClaimsViewport).toHaveBeenCalledTimes(1)
    trace.destroy()
  })

  it('keeps reporting the reader claim on a later step, not only the first', async () => {
    const onReaderClaimsViewport = vi.fn()
    const trace = mountTrace({ onReaderClaimsViewport })
    await tick()

    toggleButton(trace.target).click()
    flushSync()
    toggleButton(trace.target).click()
    flushSync()

    expect(onReaderClaimsViewport).toHaveBeenCalledTimes(2)
    trace.destroy()
  })

  it('claims the viewport when the reader opens the trace body itself', async () => {
    const onReaderClaimsViewport = vi.fn()
    const trace = mountTrace({ onReaderClaimsViewport, open: false })
    await tick()

    summaryButton(trace.target).click()
    flushSync()

    expect(onReaderClaimsViewport).toHaveBeenCalledTimes(1)
    expect(trace.toggles).toEqual([[true, true, false]])
    trace.destroy()
  })
})
