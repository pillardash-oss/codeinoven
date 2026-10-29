import { tick } from 'svelte'
import { toast } from 'svelte-sonner'
import { invoke } from '$lib/ipc.svelte'
import { loadBrowser } from '$lib/stores/browser-access.svelte'
import type { BrowserContextTab } from '$lib/stores/context-sidebar.svelte'
import { designCoordinatorState } from '$lib/stores/design-coordinator.svelte'
import { projectWorkState } from '$lib/stores/project-work.svelte'
import { videoTimelineState } from '$lib/stores/video-timeline.svelte'
import { sendOrQueueThreadMessage } from '$lib/stores/thread-delivery'
import { logRendererError } from '$lib/system/renderer-logger'
import { designContractRequest } from '$shared/design/design-contract'
import { SCREEN_CANVAS_PATH, screenCanvasLivePreviewMessage } from '$shared/design/screen-canvas'
import type {
  AuthoredWorkKind,
  DesignScreenShot,
  ScreenCanvasState,
  ThreadDesignState
} from '$shared/ipc-contract'
import type { DesignBoard } from './DesignCoordinatorPanel-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the DesignBoard board. */
export class DesignBoardGallery extends BoardUnit<DesignBoard> {
  constructor(root: DesignBoard) {
    super(root)
  }

  /** Reads the stored design state, once the board can answer for the props. */
  bindDesignState(): void {
    this.designState = designCoordinatorState.stateFor(
      this.root.props.projectId,
      this.root.props.threadId
    )
  }
  selectionThreadId = $derived(this.root.props.viewingThreadId ?? this.root.props.threadId)

  // Seeded from whatever the workspace already fetched, so the panel paints on
  // its first frame instead of flashing a spinner.
  // svelte-ignore state_referenced_locally
  /** Set by `bind()`: the stored design state for this thread. */
  designState = $state<ThreadDesignState | null>(null)

  gallery = $state<DesignScreenShot[]>([])

  /** The design preview in flight, so its own button shows the wait. */
  opening = $state(false)

  /** The canvas open in flight, kept apart from the design preview so opening one
   *  never spins the other's button. */
  openingCanvas = $state(false)

  error = $state('')

  /**
   * The design's Screen Canvas: the page that shows every screen at once.
   *
   * It is agent work like the screens are, so the board's part is only to say
   * whether one exists, ask for it, and say when it has fallen behind. The frames
   * are main's answer, because the page is a file the board cannot read for itself.
   */
  canvasState = $state<ScreenCanvasState | null>(null)

  /** Whether main has answered about the canvas, so its entry is not drawn from
   *  "no canvas yet" before the first read settles. */
  canvasRead = $state(false)

  /** Which canvas request is in flight, or an empty string when none is. */
  canvasBusy = $state('')

  /** The folder the canvas answer belongs to, so a folder switch cannot paint
   *  the previous folder's canvas entry while the new one is being read. */
  canvasDirectory = $state('')

  /** What happened to the last canvas request, in the user's terms. */
  canvasNotice = $state('')

  /** The session's words and icon: a design session and a video session share this
   *  board, so nothing below hard-codes the word "design". A board the project's
   *  rail opened carries its kind instead of reading it from the thread. */
  requestedKind = $derived<AuthoredWorkKind>(
    this.root.props.kind ?? this.designState?.kind ?? 'design'
  )

  video = $derived(this.requestedKind === 'video')

  noun = $derived(this.video ? 'composition' : 'design')

  /** Project defaults are separate from the current design or video's own folder. */
  kind = $derived<AuthoredWorkKind>(this.requestedKind)

  /** The folder this project writes new work of this kind into. */
  workRoot = $derived(
    projectWorkState.rootsFor(this.root.props.projectId)[this.kind] || this.designState?.root || ''
  )

