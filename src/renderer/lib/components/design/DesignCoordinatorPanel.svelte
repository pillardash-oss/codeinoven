<script lang="ts">
  import CioArrowUpDown from '@pdslng/cio-icon/CioArrowUpDown.svelte'
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioClapper from '@pdslng/cio-icon/CioClapper.svelte'
  import CioCopy from '@pdslng/cio-icon/CioCopy.svelte'
  import CioDisplay from '@pdslng/cio-icon/CioDisplay.svelte'
  import CioDownload from '@pdslng/cio-icon/CioDownload.svelte'
  import CioEllipsis from '@pdslng/cio-icon/CioEllipsis.svelte'
  import CioFiles from '@pdslng/cio-icon/CioFiles.svelte'
  import CioForward from '@pdslng/cio-icon/CioForward.svelte'
  import CioFrame from '@pdslng/cio-icon/CioFrame.svelte'
  import CioHistory from '@pdslng/cio-icon/CioHistory.svelte'
  import CioImageOff from '@pdslng/cio-icon/CioImageOff.svelte'
  import CioLayers from '@pdslng/cio-icon/CioLayers.svelte'
  import CioMarquee from '@pdslng/cio-icon/CioMarquee.svelte'
  import CioPalette from '@pdslng/cio-icon/CioPalette.svelte'
  import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioStore from '@pdslng/cio-icon/CioStore.svelte'
  import CioTarget from '@pdslng/cio-icon/CioTarget.svelte'
  import CioThreadBrowser from '@pdslng/cio-icon/CioThreadBrowser.svelte'
  import CioSave from '@pdslng/cio-icon/CioSave.svelte'
  import CioMaximize from '@pdslng/cio-icon/CioMaximize.svelte'
  import CioTrash from '@pdslng/cio-icon/CioTrash.svelte'
  import CioVolume from '@pdslng/cio-icon/CioVolume.svelte'
  import CioVolumeX from '@pdslng/cio-icon/CioVolumeX.svelte'
  import { ICON_SIZE } from '$lib/components/icons/cio/scale'
  import { onDestroy, onMount, tick } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { LastKnown } from '$lib/last-known'
  import { browserAudio } from '$lib/stores/browser-audio.svelte'
  import { ContextMenu, DropdownMenu } from 'bits-ui'
  import { toast } from 'svelte-sonner'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import DesignHistoryActions from '$lib/components/design/DesignHistoryActions.svelte'
  import DesignHistoryPanel from '$lib/components/design/DesignHistoryPanel.svelte'
  import CompositionStage from '$lib/components/design/CompositionStage.svelte'
  import FullscreenPanelDialog from '$lib/components/workspace/FullscreenPanelDialog.svelte'
  import VideoStudioControls from '$lib/components/design/VideoStudioControls.svelte'
  import VideoTimeline from '$lib/components/design/VideoTimeline.svelte'
  import { copyText } from '$lib/copy-text'
  import { designCopyFor } from '$lib/design-copy-context'
  import { authoredWorkOwnerLabel } from '$lib/authored-work-presentation'
  import { usesThreadWorkspaceMount } from '$shared/types'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { loadBrowser } from '$lib/stores/browser-access.svelte'
  import { contextSidebarState, type BrowserContextTab } from '$lib/stores/context-sidebar.svelte'
  import { designCoordinatorState } from '$lib/stores/design-coordinator.svelte'
  import { projectWorkState } from '$lib/stores/project-work.svelte'
  import { videoTimelineState } from '$lib/stores/video-timeline.svelte'
  import { videoPackagesStore } from '$lib/stores/video-packages.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { sendOrQueueThreadMessage } from '$lib/stores/thread-delivery'
  import { openThreadById } from '$lib/threads/open-thread-by-id'
  import { logRendererError } from '$lib/system/renderer-logger'
  import { openInBrowser } from '$lib/open-in-browser'
  import { APP_SLUG } from '$shared/brand'
  import { designContractRequest } from '$shared/design/design-contract'
  import type { VideoJob } from '$shared/video/studio'
  import { DESIGN_EXPORT_FORMATS, type DesignExportFormat } from '$shared/design/design-export'
  import { isThreadBusyStatus } from '$shared/thread-status-policy'
  import { formatCompactAge, formatDateTime } from '$shared/date-time-format'
  import {
    SCREEN_CANVAS_PATH,
    isScreenCanvasEntry,
    screenCanvasLivePreviewMessage
  } from '$shared/design/screen-canvas'
  import type {
    AuthoredWorkKind,
    DesignEntry,
    DesignScreenShot,
    ScreenCanvasState,
    ThreadDesignState
  } from '$shared/ipc-contract'
  import WorkDetailsDialog from './WorkDetailsDialog.svelte'

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
   * The canvas is the app's own page: generated from the folder's screens every
   * time it is asked for, so a screen written a minute ago is on it, there is
   * nothing for the board to warn about and nothing for the agent to keep in step.
   * The board only opens it.
   *
   * It loads its own state rather than receiving it through props, because the work
   * outlives the turn that made it: there is no live turn to hand it anything, and a
   * restarted app has to fill this in from main alone.
   */

  interface Props {
    viewingThreadId?: string
    projectId: string
    threadId: string
    /**
     * The kind this board shows, when the project's rail opened it rather than a
     * session. A session board reads its kind from the thread; the rail's entry
     * offers the project's designs or videos on whatever thread the user is on,
     * so it sets the kind here.
     */
    kind?: AuthoredWorkKind
    active?: boolean
  }

  let { projectId, threadId, viewingThreadId, kind: forcedKind, active = true }: Props = $props()
  let selectionThreadId = $derived(viewingThreadId ?? threadId)

  /** Export playback participates in the same sound registry as native views. */
  const attachExport: Attachment<HTMLVideoElement> = (element) => {
    const audioId = `video-export:${projectId}:${threadId}`
    const report = (): void => {
      browserAudio.reportThreadTab(
        audioId,
        threadId,
        projectId,
        !element.paused && !element.ended && !element.muted && element.volume > 0
      )
    }
    const events = ['play', 'pause', 'ended', 'volumechange'] as const
    for (const event of events) element.addEventListener(event, report)
    $effect(() => {
      if (!active) element.pause()
    })
    return () => {
      element.pause()
      for (const event of events) element.removeEventListener(event, report)
      browserAudio.forget(audioId)
    }
  }

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

  /**
   * The orders the board can show a design's screens in.
   *
   * Latest is where the board starts, because a design is iterated and the screen
   * that moved last is usually the one the user came to look at. The other three
   * are what a person reaches for when they know a screen's name instead.
   */
  const SCREEN_ORDERS = ['latest', 'name', 'name-desc', 'oldest'] as const
  type ScreenOrder = (typeof SCREEN_ORDERS)[number]

  /** What each order is called in the Sort menu. */
  const SCREEN_ORDER_LABELS: Record<ScreenOrder, string> = {
    latest: 'Latest',
    name: 'Name A-Z',
    'name-desc': 'Name Z-A',
    oldest: 'Oldest'
  }

  /** Whether the menu's own string is one of the board's orders. */
  function isScreenOrder(value: string): value is ScreenOrder {
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
  function orderScreens(screens: DesignScreenShot[], order: ScreenOrder): DesignScreenShot[] {
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

  // Seeded from whatever the workspace already fetched, so the panel paints on
  // its first frame instead of flashing a spinner.
  // svelte-ignore state_referenced_locally
  let designState = $state<ThreadDesignState | null>(
    designCoordinatorState.stateFor(projectId, threadId)
  )
  let gallery = $state<DesignScreenShot[]>([])
  let galleryBusy = $state(false)
  /**
   * The order the screens grid is shown in.
   *
   * A view setting of the board rather than of the design: switching designs keeps
   * it, and a board opened again starts at the default, newest first.
   */
  let screenOrder = $state<ScreenOrder>('latest')
  /**
   * Whether a turn settled while the board was off screen.
   *
   * A board the user is not looking at has nothing to show, so its screens are not
   * re-pictured behind their back; the flag is what the effect below reads when the
   * board comes back. Deliberately not reactive: nothing renders it.
   */
  let settleMissed = false
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
  /**
   * The export the composition in front already has on disk, as a project-relative
   * path.
   *
   * The job list is this process's memory of this thread's work, so it cannot
   * answer for a composition exported in another thread of the same project or
   * before a restart. This is that answer, read from the composition itself, and it
   * is what the board stands on when no job of its own describes an export.
   */
  let savedExport = $state<string | null>(null)
  /** Whether the studio controls hold unsaved edits, which a reload would discard. */
  let studioDirty = $state(false)
  /** The controls' save action, drawn in the section strip so it never moves. */
  let studioSaveAction = $state<(() => void) | null>(null)
  /**
   * Bumped when the studio controls save the composition.
   *
   * The timeline draws its bands from its own read of the same file, so a save has
   * to reach it without remounting it: a remount would drop the zoom, the scroll
   * and the open comment for a change that only moved a track.
   */
  let studioRevision = $state(0)
  /**
   * The editor's height in pixels, dragged by the splitter under the picture.
   *
   * A composition is read in two halves, and which half needs the room depends on
   * what the user is doing: watching the frame, or placing a track. The splitter is
   * what hands that choice over, and the choice is remembered per machine.
   */
  let editorHeight = $state(0)
  /** The column holding the picture and the editor, measured to bound the drag. */
  let splitArea = $state<HTMLElement | null>(null)
  /** A drag on the splitter: the pointer it belongs to and what it started from. */
  let resizingEditor = false
  let resizePointer = 0
  let resizeStartY = 0
  let resizeStartHeight = 0
  /** The editor never collapses below a readable strip of ruler and bands. */
  const EDITOR_MIN_HEIGHT = 148
  /** The picture keeps enough height to be a picture, not a sliver. */
  const STAGE_MIN_HEIGHT = 120
  /** The splitter's own hit area, in pixels, matching the `h-2` it is drawn at. */
  const SPLITTER_HEIGHT = 8
  const EDITOR_HEIGHT_KEY = `${APP_SLUG}:video-editor-height`
  /** Bumped to remount the video timeline and controls, so a refresh re-reads them. */
  let boardRevision = $state(0)
  /** Whether the user asked to reload over unsaved video controls. */
  let reloadRequested = $state(false)
  /** Whether the reference-brand URL prompt is open. */
  let referenceOpen = $state(false)
  /** The reference site URL the brand extraction measures. */
  let referenceUrl = $state('')
  /** Why the entered reference URL was rejected, in the user's terms. */
  let referenceError = $state('')
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
    // A job of this session is the freshest answer there can be, because it is
    // written the moment the export finishes. The composition's own export stands
    // behind it for every case a job record cannot cover.
    return files.at(-1) ?? savedExport
  })
  let noun = $derived(video ? 'composition' : 'design')
  let nounTitle = $derived(video ? 'Composition' : 'Design')
  /** What to call the place this scope's work lives: a project, an assistant, a chat. */
  let ownerLabel = $derived(authoredWorkOwnerLabel(projectId))
  let listLabel = $derived(`${video ? 'Compositions' : 'Designs'} in ${ownerLabel}`)
  let WorkIcon = $derived(video ? CioClapper : CioFrame)

  /** Project defaults are separate from the current design or video's own folder. */
  let kind = $derived<AuthoredWorkKind>(requestedKind)
  let detailsMode = $state<'this' | 'all' | 'rename' | null>(null)

  /** The folder this project writes new work of this kind into. */
  let workRoot = $derived(projectWorkState.rootsFor(projectId)[kind] || designState?.root || '')

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
   * board keeps the listing main answered alongside its own record.
   *
   * A composition is the exception, because a video is watched rather than owned:
   * it belongs to its project, so every thread of that project lists the same
   * compositions and can watch what another thread made. The read is keyed by this
   * project's id, which is also what keeps another project's work out of this
   * panel entirely. The session's own answer stands in until that read lands, so
   * the board never blanks while it waits.
   */
  let items = $derived.by(() => {
    if (video) {
      const project = projectWorkState.itemsFor(projectId, 'video', threadId)
      return project.length > 0 ? project : (designState?.items ?? [])
    }
    return forcedKind !== undefined
      ? projectWorkState.itemsFor(projectId, forcedKind, threadId)
      : (designState?.items ?? [])
  })
  /** How many designs sit behind the "Others" trigger. */
  let otherCount = $derived(Math.max(0, items.length - 1))
  /** What the trigger and its menu are called, in this board's own words. */
  let switchLabel = $derived(
    `Switch ${noun}, ${otherCount} other ${otherCount === 1 ? noun : `${noun}s`} in ${ownerLabel}`
  )
  /** The folder this thread last previewed, when it belongs to the kind on screen.
   *  A rail-opened board ignores a record that describes the other kind. */
  let currentFolder = $derived.by(() => {
    const current = designState?.current ?? null
    if (current === null) return null
    if (forcedKind !== undefined && current.kind !== forcedKind) return null
    return items.some((item) => item.directory === current.directory) ? current : null
  })
  /** The folder in front: the one the user picked, else the thread's own. */
  let selected = $derived.by(() => {
    const current = currentFolder
    const picked = projectWorkState.selectedDirectory(projectId, requestedKind, selectionThreadId)
    const inherited =
      selectionThreadId !== threadId
        ? projectWorkState.focusedDirectory(projectId, requestedKind)
        : ''
    const directory = items.some((item) => item.directory === picked)
      ? picked
      : (items.find((item) => item.directory === inherited)?.directory ??
        current?.directory ??
        items.find((item) => item.creatorThreadId === threadId)?.directory ??
        items.find(
          (item) => item.directory === projectWorkState.focusedDirectory(projectId, requestedKind)
        )?.directory ??
        items[0]?.directory ??
        '')
    return { directory, entry: current?.directory === directory ? current.entry : null }
  })
  /** The folder in front as main lists it, which is where its entry page is known. */
  let selectedItem = $derived(items.find((item) => item.directory === selected.directory) ?? null)
  let removeRequested = $state<DesignEntry | null>(null)
  let removeBusy = $state(false)
  let selectedMissing = $derived(selectedItem?.missing === true)
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
   * The composition the board is playing, when its own view is on screen for the
   * folder in front.
   *
   * The view arrives on `browser:state`, and it is addressed by the id main
   * returned rather than by the thread: a browser tab on the same folder must not
   * be mistaken for the board's own page. While it is here the board is a player
   * and an editor at once, and while it is not the stage falls back to the last
   * export or the captured frame.
   *
   * The folder is part of the test, not just the view's existence. Switching to
   * another composition leaves the folder just left with a live view of its own,
   * so a board that only asked "is a view open?" kept playing the composition the
   * user had navigated away from. A null here is what asks main to open the one in
   * front instead.
   */
  let liveTab = $derived.by(() => {
    if (boardTabId === '') return null
    const live = videoTimelineState.compositionByTab(boardTabId)
    if (live === null || live.directory !== selected.directory) return null
    return live
  })
  /**
   * The board's own menus, so the pane can step aside while one of them is
   * showing.
   *
   * A menu opens downward over the composition, and a native view is composited
   * above every DOM node, so a menu cannot be raised above the page: the page has
   * to come off screen for as long as the menu is up. That is the same answer a
   * modal gives, which is why every root here is watched rather than only the one
   * the user happened to open first.
   */
  let menus = $state({ list: false, sort: false, options: false, card: false })
  let menuOpen = $derived(menus.list || menus.sort || menus.options || menus.card)
  /**
   * Whether the composition is being watched full screen instead of in the pane.
   *
   * The board is the control surface and the full screen surface is the picture:
   * both show the composition's own view, so this is a mode of the board rather
   * than a hand-off. The tab that plays the film never changes, which is what lets
   * the board's mute and transport keep driving what the full screen shows.
   */
  let compositionFullscreen = $state(false)
  /**
   * The composition's tab described as a browser tab, for the full screen surface.
   *
   * The board's view is a registered browser tab that deliberately stays out of
   * every tab strip, so the full screen browser is handed the descriptor it needs
   * instead of looking one up in a list this tab is not in. Null until the view
   * exists, so the surface can never open on a tab nothing has served.
   */
  let fullscreenCompositionTab = $derived.by((): BrowserContextTab | null => {
    const live = liveTab
    if (!video || !compositionFullscreen || live === null) return null
    return {
      id: live.tabId,
      kind: 'browser',
      title: selectedName === '' ? `${nounTitle} preview` : selectedName,
      projectId,
      threadId,
      url: live.url,
      favicon: null,
      boxId: live.boxId
    }
  })
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
  const fullscreenTabs = new LastKnown<BrowserContextTab>()
  let shownFullscreenTab = $derived(fullscreenTabs.get(fullscreenCompositionTab))
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
   * The two entries that are not screens, and the screens themselves, in the order
   * the user picked.
   *
   * The canvas is swept with the screens so its entry has a picture like any other,
   * and the live preview is the design's entry page pictured once more. Both are
   * split out of the grid's screens rather than listed twice, and both keep the
   * first two cells of the grid whatever the order is: they are the design's own
   * doors rather than screens of it.
   */
  let canvasShot = $derived(gallery.find((screen) => isScreenCanvasEntry(screen.entry)) ?? null)
  let designScreens = $derived(
    orderScreens(
      gallery.filter((screen) => !isScreenCanvasEntry(screen.entry)),
      screenOrder
    )
  )
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
        ? 'No screens yet'
        : 'No preview yet.'
  )
  /** What the design's own canvas metadata gets wrong, in one line, or nothing. */
  let canvasHint = $derived.by(() => {
    const state = canvasState
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
  let liveEntryNote = $derived(liveReady ? 'No preview yet.' : 'No entry page yet')

  let refreshLabel = $derived(video ? 'Refresh the composition preview' : 'Refresh the screens')
  let screensLabel = $derived(
    video ? 'Composition preview' : `Screens in this design (${designScreens.length})`
  )

  async function loadState(): Promise<void> {
    try {
      designState = await invoke('design:state', projectId, threadId)
      error = ''
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'The work state could not be read.'
    }
  }

  async function removeMissingWork(): Promise<void> {
    const target = removeRequested
    if (!target || removeBusy) return
    removeBusy = true
    try {
      await invoke('design:removeMissing', projectId, threadId, target.directory)
      removeRequested = null
      projectWorkState.selectDirectory(projectId, kind, selectionThreadId, '')
      await projectWorkState.refresh(projectId, threadId)
      await loadState()
      await loadGallery()
      await loadCanvas()
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'The entry could not be removed.'
    } finally {
      removeBusy = false
    }
  }

  async function detailsUpdated(directory: string, moved: number): Promise<void> {
    projectWorkState.selectDirectory(projectId, kind, selectionThreadId, directory)
    await projectWorkState.refreshRoots(projectId)
    await loadState()
    await projectWorkState.refresh(projectId, threadId)
    await loadGallery()
    await loadCanvas()
    toast.success(`${moved} ${noun}${moved === 1 ? '' : 's'} updated`)
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
  async function loadGallery(force = false): Promise<void> {
    if (selected.directory === '' || selectedMissing) {
      gallery = []
      return
    }
    galleryBusy = true
    try {
      if (video && liveTab !== null) {
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
          requestedKind
        )
        gallery = [
          {
            entry: selected.entry ?? '',
            name: selectedName,
            dataUrl: shot.dataUrl,
            width: shot.width,
            height: shot.height,
            updatedAt: selectedItem?.updatedAt ?? 0
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
    projectWorkState.selectDirectory(projectId, requestedKind, selectionThreadId, directory)
    gallery = []
    void loadGallery()
    void loadCanvas()
  }

  /** Pick a design from the dropdown, which the radio group reports as a string. */
  function handleDesignChange(directory: string): void {
    selectDesign(directory)
  }

  // The board's owner stays mounted across empty threads, but its session choice
  // belongs to the conversation currently on screen.
  let previousViewingThread: string | undefined
  async function refreshViewingThread(): Promise<void> {
    await tick()
    if (selectedItem) projectWorkState.focusDirectory(projectId, requestedKind, selected.directory)
    if (canvasRead && canvasDirectory === selected.directory) return
    await loadGallery()
    await loadCanvas()
  }
  const watchViewingThread: Attachment<HTMLDivElement> = () => {
    const next = selectionThreadId
    if (previousViewingThread !== undefined && previousViewingThread !== next)
      void refreshViewingThread()
    previousViewingThread = next
  }

  /** The Sort menu reports a string too, so it is checked before it becomes the order. */
  function handleScreenOrderChange(value: string): void {
    if (isScreenOrder(value)) screenOrder = value
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
      await invoke(
        'design:open',
        projectId,
        selectionThreadId,
        directory,
        entry,
        true,
        requestedKind
      )
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
    if (!video || directory === '' || selectedMissing) return
    if (!force && compositionAsked === directory) return
    compositionAsked = directory
    composing = directory
    try {
      // The stage is fed by `browser:state`, and that listener only exists once
      // the browser runtime is wired. Wiring it before the open is what makes the
      // board's own composition arrive: without it the open succeeds in main, the
      // Store never hears about the view, and the stage has nothing to mount.
      await loadBrowser()
      const opened = await invoke(
        'design:open',
        projectId,
        threadId,
        directory,
        null,
        false,
        requestedKind
      )
      boardTabId = opened.tabId
      // A view main already holds on this composition is answered with `reused`
      // and not reloaded, so no state follows the open. Reading the view's own
      // state closes that gap rather than waiting for a report that never comes.
      await videoTimelineState.seed(opened.tabId)
      compositionError = ''
    } catch (failure) {
      compositionError =
        failure instanceof Error ? failure.message : `The ${noun} could not be opened.`
    } finally {
      if (composing === directory) composing = ''
    }
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
  async function openPreview(entry: string | null): Promise<void> {
    if (opening || openingCanvas) return
    opening = true
    try {
      if (video) {
        // A folder with no entry page has nothing to serve, so there is no page to
        // show full screen. The board says so in the pane instead.
        if (!playable || selected.directory === '') return
        await ensureComposition(selected.directory)
        // A view main already holds is not reloaded, so no state follows the open.
        // Reading its own state is what guarantees the surface has a tab to show
        // rather than opening on nothing.
        if (boardTabId !== '' && videoTimelineState.compositionByTab(boardTabId) === null) {
          await videoTimelineState.seed(boardTabId)
        }
        if (boardTabId !== '') compositionFullscreen = true
        return
      }
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
      await openWork(selected.directory, SCREEN_CANVAS_PATH)
    } finally {
      openingCanvas = false
    }
  }

  /** Read the design's canvas state, and remember that main answered. */
  async function loadCanvas(): Promise<void> {
    const directory = selected.directory
    if (directory === '' || selectedMissing) {
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
  async function requestLivePreview(): Promise<void> {
    if (selected.directory === '' || canvasBusy !== '') return
    canvasBusy = 'live'
    canvasNotice = ''
    try {
      const text = screenCanvasLivePreviewMessage({
        directory: selected.directory,
        sketchTitles: (canvasState?.sketches ?? []).map((sketch) => sketch.title),
        needsEntry: !liveReady
      })
      const delivery = await sendOrQueueThreadMessage(projectId, threadId, { text })
      canvasNotice =
        delivery === 'queued'
          ? 'Queued: it will be built when the current turn ends.'
          : 'Asked the agent to make the design live.'
      error = ''
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'The request could not be sent.'
    } finally {
      canvasBusy = ''
    }
  }

  async function requestDesignAction(
    action: 'contract' | 'critique' | 'reference' | 'tweaks',
    referenceUrl?: string
  ): Promise<void> {
    if (!selected.directory || canvasBusy) return
    canvasBusy = action
    try {
      const directoryLiteral = JSON.stringify(selected.directory)
      const text =
        action === 'contract'
          ? designContractRequest(selected.directory)
          : action === 'critique'
            ? `@cio-design Review the design in ${directoryLiteral}. Render each screen, check phone and desktop widths, exercise its main interactions and run craft lint. Record a single evidence-based critique per screen using the design capability's rubric, report scores and concrete fixes, and mark any failing screens unfinished. Do not silently run critique loops.`
            : action === 'reference'
              ? `@cio-design Extract a lightweight brand contract from the reference site ${JSON.stringify(referenceUrl ?? '')} for the design in ${directoryLiteral}. Use extract-reference to measure it, compare with existing project CSS tokens and the current contract, then generate DESIGN.md with write-contract so existing contracts are preserved as dated backups. Report measured values separately from inferred rules.`
              : `@cio-design Add lightweight live review controls to the design in ${directoryLiteral} using data-cio-tweaks and /__cio/tweaks.js. Reuse its actual CSS variables and add only useful controls such as accent, spacing, theme or sample data. Changes must update the existing DOM without reload. Wire cio:tweaks listeners for theme or content controls, test them in the preview, and keep these review controls out of production implementation.`
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

  /**
   * Open the reference-brand prompt for the folder in front.
   *
   * The extraction measures a site the user names, so the URL is collected
   * up front rather than asked for mid-turn: confirming sends it as part of
   * the prompt in the same step.
   */
  function openReferencePrompt(): void {
    if (selected.directory === '' || canvasBusy !== '') return
    referenceUrl = ''
    referenceError = ''
    referenceOpen = true
  }

  /** Send the brand extraction with the entered URL as part of the prompt. */
  function confirmReferencePrompt(): void {
    const url = referenceUrl.trim()
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error()
    } catch {
      referenceError = 'Enter a full site URL starting with http:// or https://.'
      return
    }
    referenceOpen = false
    void requestDesignAction('reference', url)
  }

  function startExport(entry: string | null, format: DesignExportFormat): void {
    const directory = selected.directory
    const exportProjectId = projectId
    void import('$lib/stores/export-progress.svelte')
      .then(({ exportProgressState }) =>
        exportProgressState.startDesign(exportProjectId, threadId, directory, entry, format)
      )
      .catch((failure: unknown) => {
        error = failure instanceof Error ? failure.message : 'Could not start export.'
      })
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
  async function refreshSettledWork(): Promise<void> {
    await loadCanvas()
    if (video) return
    await loadGallery()
  }

  /**
   * Refresh the board's own reading of the work.
   *
   * A design re-pictures its screens and its canvas. A composition also re-reads
   * its jobs and remounts its timeline and controls, so the one Refresh in the
   * header is the whole board's reload and the controls do not need their own. The
   * remount discards unsaved control edits, so those are confirmed first.
   */
  async function refreshBoard(): Promise<void> {
    await projectWorkState.refresh(projectId, threadId)
    await loadState()
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
    await readSavedExport()
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
  async function readSavedExport(): Promise<void> {
    const directory = selected.directory
    if (!video || directory === '') {
      savedExport = null
      return
    }
    try {
      const path = await invoke('video:latestExport', projectId, threadId, directory)
      if (selected.directory === directory) savedExport = path
    } catch (failure) {
      logRendererError('The export this composition has could not be read.', failure)
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

  /** A save moved the composition, so the timeline re-reads the bands it draws. */
  function setStudioSaved(): void {
    studioRevision += 1
    // The page reads studio.json once, when it loads, so a saved caption style, a
    // moved track or an edited word is invisible in the picture until the page
    // reads the file again. Reloading the board's own view refreshes it, and the
    // browser remembers the playhead across that reload.
    if (boardTabId !== '') void invoke('browser:reload', boardTabId).catch(() => undefined)
  }

  /** The editor's height, bounded so neither half of the board can be dragged shut. */
  function clampEditorHeight(height: number): number {
    const available = splitArea?.clientHeight ?? 0
    if (available <= 0) return Math.max(EDITOR_MIN_HEIGHT, height)
    const maximum = Math.max(EDITOR_MIN_HEIGHT, available - STAGE_MIN_HEIGHT - SPLITTER_HEIGHT)
    return Math.min(Math.max(height, EDITOR_MIN_HEIGHT), maximum)
  }

  /** Start a drag on the splitter, remembering where the editor stood. */
  function startEditorResize(event: PointerEvent & { currentTarget: HTMLButtonElement }): void {
    resizingEditor = true
    resizePointer = event.pointerId
    resizeStartY = event.clientY
    resizeStartHeight = editorHeight
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  /** Follow the pointer: up gives the editor more room and the picture less. */
  function resizeEditor(event: PointerEvent): void {
    if (!resizingEditor || event.pointerId !== resizePointer) return
    editorHeight = clampEditorHeight(resizeStartHeight - (event.clientY - resizeStartY))
  }

  /** Settle the drag and remember it, so the next visit opens the same way. */
  function finishEditorResize(event: PointerEvent): void {
    if (!resizingEditor || event.pointerId !== resizePointer) return
    resizingEditor = false
    localStorage.setItem(EDITOR_HEIGHT_KEY, String(editorHeight))
  }

  /** The same split from the keyboard, for a control that is reachable without a mouse. */
  function resizeEditorWithKeyboard(event: KeyboardEvent): void {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown' && event.key !== 'Home') return
    event.preventDefault()
    editorHeight =
      event.key === 'Home'
        ? clampEditorHeight(Math.round((splitArea?.clientHeight ?? 0) * 0.45))
        : clampEditorHeight(editorHeight + (event.key === 'ArrowUp' ? 24 : -24))
    localStorage.setItem(EDITOR_HEIGHT_KEY, String(editorHeight))
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
  /**
   * Show the design folder in the project's file tree: it opens the files
   * surface, expands the ancestors and selects the entry, so the design
   * lands in the same tree every other path citation uses instead of a
   * folder the user has to find again.
   */
  async function revealDesignPath(directory: string): Promise<void> {
    if (directory === '') return
    try {
      const { revealProjectFileFromAbsolutePath } = await import('$lib/reveal-file')
      const revealed = await revealProjectFileFromAbsolutePath(projectId, directory)
      if (!revealed) toast.error('The design could not be revealed in the file tree.')
    } catch (failure) {
      logRendererError('The design could not be revealed in the file tree.', failure)
      toast.error('The design could not be revealed in the file tree.')
    }
  }

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
    // The agent writes the work inside a turn, so the board catches up when that
    // turn settles. Nothing polls. A board that is off screen waits rather than
    // loading pages in the thread's tab, and the effect below reads then.
    return subscribe('thread:updated', (thread) => {
      if (thread.id !== threadId || thread.projectId !== projectId) return
      if (isThreadBusyStatus(thread.status)) return
      if (!active) {
        settleMissed = true
        return
      }
      void refreshSettledWork()
    })
  })

  // Bringing the board back on screen reads what settled while it was away, so a
  // screen the agent wrote in the meantime is already there.
  $effect(() => {
    if (!active || !settleMissed) return
    settleMissed = false
    void refreshSettledWork()
  })

  onMount(() => {
    projectWorkState.invalidate(projectId, threadId)
    // The board is one of the surfaces that watches the optional video pack, so
    // installing it from Settings turns on live editing here without a reload.
    void videoPackagesStore.load()
    void projectWorkState.refresh(projectId, threadId).then(async () => {
      await loadState()
      if (selectedItem)
        projectWorkState.focusDirectory(projectId, requestedKind, selected.directory)
      await loadGallery()
      await loadCanvas()
    })
    void projectWorkState.refreshRoots(projectId)
    return () => {
      if (selectedItem)
        projectWorkState.focusDirectory(projectId, requestedKind, selected.directory)
      videoPackagesStore.dispose()
    }
  })

  onMount(() =>
    subscribe('design:relocated', (changedProjectId) => {
      if (changedProjectId !== projectId) return
      void projectWorkState.refresh(projectId, threadId).then(async () => {
        await loadState()
        await loadGallery()
        await loadCanvas()
      })
    })
  )

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

  /**
   * The composition tab the board has most recently been driving.
   *
   * Deliberately outside the reactive graph: a pause has to be sent even after the
   * view is gone, and the store that holds the tab has already forgotten it by
   * then.
   */
  let drivenTabId = ''

  // The board owns the film: it is the surface the user is on, so leaving the board
  // stops playback. Going full screen must not, because that is this same board
  // showing this same tab bigger, and a pause there would freeze the film the user
  // just asked to watch. It is also why the stage itself must never pause: it
  // unmounts on the way into full screen (so exactly one surface ever places the
  // native view), and a teardown pause would freeze the film every time.
  $effect(() => {
    const live = liveTab
    const previous = drivenTabId
    if (live !== null && live.tabId !== previous) {
      drivenTabId = live.tabId
      // Moving to another composition leaves the one that was playing behind in a
      // parked page that keeps running offscreen, where nothing the user can see
      // ever stops it: the sound of the film they left would follow them into the
      // next one. Switching is a departure, so the film they left is stopped
      // before the new one is ever shown.
      if (previous !== '') void invoke('browser:transport', previous, 'pause', 0).catch(() => {})
    }
    if (active || drivenTabId === '') return
    void invoke('browser:transport', drivenTabId, 'pause', 0).catch(() => {})
  })

  // The board going away takes the film with it, exactly as leaving it does.
  onDestroy(() => {
    if (drivenTabId === '') return
    void invoke('browser:transport', drivenTabId, 'pause', 0).catch(() => {})
  })

  // A board that is no longer the surface on screen cannot keep a full screen
  // window: the picture would stay up over whatever the user navigated to.
  $effect(() => {
    if (!active) compositionFullscreen = false
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

<div class="flex h-full min-h-0 flex-col" {@attach watchViewingThread}>
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
          <CioDownload size={13} class="text-accent" aria-hidden="true" />
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
    {#if liveTab && !compositionFullscreen}
      <!--
        The live composition, played in the board.

        The stage owns the tab's native view while it is on screen, so the
        transport above the picture and the timeline below both drive the
        composition the user is watching rather than a still of it. The stage fits
        the composition's own aspect ratio inside this pane, so the frame is whole
        at every panel size.

        It stands aside while the composition is watched full screen, and the
        full screen surface is what places the view then. That is deliberate: the
        store resolves one owner per native view but a surface only ever asks
        whether this tab may be shown, not whether it is the one showing it, so two
        mounted surfaces for one tab would race for the frame and leave it wherever
        the loser put it. Unmounting here is also what gives the pane its picture
        back: the stage places the view as it mounts, after the full screen surface
        has let it go.
      -->
      {#key liveTab.tabId}
        <!-- The tab's identity is the stage's identity: a re-keyed tab builds a
             new stage, so the frame this pane claims, the view it places and the
             transport it draws all belong to the same tab. -->
        <CompositionStage tab={liveTab} {active} covered={menuOpen} />
      {/key}
    {:else if !playable}
      <div
        class="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 border border-border bg-elevated text-dimmed"
      >
        <CioImageOff size={16} />
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
            {@attach attachExport}
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
              <CioSpinner size={14} class="animate-spin" />
              <span class="text-[0.625rem]">Capturing…</span>
            {:else}
              <CioImageOff size={14} />
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
      ? `Watch the ${noun} full screen in the in-app browser`
      : `Open the ${noun} screen ${screen.name} in the in-app browser`}
    {@const onScreen = !video && screen.entry === selected.entry}
    {@const copyLabel = video
      ? `Copy the path of this ${noun}`
      : `Copy ${noun} screen: ${screen.name}`}
    <ContextMenu.Root bind:open={menus.card}>
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
                <CioSpinner size={14} class="animate-spin" />
                <span class="text-[0.625rem]">Capturing…</span>
              {:else}
                <CioImageOff size={14} />
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
            <span class="text-[0.625rem] font-medium text-white"
              >{video
                ? 'Watch full screen in the in-app browser'
                : 'Open in the in-app browser'}</span
            >
          </span>
        </button>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content class="z-50 min-w-44 border border-border bg-surface p-1 shadow-lg">
          <ContextMenu.Item
            class="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
            onSelect={() => void copyDesignPath(selected.directory, screen.entry)}
          >
            <CioCopy size={13} class="shrink-0 text-muted" />
            {copyLabel}
          </ContextMenu.Item>
          {#if !video}
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger
                class="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-[state=open]:bg-elevated"
              >
                <CioDownload size={13} class="shrink-0 text-muted" />
                Export
                <CioForward size={13} class="ml-auto text-muted" />
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent
                  class="z-50 min-w-44 border border-border bg-surface p-1 shadow-lg"
                >
                  {#each DESIGN_EXPORT_FORMATS as format (format)}
                    <ContextMenu.Item
                      class="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
                      onSelect={() => startExport(screen.entry, format)}
                      >Export screen as {format.toUpperCase()}</ContextMenu.Item
                    >
                  {/each}
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
          {/if}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  {/snippet}

  {#snippet entryCard(input: {
    icon: typeof CioDisplay
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
            <CioSpinner size={14} class="animate-spin" />
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
    <div class="flex items-center gap-1.5 py-1.5 pl-2.5">
      {#if items.length > 1}
        <!--
          One tab holds the design in front, and every other design of the project
          waits behind the word beside it. A project with a dozen designs would
          otherwise be a strip that scrolls sideways, hiding the very design the
          user came for; here the tab never moves and the list is one click away.
        -->
        <DropdownMenu.Root bind:open={menus.list}>
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
              <CioChevronDown size={10} class="shrink-0" />
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
                      {#if item.missing}<span class="shrink-0 text-[0.625rem] text-warning"
                          >Not found</span
                        >{/if}
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
                      <CioCheck
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
                      <CioCopy size={11} />
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
              <CioVolumeX size={12} />
            {:else}
              <CioVolume size={12} />
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
          <CioTarget size={12} />
        </button>
        {#if historyActions && selected.directory !== '' && !selectedMissing}
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
          disabled={selected.directory === '' || selectedMissing}
          aria-pressed={historyOpen}
          title={`${nounTitle} history`}
          aria-label={`${nounTitle} history`}
          onclick={() => (historyOpen = !historyOpen)}
        >
          <CioHistory size={12} />
        </button>
        {#if !video && designScreens.length > 1}
          <!--
            The order of the screens grid, one click from the grid itself.

            A design is a folder of screens, and the one that moved last is
            usually the one the user came for, so the board starts there. It is a
            dropdown rather than a row of buttons because the header has one line
            to give, and the tooltip names the order in use.
          -->
          <DropdownMenu.Root bind:open={menus.sort}>
            <DropdownMenu.Trigger
              class="flex h-6 w-6 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground"
              title={`Sort the screens (${SCREEN_ORDER_LABELS[screenOrder]})`}
              aria-label={`Sort the screens (${SCREEN_ORDER_LABELS[screenOrder]})`}
            >
              <CioArrowUpDown size={12} />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                side="bottom"
                align="end"
                sideOffset={4}
                collisionPadding={8}
                class="z-50 w-44 border border-border bg-surface p-1 shadow-lg"
              >
                <DropdownMenu.RadioGroup
                  value={screenOrder}
                  onValueChange={handleScreenOrderChange}
                  aria-label="Order the screens"
                >
                  {#each SCREEN_ORDERS as order (order)}
                    <DropdownMenu.RadioItem
                      value={order}
                      class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
                    >
                      <span class="min-w-0 flex-1 truncate">{SCREEN_ORDER_LABELS[order]}</span>
                      <CioCheck
                        size={12}
                        class={['shrink-0', order === screenOrder ? 'text-primary' : 'invisible']}
                        aria-hidden="true"
                      />
                    </DropdownMenu.RadioItem>
                  {/each}
                </DropdownMenu.RadioGroup>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        {/if}
        <button
          type="button"
          class="flex h-6 w-6 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
          disabled={galleryBusy || selected.directory === ''}
          title={refreshLabel}
          aria-label={refreshLabel}
          onclick={refreshBoard}
        >
          {#if galleryBusy}
            <CioSpinner size={12} class="animate-spin" />
          {:else}
            <CioRefresh size={12} />
          {/if}
        </button>
        <DropdownMenu.Root bind:open={menus.options}>
          <DropdownMenu.Trigger
            class="flex h-6 w-6 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground"
            title={`${nounTitle} options`}
            aria-label={`${nounTitle} options`}
          >
            <CioEllipsis size={13} />
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
                <CioRefresh size={13} class="shrink-0 text-muted" />
                {refreshLabel}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50"
                disabled={selected.directory === ''}
                onSelect={() => void copyDesignPath(selected.directory)}
              >
                <CioCopy size={13} class="shrink-0 text-muted" />
                Copy path
              </DropdownMenu.Item>
              <DropdownMenu.Item
                class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50"
                disabled={selected.directory === ''}
                onSelect={() => void revealDesignPath(selected.directory)}
              >
                <CioFiles size={13} class="shrink-0 text-muted" />
                Reveal path
              </DropdownMenu.Item>
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger
                  class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-[state=open]:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50"
                  disabled={selected.directory === ''}
                >
                  <CioDownload size={13} class="shrink-0 text-muted" />
                  Export
                  <CioForward size={13} class="ml-auto text-muted" />
                </DropdownMenu.SubTrigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.SubContent
                    class="z-50 w-56 border border-border bg-surface p-1 shadow-lg"
                    sideOffset={4}
                  >
                    {#if video}
                      <DropdownMenu.Item
                        class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50"
                        disabled={selected.directory === '' ||
                          videoJobs.some((job) => job.state === 'running')}
                        onSelect={() => void exportVideo()}
                      >
                        Export MP4
                      </DropdownMenu.Item>
                    {:else}
                      {#each DESIGN_EXPORT_FORMATS as format (format)}
                        <DropdownMenu.Item
                          class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:opacity-50"
                          disabled={selected.directory === ''}
                          onSelect={() => startExport(null, format)}
                          >Export design as {format.toUpperCase()}</DropdownMenu.Item
                        >
                      {/each}
                    {/if}
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              </DropdownMenu.Sub>
              {#if !video}
                <DropdownMenu.Item
                  class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:opacity-50"
                  disabled={canvasBusy !== '' || selected.directory === ''}
                  onSelect={() => void requestDesignAction('contract')}
                >
                  <CioPencil size={13} class="shrink-0 text-muted" />
                  Generate DESIGN.md
                </DropdownMenu.Item>
                <DropdownMenu.Sub>
                  <DropdownMenu.SubTrigger
                    class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-[state=open]:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50"
                    disabled={canvasBusy !== '' || selected.directory === ''}
                  >
                    <CioPalette size={13} class="shrink-0 text-muted" />
                    Review Design
                    <CioForward size={13} class="ml-auto text-muted" />
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.SubContent
                      class="z-50 w-56 border border-border bg-surface p-1 shadow-lg"
                      sideOffset={4}
                    >
                      <DropdownMenu.Item
                        class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:opacity-50"
                        disabled={canvasBusy !== '' || selected.directory === ''}
                        onSelect={() => void requestDesignAction('critique')}
                        ><CioPalette size={13} class="shrink-0 text-muted" />Review design quality</DropdownMenu.Item
                      >
                      <DropdownMenu.Item
                        class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:opacity-50"
                        disabled={canvasBusy !== '' || selected.directory === ''}
                        onSelect={() => void requestDesignAction('tweaks')}
                      >
                        <CioMarquee size={13} class="shrink-0 text-muted" />
                        Inspect Designs
                      </DropdownMenu.Item>
                    </DropdownMenu.SubContent>
                  </DropdownMenu.Portal>
                </DropdownMenu.Sub>
                <DropdownMenu.Item
                  class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:opacity-50"
                  disabled={canvasBusy !== '' || selected.directory === ''}
                  onSelect={openReferencePrompt}
                  ><CioThreadBrowser size={ICON_SIZE.inline} class="shrink-0 text-muted" />Extract
                  brand from reference</DropdownMenu.Item
                >

                <DropdownMenu.Item
                  class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
                  data-external-url="https://github.com/nexu-io/open-design/tree/main/design-templates"
                  onSelect={() =>
                    void openInBrowser(
                      'https://github.com/nexu-io/open-design/tree/main/design-templates'
                    )}
                >
                  <CioStore size={13} class="shrink-0 text-muted" />
                  Browse Open Design prompts</DropdownMenu.Item
                >
              {/if}
              {#if !video && canvasRead && (!liveReady || (canvasState?.sketches.length ?? 0) > 0)}
                <DropdownMenu.Item
                  class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50"
                  disabled={canvasBusy !== '' || selected.directory === ''}
                  onSelect={() => void requestLivePreview()}
                >
                  <CioLayers size={13} class="shrink-0 text-muted" />
                  Generate Live Preview
                </DropdownMenu.Item>
              {/if}
              <DropdownMenu.Separator class="my-1 h-px bg-border" />
              <DropdownMenu.Item
                class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50"
                disabled={selected.directory === '' || selectedMissing}
                onSelect={() => (historyOpen = !historyOpen)}
              >
                <CioHistory size={13} class="shrink-0 text-muted" />
                {historyOpen ? 'Hide history' : 'Show history'}
              </DropdownMenu.Item>
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger
                  class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
                  disabled={selected.directory === '' || selectedMissing}
                >
                  <CioPencil size={13} class="shrink-0 text-muted" />
                  Update {noun} details
                  <CioForward size={12} class="ml-auto" />
                </DropdownMenu.SubTrigger>
                <DropdownMenu.SubContent
                  class="z-50 min-w-48 border border-border bg-surface p-1 shadow-xl"
                  sideOffset={4}
                >
                  {#each [{ mode: 'this', label: 'Change this save path' }, { mode: 'all', label: 'Change all save paths' }, { mode: 'rename', label: `Rename ${noun}` }] as action (action.mode)}
                    <DropdownMenu.Item
                      class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
                      onSelect={() => {
                        if (
                          action.mode === 'this' ||
                          action.mode === 'all' ||
                          action.mode === 'rename'
                        )
                          detailsMode = action.mode
                      }}>{action.label}</DropdownMenu.Item
                    >
                  {/each}
                </DropdownMenu.SubContent>
              </DropdownMenu.Sub>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <button
          type="button"
          class="ml-0.5 flex h-6 w-6 items-center justify-center bg-primary text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-40"
          disabled={opening || !playable || selected.directory === '' || selectedMissing}
          title={`Expand this ${noun} to full screen`}
          aria-label={`Expand this ${noun} to full screen`}
          onclick={() => void openPreview(selected.entry)}
        >
          {#if opening}
            <CioSpinner size={12} class="animate-spin" />
          {:else}
            <CioMaximize size={ICON_SIZE.inline} />
          {/if}
        </button>
      </span>
    </div>

    {#if canvasNotice !== ''}
      <p class="pb-1.5 pl-2.5 text-[0.625rem] text-dimmed">{canvasNotice}</p>
    {/if}
  </header>

  {#if !video && canvasHint !== ''}
    <p class="shrink-0 px-2.5 pb-1 text-[0.625rem] text-dimmed">{canvasHint}</p>
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

    {#if selectedMissing}
      <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
        <CioImageOff size={20} class="text-warning" />
        <p class="text-sm font-medium">{nounTitle} not found</p>
        <p class="break-all font-mono text-xs text-muted">{selected.directory}</p>
        <p class="text-xs text-muted">
          Restore the folder and refresh, or remove this entry from the panel.
        </p>
        <button
          type="button"
          class="flex items-center gap-2 border border-danger/40 px-3 py-1.5 text-xs text-danger"
          onclick={() => (removeRequested = selectedItem)}
          ><CioTrash size={13} />Remove from panel</button
        >
      </div>
    {:else if video && selected.directory !== ''}
      <!--
        The composition above, the tools below.

        The picture takes the space the panel has, and the timeline and controls
        sit under it in their own scroller. That is what keeps the frame whole: a
        native page cannot be clipped by `overflow`, so a picture sharing a
        scrolling column with the controls would be drawn past the panel at the
        sizes where the column is taller than the panel.
      -->
      <div
        class="flex min-h-0 flex-1 flex-col"
        {@attach (node) => {
          splitArea = node
          // The stored height is a pixel count this window has to be able to hold,
          // so it is corrected against the column it is being placed in rather than
          // trusted: a board opened on a smaller window opens with both halves whole.
          if (editorHeight === 0) {
            const stored = Number.parseInt(localStorage.getItem(EDITOR_HEIGHT_KEY) ?? '', 10)
            editorHeight = clampEditorHeight(
              Number.isFinite(stored) ? stored : Math.round(node.clientHeight * 0.45)
            )
          }
          return () => {
            splitArea = null
          }
        }}
      >
        <div class="flex min-h-0 flex-1 flex-col pt-2 pl-2.5">
          {@render videoStage()}
        </div>
        <!--
          The split between the picture and the editor.

          The band belongs to the bottom of the picture, not to the top of the
          timeline: the picture's own frame already draws the line between the two
          halves, so the band draws nothing and a second hairline here would read
          as an extra rule floating above the timeline. The whole band is the
          control, there is no grabber to aim at, its cursor is the row resize it
          performs, and it is a button so the split can be moved from the keyboard.
        -->
        <button
          type="button"
          class="flex h-2 w-full shrink-0 cursor-row-resize touch-none items-center px-2.5 outline-none"
          aria-label="Resize the composition editor"
          title="Drag to resize the timeline, or use the arrow keys"
          onpointerdown={startEditorResize}
          onpointermove={resizeEditor}
          onpointerup={finishEditorResize}
          onpointercancel={finishEditorResize}
          onkeydown={resizeEditorWithKeyboard}
        ></button>
        <div class="flex min-h-0 shrink-0 flex-col pb-2 pl-2.5" style:height={`${editorHeight}px`}>
          {#key `${projectId}:${threadId}:${selected.directory}:${boardRevision}`}
            <VideoTimeline
              {projectId}
              {threadId}
              directory={selected.directory}
              tabId={boardTabId}
              revision={studioRevision}
            >
              {#snippet saveAction()}
                <!--
                  One save control for the whole editor, on the row that never
                  moves. It reads the same as the file editor's save, so a save is
                  the same gesture everywhere in the app, and it is the only place
                  that says whether the file on disk is behind.
                -->
                <button
                  type="button"
                  class="flex h-6 w-6 shrink-0 items-center justify-center bg-primary text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-30"
                  disabled={!studioDirty || studioSaveAction === null}
                  aria-label="Save the composition"
                  title={studioDirty
                    ? 'Save the composition'
                    : 'The composition has no unsaved changes'}
                  onclick={() => studioSaveAction?.()}
                >
                  <CioSave size={11} />
                </button>
              {/snippet}
              {#snippet controls(section, seek)}
                {#if liveEditing}
                  <VideoStudioControls
                    {projectId}
                    {threadId}
                    {section}
                    directory={selected.directory}
                    jobs={videoJobs}
                    onCancelJob={cancelVideoJob}
                    onExport={exportVideo}
                    onSeek={seek}
                    onDirtyChange={setStudioDirty}
                    onSaved={setStudioSaved}
                    onSaveAction={(action) => (studioSaveAction = action)}
                  />
                {/if}
              {/snippet}
            </VideoTimeline>
          {/key}
        </div>
      </div>
    {:else}
      <div class="min-h-0 flex-1 overflow-y-auto py-2 pl-2.5">
        {#if video}
          <div
            class="flex aspect-[16/10] w-full flex-col items-center justify-center gap-1.5 border border-border bg-elevated text-dimmed"
          >
            <CioImageOff size={16} />
            <span class="px-4 text-center text-[0.6875rem]">
              {`The agent has not written a ${noun} yet. It will appear here when it does.`}
            </span>
          </div>
        {:else if gallery.length === 0}
          <div
            class="flex aspect-[16/10] w-full flex-col items-center justify-center gap-1.5 border border-border bg-elevated text-dimmed"
          >
            {#if galleryBusy}
              <CioSpinner size={16} class="animate-spin" />
              <span class="text-[0.6875rem]">Capturing the {noun}…</span>
            {:else}
              <CioImageOff size={16} />
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
                icon: CioDisplay,
                name: 'Screen Canvas',
                shot: canvasShot,
                label: 'Open the Screen Canvas in the in-app browser',
                empty: canvasEntryNote,
                busy: !canvasRead || openingCanvas,
                ready: canvasState !== null,
                onOpen: () => void openCanvas()
              })}
              {@render entryCard({
                icon: CioLayers,
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
                <CioSpinner size={12} class="animate-spin" />
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
    {#if selected.directory !== '' && !selectedMissing}
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
    {/if}
  </div>
</div>

<Modal
  open={referenceOpen}
  title="Extract brand from reference"
  description="Enter the reference site to measure for this design."
  size="md"
  onClose={() => {
    referenceOpen = false
  }}
>
  <div class="flex flex-col gap-2">
    <label for="reference-url" class="text-[0.8125rem] font-medium text-foreground">
      Reference site URL
    </label>
    <input
      id="reference-url"
      type="url"
      inputmode="url"
      autocomplete="off"
      spellcheck={false}
      placeholder="https://example.com"
      bind:value={referenceUrl}
      aria-invalid={referenceError !== ''}
      aria-describedby={referenceError !== '' ? 'reference-url-error' : undefined}
      class="h-8 w-full border border-border bg-elevated px-2 text-[0.8125rem] text-foreground outline-none focus:border-primary"
      onkeydown={(event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        confirmReferencePrompt()
      }}
    />
    {#if referenceError !== ''}
      <p id="reference-url-error" class="text-[0.75rem] text-danger" role="alert">
        {referenceError}
      </p>
    {:else}
      <p class="text-[0.75rem] text-muted">
        The agent measures this site, then writes the brand into DESIGN.md for {selectedName === ''
          ? `this ${noun}`
          : selectedName}.
      </p>
    {/if}
  </div>
  {#snippet footer()}
    <button
      type="button"
      class="border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
      title="Close without extracting"
      aria-label="Close without extracting"
      onclick={() => {
        referenceOpen = false
      }}
    >
      Cancel
    </button>
    <button
      type="button"
      data-modal-primary-action
      class="bg-primary px-3 py-1.5 text-xs font-medium text-on-primary transition-colors hover:opacity-90 disabled:opacity-50"
      disabled={referenceUrl.trim() === '' || canvasBusy !== ''}
      title="Extract the brand from this reference site"
      aria-label="Extract the brand from this reference site"
      onclick={confirmReferencePrompt}
    >
      Extract brand
    </button>
  {/snippet}
</Modal>

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

{#if detailsMode}
  <WorkDetailsDialog
    {projectId}
    {threadId}
    directory={selected.directory}
    {kind}
    root={workRoot}
    projectScope={!usesThreadWorkspaceMount(projectId)}
    mode={detailsMode}
    onClose={() => (detailsMode = null)}
    onUpdated={detailsUpdated}
  />
{/if}

<ConfirmDialog
  open={removeRequested !== null}
  title={`Remove missing ${noun}?`}
  confirmLabel="Remove from panel"
  cancelLabel="Cancel"
  busy={removeBusy}
  onCancel={() => {
    if (!removeBusy) removeRequested = null
  }}
  onConfirm={removeMissingWork}
>
  <p>
    Remove {removeRequested?.name ?? ''} from {ownerLabel}'s {noun} panel? This removes its saved folder
    record. No files are deleted.
  </p>
</ConfirmDialog>

{#if fullscreenCompositionTab && shownFullscreenTab}
  <!--
    The composition's own view, full screen.

    Not a second tab and not a second player: it is the board's tab in a full
    window surface, so the page the user is already watching moves here and the
    board's controls keep driving the same tab. It carries the composition's own
    transport (`BrowserPanel` draws one for any tab showing a composition), so the
    film keeps playing and stays scrubbable. The dialog hosts the browser's native
    view, which is why the surface must not suppress it (see `hostsBrowserView`).

    The surface is switched by the live tab (null once it is minimized) while the
    panel inside reads the remembered one, so minimizing tears the panel down
    cleanly instead of handing it a null to read on the way out.
  -->
  <FullscreenPanelDialog
    tabs={[{ id: shownFullscreenTab.id, title: shownFullscreenTab.title }]}
    activeTabId={shownFullscreenTab.id}
    minimizeLabel="Minimize the composition"
    hostsBrowserView
    hideStrip
    onSelect={() => {}}
    onMinimize={() => (compositionFullscreen = false)}
  >
    {#await import('$lib/components/browser/BrowserPanel.svelte') then { default: BrowserPanel }}
      {#key shownFullscreenTab.id}
        <BrowserPanel
          tab={shownFullscreenTab}
          fullscreen
          onMinimize={() => (compositionFullscreen = false)}
        />
      {/key}
    {/await}
  </FullscreenPanelDialog>
{/if}
