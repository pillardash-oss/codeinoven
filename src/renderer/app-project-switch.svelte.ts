import { SvelteMap } from 'svelte/reactivity'
import { FolderKanban } from '@lucide/svelte'
import type { ActionDefinition, ActionSelection } from '$lib/actions'
import { projectLocationLabel } from '$lib/project-location'
import { scopeState } from '$lib/stores/scope.svelte'
import type { Project } from '$shared/types'
import { actionId } from './app-palette-actions'

interface ProjectSwitchTarget {
  project: Project
}

export interface ProjectSwitchPaletteDeps {
  /** Focus the picked project: the shell owns the view switch and the thread it lands on. */
  focusProject: (project: Project) => void | Promise<void>
}

/**
 * Reactive state machine behind the Switch project spotlight: the local project
 * list rendered as palette rows (project icon, accent colour, location, and a
 * "Current" marker on the project the shell is already focused on), plus the
 * focus call for the picked project.
 *
 * The list is built when the palette opens rather than reactively: it is a
 * transient modal picker, and the project set only changes through flows that
 * close it first (create, remove).
 */
export class ProjectSwitchPaletteController {
  paletteOpen = $state(false)
  actions = $state<ActionDefinition[]>([])

  private readonly targets = new SvelteMap<ActionDefinition['id'], ProjectSwitchTarget>()

  constructor(private readonly deps: ProjectSwitchPaletteDeps) {}

  openPalette(): void {
    this.buildRows()
    this.paletteOpen = true
  }

  close(): void {
    this.paletteOpen = false
    this.actions = []
    this.targets.clear()
  }

  select(selection: ActionSelection): void {
    const target = this.targets.get(selection.action.id)
    if (!target) return
    this.close()
    void this.deps.focusProject(target.project)
  }

  /** One row per project, in workspace order, so the list doubles as a
   *  "where am I" answer through its Current marker. */
  private buildRows(): void {
    this.targets.clear()
    const activeProjectId = scopeState.activeProjectId
    this.actions = scopeState.projectRecords.map((project): ActionDefinition => {
      const id = actionId(`project:${project.id}`)
      this.targets.set(id, { project })

      const location = projectLocationLabel(project)
      const isActive = project.id === activeProjectId
      const iconUrl = scopeState.projects.find((candidate) => candidate.id === project.id)?.iconUrl

      return {
        id,
        title: project.name,
        description: isActive
          ? location
            ? `Current project · ${location}`
            : 'Current project'
          : location || undefined,
        category: 'project',
        source: {
          id: `project:${project.id}`,
          label: project.name,
          kind: 'app',
          ...(project.color ? { color: project.color } : {})
        },
        // The project name is already the row title, so the source badge would
        // only repeat it.
        showSourceBadge: false,
        icon: FolderKanban,
        ...(iconUrl ? { iconUri: iconUrl } : {}),
        ...(isActive ? { status: { label: 'Current' } } : {}),
        keywords: [project.name, project.path, project.host ?? '', location].filter(
          (value): value is string => Boolean(value)
        )
      }
    })
  }
}