  /** Every folder of this kind the project holds, newest first.
   *
   * A rail-opened board lists the project's folders for its own kind, so the
   * board shows the work whether or not the thread on screen has any; a session
   * board keeps the listing main answered alongside its own record.
   *
   * A composition is the exception, because a video is watched rather than owned:
   * it belongs to its project, so every thread of that project lists the same
   * compositions and can watch what another thread made. The read is keyed by this
   * project's id, which is also what keeps another project's work out of this
   * panel entirely. The session's own answer stands in until that read lands, so
   * the board never blanks while it waits.
   */
  items = $derived.by(() => {
    if (this.video) {
      const project = projectWorkState.itemsFor(
        this.root.props.projectId,
        'video',
        this.root.props.threadId
      )
      return project.length > 0 ? project : (this.designState?.items ?? [])
    }
    return this.root.props.kind !== undefined
      ? projectWorkState.itemsFor(
          this.root.props.projectId,
          this.root.props.kind,
          this.root.props.threadId
        )
      : (this.designState?.items ?? [])
  })

  /** How many designs sit behind the "Others" trigger. */
  otherCount = $derived(Math.max(0, this.items.length - 1))

  /** What the trigger and its menu are called, in this board's own words. */
  switchLabel = $derived(
    `Switch ${this.noun}, ${this.otherCount} other ${this.otherCount === 1 ? this.noun : `${this.noun}s`} in ${this.root.studio.ownerLabel}`
  )

  /** The folder this thread last previewed, when it belongs to the kind on screen.
   *  A rail-opened board ignores a record that describes the other kind. */
  currentFolder = $derived.by(() => {
    const current = this.designState?.current ?? null
    if (current === null) return null
    if (this.root.props.kind !== undefined && current.kind !== this.root.props.kind) return null
    return this.items.some((item) => item.directory === current.directory) ? current : null
  })

  /** The folder in front: the one the user picked, else the thread's own. */
  selected = $derived.by(() => {
    const current = this.currentFolder
    const picked = projectWorkState.selectedDirectory(
      this.root.props.projectId,
      this.requestedKind,
      this.selectionThreadId
    )
    const inherited =
      this.selectionThreadId !== this.root.props.threadId
        ? projectWorkState.focusedDirectory(this.root.props.projectId, this.requestedKind)
        : ''
    const directory = this.items.some((item) => item.directory === picked)
      ? picked
      : (this.items.find((item) => item.directory === inherited)?.directory ??
        current?.directory ??
        this.items.find((item) => item.creatorThreadId === this.selectionThreadId)?.directory ??
        this.items.find(
          (item) =>
            item.directory ===
            projectWorkState.focusedDirectory(this.root.props.projectId, this.requestedKind)
        )?.directory ??
        this.items[0]?.directory ??
        '')
    return { directory, entry: current?.directory === directory ? current.entry : null }
  })

  /** The folder in front as main lists it, which is where its entry page is known. */
  selectedItem = $derived(
    this.items.find((item) => item.directory === this.selected.directory) ?? null
  )

  removeBusy = $state(false)

  selectedMissing = $derived(this.selectedItem?.missing === true)

  selectedName = $derived(
    this.selectedItem?.name ?? this.selected.directory.split('/').at(-1) ?? ''
  )

  /**
   * The view this board plays its composition in, named by main when it opened it.
   *
   * The board owns its view rather than borrowing the thread's browser tab, so
   * the view's id is the only way to be sure which page is being placed in the
   * stage. Empty until the first open settles.
   */
  boardTabId = $state('')

  /**
   * The composition the board is playing, when its own view is on screen for the
   * folder in front.
   *
   * The view arrives on `browser:state`, and it is addressed by the id main
   * returned rather than by the thread: a browser tab on the same folder must not
   * be mistaken for the board's own page. While it is here the board is a player
   * and an editor at once, and while it is not the stage falls back to the last
   * export or the captured frame.
   *
   * Only the selected folder may supply the stage. Its native page is destroyed
   * when selection changes or this board becomes inactive.
   */
  liveTab = $derived.by(() => {
    if (this.boardTabId === '') return null
    const live = videoTimelineState.compositionByTab(this.boardTabId)
    if (live === null || live.directory !== this.selected.directory) return null
    return live
  })

