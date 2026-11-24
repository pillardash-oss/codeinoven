import { APP_SLUG } from '$shared/brand'

/**
 * The floating env editors the project tree and the file explorer open.
 *
 * The project tree and the file explorer both know the project (and sometimes the
 * directory) they are about, so they open a dock with the identity already in
 * hand instead of navigating away from the work the user was doing.
 *
 * One project owns one dock, and opening a second project never replaces the
 * first: secrets of several projects are edited side by side, exactly the way
 * pull request drafts keep one sheet per project. Only a second open of the same
 * project re-targets the dock that project already has.
 */

/** What a caller hands `open` when it wants an env file on screen. */
export interface ProjectEnvDockOpenTarget {
  projectId: string
  projectName: string
  iconUrl?: string | null
  color?: string | null
  /** Project-relative directory group being edited, '' for the project root. */
  group?: string
  /** The file to open, when the caller already knows which one it means. */
  fileName?: string | null
  /** A key to bring into view once the file loads, set by a `cio://` link. */
  focusName?: string | null
}

/** One open env editor, owned by the project it edits. */
export interface ProjectEnvDockEntry {
  /** Both the key and the storage identity: one dock per project. */
  id: string
  projectId: string
  projectName: string
  iconUrl: string | null
  color: string | null
  group: string
  fileName: string | null
  /** A key to bring into view once the file loads, set by a `cio://` link. */
  focusName: string | null
  /** Bumped by every open, so a dock that is already mounted re-reads its target. */
  sequence: number
  minimized: boolean
}

class ProjectEnvDockState {
  /** Every open dock, in the order the user opened them. */
  docks = $state<ProjectEnvDockEntry[]>([])

  get minimizedCount(): number {
    return this.docks.filter((dock) => dock.minimized).length
  }

  /** The docks whose chips the shared row draws. */
  get minimized(): ProjectEnvDockEntry[] {
    return this.docks.filter((dock) => dock.minimized)
  }

  /**
   * Open the dock one project owns, or re-target the one it already has.
   *
   * Returns the dock's id. A project that is already open keeps its panel, its
   * unsaved drafts, and its place on screen; only its target moves.
   */
  open(target: ProjectEnvDockOpenTarget): string {
    const id = target.projectId
    const existing = this.docks.find((dock) => dock.id === id)
    if (existing) {
      this.update(id, {
        projectName: target.projectName,
        iconUrl: target.iconUrl ?? null,
        color: target.color ?? null,
        group: target.group ?? '',
        fileName: target.fileName ?? null,
        focusName: target.focusName ?? null,
        sequence: existing.sequence + 1,
        minimized: false
      })
      return id
    }
    const dock: ProjectEnvDockEntry = {
      id,
      projectId: target.projectId,
      projectName: target.projectName,
      iconUrl: target.iconUrl ?? null,
      color: target.color ?? null,
      group: target.group ?? '',
      fileName: target.fileName ?? null,
      focusName: target.focusName ?? null,
      sequence: 1,
      minimized: false
    }
    this.docks = [...this.docks, dock]
    return id
  }

  /**
   * Point an open dock at another stored file.
   *
   * The dock stays mounted while its project is open, so the file picker writes
   * the target here and the panel re-reads it through its sequence effect.
   */
  select(id: string, target: { group: string; fileName: string }): void {
    const dock = this.docks.find((candidate) => candidate.id === id)
    if (!dock) return
    this.update(id, {
      group: target.group,
      fileName: target.fileName,
      focusName: null,
      sequence: dock.sequence + 1
    })
  }

  /** Read the pending key once, so a later render does not move focus again. */
  takeFocusName(id: string): string | null {
    const dock = this.docks.find((candidate) => candidate.id === id)
    const name = dock?.focusName ?? null
    if (name !== null) this.update(id, { focusName: null })
    return name
  }

  minimize(id: string): void {
    this.update(id, { minimized: true })
  }

  expand(id: string): void {
    this.update(id, { minimized: false })
  }

  close(id: string): void {
    this.docks = this.docks.filter((dock) => dock.id !== id)
  }

  /** Where this dock remembers its panel rectangle and its chip's edge. */
  storageKeyFor(id: string): string {
    return `${APP_SLUG}.projectEnvDock.${id}.v1`
  }

  private update(id: string, patch: Partial<ProjectEnvDockEntry>): void {
    this.docks = this.docks.map((dock) => (dock.id === id ? { ...dock, ...patch } : dock))
  }
}

export const projectEnvDock = new ProjectEnvDockState()
