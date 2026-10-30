import { toast } from 'svelte-sonner'
import { invoke } from '$lib/ipc.svelte'
import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
import { standaloneFiles } from '$lib/stores/standalone-files.svelte'
import { isThreadWorking, type Thread } from '$shared/types'
import type { CloseConfirmationPayload, CloseConfirmationProject } from '$shared/ipc-contract'
import type { App } from './App-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the App board. */
export class AppSettleCloseConfirmationThread extends BoardUnit<App> {
  constructor(root: App) {
    super(root)
  }
  closeConfirmation = $state<CloseConfirmationPayload | null>(null)

  /** True when the pending close is a park (background mode), not a quit. */
  closeIsPark(): boolean {
    return this.closeConfirmation?.park === true
  }

  /** The user approved parking the window; main keeps the backend alive. */
  async parkWindow(): Promise<void> {
    await invoke('app:parkWindow')
  }

  /** The user approved the force close   tell main to park or to quit. */
  async confirmForceClose(): Promise<void> {
    await (this.closeIsPark() ? invoke('app:parkWindow') : invoke('app:confirmClose'))
  }

  /**
   * The close was abandoned: dismissed, or a save it asked for failed. Main armed
   * a quit watchdog when the close was requested, so it is told the app is
   * staying open; otherwise that watchdog force-exits the workspace the user just
   * chose to keep.
   */
  abandonClose(): void {
    this.closeConfirmation = null
    void invoke('app:abandonClose')
  }

  /**
   * While the close-confirmation modal is open, watch the threads it listed as
   * still working. As each one leaves that state (completed, failed, or
   * otherwise no longer executing/planning) it drops off the list. Once none
   * remain   and no unsaved files are pending   the close the user already
   * asked for proceeds automatically instead of waiting on a second click.
   *
   * A listed download deliberately does not hold that up: closing pauses it and
   * keeps its bytes for a later resume, so it never needs an answer of its own.
   */
  settleCloseConfirmationThread(thread: Thread): void {
    const current = this.closeConfirmation
    if (!current || isThreadWorking(thread)) return

    const projects: CloseConfirmationProject[] = []
    for (const project of current.projects) {
      const threads = project.threads.filter((entry) => entry.threadId !== thread.id)
      if (threads.length > 0) {
        projects.push({ ...project, threads, threadCount: threads.length })
      }
    }
    if (projects.length === current.projects.length) return

    if (projects.length === 0 && current.files.length === 0) {
      const park = current.park === true
      this.closeConfirmation = null
      void (park ? this.parkWindow() : this.confirmForceClose())
      return
    }
    this.closeConfirmation = { ...current, projects }
  }

  /** Save every unsaved file, then close the app. Stays open if a save fails. */
  async confirmForceCloseSaving(): Promise<void> {
    const savedProjectFiles = await projectFilesWorkspace.saveAllUnsaved()
    // Standalone files are saved too: they are opened outside any project, so
    // nothing else would ever write their drafts.
    const savedStandaloneFiles = await standaloneFiles.saveAllUnsaved()
    if (savedProjectFiles && savedStandaloneFiles) {
      await (this.closeIsPark() ? invoke('app:parkWindow') : invoke('app:confirmClose'))
    } else {
      this.abandonClose()
      toast.error('Some files could not be saved', {
        description: 'The application stayed open so you can review them.'
      })
    }
  }
}