  /**
   * The composition's tab described as a browser tab, for the full screen surface.
   *
   * The board's view is a registered browser tab that deliberately stays out of
   * every tab strip, so the full screen browser is handed the descriptor it needs
   * instead of looking one up in a list this tab is not in. Null until the view
   * exists, so the surface can never open on a tab nothing has served.
   */
  fullscreenCompositionTab = $derived.by((): BrowserContextTab | null => {
    const live = this.liveTab
    if (!this.video || !this.root.studio.compositionFullscreen || live === null) return null
    return {
      id: live.tabId,
      kind: 'browser',
      title: this.selectedName === '' ? `${this.root.studio.nounTitle} preview` : this.selectedName,
      projectId: this.root.props.projectId,
      threadId: this.root.props.threadId,
      url: live.url,
      favicon: null,
      boxId: live.boxId
    }
  })

  /**
   * Whether the folder in front has an entry page, which is what makes it playable.
   *
   * A composition folder with no `index.html` yet is a folder of assets rather than
   * a composition: there is nothing to serve, so the board says so instead of
   * opening a tab on a directory listing.
   */
  playable = $derived(this.video && this.selectedItem?.hasEntry === true)

  /** The folder whose composition the board is opening right now, or an empty string. */
  composing = $state('')

  /**
   * The folder this board has already asked main to open.
   *
   * Deliberately not reactive state: it guards the effect below against asking
   * twice for one folder, and nothing renders it. A failure is reported and not
   * retried, so a folder that cannot be served never spins.
   */
  compositionAsked = ''

  /** Whether the design has a page the live preview could open at all. Main's
   *  listing knows the entry file, and the sweep shows it once it is pictured, so
   *  either answer is enough to open it. */
  liveReady = $derived(
    !this.video && (this.selectedItem?.hasEntry === true || this.root.studio.liveShot !== null)
  )

  async loadState(): Promise<void> {
    try {
      this.designState = await invoke(
        'design:state',
        this.root.props.projectId,
        this.root.props.threadId
      )
      this.error = ''
    } catch (failure) {
      this.error = failure instanceof Error ? failure.message : 'The work state could not be read.'
    }
  }

  async removeMissingWork(): Promise<void> {
    const target = this.root.studio.removeRequested
    if (!target || this.removeBusy) return
    this.removeBusy = true
    try {
      await invoke(
        'design:removeMissing',
        this.root.props.projectId,
        this.root.props.threadId,
        target.directory
      )
      this.root.studio.removeRequested = null
      projectWorkState.selectDirectory(
        this.root.props.projectId,
        this.kind,
        this.selectionThreadId,
        ''
      )
      await projectWorkState.refresh(this.root.props.projectId, this.root.props.threadId)
      await this.loadState()
      await this.loadGallery()
      await this.loadCanvas()
    } catch (failure) {
      this.error = failure instanceof Error ? failure.message : 'The entry could not be removed.'
    } finally {
      this.removeBusy = false
    }
  }

  async detailsUpdated(directory: string, moved: number): Promise<void> {
    projectWorkState.selectDirectory(
      this.root.props.projectId,
      this.kind,
      this.selectionThreadId,
      directory
    )
    await projectWorkState.refreshRoots(this.root.props.projectId)
    await this.loadState()
    await projectWorkState.refresh(this.root.props.projectId, this.root.props.threadId)
    await this.loadGallery()
    await this.loadCanvas()
    toast.success(`${moved} ${this.noun}${moved === 1 ? '' : 's'} updated`)
  }

