import type { Project } from '$shared/types'
import { BoardUnit } from '$lib/components/board-unit'
import type { Workspace } from './Workspace-board.svelte'

/**
 * Whether a project can host a project thread at all.
 *
 * The inbox, the assistant space and the browser container are hidden
 * conversation containers: a thread minted in one of them is not a project
 * thread, and none of them belongs in a project picker.
 */
export function canHostProjectThread(project: Project | null): project is Project {
  return project !== null && project.hidden !== true
}

/**
 * The project picker a new thread falls back to when nothing open says which
 * project it belongs to.
 *
 * The header's new-thread action and the Cmd/Ctrl+N chord both reach a thread
 * view with no project selected (a launch that restored no thread and no
 * project, or a window whose projects were never entered). Creating a thread
 * there used to be impossible, so the request is answered with the same project
 * selector the chat hand-off uses, and the chosen project mints the empty
 * thread.
 */
export class WorkspaceNewThreadProjectPicker extends BoardUnit<Workspace> {
  constructor(root: Workspace) {
    super(root)
  }

  /** True while the picker asks which project the new thread belongs to. */
  open = $state(false)

  /** True while the chosen project's thread is being created. */
  busy = $state(false)

  /** The project created from inside the picker, whose thread creation it
   *  already performed. Picking it again must not create a second thread. */
  #createdProjectId: string | null = null

  /** Every project the picker offers: the visible ones, in sidebar order. */
  get projects(): Project[] {
    return this.root.mergeThreadsInList.visibleProjects
  }

  get projectIcons(): ReadonlyMap<string, string> {
    return this.root.createThreadInProject.projectIcons
  }

  /** Ask which project a new thread belongs to. */
  request(): void {
    this.#createdProjectId = null
    this.open = true
  }

  close(): void {
    if (this.busy) return
    this.#createdProjectId = null
    this.open = false
  }

  /** Mint the empty thread in the project the user picked. */
  async pick(project: Project): Promise<void> {
    if (this.busy) return
    // A project created from this very modal already landed in a fresh thread
    // (the add-project flow takes the user straight into it), so this pick only
    // has to close the picker.
    if (this.#createdProjectId === project.id) {
      this.#createdProjectId = null
      this.open = false
      return
    }
    this.busy = true
    try {
      await this.root.createThreadInProject.createThreadInProject(project)
      this.open = false
    } finally {
      this.busy = false
    }
  }

  /**
   * The add-project control created a project for this request: register it in
   * the workspace and take the user into its fresh thread, exactly as the
   * Projects view's own add-project flow does. The modal reports the pick right
   * after this, and `pick` recognises the project as already handled.
   */
  async projectCreated(project: Project): Promise<void> {
    this.#createdProjectId = project.id
    await this.root.switcherPanelTabs.handleProjectCreated(project)
  }
}
