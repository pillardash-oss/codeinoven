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
  minimized = $state(false)

  open(target: {
    projectId: string
    projectName: string
    iconUrl?: string | null
    color?: string | null
    group?: string
  }): void {
    this.projectId = target.projectId
    this.projectName = target.projectName
    this.iconUrl = target.iconUrl ?? null
    this.color = target.color ?? null
    this.group = target.group ?? ''
    this.minimized = false
  }

  minimize(): void {
    this.minimized = true
  }

  expand(): void {
    this.minimized = false
  }

  close(): void {
    this.projectId = null
    this.minimized = false
  }
}

export const projectEnvDock = new ProjectEnvDockState()