  /**
   * Picture the work for the board.
   *
   * A design is asked for every screen at once, because the board's question is what
   * the whole design looks like and a screen at a time would be one round trip and one
   * page load per card. Main captures them the same way it captures one: in the
   * thread's browser tab, off screen, and it puts the tab back where it found it when
   * the sweep is done. The Screen Canvas is not among them: it is the board's own
   * strip, and it has no picture.
   *
   * A composition has no screens, so its single picture keeps coming from the one
   * thumbnail call, which is also what reports the tab the mute button drives.
   * That call is skipped only once the board is actually playing the composition
   * in its own view: a poster then would reload the page to a still under the
   * playhead. It is taken precisely when the live view has not arrived, so a board
   * waiting on its stage shows the composition's own frame instead of claiming it
   * has captured nothing.
   */
  async loadGallery(force = false): Promise<void> {
    if (this.selected.directory === '' || this.selectedMissing) {
      this.gallery = []
      return
    }
    this.root.studio.galleryBusy = true
    try {
      if (this.video && this.liveTab !== null) {
        this.gallery = []
      } else if (this.video) {
        const shot = await invoke(
          'design:thumbnail',
          this.root.props.projectId,
          this.root.props.threadId,
          this.selected.directory,
          this.selected.entry,
          this.root.studio.SCREEN_SHOT_WIDTH,
          this.requestedKind
        )
        this.gallery = [
          {
            entry: this.selected.entry ?? '',
            name: this.selectedName,
            dataUrl: shot.dataUrl,
            width: shot.width,
            height: shot.height,
            updatedAt: this.selectedItem?.updatedAt ?? 0
          }
        ]
      } else {
        this.gallery = await invoke(
          'design:screens',
          this.root.props.projectId,
          this.root.props.threadId,
          this.selected.directory,
          this.root.studio.SCREEN_SHOT_WIDTH,
          force
        )
      }
      this.error = ''
    } catch (failure) {
      this.error = failure instanceof Error ? failure.message : 'The screens could not be pictured.'
    } finally {
      this.root.studio.galleryBusy = false
    }
  }

  /**
   * Show another design of this project on the board. A view change, not a preview.
   *
   * This is what picking an entry from the dropdown runs, so the board follows the
   * user's choice while the browser stays where it is.
   */
  selectDesign(directory: string): void {
    if (directory === '' || directory === this.selected.directory) return
    projectWorkState.selectDirectory(
      this.root.props.projectId,
      this.requestedKind,
      this.selectionThreadId,
      directory
    )
    this.gallery = []
    void this.loadGallery()
    void this.loadCanvas()
  }

  async refreshViewingThread(): Promise<void> {
    await tick()
    if (this.selectedItem)
      projectWorkState.focusDirectory(
        this.root.props.projectId,
        this.requestedKind,
        this.selected.directory
      )
    if (this.canvasRead && this.canvasDirectory === this.selected.directory) return
    await this.loadGallery()
    await this.loadCanvas()
  }

  /** Serve the work and bring its tab to the user. Main reveals it; the
   *  workspace opens and focuses the sidebar tab from that event, so this panel
   *  never has to know how the browser is laid out. */
  async openWork(directory: string, entry: string | null): Promise<void> {
    if (directory === '') return
    try {
      await invoke(
        'design:open',
        this.root.props.projectId,
        this.selectionThreadId,
        directory,
        entry,
        true,
        this.requestedKind
      )
      await this.loadState()
      await this.loadGallery()
      await this.loadCanvas()
      this.error = ''
    } catch (failure) {
      this.error = failure instanceof Error ? failure.message : 'The work could not be opened.'
    }
  }

  /**
   * Open the composition in the background, so the board can play it itself.
   *
   * The same call the Live preview action makes, minus the reveal. The board owns
   * its own composition view rather than borrowing the thread's browser tab, so
   * nothing the user has to find or open takes part: the view is served, marked as
   * a composition and reported on `browser:state`, which is what mounts the stage.
   * The browser is left exactly where it was, because the browser is not where this
   * board plays.
   */
  compositionRevision = 0

