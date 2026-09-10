import { APP_SLUG } from '$shared/brand'

const STORAGE_KEY = `${APP_SLUG}.pinnedFold.v1`

/** Sidebar sections whose pinned block can be folded. */
export type PinnedSectionKey = 'threads' | 'projects-threads' | 'projects-projects' | 'chats'

function loadFolded(): Record<PinnedSectionKey, boolean> {
  const defaults: Record<PinnedSectionKey, boolean> = {
    threads: false,
    'projects-threads': false,
    'projects-projects': false,
    chats: false
  }
  if (typeof window === 'undefined') return defaults
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaults
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return defaults
    const record = parsed as Record<string, unknown>
    for (const key of Object.keys(defaults) as PinnedSectionKey[]) {
      if (typeof record[key] === 'boolean') defaults[key] = record[key]
    }
    return defaults
  } catch {
    return defaults
  }
}

/**
 * Whether each sidebar pinned section is folded (children hidden). Persisted
 * per section in localStorage, so the fold state survives across sessions.
 */
class PinnedFoldStore {
  #folded = $state<Record<PinnedSectionKey, boolean>>(loadFolded())

  isFolded(section: PinnedSectionKey): boolean {
    return this.#folded[section]
  }

  toggle(section: PinnedSectionKey): void {
    this.#folded[section] = !this.#folded[section]
    this.persist()
  }

  private persist(): void {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.#folded))
    } catch {
      // The preference is optional; unavailable storage must not break the UI.
    }
  }
}

export const pinnedFold = new PinnedFoldStore()
