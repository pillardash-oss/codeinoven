// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import ComposerQueuedCard from '$lib/components/threads/ComposerQueuedCard.svelte'
import type { QueuedRowSummary } from '$lib/components/threads/ComposerQueuedCard/queued-row'

/**
 * The queue card lists every waiting message in send order, and the order is
 * something the reader changes. These tests pin the two things the card owes the
 * reader: one gripper per queued message, and a keyboard path that asks for the
 * move the gripper's drag would make.
 */

const rows: QueuedRowSummary[] = [
  { id: 'message-1', text: 'First in line', attachments: 0, waitsOn: 0, hasPresentation: false },
  { id: 'message-2', text: 'Second in line', attachments: 2, waitsOn: 1, hasPresentation: false },
  { id: 'message-3', text: '', attachments: 0, waitsOn: 0, hasPresentation: true }
]

function mountCard(queue: QueuedRowSummary[]): {
  target: HTMLElement
  reorders: Array<{ id: string; targetIndex: number }>
  sends: string[]
  edits: string[]
  deletes: string[]
  headEdits: number
  headDeletes: number
  deleteAlls: number
  destroy: () => void
} {
  const target = document.createElement('div')
  document.body.append(target)
  const reorders: Array<{ id: string; targetIndex: number }> = []
  const sends: string[] = []
  const edits: string[] = []
  const deletes: string[] = []
  const counters = { headEdits: 0, headDeletes: 0, deleteAlls: 0 }
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
      onSendQueued: (id: string) => sends.push(id),
      onEdit: () => {
        counters.headEdits += 1
      },
      onEditQueued: (id: string) => edits.push(id),
      onDelete: () => {
        counters.headDeletes += 1
      },
      onDeleteQueued: (id: string) => deletes.push(id),
      onDeleteAll: () => {
        counters.deleteAlls += 1
      },
      onReorder: (id: string, targetIndex: number) => reorders.push({ id, targetIndex }),
      onAddStartAfter: () => {},
      onRemoveStartAfter: () => {},
      onOpenStartAfter: () => {},
      onPreloadStartAfter: () => {}
    }
  })
  return {
    target,
    reorders,
    sends,
    edits,
    deletes,
    get headEdits() {
      return counters.headEdits
    },
    get headDeletes() {
      return counters.headDeletes
    },
    get deleteAlls() {
      return counters.deleteAlls
    },
    destroy: () => void unmount(component)
  }
}

function buttonWithLabel(target: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.getAttribute('aria-label') === label
    ) ?? null
  )
}

function buttonStartingWith(target: HTMLElement, prefix: string): HTMLButtonElement[] {
  return Array.from(target.querySelectorAll<HTMLButtonElement>('button')).filter((button) =>
    (button.getAttribute('aria-label') ?? '').startsWith(prefix)
  )
}

async function click(element: HTMLElement | null): Promise<void> {
  if (!element) throw new Error('The control to click is not rendered')
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  // Svelte applies the state change the click made on the next flush.
  await tick()
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

  it('keeps Send now in the head while a single message is queued', async () => {
    const { target, destroy } = mountCard([rows[0]])
    expect(target.textContent).toContain('Send now')
    // One message needs no per-row controls: its head carries them.
    expect(buttonStartingWith(target, 'Send queued message')).toHaveLength(0)
    expect(buttonStartingWith(target, 'Actions for queued message')).toHaveLength(0)

    await click(buttonWithLabel(target, 'Queued message actions'))
    const items = Array.from(target.querySelectorAll('[role="menuitem"]')).map((item) =>
      item.textContent?.trim()
    )
    expect(items).toEqual(['Edit', 'Delete'])
    destroy()
  })

  it('moves Send now onto every row once more than one message waits', async () => {
    const { target, sends, edits, deletes, deleteAlls, destroy } = mountCard(rows)
    // The head button is gone, so nothing sends the whole queue at once.
    expect(target.textContent).not.toContain('Send now')
    const rowSends = buttonStartingWith(target, 'Send queued message')
    expect(rowSends).toHaveLength(rows.length)

    await click(rowSends[1])
    expect(sends).toEqual(['message-2'])

    // The head's menu only empties the queue; each row edits and deletes itself.
    await click(buttonWithLabel(target, 'Queued message actions'))
    expect(
      Array.from(target.querySelectorAll('[role="menuitem"]')).map((item) =>
        item.textContent?.trim()
      )
    ).toEqual(['Delete all (3)'])
    await click(buttonWithLabel(target, 'Close menu'))
    expect(deleteAlls).toBe(0)

    const rowMenus = buttonStartingWith(target, 'Actions for queued message')
    expect(rowMenus).toHaveLength(rows.length)
    await click(rowMenus[1])
    const rowItems = Array.from(target.querySelectorAll('[role="menuitem"]')).map((item) =>
      item.textContent?.trim()
    )
    expect(rowItems).toEqual(['Edit', 'Delete'])

    const rowMenuItems = Array.from(target.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    await click(rowMenuItems[0])
    expect(edits).toEqual(['message-2'])

    await click(rowMenus[2])
    const thirdMenuItems = Array.from(
      target.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    )
    // A row that carries a presentation instead of text has nothing to edit.
    expect(thirdMenuItems.map((item) => item.textContent?.trim())).toEqual(['Delete'])
    await click(thirdMenuItems[0])
    expect(deletes).toEqual(['message-3'])
    destroy()
  })
})