  releaseComposition(): void {
    this.compositionRevision += 1
    const previous = this.boardTabId
    this.boardTabId = ''
    this.compositionAsked = ''
    this.composing = ''
    if (previous !== '') void invoke('browser:destroy', previous, 'closed').catch(() => {})
  }

  scheduleRelease(): void {
    this.root.studio.cancelPendingRelease()
    const tab = this.boardTabId
    if (tab === '') return
    this.root.studio.pendingRelease = setTimeout(() => {
      this.root.studio.pendingRelease = null
      // A newer view took over while the teardown waited, so this one is not ours.
      if (this.boardTabId !== tab) return
      if (
        this.root.props.active &&
        this.video &&
        this.playable &&
        !this.selectedMissing &&
        this.selected.directory !== ''
      )
        return
      this.releaseComposition()
    }, 400)
  }

  async ensureComposition(directory: string, force = false): Promise<void> {
    if (
      !this.root.props.active ||
      !this.video ||
      directory === '' ||
      this.selectedMissing ||
      this.selected.directory !== directory
    )
      return
    if (!force && this.compositionAsked === directory) return
    this.compositionAsked = directory
    this.composing = directory
    const revision = ++this.compositionRevision
    // Serialize opens so a late result can be destroyed before a newer request
    // reuses the same deterministic tab id, including an A -> B -> A switch.
    const opening = this.root.studio.compositionOpen.then(async () => {
      if (revision !== this.compositionRevision) return
      try {
        await loadBrowser()
        if (revision !== this.compositionRevision) return
        const opened = await invoke(
          'design:open',
          this.root.props.projectId,
          this.root.props.threadId,
          directory,
          null,
          false,
          this.requestedKind
        )
        if (revision !== this.compositionRevision) {
          await invoke('browser:destroy', opened.tabId, 'closed')
          return
        }
        this.boardTabId = opened.tabId
        await videoTimelineState.seed(opened.tabId)
        if (revision === this.compositionRevision) this.root.studio.compositionError = ''
      } catch (failure) {
        if (revision === this.compositionRevision)
          this.root.studio.compositionError =
            failure instanceof Error ? failure.message : `The ${this.noun} could not be opened.`
      } finally {
        if (revision === this.compositionRevision) this.composing = ''
      }
    })
    this.root.studio.compositionOpen = opening.catch(() => {})
    await opening
  }

  /**
   * Open the work in the in-app browser.
   *
   * A design opens in its own browser tab, which is where a page a visitor
   * lands on belongs. A composition opens full screen instead, on the board's own
   * view: the board is the control surface and the full screen browser is the same
   * tab shown bigger, so this is not a second tab and the transport the user was
   * just using keeps driving the picture.
   */
  async openPreview(entry: string | null): Promise<void> {
    if (this.opening || this.openingCanvas) return
    this.opening = true
    try {
      if (this.video) {
        // A folder with no entry page has nothing to serve, so there is no page to
        // show full screen. The board says so in the pane instead.
        if (!this.playable || this.selected.directory === '') return
        await this.ensureComposition(this.selected.directory)
        // A view main already holds is not reloaded, so no state follows the open.
        // Reading its own state is what guarantees the surface has a tab to show
        // rather than opening on nothing.
        if (
          this.boardTabId !== '' &&
          videoTimelineState.compositionByTab(this.boardTabId) === null
        ) {
          await videoTimelineState.seed(this.boardTabId)
        }
        if (this.boardTabId !== '') this.root.studio.compositionFullscreen = true
        return
      }
      await this.openWork(this.selected.directory, entry)
    } finally {
      this.opening = false
    }
  }

  /** Bring the Screen Canvas forward, in its own tab. */
  async openCanvas(): Promise<void> {
    if (this.opening || this.openingCanvas) return
    this.openingCanvas = true
    try {
      await this.openWork(this.selected.directory, SCREEN_CANVAS_PATH)
    } finally {
      this.openingCanvas = false
    }
  }

