import { SvelteSet } from 'svelte/reactivity'
import { APP_SLUG } from '$shared/brand'

const STORAGE_KEY = `${APP_SLUG}.timelinePins.v1`

function load(): SvelteSet<string> {
  if (typeof window === 'undefined') return new SvelteSet()
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return new SvelteSet()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new SvelteSet()
    return new SvelteSet(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0))
  } catch {
    return new SvelteSet()
  }
}

class TimelinePinsStore {
  pins = $state(load())

  isPinned(threadId: string): boolean {
    return this.pins.has(threadId)
  }

  toggle(threadId: string): void {
    if (this.pins.has(threadId)) {
      this.pins.delete(threadId)
    } else {
      this.pins.add(threadId)
    }
    this.persist()
  }

  persist(): void {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.pins]))
    } catch {
      // Pins are cosmetic; unavailable storage must not break the app.
    }
  }
}

export const timelinePins = new TimelinePinsStore()
