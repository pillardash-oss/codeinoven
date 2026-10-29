import CioClapper from '@pdslng/cio-icon/CioClapper.svelte'
import CioFrame from '@pdslng/cio-icon/CioFrame.svelte'
import type { Attachment } from 'svelte/attachments'
import { LastKnown } from '$lib/last-known'
import { authoredWorkOwnerLabel } from '$lib/authored-work-presentation'
import { invoke } from '$lib/ipc.svelte'
import type { BrowserContextTab } from '$lib/stores/context-sidebar.svelte'
import { openThreadById } from '$lib/threads/open-thread-by-id'
import { logRendererError } from '$lib/system/renderer-logger'
import type { VideoJob } from '$shared/video/studio'
import { type DesignExportFormat } from '$shared/design/design-export'
import { isScreenCanvasEntry } from '$shared/design/screen-canvas'
import type { DesignEntry, DesignScreenShot } from '$shared/ipc-contract'
import { SCREEN_ORDERS } from './DesignCoordinatorPanel-types'
import type { ScreenOrder } from './DesignCoordinatorPanel-types'
import type { DesignBoard } from './DesignCoordinatorPanel-board.svelte'
import { isSiteUrl } from './design-board-reference'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the DesignBoard board. */
export class DesignBoardStudio extends BoardUnit<DesignBoard> {
  constructor(root: DesignBoard) {
    super(root)
  }
  /**
   * How wide a screen is pictured at.
   *
   * One size for every card, so the pictures are taken once and shown at whatever
   * size the grid gives them: a second size would be a second sweep of page loads
   * for the same screens. The capture is the parked tab's viewport, so every picture
   * has the same shape and the cards line up.
   */
  SCREEN_SHOT_WIDTH = 520

  /**
   * The file the live preview opens: the design's own entry page.
   *
   * A design is previewed by opening the page a visitor lands on, and the design
   * playbook makes that `index.html`. A folder without one has nothing to preview
   * live, which is what the board's menu offers to fix.
   */
  LIVE_PREVIEW_ENTRY = 'index.html'

  /** Whether the menu's own string is one of the board's orders. */
  isScreenOrder(value: string): value is ScreenOrder {
    return SCREEN_ORDERS.some((order) => order === value)
  }

  /**
   * The screens of one design in the order the user picked.
   *
   * "Latest" is the file's own modification time, stamped when the agent writes
   * the screen, so the top of the grid is the part of the design that moved last.
   * Name is the card's label rather than the file path, because the label is what
   * the user reads, and the entry path settles ties so two screens never swap
   * places between paints.
   */
  orderScreens(screens: DesignScreenShot[], order: ScreenOrder): DesignScreenShot[] {
    const byName = (left: DesignScreenShot, right: DesignScreenShot): number =>
      left.name.localeCompare(right.name) || left.entry.localeCompare(right.entry)
    if (order === 'name') return screens.toSorted(byName)
    if (order === 'name-desc') return screens.toSorted((left, right) => byName(right, left))
    const byAge = (left: DesignScreenShot, right: DesignScreenShot): number =>
      left.updatedAt - right.updatedAt || byName(left, right)
    return order === 'latest'
      ? screens.toSorted((left, right) => byAge(right, left))
      : screens.toSorted(byAge)
  }

  galleryBusy = $state(false)

  /**
   * The order the screens grid is shown in.
   *
   * A view setting of the board rather than of the design: switching designs keeps
   * it, and a board opened again starts at the default, newest first.
   */
  screenOrder = $state<ScreenOrder>('latest')

  /**
   * The composition's jobs, read by the board.
   *
   * The board draws the export above the controls and the controls report progress
   * below, so the board holds the one list and hands it down: two readers could
   * disagree about whether an export is running. A design has no jobs, so this
   * stays empty for it.
   */
  videoJobs = $state.raw<VideoJob[]>([])

  /**
   * The export the composition in front already has on disk, as a project-relative
   * path.
   *
   * The job list is this process's memory of this thread's work, so it cannot
   * answer for a composition exported in another thread of the same project or
   * before a restart. This is that answer, read from the composition itself, and it
   * is what the board stands on when no job of its own describes an export.
   */
  savedExport = $state<string | null>(null)

  /** Whether the studio controls hold unsaved edits, which a reload would discard. */
  studioDirty = $state(false)

  /** Bumped to remount the video timeline and controls, so a refresh re-reads them. */
  boardRevision = $state(0)

  /** Whether the user asked to reload over unsaved video controls. */
  reloadRequested = $state(false)

  /** Whether the reference-brand URL prompt is open. */
  referenceOpen = $state(false)

  /** The reference site URL the brand extraction measures. */
  referenceUrl = $state('')

  /** Why the entered reference URL was rejected, in the user's terms. */
  referenceError = $state('')

  /** The newest finished export, played in the board above the timeline. */
  exportPath = $derived.by(() => {
    if (!this.root.gallery.video) return null
    const files = this.videoJobs.flatMap((job) =>
      job.operation === 'export' && job.state === 'completed' ? job.files : []
    )
    // A job of this session is the freshest answer there can be, because it is
    // written the moment the export finishes. The composition's own export stands
    // behind it for every case a job record cannot cover.
    return files.at(-1) ?? this.savedExport
  })