  /** Read the design's canvas state, and remember that main answered. */
  async loadCanvas(): Promise<void> {
    const directory = this.selected.directory
    if (directory === '' || this.selectedMissing) {
      this.canvasState = null
      this.canvasDirectory = ''
      this.canvasRead = true
      return
    }
    // Another folder's answer must not stand in for this one while it is read,
    // so the strip is held back until this folder has its own.
    if (directory !== this.canvasDirectory) this.canvasRead = false
    try {
      const state = await invoke(
        'design:canvas',
        this.root.props.projectId,
        this.root.props.threadId,
        directory
      )
      // A switch that landed while this read was in flight owns the strip now.
      if (directory !== this.selected.directory) return
      this.canvasState = state
    } catch (failure) {
      if (directory !== this.selected.directory) return
      // A board that cannot read the canvas still shows the screens, so this is
      // logged rather than shown, and the strip falls back to "not made yet".
      logRendererError('The design canvas state could not be read.', failure)
      this.canvasState = null
    }
    this.canvasDirectory = directory
    this.canvasRead = true
  }

  /**
   * Ask the agent for what the design still needs to be live.
   *
   * The canvas itself never needs asking: the app generates it from the folder.
   * What a folder cannot say on its own is an entry page for the preview to open
   * and the real screens behind the states still declared as sketches, so that is
   * all this asks for.
   *
   * The request is a message in the thread, sent when the agent is idle and
   * queued behind a running turn when it is not: the menu never steers work in
   * flight, and what happened is said under the header either way.
   */
  async requestLivePreview(): Promise<void> {
    if (this.selected.directory === '' || this.canvasBusy !== '') return
    this.canvasBusy = 'live'
    this.canvasNotice = ''
    try {
      const text = screenCanvasLivePreviewMessage({
        directory: this.selected.directory,
        sketchTitles: (this.canvasState?.sketches ?? []).map((sketch) => sketch.title),
        needsEntry: !this.liveReady
      })
      const delivery = await sendOrQueueThreadMessage(
        this.root.props.projectId,
        this.root.props.threadId,
        { text }
      )
      this.canvasNotice =
        delivery === 'queued'
          ? 'Queued: it will be built when the current turn ends.'
          : 'Asked the agent to make the design live.'
      this.error = ''
    } catch (failure) {
      this.error = failure instanceof Error ? failure.message : 'The request could not be sent.'
    } finally {
      this.canvasBusy = ''
    }
  }

  async requestDesignAction(
    action: 'contract' | 'critique' | 'reference' | 'tweaks',
    referenceUrl?: string
  ): Promise<void> {
    if (!this.selected.directory || this.canvasBusy) return
    this.canvasBusy = action
    try {
      const directoryLiteral = JSON.stringify(this.selected.directory)
      const text =
        action === 'contract'
          ? designContractRequest(this.selected.directory)
          : action === 'critique'
            ? `@cio-design Review the design in ${directoryLiteral}. Render each screen, check phone and desktop widths, exercise its main interactions and run craft lint. Record a single evidence-based critique per screen using the design capability's rubric, report scores and concrete fixes, and mark any failing screens unfinished. Do not silently run critique loops.`
            : action === 'reference'
              ? `@cio-design Extract a lightweight brand contract from the reference site ${JSON.stringify(referenceUrl ?? '')} for the design in ${directoryLiteral}. Use extract-reference to measure it, compare with existing project CSS tokens and the current contract, then generate DESIGN.md with write-contract so existing contracts are preserved as dated backups. Report measured values separately from inferred rules.`
              : `@cio-design Add lightweight live review controls to the design in ${directoryLiteral} using data-cio-tweaks and /__cio/tweaks.js. Reuse its actual CSS variables and add only useful controls such as accent, spacing, theme or sample data. Changes must update the existing DOM without reload. Wire cio:tweaks listeners for theme or content controls, test them in the preview, and keep these review controls out of production implementation.`
      const delivery = await sendOrQueueThreadMessage(
        this.root.props.projectId,
        this.root.props.threadId,
        {
          text
        }
      )
      this.canvasNotice =
        delivery === 'queued'
          ? 'Design action queued.'
          : action === 'contract'
            ? 'Asked the agent to generate DESIGN.md.'
            : action === 'critique'
              ? 'Asked the agent to review this design.'
              : action === 'reference'
                ? 'Asked the agent to extract the reference brand.'
                : 'Asked the agent to add live review controls.'
    } catch (failure: unknown) {
      this.error =
        failure instanceof Error ? failure.message : 'Could not request this design action.'
    } finally {
      this.canvasBusy = ''
    }
  }

