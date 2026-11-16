// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'codeinoven.assistantTabOrder.v1'

/**
 * The store reads its arrangement once, at module load, exactly as it does when
 * the renderer boots. Importing it fresh is what proves a drag survives a
 * restart instead of only living in the module that wrote it.
 */
async function freshStore(): Promise<
  (typeof import('$lib/stores/assistant-tab-order.svelte'))['assistantTabOrder']
> {
  vi.resetModules()
  const module = await import('$lib/stores/assistant-tab-order.svelte')
  return module.assistantTabOrder
}

beforeEach(() => {
  window.localStorage.clear()
})

describe('the assistant tab strip arrangement', () => {
  it('has no opinion until the user drags a tab', async () => {
    const store = await freshStore()
    expect(store.orderFor('assistant-1', 'open')).toEqual([])
    expect(store.orderFor('assistant-1', 'pinned')).toEqual([])
  })

  it('remembers the group it was given, and keeps the two groups apart', async () => {
    const store = await freshStore()
    store.place('assistant-1', 'open', ['thread-c', 'thread-a', 'thread-b'])
    expect(store.orderFor('assistant-1', 'open')).toEqual(['thread-c', 'thread-a', 'thread-b'])
    expect(store.orderFor('assistant-1', 'pinned')).toEqual([])

    store.place('assistant-1', 'pinned', ['thread-p2', 'thread-p1'])
    expect(store.orderFor('assistant-1', 'pinned')).toEqual(['thread-p2', 'thread-p1'])
    expect(store.orderFor('assistant-1', 'open')).toEqual(['thread-c', 'thread-a', 'thread-b'])
    expect(store.orderFor('another-assistant', 'open')).toEqual([])
  })

  it('returns the arrangement a previous session persisted', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        'assistant-1': { pinned: ['thread-p'], open: ['thread-b', 'thread-a'] }
      })
    )
    const store = await freshStore()
    expect(store.orderFor('assistant-1', 'open')).toEqual(['thread-b', 'thread-a'])
    expect(store.orderFor('assistant-1', 'pinned')).toEqual(['thread-p'])
  })

  it('ignores a corrupt or half-written entry instead of reordering the strip', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ 'assistant-1': { open: ['thread-a', 7, null], pinned: 'nonsense' } })
    )
    const store = await freshStore()
    expect(store.orderFor('assistant-1', 'open')).toEqual(['thread-a'])
    expect(store.orderFor('assistant-1', 'pinned')).toEqual([])
  })

  it('does not rewrite storage when a drop lands where it already was', async () => {
    const store = await freshStore()
    store.place('assistant-1', 'open', ['thread-a', 'thread-b'])
    const written = window.localStorage.getItem(STORAGE_KEY)
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    store.place('assistant-1', 'open', ['thread-a', 'thread-b'])
    expect(setItem).not.toHaveBeenCalled()
    expect(window.localStorage.getItem(STORAGE_KEY)).toEqual(written)
    setItem.mockRestore()
  })
})