  nounTitle = $derived(this.root.gallery.video ? 'Composition' : 'Design')

  /** What to call the place this scope's work lives: a project, an assistant, a chat. */
  ownerLabel = $derived(authoredWorkOwnerLabel(this.root.props.projectId))

  WorkIcon = $derived(this.root.gallery.video ? CioClapper : CioFrame)

  removeRequested = $state<DesignEntry | null>(null)

  /**
   * Whether the composition is being watched full screen instead of in the pane.
   *
   * The board is the control surface and the full screen surface is the picture:
   * both show the composition's own view, so this is a mode of the board rather
   * than a hand-off. The tab that plays the film never changes, which is what lets
   * the board's mute and transport keep driving what the full screen shows.
   */
  compositionFullscreen = $state(false)

  compositionPlaybackOnly = $state(false)

  minimizeCompositionEditor(): void {
    this.compositionPlaybackOnly = false
    this.compositionFullscreen = false
  }

  /**
   * The tab the full screen surface shows, with the last one it showed as the
   * floor of every read.
   *
   * This is the same rule the stage below follows: the browser panel that hosts
   * the view reads its tab through a getter that re-reads its source until the
   * panel is gone, and the tab turns null the moment the user minimizes the
   * surface (or the composition stops being the one in front). A null read there
   * would throw out of that panel's own cleanup and take the board's render with
   * it. `fullscreenCompositionTab` still decides whether the surface exists.
   */
  fullscreenTabs = new LastKnown<BrowserContextTab>()

  shownFullscreenTab = $derived(this.fullscreenTabs.get(this.root.gallery.fullscreenCompositionTab))

  /** Why the last open failed, in the user's terms, or an empty string. */
  compositionError = $state('')

  /**
   * The thread that created the design in front, or an empty string when none is
   * recorded.
   *
   * A design is created by one thread, and the board can send the user there, so
   * this is the id the reveal control acts on. A folder that predates origin
   * recording, or whose creating thread has been deleted, has none, and the
   * control stays off rather than guessing.
   */
  selectedCreatorThreadId = $derived(this.root.gallery.selectedItem?.creatorThreadId ?? '')

  /**
   * Whether there is another thread to reveal.
   *
   * False when no creator is recorded and false when the creator is this very
   * thread: a control that would leave the user where they already are is not a
   * control, so it stays disabled with a title that says why.
   */
  canRevealCreator = $derived(
    this.selectedCreatorThreadId !== '' &&
      this.selectedCreatorThreadId !== this.root.gallery.selectionThreadId
  )

  /** What the reveal control says, whether it acts or explains why it cannot. */
  revealLabel = $derived.by(() => {
    const name =
      this.root.gallery.selectedName === '' ? this.nounTitle : this.root.gallery.selectedName
    if (this.canRevealCreator) return `Reveal the thread that created ${name}`
    if (this.selectedCreatorThreadId === this.root.gallery.selectionThreadId)
      return `This thread created ${name}`
    return 'Thread unavailable'
  })

  /**
   * The two entries that are not screens, and the screens themselves, in the order
   * the user picked.
   *
   * The canvas is swept with the screens so its entry has a picture like any other,
   * and the live preview is the design's entry page pictured once more. Both are
   * split out of the grid's screens rather than listed twice, and both keep the
   * first two cells of the grid whatever the order is: they are the design's own
   * doors rather than screens of it.
   */
  canvasShot = $derived(
    this.root.gallery.gallery.find((screen) => isScreenCanvasEntry(screen.entry)) ?? null
  )

  designScreens = $derived(
    this.orderScreens(
      this.root.gallery.gallery.filter((screen) => !isScreenCanvasEntry(screen.entry)),
      this.screenOrder
    )
  )

  liveShot = $derived(
    this.designScreens.find((screen) => screen.entry === this.LIVE_PREVIEW_ENTRY) ?? null
  )

  /** What the canvas entry says while it has no picture to show. */
  canvasEntryNote = $derived(
    !this.root.gallery.canvasRead
      ? 'Reading the canvas…'
      : this.root.gallery.canvasState === null
        ? 'No screens yet'
        : 'No preview yet.'
  )

  /** What the design's own canvas metadata gets wrong, in one line, or nothing. */
  canvasHint = $derived.by(() => {
    const state = this.root.gallery.canvasState
    if (state === null) return ''
    const parts: string[] = []
    if (state.metadataError !== null) {
      parts.push(`canvas.json could not be read: ${state.metadataError}`)
    }
    if (state.orphanFrames.length > 0) {
      const count = state.orphanFrames.length
      parts.push(
        `canvas.json frames ${count} file${count === 1 ? '' : 's'} that no longer exist: ${state.orphanFrames.join(', ')}`
      )
    }
    return parts.join(' · ')
  })