  /**
   * Catch the board up with what a settled turn wrote.
   *
   * The canvas state decides whether the canvas entry is behind, and the sweep
   * behind `loadGallery` is what pictures a screen the turn just wrote, so a design
   * that gained a screen shows it without the user pressing Refresh. The sweep is
   * cached against each file's own stamp, so a settle that changed nothing loads no
   * page at all.
   *
   * A composition is read for its canvas state only: its picture comes from the
   * thread's own tab, and re-picturing it would move a page the user may be
   * watching.
   */
  async refreshSettledWork(): Promise<void> {
    await this.loadCanvas()
    if (this.video) return
    await this.loadGallery()
  }

  /**
   * Refresh the board's own reading of the work.
   *
   * A design re-pictures its screens and its canvas. A composition also re-reads
   * its jobs and remounts its timeline and controls, so the one Refresh in the
   * header is the whole board's reload and the controls do not need their own. The
   * remount discards unsaved control edits, so those are confirmed first.
   */
  async refreshBoard(): Promise<void> {
    await projectWorkState.refresh(this.root.props.projectId, this.root.props.threadId)
    await this.loadState()
    if (this.video) {
      if (this.root.studio.studioDirty) {
        this.root.studio.reloadRequested = true
        return
      }
      this.reloadVideoBoard()
      return
    }
    void this.loadGallery(true)
    void this.loadCanvas()
  }

  /** Re-read a composition after a refresh: picture, jobs, timeline and controls. */
  reloadVideoBoard(): void {
    this.root.studio.boardRevision += 1
    void this.loadGallery(true)
    void this.root.studio.readVideoJobs()
    // A view that was closed under the board has nothing to mount, so the one
    // Refresh asks for it again rather than leaving the stage on a still.
    if (this.video) void this.ensureComposition(this.selected.directory, true)
  }

  /**
   * Read the export the composition in front already has.
   *
   * Asked on every job poll rather than once per folder, because an export the
   * agent runs from another thread writes this file with no job of ours to report
   * it, and the board should stand on it as soon as it exists. A read that fails,
   * or one that is answered for a folder the user has already left, leaves the
   * answer it had rather than blanking a board the user is watching.
   */
  async readSavedExport(): Promise<void> {
    const directory = this.selected.directory
    if (!this.video || directory === '') {
      this.root.studio.savedExport = null
      return
    }
    try {
      const path = await invoke(
        'video:latestExport',
        this.root.props.projectId,
        this.root.props.threadId,
        directory
      )
      if (this.selected.directory === directory) this.root.studio.savedExport = path
    } catch (failure) {
      logRendererError('The export this composition has could not be read.', failure)
    }
  }

  /**
   * Start an export from the board's own menu or the controls' primary action.
   *
   * The export reports in the shared dockable export panel, so the board only
   * hands the folder over; its own job poll picks the running export up again for
   * the readout above the controls.
   */
  exportVideo(): void {
    if (this.selected.directory === '') return
    const directory = this.selected.directory
    void import('$lib/stores/export-progress.svelte')
      .then(({ exportProgressState }) =>
        exportProgressState.startVideo(
          this.root.props.projectId,
          this.root.props.threadId,
          directory
        )
      )
      .catch((failure: unknown) => {
        this.error = failure instanceof Error ? failure.message : 'The export could not be started.'
      })
  }
}
