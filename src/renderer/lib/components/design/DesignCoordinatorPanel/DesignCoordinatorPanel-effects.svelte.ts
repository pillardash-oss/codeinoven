import { onMount } from 'svelte'
import { subscribe } from '$lib/ipc.svelte'
import { projectWorkState } from '$lib/stores/project-work.svelte'
import { isThreadBusyStatus } from '$shared/thread-status-policy'
import type { DesignBoard } from './DesignCoordinatorPanel-board.svelte'
/** One concern of the DesignBoard board. */
export class DesignBoardEffects {
  #root: DesignBoard | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): DesignBoard {
    if (!this.#root) throw new Error('DesignBoardEffects read its board before it was bound')
    return this.#root
  }
  constructor(root: DesignBoard) {
    this.#root = root
  }
  /**
   * The work the surface used to do as it set itself up: effects, the
   * subscriptions it opened and the first load it kicked off. It runs from
   * the board's constructor, which the component calls during its own setup,
   * so every effect here is owned by the component.
   */
  init(): void {
    onMount(() => {
      // The agent writes the work inside a turn, so the board catches up when that
      // turn settles. Nothing polls. A board that is off screen waits rather than
      // loading pages in the thread's tab, and the effect below reads then.
      return subscribe('thread:updated', (thread) => {
        if (
          thread.id !== this.root.props.threadId ||
          thread.projectId !== this.root.props.projectId
        )
          return
        if (isThreadBusyStatus(thread.status)) return
        if (!this.root.props.active) {
          this.root.state.settleMissed = true
          return
        }
        void this.root.gallery.refreshSettledWork()
      })
    })

    // Bringing the board back on screen reads what settled while it was away, so a
    // screen the agent wrote in the meantime is already there.
    $effect(() => {
      if (!this.root.props.active || !this.root.state.settleMissed) return
      this.root.state.settleMissed = false
      void this.root.gallery.refreshSettledWork()
    })

    onMount(() => () => {
      // Leaving the board for good still ends the view straight away; only a flap
      // inside the board's own life waits out `scheduleRelease`.
      this.root.studio.cancelPendingRelease()
      this.root.gallery.releaseComposition()
    })

    onMount(() => {
      projectWorkState.invalidate(this.root.props.projectId, this.root.props.threadId)
      void projectWorkState
        .refresh(this.root.props.projectId, this.root.props.threadId)
        .then(async () => {
          await this.root.gallery.loadState()
          if (this.root.gallery.selectedItem)
            projectWorkState.focusDirectory(
              this.root.props.projectId,
              this.root.gallery.requestedKind,
              this.root.gallery.selected.directory
            )
          await this.root.gallery.loadGallery()
          await this.root.gallery.loadCanvas()
        })
      void projectWorkState.refreshRoots(this.root.props.projectId)
      return () => {
        if (this.root.gallery.selectedItem)
          projectWorkState.focusDirectory(
            this.root.props.projectId,
            this.root.gallery.requestedKind,
            this.root.gallery.selected.directory
          )
      }
    })

    onMount(() =>
      subscribe('design:relocated', (changedProjectId) => {
        if (changedProjectId !== this.root.props.projectId) return
        void projectWorkState
          .refresh(this.root.props.projectId, this.root.props.threadId)
          .then(async () => {
            await this.root.gallery.loadState()
            await this.root.gallery.loadGallery()
            await this.root.gallery.loadCanvas()
          })
      })
    )

    // Own the native page for exactly as long as this video is selected on an
    // active board. Fullscreen and menus reuse that ownership, never end it.
    $effect(() => {
      const directory = this.root.gallery.selected.directory
      if (
        !this.root.props.active ||
        !this.root.gallery.video ||
        !this.root.gallery.playable ||
        this.root.gallery.selectedMissing ||
        directory === ''
      )
        return
      // A board that comes back within the grace window keeps the page it already
      // owns: an unrelated update that flips the board inactive for a frame must
      // not destroy the composition view and open a second one.
      this.root.studio.cancelPendingRelease()
      let cancelled = false
      // Read the lifecycle inputs above, without subscribing to the state written
      // while the asynchronous open completes.
      void Promise.resolve().then(() => {
        if (!cancelled) return this.root.gallery.ensureComposition(directory)
      })
      return () => {
        cancelled = true
        this.root.gallery.scheduleRelease()
      }
    })

    // A board that is no longer the surface on screen cannot keep a full screen
    // window: the picture would stay up over whatever the user navigated to.
    $effect(() => {
      if (!this.root.props.active) this.root.studio.minimizeCompositionEditor()
    })

    // The board owns the composition job poll, because it draws the export above the
    // controls and both must read the same list. A design has no jobs, so nothing
    // polls for one.
    $effect(() => {
      if (!this.root.gallery.video) return
      void this.root.studio.readVideoJobs()
      const timer = setInterval(() => void this.root.studio.readVideoJobs(), 1500)
      return () => clearInterval(timer)
    })
  }
}
