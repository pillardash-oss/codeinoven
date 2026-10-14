// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { ToastT } from 'svelte-sonner'

// The bridge reaches this through the store graph, which wants a live app
// window; the projection itself is pure and is what this suite exercises.
vi.mock('$lib/stores/memory-proposal-open', () => ({ openMemoryProposal: vi.fn() }))

import { projectStack, projectToast } from '$lib/browser-overlay-bridge'
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
})
