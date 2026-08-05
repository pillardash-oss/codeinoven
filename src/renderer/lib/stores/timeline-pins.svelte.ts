import { APP_SLUG } from '$shared/brand'

const STORAGE_KEY = `${APP_SLUG}.timelinePins.v1`

function load(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0))
  } catch {
    return new Set()
  }
}

class TimelinePinsStore {
  pins = $state(load())

  isPinned(threadId: string): boolean {
    return this.pins.has(threadId)
  }

  toggle(threadId: string): void {
    const next = new Set(this.pins)
    if (next.has(threadId)) {
      next.delete(threadId)
    } else {
      next.add(threadId)
    }
    this.pins = next
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
