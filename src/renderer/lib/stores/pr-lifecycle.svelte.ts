import { APP_SLUG } from '$shared/brand'
import { DEFAULT_SCOPE_BUCKET_ID } from '$shared/types'

/** Live status a minimized PR draft reports to its dock chip. */
export type PrDockStatus = 'draft' | 'working' | 'attention' | 'composed' | 'created'

/** What a PR modal shows for itself while docked (project identity + state). */
export interface PrDockDescriptor {
  projectName: string
  iconUrl: string | null
  status: PrDockStatus
  title: string
}

export interface PrDraft {
  id: string
  projectId: string
  scopeBucketId: string
  threadId: string
  minimized: boolean
  createdAt: number
  /** Live dock descriptor reported by the sheet; rendered by the host dock. */
  dock: PrDockDescriptor
}

/**
 * App-wide PR compose lifecycle — mirrors `HarnessLifecycleStore` so the
 * "New pull request" panel survives thread / project / view navigation and
 * the git sidebar being hidden. One draft per project scope is mounted
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
   * Open (or focus) a PR draft for one project scope. Sibling scopes own
   * separate drafts because they may point at different worktrees and branches.
   */
  open(projectId: string, threadId: string, scopeBucketId = DEFAULT_SCOPE_BUCKET_ID): string {
    const existing = this.drafts.find(
      (draft) => draft.projectId === projectId && draft.scopeBucketId === scopeBucketId
    )
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
      scopeBucketId,
      threadId,
      minimized: false,
      createdAt: Date.now(),
      dock: { projectName: '', iconUrl: null, status: 'draft', title: 'New pull request' }
    }
    this.drafts = [...this.drafts, draft]
    this.focusedId = draft.id
    return draft.id
  }

  /** Always create a new draft, even if one already exists for the project. */
  openNew(projectId: string, threadId: string, scopeBucketId = DEFAULT_SCOPE_BUCKET_ID): string {
    const draft: PrDraft = {
      id: crypto.randomUUID(),
      projectId,
      scopeBucketId,
      threadId,
      minimized: false,
      createdAt: Date.now(),
      dock: { projectName: '', iconUrl: null, status: 'draft', title: 'New pull request' }
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

  /** Current dock descriptor for a draft, or null when the draft is gone. */
  dockFor(id: string): PrDockDescriptor | null {
    return this.drafts.find((draft) => draft.id === id)?.dock ?? null
  }

  /**
   * Update the live dock descriptor a sheet reports to the host dock. The write
   * is idempotent: when every field is unchanged the drafts array is left
   * untouched so no re-render cascades back into the sheet's reporting effect.
   */
  updateDock = (id: string, patch: Partial<PrDockDescriptor>): void => {
    const current = this.drafts.find((draft) => draft.id === id)?.dock
    if (!current) return
    const merged = { ...current, ...patch }
    if (
      merged.projectName === current.projectName &&
      merged.iconUrl === current.iconUrl &&
      merged.status === current.status &&
      merged.title === current.title
    ) {
      return
    }
    this.drafts = this.drafts.map((draft) => (draft.id === id ? { ...draft, dock: merged } : draft))
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
