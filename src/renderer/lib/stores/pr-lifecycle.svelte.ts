import { APP_SLUG } from '$shared/brand'

export interface PrDraft {
  id: string
  projectId: string
  threadId: string
  minimized: boolean
  createdAt: number
}

/**
 * App-wide PR compose lifecycle — mirrors `HarnessLifecycleStore` so the
 * "New pull request" panel survives thread / project / view navigation and
 * the git sidebar being hidden. One draft per `open()` call is mounted
 * globally by `PrDockHost` and rendered regardless of the active context tab.
 */
class PrLifecycleStore {
  drafts = $state<PrDraft[]>([])
  focusedId = $state<string | null>(null)

  get count(): number {
    return this.drafts.length
  }

  get minimizedCount(): number {
    return this.drafts.filter((draft) => draft.minimized).length
  }

  /**
   * Open (or focus) a PR draft for the project. If a draft for that
   * project already exists it is expanded and focused instead of creating
   * a duplicate — call `openNew` when a second draft for the same project
   * is intentionally desired.
   */
  open(projectId: string, threadId: string): string {
    const existing = this.drafts.find((draft) => draft.projectId === projectId)
    if (existing) {
      this.drafts = this.drafts.map((draft) =>
        draft.id === existing.id ? { ...draft, threadId, minimized: false } : draft
      )
      this.focusedId = existing.id
      return existing.id
    }
    const draft: PrDraft = {
      id: crypto.randomUUID(),
      projectId,
      threadId,
      minimized: false,
      createdAt: Date.now()
    }
    this.drafts = [...this.drafts, draft]
    this.focusedId = draft.id
    return draft.id
  }

  /** Always create a new draft, even if one already exists for the project. */
  openNew(projectId: string, threadId: string): string {
    const draft: PrDraft = {
      id: crypto.randomUUID(),
      projectId,
      threadId,
      minimized: false,
      createdAt: Date.now()
    }
    this.drafts = [...this.drafts, draft]
    this.focusedId = draft.id
    return draft.id
  }

  minimize = (id: string): void => {
    this.drafts = this.drafts.map((draft) =>
      draft.id === id ? { ...draft, minimized: true } : draft
    )
  }

  expand = (id: string): void => {
    this.drafts = this.drafts.map((draft) =>
      draft.id === id ? { ...draft, minimized: false } : draft
    )
    this.focusedId = id
  }

  expandAll = (): void => {
    this.drafts = this.drafts.map((draft) => ({ ...draft, minimized: false }))
    this.focusedId = null
  }

  focus = (id: string): void => {
    this.expand(id)
  }

  close = (id: string): void => {
    this.drafts = this.drafts.filter((draft) => draft.id !== id)
    if (this.focusedId === id) this.focusedId = null
  }

  closeAll = (): void => {
    this.drafts = []
    this.focusedId = null
  }

  storageKeyFor(id: string): string {
    return `${APP_SLUG}.pullRequestSheet.${id}.v1`
  }
}

export const prLifecycleStore = new PrLifecycleStore()
