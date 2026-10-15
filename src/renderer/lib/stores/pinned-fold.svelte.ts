import { APP_SLUG } from '$shared/brand'

const STORAGE_KEY = `${APP_SLUG}.pinnedFold.v1`

/** Sidebar sections whose pinned block can be folded. */
export type PinnedSectionKey =
  'threads' | 'projects-threads' | 'projects-projects' | 'chats' | 'assistant'

function loadFolded(): Record<PinnedSectionKey, boolean> {
  const defaults: Record<PinnedSectionKey, boolean> = {
    threads: false,
    'projects-threads': false,
    'projects-projects': false,
    chats: false,
    assistant: false
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
    this.setFolded(section, !this.#folded[section])
  }

  /**
   * Set a section's fold state outright.
   *
   * Folding is the reader's own preference, so this returns early when the
   * section is already in the requested state: a caller that has to open a
   * section to complete an action (a pin revealing its row) must never write a
   * preference the reader did not change, and must not repaint for nothing.
   */
  setFolded(section: PinnedSectionKey, folded: boolean): void {
    if (this.#folded[section] === folded) return
    this.#folded[section] = folded
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
