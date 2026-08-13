import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cacheHasDeployments, cachedHasDeployments } from './git-deployments-cache'

interface LocalStorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

let store: Map<string, string>

const localStorageMock: LocalStorageLike = {
  getItem: vi.fn((key: string) => store.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => {
    store.set(key, value)
  })
}

beforeEach(() => {
  store = new Map()
  ;(localStorageMock.getItem as ReturnType<typeof vi.fn>).mockClear()
  ;(localStorageMock.setItem as ReturnType<typeof vi.fn>).mockClear()
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage: localStorageMock },
    configurable: true,
    writable: true
  })
})

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('sidebar deployment visibility (git-deployments-cache)', () => {
  it('returns true for a project known to have deployments, so its Deployments tab is shown', () => {
    cacheHasDeployments('proj-with-deployments', true)

    expect(cachedHasDeployments('proj-with-deployments')).toBe(true)
  })

  it('returns false for a project known to have no deployments, so its Deployments tab is hidden', () => {
    cacheHasDeployments('proj-without-deployments', false)

    expect(cachedHasDeployments('proj-without-deployments')).toBe(false)
  })

  it('returns null when nothing is known yet for a project', () => {
    expect(cachedHasDeployments('never-seen-project')).toBeNull()
  })

  it('isolates the visibility flag per project (no cross-project collision)', () => {
    cacheHasDeployments('proj-with-deployments', true)
    cacheHasDeployments('proj-without-deployments', false)

    expect(cachedHasDeployments('proj-with-deployments')).toBe(true)
    expect(cachedHasDeployments('proj-without-deployments')).toBe(false)
  })

  it('survives a re-read from the backing storage (persisted between mounts)', () => {
    cacheHasDeployments('proj-with-deployments', true)

    expect(cachedHasDeployments('proj-with-deployments')).toBe(true)
    expect(localStorageMock.setItem).toHaveBeenCalled()
  })

  it('does not rewrite storage when the flag is unchanged', () => {
    cacheHasDeployments('proj-with-deployments', true)
    const writes = (localStorageMock.setItem as ReturnType<typeof vi.fn>).mock.calls.length

    cacheHasDeployments('proj-with-deployments', true)

    expect((localStorageMock.setItem as ReturnType<typeof vi.fn>).mock.calls.length).toBe(writes)
  })

  it('ignores non-boolean persisted values instead of trusting them', () => {
    cacheHasDeployments('proj-a', true)
    store.set('codeinoven.git-deployments.v1', JSON.stringify({ 'proj-a': 'truthy-string' }))

    expect(cachedHasDeployments('proj-a')).toBeNull()
  })
})
