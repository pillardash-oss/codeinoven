import { APP_SLUG } from '$shared/brand'

const STORAGE_KEY = `${APP_SLUG}.threadProjectFilter.v1`

function load(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.filter((id): id is string => typeof id === 'string')
    }
  } catch {
    // Corrupt or unavailable storage must not break the threads view.
  }
  return []
}

/**
 * Persisted project filter for the Threads view.
 *
 * An empty selection means "all projects" (the default). Any explicit subset
 * limits the visible threads to those projects. The selection survives
 * restarts through localStorage, mirroring `thread-sort.svelte.ts`.
 */
class ThreadProjectFilterStore {
  selectedIds = $state<string[]>(load())

  /** True when no explicit subset is chosen, so every project shows. */
  get isAll(): boolean {
    return this.selectedIds.length === 0
  }

  /** True when the given project passes the current filter. */
  matches(projectId: string): boolean {
    return this.isAll || this.selectedIds.includes(projectId)
  }

  setSelection(projectIds: string[]): void {
    this.selectedIds = projectIds
    this.persist()
  }

  persist(): void {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.selectedIds))
    } catch {
      // Filter preference is optional; unavailable storage must not break the app.
    }
  }
}

export const threadProjectFilterState = new ThreadProjectFilterStore()
