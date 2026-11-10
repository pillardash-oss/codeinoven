/**
 * The floating env editor a project row opens.
 *
 * The project tree and the file explorer both know the project (and sometimes the
 * directory) they are about, so they open this dock with the identity already in
 * hand instead of navigating away from the work the user was doing.
 */
class ProjectEnvDockState {
  /** The project being edited, null while the panel is closed. */
  projectId = $state<string | null>(null)
  projectName = $state('')
  iconUrl = $state<string | null>(null)
  color = $state<string | null>(null)
  /** Project-relative directory group being edited, '' for the project root. */
  group = $state('')
  /** The file to open, when the caller already knows which one it means. */
  fileName = $state<string | null>(null)
  /** A key to bring into view once the file loads, set by a `cio://` link. */
  focusName = $state<string | null>(null)
  /** Bumped by every open, so a dock that is already mounted re-reads its target. */
  sequence = $state(0)
  minimized = $state(false)

  open(target: {
    projectId: string
    projectName: string
    iconUrl?: string | null
    color?: string | null
    group?: string
    fileName?: string | null
    focusName?: string | null
  }): void {
    this.projectId = target.projectId
    this.projectName = target.projectName
    this.iconUrl = target.iconUrl ?? null
    this.color = target.color ?? null
    this.group = target.group ?? ''
    this.fileName = target.fileName ?? null
    this.focusName = target.focusName ?? null
    this.sequence += 1
    this.minimized = false
  }

  /** Read the pending key once, so a later render does not move focus again. */
  takeFocusName(): string | null {
    const name = this.focusName
    this.focusName = null
    return name
  }

  minimize(): void {
    this.minimized = true
  }

  expand(): void {
    this.minimized = false
  }

  close(): void {
    this.projectId = null
    this.fileName = null
    this.focusName = null
    this.minimized = false
  }
}

export const projectEnvDock = new ProjectEnvDockState()
