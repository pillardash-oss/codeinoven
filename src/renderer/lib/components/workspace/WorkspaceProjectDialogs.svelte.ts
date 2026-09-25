import { SvelteMap } from 'svelte/reactivity'
import { invoke } from '$lib/ipc.svelte'
import { getProjectIcon } from '$lib/project-icons'
import { scopeState } from '$lib/stores/scope.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import type { Project } from '$shared/types'

export interface WorkspaceProjectDialogsOptions {
  /** Live project records the dialogs read and rewrite. */
  getProjects: () => Project[]
  setProjects: (next: Project[]) => void
  /** Icon data-URL cache keyed by project id. */
  getProjectIcons: () => SvelteMap<string, string>
  /** Deletes a project (optionally erasing its folder)   owned by the shell. */
  deleteProject: (projectId: string, deleteFolder?: boolean) => Promise<void>
}

/**
 * Owns the workspace's project dialogs: the edit-project form and the two-step
 * remove-project confirmation, so `Workspace.svelte` keeps only the sidebar
 * actions that open them.
 */
export class WorkspaceProjectDialogs {
  private readonly options: WorkspaceProjectDialogsOptions

  // Remove-project confirmation
  showRemoveModal = $state(false)
  removeTarget = $state<Project | null>(null)
  /** Folder-erasure switch for the remove-project modal. Always starts off. */
  removeDeleteFolder = $state(false)
  /** Second-confirmation modal shown when folder erasure is requested. */
  showRemoveFinalConfirm = $state(false)
  /** Project currently being deleted in the background; guards repeat clicks. */
  deletingProjectId = $state<string | null>(null)

  // Edit-project modal
  showEditModal = $state(false)
  editProject = $state<Project | null>(null)
  editProjectName = $state('')
  editProjectColor = $state<string | undefined>()
  editProjectIconType = $state<string | undefined>()
  editProjectPendingIcon = $state<{ path: string; dataUrl: string } | undefined>()

  constructor(options: WorkspaceProjectDialogsOptions) {
    this.options = options
  }

  askEditProject(projectId: string): void {
    const project = this.options.getProjects().find((p) => p.id === projectId)
    if (!project) return
    this.editProject = project
    this.editProjectName = project.name
    this.editProjectColor = project.color
    this.editProjectIconType = project.iconType
    this.editProjectPendingIcon = undefined
    this.showEditModal = true
  }

  closeEditProject(): void {
    this.showEditModal = false
  }

  async confirmEditProject(e?: SubmitEvent): Promise<void> {
    e?.preventDefault()
    const editProject = this.editProject
    if (!editProject || !this.editProjectName.trim()) return

    const patch = {
      name: this.editProjectName.trim(),
      color: this.editProjectColor,
      iconType: this.editProjectIconType
    }
    let updated: Project

    if (this.editProjectPendingIcon) {
      // Persist the new image, then the appearance the form holds. An image wins
      // the preview, but the colour and icon type still save so a colour picked
      // in the same session is never dropped.
      await invoke('project:setIcon', editProject.id, this.editProjectPendingIcon.path)
      updated = await invoke('project:update', editProject.id, patch)
    } else {
      const hadCustomIcon = !!editProject.icon
      // Only clear a custom image when switching to an SVG icon type.
      const switchingToSvgIcon =
        this.editProjectIconType !== editProject.iconType && this.editProjectIconType !== undefined

      if (hadCustomIcon && switchingToSvgIcon) {
        await invoke('project:clearIcon', editProject.id)
      }

      updated = await invoke('project:update', editProject.id, patch)
    }

    this.options.setProjects(
      this.options.getProjects().map((p) => (p.id === updated.id ? updated : p))
    )

    // Refresh icon cache
    const projectIcons = this.options.getProjectIcons()
    if (updated.icon) {
      const url = await invoke('project:getIcon', updated.id)
      if (url) projectIcons.set(updated.id, url)
      else projectIcons.delete(updated.id)
    } else {
      projectIcons.delete(updated.id)
    }

    // Sync the workspace store's active project so the header icon updates immediately
    if (workspaceState.activeProject?.id === updated.id) {
      workspaceState.activeProject = updated
    }

    // Sync the scope store so scope tabs and scope-sidebar project info refresh
    scopeState.projectRecords = scopeState.projectRecords.map((p) =>
      p.id === updated.id ? updated : p
    )
    const storedIcon = projectIcons.get(updated.id)
    scopeState.projects = scopeState.projects.map((p) =>
      p.id === updated.id
        ? {
            id: updated.id,
            name: updated.name,
            path: updated.path,
            source: updated.source,
            host: updated.host,
            color: updated.color,
            iconUrl: getProjectIcon(updated, storedIcon)
          }
        : p
    )

    this.showEditModal = false
    this.editProject = null
    this.editProjectPendingIcon = undefined
  }

  async changeEditProjectIcon(): Promise<void> {
    if (!this.editProject) return
    const imagePath = await invoke('dialog:pickImage')
    if (!imagePath) return
    // Read the file as a data URL for local preview only   never persist here
    const dataUrl = await invoke('file:readAsDataUrl', imagePath)
    if (!dataUrl) return
    this.editProjectPendingIcon = { path: imagePath, dataUrl }
  }

  askRemoveProject(projectId: string): void {
    this.removeTarget = this.options.getProjects().find((p) => p.id === projectId) ?? null
    if (this.removeTarget) {
      // The folder-erasure switch never carries over between opens.
      this.removeDeleteFolder = false
      this.showRemoveModal = true
    }
  }

  closeRemoveModal(): void {
    this.showRemoveModal = false
    // The switch always rests in the off state; it only ever turns on when
    // the user explicitly flips it inside the open modal.
    this.removeDeleteFolder = false
  }

  async confirmRemoveProject(): Promise<void> {
    const target = this.removeTarget
    if (!target || this.deletingProjectId !== null) return
    if (this.removeDeleteFolder) {
      // Folder erasure is destructive beyond the app, so it gets its own
      // explicit confirmation before anything is deleted.
      this.showRemoveModal = false
      this.showRemoveFinalConfirm = true
      return
    }
    this.showRemoveModal = false
    this.removeTarget = null
    await this.options.deleteProject(target.id)
  }

  cancelRemoveFinalConfirm(): void {
    // Return to the first modal with the switch still on so the user can
    // simply turn it off instead of starting over.
    this.showRemoveFinalConfirm = false
    this.showRemoveModal = true
  }

  async confirmRemoveWithFolder(): Promise<void> {
    const target = this.removeTarget
    if (!target || this.deletingProjectId !== null) return
    this.showRemoveFinalConfirm = false
    this.showRemoveModal = false
    this.removeTarget = null
    this.removeDeleteFolder = false
    await this.options.deleteProject(target.id, true)
  }
}
