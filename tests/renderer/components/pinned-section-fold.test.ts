// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'

/**
 * The pinned block folds like every other fold in the app.
 *
 * A status group's rows animate on fold because the sidebar drops them from its
 * own keyed list, and that list's `animate:` carries the motion. The pinned
 * block owns its rows instead, so it has to carry the transition itself: without
 * one, `{#if !folded}` tears the list out on the fold frame and the section
 * blinks shut while the group beside it slides.
 *
 * These tests lock the difference in. A block with a transition keeps its rows in
 * the DOM after the fold, because Svelte holds an outro-ing block until the
 * animation finishes; a bare conditional removes them in the same flush.
 *
 * The block is driven through the store rather than the controlled `folded`
 * prop, which is the path every sidebar call site actually uses (they pass
 * `headerOnly`, or nothing at all, and let the store own the fold).
 */

const invokeMock = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('$lib/ipc.svelte', () => ({
  invoke: invokeMock,
  subscribe: vi.fn(() => () => {})
}))

// The real row drags in the whole store graph and writes a great deal of DOM.
// This test is about the block that holds the rows, so it holds a marker instead:
// one stable node per thread, which is enough to see whether the block is still
// on screen.
vi.mock('$lib/components/threads/ThreadRow.svelte', async () => {
  const { default: ThreadRowStub } = await import('./stubs/ThreadRowStub.svelte')
  return { default: ThreadRowStub }
})

import PinnedSection from '$lib/components/threads/PinnedSection.svelte'
import { pinnedFold } from '$lib/stores/pinned-fold.svelte'
import type { Thread } from '$shared/types'

// jsdom ships no `Element.animate`, which a Svelte `transition:` drives. The stub
// leaves the animation in flight forever (its `onfinish` is never called), which
// is exactly the state these tests assert: an outro-ing block whose rows are
// still mounted. Without it the slide throws instead of running, and a bare
// `{#if}` would still be indistinguishable from a transitioned one.
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

function thread(id: string): Thread {
  return {
    id,
    projectId: 'alpha',
    providerId: 'pi',
    title: id,
    titleSource: 'manual',
    status: 'completed',
    pinned: true,
    archived: false,
    read: true,
    createdAt: 1,
    updatedAt: 1,
    lastActivity: 1,
    workingDirectory: '/tmp/alpha'
  }
}

function render() {
  const target = document.createElement('div')
  document.body.append(target)
  const component = mount(PinnedSection, {
    target,
    props: {
      sectionKey: 'threads',
      label: 'Pinned Threads',
      threads: [thread('p1'), thread('p2')],
      activeThreadId: null,
      detailed: true,
      onOpen: vi.fn(),
      onRename: vi.fn(async () => {}),
      onTogglePin: vi.fn(),
      onDelete: vi.fn(async () => {}),
      onFork: vi.fn()
    }
  })
  flushSync()
  return { target, component }
}

const rowCount = (target: HTMLElement) => target.querySelectorAll('[data-thread-row]').length

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('the pinned block fold', () => {
  it('holds its rows on the fold frame instead of blinking them away', async () => {
    pinnedFold.setFolded('threads', false)
    const { target, component } = render()
    await tick()
    expect(rowCount(target)).toBe(2)

    // Fold it. The block has an outro now, so Svelte keeps its rows mounted on
    // this frame while the list slides shut. A bare `{#if}` would already have
    // removed them in this same flush.
    pinnedFold.setFolded('threads', true)
    flushSync()
    expect(rowCount(target)).toBe(2)

    void unmount(component)
  })

  it('opens from a folded start without a fold-frame delay', async () => {
    pinnedFold.setFolded('threads', true)
    const { target, component } = render()
    flushSync()
    expect(rowCount(target)).toBe(0)

    pinnedFold.setFolded('threads', false)
    flushSync()
    expect(rowCount(target)).toBe(2)

    void unmount(component)
  })
})
