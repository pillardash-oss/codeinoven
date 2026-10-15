// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { ToastT } from 'svelte-sonner'

// The bridge reaches this through the store graph, which wants a live app
// window; the projection itself is pure and is what this suite exercises.
vi.mock('$lib/stores/memory-proposal-open', () => ({ openMemoryProposal: vi.fn() }))

import { projectStack, projectToast } from '$lib/browser-overlay-bridge'
import ClipboardToastIcon from '$lib/components/ui/ClipboardToastIcon.svelte'
import MemoryToastComponent from '$lib/components/ui/MemoryToast.svelte'
import { MAX_OVERLAY_TOASTS } from '$shared/browser-overlay'

/** One live sonner toast, in the shape the app's own call sites produce. */
function toastAt(index: number): ToastT {
  return { id: `toast-${index}`, type: 'success', title: `Toast ${index}` } as unknown as ToastT
}

describe('toast stack projection', () => {
  it('projects a stack within the ceiling whole, newest first', () => {
    const stack = projectStack([toastAt(0), toastAt(1)], 'dark')
    expect(stack.toasts.map((entry) => entry.id)).toEqual(['toast-0', 'toast-1'])
    expect(stack.theme).toBe('dark')
  })

  /**
   * The renderer's half of the same guarantee: what it hands the boundary is
   * bounded, so a session that accumulated more live toasts than the overlay can
   * draw still publishes the newest ones rather than losing the whole stack.
   */
  it('projects only the newest cards when sonner holds more than the ceiling', () => {
    const live = Array.from({ length: MAX_OVERLAY_TOASTS + 4 }, (_, index) => toastAt(index))
    const stack = projectStack(live, 'light')
    expect(stack.toasts).toHaveLength(MAX_OVERLAY_TOASTS)
    expect(stack.toasts[0]?.id).toBe('toast-0')
    expect(stack.toasts.at(-1)?.id).toBe(`toast-${MAX_OVERLAY_TOASTS - 1}`)
  })

  it('drops a card the overlay cannot draw rather than bounding the stack around it', () => {
    expect(projectToast({ id: 'x' } as unknown as ToastT)).toBeNull()
  })

  /**
   * The regression this guards: a card's icon travels as a token, because the
   * component the app renderer holds cannot cross to the window that draws the
   * cards. Projected without it, a copy confirmation reached the overlay as a
   * plain card with no mark at all, and the memory proposal lost its icon as a
   * `memory` kind the main-process kind set quietly rewrote to `default`.
   */
  it('projects the icon a card carries as a token', () => {
    const copy = projectToast({
      id: 'copy',
      type: 'default',
      title: 'Copied to clipboard',
      icon: ClipboardToastIcon
    } as unknown as ToastT)
    expect(copy).toMatchObject({ kind: 'default', icon: 'clipboard' })
  })

  it('projects an icon outside its own registry as no icon rather than guessing', () => {
    const plain = projectToast({
      id: 'plain',
      type: 'default',
      title: 'Copied to clipboard',
      icon: class Unregistered {}
    } as unknown as ToastT)
    expect(plain?.icon).toBeUndefined()
  })

  /**
   * The memory proposal is raised as a component, so it is projected from its own
   * props: the one card whose text is not a string still arrives with the icon
   * that tells it apart, and with the button and accent it has always carried.
   */
  it('projects a memory proposal as a plain card that leads with the memory icon', () => {
    const memory = projectToast({
      id: 'memory',
      type: 'default',
      component: MemoryToastComponent,
      componentProps: {
        message: 'CodeInOven found a preference worth remembering.',
        projectId: 'project-1',
        threadId: 'thread-1'
      }
    } as unknown as ToastT)
    expect(memory).toMatchObject({
      kind: 'default',
      icon: 'memory',
      title: 'CodeInOven found a preference worth remembering.',
      action: { label: 'Review Memory' }
    })
  })
})