  /** What the live preview entry says while it has no picture to show. */
  liveEntryNote = $derived(this.root.gallery.liveReady ? 'No preview yet.' : 'No entry page yet')

  refreshLabel = $derived(
    this.root.gallery.video ? 'Refresh the composition preview' : 'Refresh the screens'
  )

  screensLabel = $derived(
    this.root.gallery.video
      ? 'Composition preview'
      : `Screens in this design (${this.designScreens.length})`
  )

  // The board's owner stays mounted across empty threads, but its session choice
  // belongs to the conversation currently on screen.
  previousViewingThread: string | undefined

  watchViewingThread: Attachment<HTMLDivElement> = () => {
    const next = this.root.gallery.selectionThreadId
    if (this.previousViewingThread !== undefined && this.previousViewingThread !== next)
      void this.root.gallery.refreshViewingThread()
    this.previousViewingThread = next
  }

  /** The Sort menu reports a string too, so it is checked before it becomes the order. */
  handleScreenOrderChange(value: string): void {
    if (this.isScreenOrder(value)) this.screenOrder = value
  }

  /**
   * Show the thread that created the design in front.
   *
   * A design is often iterated in a later thread than the one that made it, and
   * the user asks "where did this come from?" from the board. Revealing the
   * creator opens that thread in its owning view, the same way an 'Open thread'
   * notification does, so the question is answered without a search.
   */
  async revealCreator(): Promise<void> {
    if (!this.canRevealCreator) return
    await openThreadById(this.root.props.projectId, this.selectedCreatorThreadId)
  }

  compositionOpen: Promise<void> = Promise.resolve()

  /**
   * A teardown waiting out a flap.
   *
   * The board's `active` flag follows the sidebar, and an update elsewhere in the
   * window can take it away for a frame and give it straight back. Ending the view
   * on that frame destroyed the composition page and opened another one, twice, on
   * an update that had nothing to do with the video: the picture flashed, the page
   * re-ran its startup and a muted user heard the film again. The release therefore
   * waits, and is cancelled by the ownership effect coming back.
   */
  pendingRelease: ReturnType<typeof setTimeout> | null = null

  cancelPendingRelease(): void {
    if (this.pendingRelease === null) return
    clearTimeout(this.pendingRelease)
    this.pendingRelease = null
  }

  /**
   * Open the reference-brand prompt for the folder in front.
   *
   * The extraction measures a site the user names, so the URL is collected
   * up front rather than asked for mid-turn: confirming sends it as part of
   * the prompt in the same step.
   */
  openReferencePrompt(): void {
    if (this.root.gallery.selected.directory === '' || this.root.gallery.canvasBusy !== '') return
    this.referenceUrl = ''
    this.referenceError = ''
    this.referenceOpen = true
  }

  /** Send the brand extraction with the entered URL as part of the prompt. */
  confirmReferencePrompt(): void {
    const url = this.referenceUrl.trim()
    if (!isSiteUrl(url)) {
      this.referenceError = 'Enter a full site URL starting with http:// or https://.'
      return
    }
    this.referenceOpen = false
    void this.root.gallery.requestDesignAction('reference', url)
  }

  startExport(entry: string | null, format: DesignExportFormat): void {
    const directory = this.root.gallery.selected.directory
    const exportProjectId = this.root.props.projectId
    void import('$lib/stores/export-progress.svelte')
      .then(({ exportProgressState }) =>
        exportProgressState.startDesign(
          exportProjectId,
          this.root.props.threadId,
          directory,
          entry,
          format
        )
      )
      .catch((failure: unknown) => {
        this.root.gallery.error =
          failure instanceof Error ? failure.message : 'Could not start export.'
      })
  }

  /** Read the composition's jobs, the list the board's export stands on. */
  async readVideoJobs(): Promise<void> {
    try {
      this.videoJobs = await invoke(
        'video:jobs',
        this.root.props.projectId,
        this.root.props.threadId
      )
    } catch (failure) {
      logRendererError('The video jobs could not be read.', failure)
    }
    await this.root.gallery.readSavedExport()
  }

  /** The controls' unsaved state, so a refresh can ask before discarding it. */
  setStudioDirty(value: boolean): void {
    this.studioDirty = value
  }

  /** A save moved the composition, so the timeline re-reads the bands it draws. */
  setStudioSaved(): void {
    // The page reads studio.json once, when it loads, so a saved caption style, a
    // moved track or an edited word is invisible in the picture until the page
    // reads the file again. Reloading the board's own view refreshes it, and the
    // browser remembers the playhead across that reload.
    if (this.root.gallery.boardTabId !== '')
      void invoke('browser:reload', this.root.gallery.boardTabId).catch(() => undefined)
  }

  /**
   * The folder moved along its history, so picture it as it now is.
   *
   * A restore rewrote the files, so the pictures the board holds are pictures of a
   * design that no longer exists: forcing the sweep is what puts the folder the user
   * chose on screen instead of the one they left.
   */
  restoreBoard(): void {
    void this.root.gallery.loadGallery(true)
    void this.root.gallery.loadCanvas()
  }
}
