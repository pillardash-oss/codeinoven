// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount, unmount } from 'svelte'
import ComposerQueuedCard from '$lib/components/threads/ComposerQueuedCard.svelte'
import type { QueuedRowSummary } from '$lib/components/threads/ComposerQueuedCard/queued-row'

/**
 * The queue card lists every waiting message in send order, and the order is
 * something the reader changes. These tests pin the two things the card owes the
 * reader: one gripper per queued message, and a keyboard path that asks for the
 * move the gripper's drag would make.
 */

const rows: QueuedRowSummary[] = [
  { id: 'message-1', text: 'First in line', attachments: 0, waitsOn: 0 },
  { id: 'message-2', text: 'Second in line', attachments: 2, waitsOn: 1 },
  { id: 'message-3', text: '', attachments: 0, waitsOn: 0 }
]

function mountCard(queue: QueuedRowSummary[]): {
  target: HTMLElement
  reorders: Array<{ id: string; targetIndex: number }>
  destroy: () => void
} {
  const target = document.createElement('div')
  document.body.append(target)
  const reorders: Array<{ id: string; targetIndex: number }> = []
  const component = mount(ComposerQueuedCard, {
    target,
    props: {
      text: 'First in line',
      hasContent: true,
      attachments: [],
      previewUrls: {},
      queue,
      promptReferences: [],
      presentation: undefined,
      startAfterThreads: [],
      steerModifierLabel: '⌘',
      threadId: 'thread-1',
      onSteer: () => {},
      onEdit: () => {},
      onDelete: () => {},
      onDeleteAll: () => {},
      onReorder: (id: string, targetIndex: number) => reorders.push({ id, targetIndex }),
      onAddStartAfter: () => {},
      onRemoveStartAfter: () => {},
      onOpenStartAfter: () => {},
      onPreloadStartAfter: () => {}
    }
  })
  return { target, reorders, destroy: () => void unmount(component) }
}

function grippers(target: HTMLElement): HTMLButtonElement[] {
  return Array.from(target.querySelectorAll<HTMLButtonElement>('button[aria-label^="Move queued"]'))
}

describe('ComposerQueuedCard queue order', () => {
  it('gives every queued message its own gripper, numbered in send order', () => {
    const { target, destroy } = mountCard(rows)
    const handles = grippers(target)
    expect(handles).toHaveLength(rows.length)
    expect(handles[0].getAttribute('aria-label')).toContain('Move queued message 1 of 3')
    expect(handles[2].getAttribute('aria-label')).toContain('Move queued message 3 of 3')
    // The message behind the head shows what it carries and what holds it back.
    expect(target.textContent).toContain('Second in line')
    expect(target.textContent).toContain('Carries files or context only')
    destroy()
  })

  it('moves a message one place with the arrow keys', () => {
    const { target, reorders, destroy } = mountCard(rows)
    const handles = grippers(target)
    handles[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    handles[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    // Any other key leaves the order alone: typing inside the card is not a move.
    handles[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(reorders).toEqual([
      { id: 'message-1', targetIndex: 1 },
      { id: 'message-3', targetIndex: 1 }
    ])
    destroy()
  })

  it('offers one gripper for a single queued message, which cannot move anywhere', () => {
    const { target, reorders, destroy } = mountCard([rows[0]])
    const handles = grippers(target)
    expect(handles).toHaveLength(1)
    handles[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    // The card asks for the move; the store is what clamps it to the queue.
    expect(reorders).toEqual([{ id: 'message-1', targetIndex: -1 }])
    destroy()
  })
})
