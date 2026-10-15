<script lang="ts">
  import { onMount } from 'svelte'
  import {
    Check,
    ChevronDown,
    Copy,
    Download,
    Ellipsis,
    Film,
    Frame,
    GlobeCode,
    History,
    ImageOff,
    ListClock,
    LoaderCircle,
    Pencil,
    PlayingCardsFan,
    Presentation,
    RefreshCw,
    RotateCcw,
    Target,
    Volume2,
    VolumeX,
    X
  } from '@lucide/svelte'
  import { ContextMenu, DropdownMenu } from 'bits-ui'
  import { toast } from 'svelte-sonner'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import DesignHistoryActions from '$lib/components/design/DesignHistoryActions.svelte'
  import DesignHistoryPanel from '$lib/components/design/DesignHistoryPanel.svelte'
  import CompositionStage from '$lib/components/design/CompositionStage.svelte'
  import VideoStudioControls from '$lib/components/design/VideoStudioControls.svelte'
  import VideoTimeline from '$lib/components/design/VideoTimeline.svelte'
  import StalePanelNotice from '$lib/components/ui/StalePanelNotice.svelte'
  import { copyText } from '$lib/copy-text'
  import { designCopyFor } from '$lib/design-copy-context'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { designCoordinatorState } from '$lib/stores/design-coordinator.svelte'
  import { projectWorkState } from '$lib/stores/project-work.svelte'
  import { videoTimelineState } from '$lib/stores/video-timeline.svelte'
  import { videoPackagesStore } from '$lib/stores/video-packages.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { sendOrQueueThreadMessage } from '$lib/stores/thread-delivery'
  import { openThreadById } from '$lib/threads/open-thread-by-id'
  import { logRendererError } from '$lib/system/renderer-logger'
  import { workRootMoveSummary } from '$lib/design-work-root-summary'
  import { openInBrowser } from '$lib/open-in-browser'
  import { designContractRequest } from '$shared/design/design-contract'
  import type { VideoJob } from '$shared/video/studio'
  import { DESIGN_EXPORT_FORMATS, type DesignExportFormat } from '$shared/design/design-export'
  import { isThreadBusyStatus } from '$shared/thread-status-policy'
  import { formatCompactAge, formatDateTime } from '$shared/date-time-format'
  import {
    SCREEN_CANVAS_FILE,
    isScreenCanvasEntry,
    screenCanvasLivePreviewMessage,
    screenCanvasRequestMessage
  } from '$shared/design/screen-canvas'
  import type {
    AuthoredWorkKind,
    DesignEntry,
    DesignScreenShot,
    ScreenCanvasState,
    ThreadDesignState,
    WorkRootState
  } from '$shared/ipc-contract'
  import type { WorkRoots } from '$shared/design/work-roots'

  /**
   * The coordinator board for a thread's authored work.
   *
   * A session's work is a folder of HTML, and the user's question after a restart is
   * "where did my design go?" or "where did my video go?". This panel answers it: the
   * folder in use, a preview of every screen it holds, and the controls that move
   * between designs, bring one on screen, or ask the agent for more.
   *
   * The panel is a header plus one scrolling surface. The header owns the design in
   * front, the refresh and the menu; every other design of the project sits behind
   * the dropdown beside it, so a project with a dozen designs still shows one tab
   * and a way to reach the rest. The surface is the board, and its first two entries
   * are the two pages
   * that are not screens: the Screen Canvas that shows every screen at once, and the
   * live preview a visitor lands on. Everything after them is a screen of the folder
   * in front, all the same size: a picture is a picture of a screen, not the screen
   * itself, and the one in front is marked rather than enlarged.
   *
   * The canvas is the one entry that can fall behind the design it frames, and that is
   * the board's warning rather than a line of text: the same banner a stale panel
   * wears, over the screens, with the one action that fixes it.
   *
   * It loads its own state rather than receiving it through props, because the work
   * outlives the turn that made it: there is no live turn to hand it anything, and a
   * restarted app has to fill this in from main alone.
   */

  interface Props {
    projectId: string
    threadId: string
    /**
     * The kind this board shows, when the project's rail opened it rather than a
     * session. A session board reads its kind from the thread; the rail's entry
     * offers the project's designs or videos on whatever thread the user is on,
     * so it sets the kind here.
     */
    kind?: AuthoredWorkKind
  }

  let { projectId, threadId, kind: forcedKind }: Props = $props()

  /**
   * How wide a screen is pictured at.
   *
   * One size for every card, so the pictures are taken once and shown at whatever
   * size the grid gives them: a second size would be a second sweep of page loads
   * for the same screens. The capture is the parked tab's viewport, so every picture
   * has the same shape and the cards line up.
   */
  const SCREEN_SHOT_WIDTH = 520

  /**
   * The file the live preview opens: the design's own entry page.
   *
   * A design is previewed by opening the page a visitor lands on, and the design
   * playbook makes that `index.html`. A folder without one has nothing to preview
   * live, which is what the board's menu offers to fix.
   */
  const LIVE_PREVIEW_ENTRY = 'index.html'

  // Seeded from whatever the workspace already fetched, so the panel paints on
  // its first frame instead of flashing a spinner.
  // svelte-ignore state_referenced_locally
  let designState = $state<ThreadDesignState | null>(
    designCoordinatorState.stateFor(projectId, threadId)
  )
  let gallery = $state<DesignScreenShot[]>([])
  let galleryBusy = $state(false)
  /** The design preview in flight, so its own button shows the wait. */
  let opening = $state(false)
  /** The canvas open in flight, kept apart from the design preview so opening one
   *  never spins the other's button. */
  let openingCanvas = $state(false)
  let error = $state('')
  /** The tab holding the work, so the board can reach its own controls. Empty
   *  until the first capture opens one, and an empty id reads as idle state. */
  let tabId = $state('')

  /**
   * Whether the history pane is on screen.
   *
   * The pane is what makes iteration safe, so it is one click from the board rather
   * than a detour: the design stays in the top half and its history opens under it.
   */
  let historyOpen = $state(false)

  /**
   * The composition's jobs, read by the board.
   *
   * The board draws the export above the controls and the controls report progress
   * below, so the board holds the one list and hands it down: two readers could
   * disagree about whether an export is running. A design has no jobs, so this
   * stays empty for it.
   */
  let videoJobs = $state.raw<VideoJob[]>([])
  /** Whether the studio controls hold unsaved edits, which a reload would discard. */
  let studioDirty = $state(false)
  /** Bumped to remount the video timeline and controls, so a refresh re-reads them. */
  let boardRevision = $state(0)
  /** Whether the user asked to reload over unsaved video controls. */
  let reloadRequested = $state(false)
  /**
   * Undo and Redo for the folder in front, published by the history pane.
   *
   * The pane owns the history read; the board only shows the two steps, so the
   * checkpoint is one click away without opening the pane. A design and a
   * composition share this, which is the point: the same control, the same place.
   */
  let historyActions = $state<{
    canUndo: boolean
    canRedo: boolean
    undo: () => void
    redo: () => void
  } | null>(null)

  /**
   * The folder the user is looking at, when it is not the thread's own.
   *
   * A design tab is a view change, not a preview: picking another design shows its
   * screens here and leaves the browser alone, and the thread's own folder takes the
   * board back the moment the agent or a preview moves it.
   */
  let viewedDirectory = $state('')

  /**
   * The design's Screen Canvas: the page that shows every screen at once.
   *
   * It is agent work like the screens are, so the board's part is only to say
   * whether one exists, ask for it, and say when it has fallen behind. The frames
   * are main's answer, because the page is a file the board cannot read for itself.
   */
  let canvasState = $state<ScreenCanvasState | null>(null)
  /** Whether main has answered about the canvas, so its entry is not drawn from
   *  "no canvas yet" before the first read settles. */
  let canvasRead = $state(false)
  /** Which canvas request is in flight, or an empty string when none is. */
  let canvasBusy = $state('')
  /** The folder the canvas answer belongs to, so a folder switch cannot paint
   *  the previous folder's canvas entry while the new one is being read. */
  let canvasDirectory = $state('')
  /** What happened to the last canvas request, in the user's terms. */
  let canvasNotice = $state('')

  /** The session's words and icon: a design session and a video session share this
   *  board, so nothing below hard-codes the word "design". A board the project's
   *  rail opened carries its kind instead of reading it from the thread. */
  let requestedKind = $derived<AuthoredWorkKind>(forcedKind ?? designState?.kind ?? 'design')
  let video = $derived(requestedKind === 'video')
  /** The newest finished export, played in the board above the timeline. */
  let exportPath = $derived.by(() => {
    if (!video) return null
    const files = videoJobs.flatMap((job) =>
      job.operation === 'export' && job.state === 'completed' ? job.files : []
    )
    return files.at(-1) ?? null
  })
  let noun = $derived(video ? 'composition' : 'design')
  let nounTitle = $derived(video ? 'Composition' : 'Design')
  let listLabel = $derived(video ? 'Compositions in this project' : 'Designs in this project')
  let WorkIcon = $derived(video ? Film : Frame)

  /**
   * Where this kind of work is written, and the controls that change it.
   *
   * The folder is a setting rather than a constant, so the board is also the
   * place a user points it at a folder Git tracks: they are looking at the work,
   * so moving it is one menu item rather than a detour through Settings. Main owns
   * the value and reports what the move did, which is why the draft is saved
   * through the same channel the settings card uses.
   */
  let kind = $derived<AuthoredWorkKind>(requestedKind)
  let workRoots = $state<WorkRootState | null>(null)
  let editingRoot = $state(false)
  let rootDraft = $state('')
  let rootBusy = $state(false)
  let rootError = $state('')
  let rootNotice = $state('')

  /** The folder in use: main's answer once it has arrived, the board's until then. */
  let workRoot = $derived(workRoots?.roots[kind] ?? designState?.root ?? '')
  let defaultRoot = $derived(workRoots?.defaults[kind] ?? '')
  let rootIsDefault = $derived(workRoot !== '' && workRoot === defaultRoot)

  /**
   * The tab's live audio state, read from the same store the tab strip reads.
   *
   * A composition's mute is a property of its tab, so the board drives that one
   * rather than keeping its own: the speaker in this panel and the speaker on the
   * tab can then never disagree about whether the work is audible.
   */
  let tabRuntime = $derived(contextSidebarState.browserRuntime(tabId))
  /** What the mute button does next, in this board's own words. */
  let muteLabel = $derived(
    tabRuntime.muted ? `Unmute the ${noun} preview` : `Mute the ${noun} preview`
  )

  /** Every folder of this kind the project holds, newest first.
   *
   * A rail-opened board lists the project's folders for its own kind, so the
   * board shows the work whether or not the thread on screen has any; a session
   * board keeps the listing main answered alongside its own record. */
  let items = $derived(
    forcedKind !== undefined
      ? projectWorkState.itemsFor(projectId, forcedKind)
      : (designState?.items ?? [])
  )
  /** How many designs sit behind the "Others" trigger. */
  let otherCount = $derived(Math.max(0, items.length - 1))
  /** What the trigger and its menu are called, in this board's own words. */
  let switchLabel = $derived(
    `Switch ${noun}, ${otherCount} other ${otherCount === 1 ? noun : `${noun}s`} in this project`
  )
  /** The folder this thread last previewed, when it belongs to the kind on screen.
   *  A rail-opened board ignores a record that describes the other kind. */
  let currentFolder = $derived.by(() => {
    const current = designState?.current ?? null
    if (current === null) return null
    if (forcedKind !== undefined && current.kind !== forcedKind) return null
    return current
  })
  /** The folder in front: the one the user picked, else the thread's own. */
  let selected = $derived.by(() => {
    const current = currentFolder
    const picked =
      viewedDirectory !== '' && items.some((item) => item.directory === viewedDirectory)
        ? viewedDirectory
        : ''
    const directory =
      picked !== '' ? picked : (current?.directory ?? items[0]?.directory ?? workRoot)
    return { directory, entry: current?.directory === directory ? current.entry : null }
  })
  /** The folder in front as main lists it, which is where its entry page is known. */
  let selectedItem = $derived(items.find((item) => item.directory === selected.directory) ?? null)
  let selectedName = $derived(selectedItem?.name ?? selected.directory.split('/').at(-1) ?? '')
  /**
   * The view this board plays its composition in, named by main when it opened it.
   *
   * The board owns its view rather than borrowing the thread's browser tab, so
   * the view's id is the only way to be sure which page is being placed in the
   * stage. Empty until the first open settles.
   */
  let boardTabId = $state('')
  /**
   * Whether the optional video pack is installed, which is what enables the
   * live editor.
   *
   * The pack is the app's one on-demand video dependency, so it is the signal
   * for whether the board offers direct editing at all: with it the board plays
   * the composition, scrubs it and edits its controls, and without it the board
   * stays a reader and the user edits by prompting the agent.
   */
  let liveEditing = $derived(video && videoPackagesStore.state?.installed === true)
  /**
   * The composition the board is playing, when its own view is on screen.
   *
   * The view arrives on `browser:state`, and it is addressed by the id main
   * returned rather than by the thread: a browser tab on the same folder must not
   * be mistaken for the board's own page. While it is here the board is a player
   * and an editor at once, and while it is not the stage falls back to the last
   * export or the captured frame.
   */
  let liveTab = $derived(boardTabId !== '' ? videoTimelineState.compositionByTab(boardTabId) : null)
  /**
   * Whether the folder in front has an entry page, which is what makes it playable.
   *
   * A composition folder with no `index.html` yet is a folder of assets rather than
   * a composition: there is nothing to serve, so the board says so instead of
   * opening a tab on a directory listing.
   */
  let playable = $derived(video && selectedItem?.hasEntry === true)
  /** The folder whose composition the board is opening right now, or an empty string. */
  let composing = $state('')
  /** Why the last open failed, in the user's terms, or an empty string. */
  let compositionError = $state('')
  /**
   * The folder this board has already asked main to open.
   *
   * Deliberately not reactive state: it guards the effect below against asking
   * twice for one folder, and nothing renders it. A failure is reported and not
   * retried, so a folder that cannot be served never spins.
   */
  let compositionAsked = ''
  /**
   * The thread that created the design in front, or an empty string when none is
   * recorded.
   *
   * A design is created by one thread, and the board can send the user there, so
   * this is the id the reveal control acts on. A folder that predates origin
   * recording, or whose creating thread has been deleted, has none, and the
   * control stays off rather than guessing.
   */
  let selectedCreatorThreadId = $derived(selectedItem?.creatorThreadId ?? '')
  /**
   * Whether there is another thread to reveal.
   *
   * False when no creator is recorded and false when the creator is this very
   * thread: a control that would leave the user where they already are is not a
   * control, so it stays disabled with a title that says why.
   */
  let canRevealCreator = $derived(
    selectedCreatorThreadId !== '' && selectedCreatorThreadId !== threadId
  )
  /** What the reveal control says, whether it acts or explains why it cannot. */
  let revealLabel = $derived.by(() => {
    const name = selectedName === '' ? nounTitle : selectedName
    if (canRevealCreator) return `Reveal the thread that created ${name}`
    if (selectedCreatorThreadId === threadId) return `This thread created ${name}`
    return 'Thread unavailable'
  })

  /**
   * The two entries that are not screens, and the screens themselves.
   *
   * The canvas is swept with the screens so its entry has a picture like any other,
   * and the live preview is the design's entry page pictured once more. Both are
   * split out of the grid's screens rather than listed twice.
   */
  let canvasShot = $derived(gallery.find((screen) => isScreenCanvasEntry(screen.entry)) ?? null)
  let designScreens = $derived(gallery.filter((screen) => !isScreenCanvasEntry(screen.entry)))
  let liveShot = $derived(
    designScreens.find((screen) => screen.entry === LIVE_PREVIEW_ENTRY) ?? null
  )
  /** Whether the design has a page the live preview could open at all. Main's
   *  listing knows the entry file, and the sweep shows it once it is pictured, so
   *  either answer is enough to open it. */
  let liveReady = $derived(!video && (selectedItem?.hasEntry === true || liveShot !== null))
  /** What the canvas entry says while it has no picture to show. */
  let canvasEntryNote = $derived(
    !canvasRead
      ? 'Reading the canvas…'
      : canvasState === null
        ? 'No Screen Canvas yet'
        : 'No preview yet.'
  )
  /** What the live preview entry says while it has no picture to show. */
  let liveEntryNote = $derived(liveReady ? 'No preview yet.' : 'No entry page yet')

  /** What the canvas is behind on, in one line, or nothing when it is current. */
  let canvasDrift = $derived.by(() => {
    const state = canvasState
    if (state === null) return ''
    const parts: string[] = []
    const missing = state.missingScreens.length
    const changed = state.changedScreens.length
    const orphaned = state.orphanFrames.length
    if (missing > 0) parts.push(`${missing} screen${missing === 1 ? '' : 's'} not on it yet`)
    if (changed > 0) parts.push(`${changed} changed since it was written`)
    if (orphaned > 0) {
      parts.push(`${orphaned} frame${orphaned === 1 ? '' : 's'} with no screen left`)
    }
    return parts.join(' · ')
  })

  let refreshLabel = $derived(video ? 'Refresh the composition preview' : 'Refresh the screens')
  let screensLabel = $derived(
    video ? 'Composition preview' : `Screens in this design (${designScreens.length})`
  )

  async function loadState(): Promise<void> {
    const before = designState?.current?.directory ?? ''
    try {
      designState = await invoke('design:state', projectId, threadId)
      const current = designState.current?.directory ?? ''
      // The thread's own folder is the truth: when the agent, or a preview, moves
      // it, the board follows rather than staying on a tab the user picked earlier.
      if (current !== before && current !== viewedDirectory) viewedDirectory = ''
      error = ''
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'The work state could not be read.'
    }
  }

  /** Read the folders in use, and what the last change moved. */
  async function loadWorkRoots(): Promise<WorkRootState | null> {
    try {
      const state = await invoke('design:workRootState')
      workRoots = state
      return state
    } catch {
      // A board that cannot read the setting still shows the work, so the folder
      // line falls back to what the board's own state reported.
      workRoots = null
      return null
    }
  }

  function beginEditRoot(): void {
    rootDraft = workRoot
    rootError = ''
    rootNotice = ''
    editingRoot = true
  }

  function cancelEditRoot(): void {
    editingRoot = false
    rootError = ''
  }

  /**
   * Point this kind of work at another folder, or back at the default.
   *
   * The setting is app-wide, so main moves every project's folder and answers with
   * what it moved. The board re-reads its own state afterwards, because the folder
   * it was showing may be the one that just moved.
   */
  async function applyRoot(next: string): Promise<void> {
    const roots = workRoots?.roots
    if (!roots || rootBusy || next === '' || next === workRoot) return
    const nextRoots: WorkRoots =
      kind === 'video' ? { ...roots, video: next } : { ...roots, design: next }
    rootBusy = true
    rootError = ''
    rootNotice = ''
    try {
      await invoke('config:update', { workRoots: nextRoots })
      const state = await loadWorkRoots()
      await loadState()
      await loadGallery()
      await loadCanvas()
      rootNotice = state ? workRootMoveSummary(state, kind) : ''
      editingRoot = false
    } catch (failure) {
      rootError = failure instanceof Error ? failure.message : 'The save path could not be changed.'
    } finally {
      rootBusy = false
    }
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
   * Once the board is playing the composition in its own view, that call is
   * skipped: the live view is on screen, and a poster would reload it to a still
   * under the playhead. The mute then drives the view the user is watching.
   */
  async function loadGallery(force = false): Promise<void> {
    if (selected.directory === '') {
      gallery = []
      return
    }
    galleryBusy = true
    try {
      if (video && liveEditing && boardTabId !== '') {
        gallery = []
        tabId = boardTabId
      } else if (video) {
        const shot = await invoke(
          'design:thumbnail',
          projectId,
          threadId,
          selected.directory,
          selected.entry,
          SCREEN_SHOT_WIDTH,
          forcedKind
        )
        gallery = [
          {
            entry: selected.entry ?? '',
            name: selectedName,
            dataUrl: shot.dataUrl,
            width: shot.width,
            height: shot.height
          }
        ]
        tabId = shot.tabId ?? ''
      } else {
        gallery = await invoke(
          'design:screens',
          projectId,
          threadId,
          selected.directory,
          SCREEN_SHOT_WIDTH,
          force
        )
      }
      error = ''
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'The screens could not be pictured.'
    } finally {
      galleryBusy = false
    }
  }

  /**
   * Show another design of this project on the board. A view change, not a preview.
   *
   * This is what picking an entry from the dropdown runs, so the board follows the
   * user's choice while the browser stays where it is.
   */
  function selectDesign(directory: string): void {
    if (directory === '' || directory === selected.directory) return
    viewedDirectory = directory
    gallery = []
    void loadGallery()
    void loadCanvas()
  }

  /** Pick a design from the dropdown, which the radio group reports as a string. */
  function handleDesignChange(directory: string): void {
    selectDesign(directory)
  }

  /**
   * Show the thread that created the design in front.
   *
   * A design is often iterated in a later thread than the one that made it, and
   * the user asks "where did this come from?" from the board. Revealing the
   * creator opens that thread in its owning view, the same way an 'Open thread'
   * notification does, so the question is answered without a search.
   */
  async function revealCreator(): Promise<void> {
    if (!canRevealCreator) return
    await openThreadById(projectId, selectedCreatorThreadId)
  }

  /** Serve the work and bring its tab to the user. Main reveals it; the
   *  workspace opens and focuses the sidebar tab from that event, so this panel
   *  never has to know how the browser is laid out. */
  async function openWork(directory: string, entry: string | null): Promise<void> {
    if (directory === '') return
    try {
      await invoke('design:open', projectId, threadId, directory, entry, true, forcedKind)
      await loadState()
      await loadGallery()
      await loadCanvas()
      error = ''
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'The work could not be opened.'
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
  async function ensureComposition(directory: string, force = false): Promise<void> {
    if (!video || directory === '') return
    if (!force && compositionAsked === directory) return
    compositionAsked = directory
    composing = directory
    try {
      const opened = await invoke(
        'design:open',
        projectId,
        threadId,
        directory,
        null,
        false,
        forcedKind
      )
      boardTabId = opened.tabId
      compositionError = ''
    } catch (failure) {
      compositionError =
        failure instanceof Error ? failure.message : `The ${noun} could not be opened.`
    } finally {
      if (composing === directory) composing = ''
    }
  }

  /** Preview one screen, or the design's own entry file. */
  async function openPreview(entry: string | null): Promise<void> {
    if (opening || openingCanvas) return
    opening = true
    try {
      await openWork(selected.directory, entry)
    } finally {
      opening = false
    }
  }

  /** Bring the Screen Canvas forward, in its own tab. */
  async function openCanvas(): Promise<void> {
    if (opening || openingCanvas) return
    openingCanvas = true
    try {
      await openWork(selected.directory, SCREEN_CANVAS_FILE)
    } finally {
      openingCanvas = false
    }
  }

  /** Read the design's canvas state, and remember that main answered. */
  async function loadCanvas(): Promise<void> {
    const directory = selected.directory
    if (directory === '') {
      canvasState = null
      canvasDirectory = ''
      canvasRead = true
      return
    }
    // Another folder's answer must not stand in for this one while it is read,
    // so the strip is held back until this folder has its own.
    if (directory !== canvasDirectory) canvasRead = false
    try {
      const state = await invoke('design:canvas', projectId, threadId, directory)
      // A switch that landed while this read was in flight owns the strip now.
      if (directory !== selected.directory) return
      canvasState = state
    } catch (failure) {
      if (directory !== selected.directory) return
      // A board that cannot read the canvas still shows the screens, so this is
      // logged rather than shown, and the strip falls back to "not made yet".
      logRendererError('The design canvas state could not be read.', failure)
      canvasState = null
    }
    canvasDirectory = directory
    canvasRead = true
  }

  /**
   * Ask the agent for the canvas, or for the change the user just asked for.
   *
   * The request is a message in the thread, sent when the agent is idle and
   * queued behind a running turn when it is not: the menu never steers work in
   * flight, and what happened is said under the header either way.
   */
  async function requestCanvas(action: 'create' | 'update' | 'live'): Promise<void> {
    if (selected.directory === '' || canvasBusy !== '') return
    canvasBusy = action
    canvasNotice = ''
    try {
      const text =
        action === 'live'
          ? screenCanvasLivePreviewMessage({
              directory: selected.directory,
              sketchTitles: canvasState?.sketchTitles ?? [],
              needsEntry: !liveReady
            })
          : screenCanvasRequestMessage({
              directory: selected.directory,
              updating: action === 'update',
              missingScreens: canvasState?.missingScreens ?? [],
              changedScreens: canvasState?.changedScreens ?? [],
              orphanFrames: canvasState?.orphanFrames ?? [],
              sketchTitles: canvasState?.sketchTitles ?? []
            })
      const delivery = await sendOrQueueThreadMessage(projectId, threadId, { text })
      canvasNotice =
        delivery === 'queued'
          ? 'Queued: it will be built when the current turn ends.'
          : action === 'live'
            ? 'Asked the agent to make the design live.'
            : action === 'create'
              ? 'Asked the agent to write the canvas.'
              : 'Asked the agent to sync the canvas.'
      error = ''
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'The canvas request could not be sent.'
    } finally {
      canvasBusy = ''
    }
  }

  async function requestDesignAction(
    action: 'contract' | 'critique' | 'reference' | 'tweaks'
  ): Promise<void> {
    if (!selected.directory || canvasBusy) return
    canvasBusy = action
    try {
      const text =
        action === 'contract'
          ? designContractRequest(selected.directory)
          : action === 'critique'
            ? `@cio-design Review the design in ${JSON.stringify(selected.directory)}. Render each screen, check phone and desktop widths, exercise its main interactions and run craft lint. Record a single evidence-based critique per screen using the design capability's rubric, report scores and concrete fixes, and mark any failing screens unfinished. Do not silently run critique loops.`
            : action === 'reference'
              ? `@cio-design Extract a lightweight brand contract from the reference site I name for the design in ${JSON.stringify(selected.directory)}. If no reference URL is attached or supplied, ask me for it. Use extract-reference to measure it, compare with existing project CSS tokens and the current contract, then generate DESIGN.md with write-contract so existing contracts are preserved as dated backups. Report measured values separately from inferred rules.`
              : `@cio-design Add lightweight live review controls to the design in ${JSON.stringify(selected.directory)} using data-cio-tweaks and /__cio/tweaks.js. Reuse its actual CSS variables and add only useful controls such as accent, spacing, theme or sample data. Changes must update the existing DOM without reload. Wire cio:tweaks listeners for theme or content controls, test them in the preview, and keep these review controls out of production implementation.`
      const delivery = await sendOrQueueThreadMessage(projectId, threadId, {
        text
      })
      canvasNotice =
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
      error = failure instanceof Error ? failure.message : 'Could not request this design action.'
    } finally {
      canvasBusy = ''
    }
  }

  function startExport(entry: string | null, format: DesignExportFormat): void {
    const directory = selected.directory
    const exportProjectId = projectId
    void import('$lib/stores/export-progress.svelte')
      .then(({ exportProgressState }) =>
        exportProgressState.startDesign(exportProjectId, directory, entry, format)
      )
      .catch((failure: unknown) => {
        error = failure instanceof Error ? failure.message : 'Could not start export.'
      })
  }

  /** Re-read the canvas once the agent settles, and picture it when it appeared. */
  async function refreshCanvas(): Promise<void> {
    const before = canvasState
    await loadCanvas()
    const appeared = before === null && canvasState !== null
    const rewritten =
      before !== null && canvasState !== null && canvasState.updatedAt !== before.updatedAt
    if (appeared || rewritten) await loadGallery()
  }

  /**
   * Refresh the board's own reading of the work.
   *
   * A design re-pictures its screens and its canvas. A composition also re-reads
   * its jobs and remounts its timeline and controls, so the one Refresh in the
   * header is the whole board's reload and the controls do not need their own. The
   * remount discards unsaved control edits, so those are confirmed first.
   */
  function refreshBoard(): void {
    if (video) {
      if (studioDirty) {
        reloadRequested = true
        return
      }
      reloadVideoBoard()
      return
    }
    void loadGallery(true)
    void loadCanvas()
  }

  /** Re-read a composition after a refresh: picture, jobs, timeline and controls. */
  function reloadVideoBoard(): void {
    boardRevision += 1
    void loadGallery(true)
    void readVideoJobs()
    // A view that was closed under the board has nothing to mount, so the one
    // Refresh asks for it again rather than leaving the stage on a still.
    if (liveEditing) void ensureComposition(selected.directory, true)
  }

  /** Read the composition's jobs, the list the board's export stands on. */
  async function readVideoJobs(): Promise<void> {
    try {
      videoJobs = await invoke('video:jobs', projectId, threadId)
    } catch (failure) {
      logRendererError('The video jobs could not be read.', failure)
    }
  }

  /** Cancel a running job, which the controls ask for rather than doing themselves. */
  async function cancelVideoJob(id: string): Promise<void> {
    try {
      await invoke('video:cancel', projectId, threadId, id)
      await readVideoJobs()
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'The job could not be cancelled.'
    }
  }

  /**
   * Start an export from the board's own menu or the controls' primary action.
   *
   * The export reports in the shared dockable export panel, so the board only
   * hands the folder over; its own job poll picks the running export up again for
   * the readout above the controls.
   */
  function exportVideo(): void {
    if (selected.directory === '') return
    const directory = selected.directory
    void import('$lib/stores/export-progress.svelte')
      .then(({ exportProgressState }) =>
        exportProgressState.startVideo(projectId, threadId, directory)
      )
      .catch((failure: unknown) => {
        error = failure instanceof Error ? failure.message : 'The export could not be started.'
      })
  }

  /** The controls' unsaved state, so a refresh can ask before discarding it. */
  function setStudioDirty(value: boolean): void {
    studioDirty = value
  }

  /** The history pane's Undo and Redo, mirrored into the board header. */
  function handleHistoryActions(state: {
    canUndo: boolean
    canRedo: boolean
    undo: () => void
    redo: () => void
  }): void {
    historyActions = state
  }

  /**
   * Copy a design folder, or one screen inside it, in the form the asking agent
   * can use.
   *
   * The decision lives in the copy helper: a tag when the board's thread shares
   * the project, scope and machine the design lives on, an absolute path when it
   * does not, and the way to reach another Oven when the design is on one.
   */
  async function copyDesignPath(directory: string, entry: string | null = null): Promise<void> {
    if (directory === '') return
    const payload = designCopyFor(directory, entry)
    if (payload === null) {
      toast.error('This design cannot be copied.')
      return
    }
    try {
      await copyText(payload.text, payload.message)
    } catch (failure) {
      logRendererError('The design path could not be copied.', failure)
      toast.error('The design path could not be copied.')
    }
  }

  /**
   * The folder moved along its history, so picture it as it now is.
   *
   * A restore rewrote the files, so the pictures the board holds are pictures of a
   * design that no longer exists: forcing the sweep is what puts the folder the user
   * chose on screen instead of the one they left.
   */
  function restoreBoard(): void {
    void loadGallery(true)
    void loadCanvas()
  }

  onMount(() => {
    // The agent writes the canvas inside a turn, so the board re-reads when that
    // turn settles. Nothing polls: a canvas that appeared is read then, and one
    // that was rewritten is read again then.
    return subscribe('thread:updated', (thread) => {
      if (thread.id !== threadId || thread.projectId !== projectId) return
      if (isThreadBusyStatus(thread.status)) return
      void refreshCanvas()
    })
  })

  onMount(() => {
    void projectWorkState.ensure(projectId)
    // The board is one of the surfaces that watches the optional video pack, so
    // installing it from Settings turns on live editing here without a reload.
    void videoPackagesStore.load()
    void loadState().then(async () => {
      await loadGallery()
      await loadCanvas()
    })
    void loadWorkRoots()
    return () => videoPackagesStore.dispose()
  })

  // Play the composition in the board rather than in the browser.
  //
  // The folder in front changes, a rail panel comes back on screen, or a tab was
  // closed under the board: every one of those leaves the stage with nothing to
  // mount, and this is what asks for the tab again. Only the folder, the live tab
  // and whether the folder is playable are read here, so a report from
  // `browser:state` is what settles it rather than a poll.
  $effect(() => {
    const directory = selected.directory
    const live = liveTab
    const canPlay = playable
    const busyFolder = composing
    const enhanced = liveEditing
    if (
      !video ||
      !enhanced ||
      !canPlay ||
      live !== null ||
      directory === '' ||
      busyFolder === directory
    )
      return
    void ensureComposition(directory)
  })

  // The board owns the composition job poll, because it draws the export above the
  // controls and both must read the same list. A design has no jobs, so nothing
  // polls for one.
  $effect(() => {
    if (!video) return
    void readVideoJobs()
    const timer = setInterval(() => void readVideoJobs(), 1500)
    return () => clearInterval(timer)
  })

  /** A design's age, in the same compact form a thread row uses. */
  function ageLabel(value: number): string {
    return value > 0 ? formatCompactAge(value) : ''
  }

  /** A design's timestamps in full, for the row's tooltip. */
  function designTooltip(item: DesignEntry): string {
    if (!item.hasEntry) return `${item.name}, no entry page`
    const parts = [item.name]
    if (item.createdAt > 0) parts.push(`created ${formatDateTime(item.createdAt)}`)
    if (item.updatedAt > 0) parts.push(`updated ${formatDateTime(item.updatedAt)}`)
    return parts.join(', ')
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  {#snippet videoStage()}
    {#if video && selected.directory !== '' && !liveEditing}
      <!--
        Live editing is off because the optional video pack is not installed.

        The board stays a reader: it shows the last export or the captured still
        and the timeline below still places notes, so a user edits by prompting
        the agent. The pack is what turns the board into a player and a direct
        editor, so the one thing this asks for is the pack, in one click, rather
        than explaining a setting the user would have to go and find.
      -->
      <div class="mb-2 shrink-0 border border-border bg-surface p-3">
        <div class="flex items-center gap-1.5">
          <Download size={13} class="text-accent" aria-hidden="true" />
          <span class="text-xs font-semibold text-foreground">
            Install the video pack to edit here
          </span>
        </div>
        <p class="mt-1 text-[0.6875rem] leading-relaxed text-muted">
          {exportPath
            ? 'The board plays the composition, scrubs it and edits its controls once the optional video pack is installed. Until then, describe the change to the agent and watch the last export here.'
            : 'The board plays the composition, scrubs it and edits its controls once the optional video pack is installed. Until then, describe the change to the agent.'}
        </p>
        <button
          type="button"
          class="mt-2 bg-primary px-3 py-1.5 text-xs font-medium text-on-primary transition-colors hover:opacity-90"
          title="Open Design and video settings to install the optional video pack"
          aria-label="Open Design and video settings to install the optional video pack"
          onclick={() => workspaceState.navigateToSettings?.('design')}
        >
          Open Settings
        </button>
      </div>
    {/if}
    {#if liveTab}
      <!--
        The live composition, played in the board.

        The stage owns the tab's native view while it is on screen, so the
        transport above the picture and the timeline below both drive the
        composition the user is watching rather than a still of it. The stage fits
        the composition's own aspect ratio inside this pane, so the frame is whole
        at every panel size.
      -->
      <CompositionStage tab={liveTab} />
    {:else if !playable}
      <div
        class="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 border border-border bg-elevated text-dimmed"
      >
        <ImageOff size={16} />
        <span class="px-4 text-center text-[0.6875rem]">
          {`This ${noun} has no entry page yet, so there is nothing to play. The agent writes one when it starts the ${noun}.`}
        </span>
      </div>
    {:else}
      <!--
        Nothing to play yet: the tab is being served, or the folder holds no
        composition to serve. The last export stands in while that settles, in the
        same frame the live stage uses, so the board does not jump when the page
        lands. The action here is a retry in the panel rather than a hand-off to
        the browser, because the browser is not where this board plays.
      -->
      <div
        class="flex min-h-0 flex-1 flex-col overflow-hidden border border-border bg-app"
        aria-label={`${nounTitle} preview`}
      >
        {#if exportPath}
          <video
            class="min-h-0 flex-1 object-contain"
            src={`appfile://project/${projectId}/${exportPath}`}
            controls
            playsinline
            preload="metadata"
            aria-label={`Exported ${noun} ${selectedName}`}
          >
            <track kind="captions" />
          </video>
        {:else if gallery[0]?.dataUrl}
          <img
            src={gallery[0].dataUrl}
            alt={`Preview of the ${noun} ${selectedName}`}
            class="min-h-0 flex-1 object-contain"
          />
        {:else}
          <div class="flex min-h-0 flex-1 items-center justify-center gap-1.5 text-dimmed">
            {#if galleryBusy}
              <LoaderCircle size={14} class="animate-spin" />
              <span class="text-[0.625rem]">Capturing…</span>
            {:else}
              <ImageOff size={14} />
              <span class="text-[0.625rem]">No frame captured yet.</span>
            {/if}
          </div>
        {/if}
        <div
          class="flex shrink-0 items-center justify-between gap-2 border-t border-border px-2 py-1.5"
        >
          <span class="min-w-0 truncate text-[0.625rem] text-dimmed">
            {composing === selected.directory
              ? `Opening the ${noun}…`
              : exportPath
                ? `Latest export · ${exportPath.split('/').at(-1)}`
                : `Waiting for the ${noun} preview`}
          </span>
          <button
            type="button"
            class="shrink-0 border border-border px-1.5 py-0.5 text-[0.625rem] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
            title={`Open the ${noun} preview again`}
            aria-label={`Open the ${noun} preview again`}
            disabled={composing !== ''}
            onclick={() => void ensureComposition(selected.directory, true)}
          >
            Try again
          </button>
        </div>
      </div>
    {/if}
  {/snippet}

  {#snippet screenCard(screen: DesignScreenShot, full: boolean)}
    {@const cardLabel = video
      ? `Open the ${noun} in the in-app browser`
      : `Open the ${noun} screen ${screen.name} in the in-app browser`}
    {@const onScreen = !video && screen.entry === selected.entry}
    {@const copyLabel = video
      ? `Copy the path of this ${noun}`
      : `Copy ${noun} screen: ${screen.name}`}
    <ContextMenu.Root>
      <ContextMenu.Trigger class={full ? 'col-span-2' : ''}>
        <button
          type="button"
          class="group relative block w-full overflow-hidden border bg-elevated transition-colors hover:border-primary/60 {onScreen
            ? 'border-accent/60'
            : 'border-border'}"
          title={cardLabel}
          aria-label={cardLabel}
          onclick={() => void openPreview(screen.entry)}
        >
          {#if screen.dataUrl}
            <img
              src={screen.dataUrl}
              alt={video
                ? `Preview of the ${noun} ${selectedName}`
                : `Preview of the ${noun} screen ${screen.name}`}
              class="block max-h-44 w-full object-cover object-top"
            />
          {:else}
            <span
              class="flex aspect-[16/10] w-full flex-col items-center justify-center gap-1 text-dimmed"
            >
              {#if galleryBusy}
                <LoaderCircle size={14} class="animate-spin" />
                <span class="text-[0.625rem]">Capturing…</span>
              {:else}
                <ImageOff size={14} />
                <span class="px-2 text-center text-[0.625rem]">No preview yet.</span>
              {/if}
            </span>
          {/if}
          <span
            class="absolute inset-x-0 bottom-0 flex items-center bg-gradient-to-t from-black/60 to-transparent px-1.5 pt-3 pb-1"
          >
            <span class="truncate text-[0.625rem] font-medium text-white">{screen.name}</span>
          </span>
          <span
            class="absolute inset-0 flex items-center justify-center bg-black/35 p-2 opacity-0 transition-opacity group-hover:opacity-100"
          >
            <span class="text-[0.625rem] font-medium text-white">Open in the in-app browser</span>
          </span>
        </button>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content class="z-50 min-w-44 border border-border bg-surface p-1 shadow-lg">
          <ContextMenu.Item
            class="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
            onSelect={() => void copyDesignPath(selected.directory, screen.entry)}
          >
            <Copy size={13} class="shrink-0 text-muted" />
            {copyLabel}
          </ContextMenu.Item>
          {#if !video}
            {#each DESIGN_EXPORT_FORMATS as format (format)}
              <ContextMenu.Item
                class="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
                onSelect={() => startExport(screen.entry, format)}
                >Export screen as {format.toUpperCase()}</ContextMenu.Item
              >
            {/each}
          {/if}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  {/snippet}

  {#snippet entryCard(input: {
    icon: typeof Presentation
    name: string
    shot: DesignScreenShot | null
    label: string
    empty: string
    busy: boolean
    ready: boolean
    onOpen: () => void
  })}
    {@const Icon = input.icon}
    <button
      type="button"
      class="group relative block overflow-hidden border border-border bg-elevated transition-colors hover:border-primary/60 disabled:opacity-40"
      title={input.label}
      aria-label={input.label}
      disabled={!input.ready || input.busy}
      onclick={input.onOpen}
    >
      {#if input.shot?.dataUrl}
        <img
          src={input.shot.dataUrl}
          alt={input.label}
          class="block max-h-44 w-full object-cover object-top"
        />
      {:else}
        <span
          class="flex aspect-[16/10] w-full flex-col items-center justify-center gap-1 text-dimmed"
        >
          {#if input.busy}
            <LoaderCircle size={14} class="animate-spin" />
          {:else}
            <Icon size={16} />
          {/if}
          <span class="px-2 text-center text-[0.625rem]">{input.empty}</span>
        </span>
      {/if}
      <span
        class="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/60 to-transparent px-1.5 pt-3 pb-1"
      >
        <Icon size={11} class="shrink-0 text-white/90" aria-hidden="true" />
        <span class="truncate text-[0.625rem] font-medium text-white">{input.name}</span>
      </span>
      {#if input.ready}
        <span
          class="absolute inset-0 flex items-center justify-center bg-black/35 p-2 opacity-0 transition-opacity group-hover:opacity-100"
        >
          <span class="text-[0.625rem] font-medium text-white">Open in the in-app browser</span>
        </span>
      {/if}
    </button>
  {/snippet}

  <header class="shrink-0 border-b border-border">
    <div class="flex items-center gap-1.5 px-2.5 py-1.5">
      {#if items.length > 1}
        <!--
          One tab holds the design in front, and every other design of the project
          waits behind the word beside it. A project with a dozen designs would
          otherwise be a strip that scrolls sideways, hiding the very design the
          user came for; here the tab never moves and the list is one click away.
        -->
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            class="group flex max-w-56 min-w-0 cursor-pointer items-center gap-1 px-1.5 py-0.5 transition-colors hover:bg-elevated data-[state=open]:bg-elevated"
            title="{switchLabel}, currently {selectedName === '' ? nounTitle : selectedName}"
            aria-label="{switchLabel}, currently {selectedName === '' ? nounTitle : selectedName}"
          >
            <WorkIcon size={13} class="shrink-0 text-accent" />
            <span
              class="min-w-0 truncate text-xs font-semibold text-foreground"
              title={selected.directory}
            >
              {selectedName === '' ? nounTitle : selectedName}
            </span>
            {#if !video && designScreens.length > 0}
              <span
                class="shrink-0 border border-border bg-elevated px-1.5 text-[0.625rem] tabular-nums text-muted"
              >
                {designScreens.length}
              </span>
            {/if}
            <span
              class="flex shrink-0 items-center gap-0.5 pl-0.5 text-[0.625rem] font-medium text-dimmed transition-colors group-hover:text-foreground"
            >
              Others
              <ChevronDown size={10} class="shrink-0" />
            </span>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="bottom"
              align="start"
              sideOffset={4}
              collisionPadding={8}
              class="z-50 max-h-72 w-64 overflow-y-auto border border-border bg-surface p-1 shadow-lg"
              aria-label={listLabel}
            >
              <DropdownMenu.RadioGroup
                value={selected.directory}
                onValueChange={handleDesignChange}
              >
                {#each items as item (item.directory)}
                  {@const created = ageLabel(item.createdAt)}
                  {@const updated = ageLabel(item.updatedAt)}
                  {@const stamp =
                    created === ''
                      ? updated
                      : updated === '' || created === updated
                        ? created
                        : `${created} · ${updated}`}
                  <div class="flex items-center gap-0.5 pr-0.5">
                    <DropdownMenu.RadioItem
                      value={item.directory}
                      class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
                      title={designTooltip(item)}
                    >
                      <WorkIcon size={12} class="shrink-0 text-dimmed" />
                      <span class="min-w-0 flex-1 truncate">{item.name}</span>
                      {#if item.creatorThreadId === threadId}
                        <span
                          class="shrink-0 bg-accent/15 px-1 text-[0.5625rem] font-semibold tracking-wide text-accent uppercase"
                        >
                          Current
                        </span>
                      {/if}
                      {#if stamp !== ''}
                        <span class="shrink-0 text-[0.5625rem] tabular-nums text-dimmed">
                          {stamp}
                        </span>
                      {/if}
                      <Check
                        size={12}
                        class={[
                          'shrink-0',
                          item.directory === selected.directory ? 'text-primary' : 'invisible'
                        ]}
                        aria-hidden="true"
                      />
                    </DropdownMenu.RadioItem>
                    <button
                      type="button"
                      class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                      title={`Copy the path of ${item.name}`}
                      aria-label={`Copy the path of ${item.name}`}
                      onclick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        void copyDesignPath(item.directory)
                      }}
                    >
                      <Copy size={11} />
                    </button>
                  </div>
                {/each}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      {:else}
        <WorkIcon size={13} class="shrink-0 text-accent" />
        <span
          class="max-w-40 shrink-0 truncate text-xs font-semibold text-foreground"
          title={selected.directory}
        >
          {selectedName === '' ? nounTitle : selectedName}
        </span>
        {#if !video && designScreens.length > 0}
          <span
            class="shrink-0 border border-border bg-elevated px-1.5 text-[0.625rem] tabular-nums text-muted"
          >
            {designScreens.length}
          </span>
        {/if}
      {/if}
      <span class="min-w-0 flex-1"></span>
      <span class="flex shrink-0 items-center gap-0.5">
        {#if video && tabId !== ''}
          <button
            type="button"
            class="flex h-6 w-6 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground {tabRuntime.muted
              ? 'text-accent'
              : ''}"
            aria-pressed={tabRuntime.muted}
            title={muteLabel}
            aria-label={muteLabel}
            onclick={() => contextSidebarState.toggleBrowserTabMute(tabId)}
          >
            {#if tabRuntime.muted}
              <VolumeX size={12} />
            {:else}
              <Volume2 size={12} />
            {/if}
          </button>
        {/if}
        <button
          type="button"
          class="flex h-6 w-6 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
          disabled={!canRevealCreator}
          title={revealLabel}
          aria-label={revealLabel}
          onclick={() => void revealCreator()}
        >
          <Target size={12} />
        </button>
        {#if historyActions && selected.directory !== ''}
          <DesignHistoryActions
            canUndo={historyActions.canUndo}
            canRedo={historyActions.canRedo}
            undoTitle={`Undo the last change to this ${noun}`}
            redoTitle={`Redo the change to this ${noun}`}
            onUndo={historyActions.undo}
            onRedo={historyActions.redo}
          />
        {/if}
        <button
          type="button"
          class="flex h-6 w-6 items-center justify-center transition-colors hover:bg-elevated disabled:opacity-40 {historyOpen
            ? 'bg-elevated text-foreground'
            : 'text-dimmed hover:text-foreground'}"
          disabled={selected.directory === ''}
          aria-pressed={historyOpen}
          title={`${nounTitle} history`}
          aria-label={`${nounTitle} history`}
          onclick={() => (historyOpen = !historyOpen)}
        >
          <History size={12} />
        </button>
        <button
          type="button"
          class="flex h-6 w-6 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
          disabled={galleryBusy || selected.directory === ''}
          title={refreshLabel}
          aria-label={refreshLabel}
          onclick={refreshBoard}
        >
          {#if galleryBusy}
            <LoaderCircle size={12} class="animate-spin" />
          {:else}
            <RefreshCw size={12} />
          {/if}
        </button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            class="flex h-6 w-6 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground"
            title={`${nounTitle} options`}
            aria-label={`${nounTitle} options`}
          >
            <Ellipsis size={13} />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="bottom"
              align="end"
              sideOffset={4}
              collisionPadding={8}
              class="z-50 w-56 border border-border bg-surface p-1 shadow-lg"
            >
              <DropdownMenu.Item
                class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
                onSelect={refreshBoard}
              >
                <RefreshCw size={13} class="shrink-0 text-muted" />
                {refreshLabel}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50"
                disabled={selected.directory === ''}
                onSelect={() => void copyDesignPath(selected.directory)}
              >
                <Copy size={13} class="shrink-0 text-muted" />
                Copy path
              </DropdownMenu.Item>
              {#if video}
                <DropdownMenu.Item
                  class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50"
                  disabled={selected.directory === '' ||
                    videoJobs.some((job) => job.state === 'running')}
                  onSelect={() => void exportVideo()}
                >
                  <Download size={13} class="shrink-0 text-muted" />
                  Export MP4
                </DropdownMenu.Item>
              {/if}
              {#if !video}
                <DropdownMenu.Item
                  class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:opacity-50"
                  disabled={canvasBusy !== '' || selected.directory === ''}
                  onSelect={() => void requestDesignAction('contract')}
                >
                  <Pencil size={13} class="shrink-0 text-muted" />
                  Generate DESIGN.md
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:opacity-50"
                  disabled={canvasBusy !== '' || selected.directory === ''}
                  onSelect={() => void requestDesignAction('critique')}
                  >Review design quality</DropdownMenu.Item
                >
                <DropdownMenu.Item
                  class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:opacity-50"
                  disabled={canvasBusy !== '' || selected.directory === ''}
                  onSelect={() => void requestDesignAction('reference')}
                  >Extract brand from reference</DropdownMenu.Item
                >
                <DropdownMenu.Item
                  class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:opacity-50"
                  disabled={canvasBusy !== '' || selected.directory === ''}
                  onSelect={() => void requestDesignAction('tweaks')}
                  >Add live controls</DropdownMenu.Item
                >
                <DropdownMenu.Item
                  class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
                  data-external-url="https://github.com/nexu-io/open-design/tree/main/design-templates"
                  onSelect={() =>
                    void openInBrowser(
                      'https://github.com/nexu-io/open-design/tree/main/design-templates'
                    )}>Browse Open Design prompts</DropdownMenu.Item
                >
                {#each DESIGN_EXPORT_FORMATS as format (format)}
                  <DropdownMenu.Item
                    class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:opacity-50"
                    disabled={selected.directory === ''}
                    onSelect={() => startExport(null, format)}
                    >Export design as {format.toUpperCase()}</DropdownMenu.Item
                  >
                {/each}
              {/if}
              {#if !video && canvasRead && canvasState === null}
                <DropdownMenu.Item
                  class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50"
                  disabled={canvasBusy !== '' || selected.directory === ''}
                  onSelect={() => void requestCanvas('create')}
                >
                  <Presentation size={13} class="shrink-0 text-muted" />
                  Generate Screen Canvas
                </DropdownMenu.Item>
              {/if}
              {#if !video && canvasRead && !liveReady}
                <DropdownMenu.Item
                  class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50"
                  disabled={canvasBusy !== '' || selected.directory === ''}
                  onSelect={() => void requestCanvas('live')}
                >
                  <PlayingCardsFan size={13} class="shrink-0 text-muted" />
                  Generate Live Preview
                </DropdownMenu.Item>
              {/if}
              <DropdownMenu.Separator class="my-1 h-px bg-border" />
              <DropdownMenu.Item
                class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50"
                disabled={selected.directory === ''}
                onSelect={() => (historyOpen = !historyOpen)}
              >
                <History size={13} class="shrink-0 text-muted" />
                {historyOpen ? 'Hide history' : 'Show history'}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
                onSelect={beginEditRoot}
              >
                <Pencil size={13} class="shrink-0 text-muted" />
                Change save path
              </DropdownMenu.Item>
              <DropdownMenu.Item
                class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50"
                disabled={rootIsDefault || rootBusy}
                onSelect={() => void applyRoot(defaultRoot)}
              >
                <RotateCcw size={13} class="shrink-0 text-muted" />
                Reset save path to default
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <button
          type="button"
          class="ml-0.5 flex h-6 w-6 items-center justify-center bg-primary text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-40"
          disabled={opening || selected.directory === ''}
          title={`Show this ${noun} in the in-app browser`}
          aria-label={`Show this ${noun} in the in-app browser`}
          onclick={() => void openPreview(selected.entry)}
        >
          {#if opening}
            <LoaderCircle size={12} class="animate-spin" />
          {:else}
            <GlobeCode size={12} />
          {/if}
        </button>
      </span>
    </div>

    {#if editingRoot}
      <div class="flex items-center gap-1 border-t border-border/60 px-2.5 py-1.5">
        <input
          class="h-6 min-w-0 flex-1 border border-border bg-elevated px-1.5 font-mono text-[0.6875rem] text-foreground outline-none focus:border-primary"
          bind:value={rootDraft}
          placeholder={defaultRoot}
          aria-label={`Folder new ${noun}s are saved in, relative to the project`}
          onkeydown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              cancelEditRoot()
              return
            }
            if (event.key !== 'Enter') return
            event.preventDefault()
            void applyRoot(rootDraft.trim())
          }}
        />
        <button
          type="button"
          class="flex h-6 w-6 shrink-0 items-center justify-center text-accent transition-colors hover:bg-elevated disabled:opacity-40"
          disabled={rootBusy || rootDraft.trim() === ''}
          title={`Save this ${noun} folder`}
          aria-label={`Save this ${noun} folder`}
          onclick={() => void applyRoot(rootDraft.trim())}
        >
          {#if rootBusy}
            <LoaderCircle size={11} class="animate-spin" />
          {:else}
            <Check size={12} />
          {/if}
        </button>
        <button
          type="button"
          class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          title="Cancel"
          aria-label="Cancel changing the save path"
          onclick={cancelEditRoot}
        >
          <X size={12} />
        </button>
      </div>
    {/if}

    {#if rootError !== ''}
      <p class="px-2.5 pb-1.5 text-[0.6875rem] text-danger" role="alert">{rootError}</p>
    {:else if rootNotice !== ''}
      <p class="px-2.5 pb-1.5 text-[0.6875rem] text-muted">{rootNotice}</p>
    {/if}

    {#if canvasNotice !== ''}
      <p class="px-2.5 pb-1.5 text-[0.625rem] text-dimmed">{canvasNotice}</p>
    {/if}
  </header>

  {#if !video && canvasDrift !== ''}
    <StalePanelNotice
      stale
      reason="canvas"
      wrap
      message={`The Screen Canvas is behind: ${canvasDrift}.`}
    >
      {#snippet action()}
        <button
          type="button"
          class="ml-auto flex shrink-0 items-center gap-1 border border-warning/40 px-2 py-0.5 text-xs font-semibold text-warning transition-colors hover:bg-warning/20 disabled:opacity-50"
          disabled={canvasBusy !== ''}
          title="Ask the agent to bring the Screen Canvas up to date with the screens"
          aria-label="Ask the agent to sync the Screen Canvas"
          onclick={() => void requestCanvas('update')}
        >
          {#if canvasBusy === 'update'}
            <LoaderCircle size={12} class="animate-spin" />
          {:else}
            <ListClock size={12} />
          {/if}
          Sync
        </button>
      {/snippet}
    </StalePanelNotice>
  {/if}

  <div class="flex min-h-0 flex-1 flex-col">
    {#if error !== '' || compositionError !== ''}
      <p
        class="mx-2.5 mt-2 shrink-0 border border-danger/20 bg-danger/10 px-2 py-1 text-[0.6875rem] text-danger"
        role="alert"
      >
        {error !== '' ? error : compositionError}
      </p>
    {/if}

    {#if video && selected.directory !== ''}
      <!--
        The composition above, the tools below.

        The picture takes the space the panel has, and the timeline and controls
        sit under it in their own scroller. That is what keeps the frame whole: a
        native page cannot be clipped by `overflow`, so a picture sharing a
        scrolling column with the controls would be drawn past the panel at the
        sizes where the column is taller than the panel.
      -->
      <div class="flex min-h-0 flex-1 flex-col px-2.5 pt-2">
        {@render videoStage()}
      </div>
      <div class="max-h-[55%] min-h-0 shrink-0 overflow-y-auto px-2.5 py-2">
        {#key `${projectId}:${threadId}:${selected.directory}:${boardRevision}`}
          <VideoTimeline {projectId} {threadId} directory={selected.directory} tabId={boardTabId} />
          {#if liveEditing}
            <VideoStudioControls
              {projectId}
              directory={selected.directory}
              jobs={videoJobs}
              onCancelJob={cancelVideoJob}
              onExport={exportVideo}
              onDirtyChange={setStudioDirty}
            />
          {/if}
        {/key}
      </div>
    {:else}
      <div class="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
        {#if video}
          <div
            class="flex aspect-[16/10] w-full flex-col items-center justify-center gap-1.5 border border-border bg-elevated text-dimmed"
          >
            <ImageOff size={16} />
            <span class="px-4 text-center text-[0.6875rem]">
              {`The agent has not written a ${noun} yet. It will appear here when it does.`}
            </span>
          </div>
        {:else if gallery.length === 0}
          <div
            class="flex aspect-[16/10] w-full flex-col items-center justify-center gap-1.5 border border-border bg-elevated text-dimmed"
          >
            {#if galleryBusy}
              <LoaderCircle size={16} class="animate-spin" />
              <span class="text-[0.6875rem]">Capturing the {noun}…</span>
            {:else}
              <ImageOff size={16} />
              <span class="px-4 text-center text-[0.6875rem]">
                {items.length === 0
                  ? `The agent has not written a ${noun} yet. It will appear here when it does.`
                  : 'No preview captured yet.'}
              </span>
            {/if}
          </div>
        {:else}
          <div class="grid grid-cols-2 gap-1.5" aria-label={screensLabel}>
            {#if !video}
              {@render entryCard({
                icon: Presentation,
                name: 'Screen Canvas',
                shot: canvasShot,
                label: 'Open the Screen Canvas in the in-app browser',
                empty: canvasEntryNote,
                busy: !canvasRead || openingCanvas,
                ready: canvasState !== null,
                onOpen: () => void openCanvas()
              })}
              {@render entryCard({
                icon: PlayingCardsFan,
                name: 'Live preview',
                shot: liveShot,
                label: `Open the live preview of this ${noun} in the in-app browser`,
                empty: liveEntryNote,
                busy: opening,
                ready: liveReady,
                onOpen: () => void openPreview(LIVE_PREVIEW_ENTRY)
              })}
            {/if}
            {#each designScreens as screen (screen.entry)}
              {@render screenCard(screen, video)}
            {/each}
          </div>
          {#if !video && designScreens.length === 0}
            {#if galleryBusy}
              <p class="mt-2 flex items-center justify-center gap-1.5 text-[0.6875rem] text-dimmed">
                <LoaderCircle size={12} class="animate-spin" />
                Capturing the {noun}…
              </p>
            {:else}
              <p class="mt-2 text-center text-[0.6875rem] text-muted">
                {`The agent has not written a ${noun} yet. It will appear here when it does.`}
              </p>
            {/if}
          {/if}
        {/if}
      </div>
    {/if}
    {#key `${projectId}:${threadId}:${selected.directory}`}
      <DesignHistoryPanel
        {projectId}
        {threadId}
        directory={selected.directory}
        {noun}
        unit={video ? 'file' : 'screen'}
        open={historyOpen}
        onRestored={restoreBoard}
        onClose={() => (historyOpen = false)}
        onActions={handleHistoryActions}
      />
    {/key}
  </div>
</div>

<ConfirmDialog
  open={reloadRequested}
  title="Discard unsaved video controls?"
  confirmLabel="Discard and reload"
  cancelLabel="Keep editing"
  onCancel={() => {
    reloadRequested = false
  }}
  onConfirm={() => {
    reloadRequested = false
    reloadVideoBoard()
  }}
>
  <p>Your unsaved control and caption edits will be replaced with the saved version.</p>
</ConfirmDialog>
