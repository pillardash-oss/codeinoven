<script lang="ts">
  import { onMount } from 'svelte'
  import {
    Check,
    ExternalLink,
    Film,
    Frame,
    ImageOff,
    LoaderCircle,
    Pencil,
    Play,
    RefreshCw,
    RotateCcw,
    Volume2,
    VolumeX,
    X
  } from '@lucide/svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { designCoordinatorState } from '$lib/stores/design-coordinator.svelte'
  import { sendOrQueueThreadMessage } from '$lib/stores/thread-delivery'
  import { logRendererError } from '$lib/system/renderer-logger'
  import { workRootMoveSummary } from '$lib/design-work-root-summary'
  import { isThreadBusyStatus } from '$shared/thread-status-policy'
  import {
    SCREEN_CANVAS_FILE,
    isScreenCanvasEntry,
    screenCanvasLiveViewMessage,
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
   * folder in use, a picture of every screen it holds, every folder of that kind the
   * project holds, and one button that brings its browser tab forward. A design session
   * and a video session share the board, so the words come from the kind and nothing
   * else does.
   *
   * A design is a product rather than a page, so the pictures are one per screen of the
   * folder in use. That is what makes a website and its dashboard visible together,
   * where a single picture of the design showed the entry file and hid the rest.
   *
   * It loads its own state rather than receiving it through props, because the work
   * outlives the turn that made it: there is no live turn to hand it anything, and a
   * restarted app has to fill this in from main alone.
   */

  interface Props {
    projectId: string
    threadId: string
  }

  let { projectId, threadId }: Props = $props()

  /**
   * How wide a screen is pictured at.
   *
   * One size for every card, featured or not, so the pictures are taken once and
   * shown at whatever size the grid gives them: a second size would be a second sweep
   * of page loads for the same screens.
   */
  const SCREEN_SHOT_WIDTH = 520

  // Seeded from whatever the workspace already fetched, so the panel paints on
  // its first frame instead of flashing a spinner.
  // svelte-ignore state_referenced_locally
  let designState = $state<ThreadDesignState | null>(
    designCoordinatorState.stateFor(projectId, threadId)
  )
  let gallery = $state<DesignScreenShot[]>([])
  let galleryBusy = $state(false)
  let opening = $state('')
  let error = $state('')
  /** The tab holding the work, so the board can reach its own controls. Empty
   *  until the first capture opens one, and an empty id reads as idle state. */
  let tabId = $state('')

  /**
   * The design's Screen Canvas: the page that shows every screen at once.
   *
   * It is agent work like the screens are, so the board's part is only to say
   * whether one exists, picture it, ask for it, and say when it has fallen
   * behind. The frames are main's answer, because the page is a file the board
   * cannot read for itself.
   */
  let canvasState = $state<ScreenCanvasState | null>(null)
  /** Whether main has answered about the canvas, so the card is not drawn from
   *  "no canvas yet" before the first read settles. */
  let canvasRead = $state(false)
  /** Which canvas request is in flight, or an empty string when none is. */
  let canvasBusy = $state('')
  /** The folder the canvas answer belongs to, so a folder switch cannot paint
   *  the previous folder's canvas card while the new one is being read. */
  let canvasDirectory = $state('')
  /** What happened to the last canvas request, in the user's terms. */
  let canvasNotice = $state('')

  /** The session's words and icon: a design session and a video session share this
   *  board, so nothing below hard-codes the word "design". */
  let video = $derived(designState?.kind === 'video')
  let noun = $derived(video ? 'composition' : 'design')
  let nounTitle = $derived(video ? 'Composition' : 'Design')
  let listLabel = $derived(video ? 'Compositions in this project' : 'Designs in this project')
  let WorkIcon = $derived(video ? Film : Frame)

  /**
   * Where this kind of work is written, and the two controls that change it.
   *
   * The folder is a setting rather than a constant, so the board is also the
   * place a user points it at a folder Git tracks: they are looking at the work,
   * so moving it is one button rather than a detour through Settings. Main owns
   * the value and reports what the move did, which is why the draft is saved
   * through the same channel the settings card uses.
   */
  let kind = $derived<AuthoredWorkKind>(video ? 'video' : 'design')
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

  /** The folder being shown: the thread's own, or the newest one it can open. */
  let selected = $derived.by(() => {
    const current = designState?.current ?? null
    const directory = current?.directory ?? designState?.defaultDirectory ?? ''
    return { directory, entry: current?.entry ?? null }
  })
  let items = $derived(designState?.items ?? [])
  let selectedName = $derived(
    items.find((item) => item.directory === selected.directory)?.name ??
      selected.directory.split('/').at(-1) ??
      ''
  )

  /** The screens of the design, without the canvas: the canvas has its own card. */
  let designScreens = $derived(gallery.filter((screen) => !isScreenCanvasEntry(screen.entry)))
  /** The canvas's own picture, when the sweep has captured one. */
  let canvasShot = $derived(gallery.find((screen) => isScreenCanvasEntry(screen.entry)) ?? null)
  /** How many frames of the canvas are sketches waiting for a real screen. */
  let canvasSketches = $derived(canvasState?.sketchTitles.length ?? 0)
  /** What the canvas holds, in one line, or nothing before there is one. */
  let canvasSummary = $derived.by(() => {
    const state = canvasState
    if (state === null) return ''
    const live = state.frames.filter((frame) => frame.entry !== null).length
    const parts = [`${live} screen${live === 1 ? '' : 's'}`]
    const sketches = state.sketchTitles.length
    if (sketches > 0) parts.push(`${sketches} sketch${sketches === 1 ? '' : 'es'}`)
    return parts.join(', ')
  })
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

  /**
   * The screen in front: the one the thread is on, or the design's first screen.
   *
   * A design with one screen, and a composition, are the same board with one card, so
   * nothing below treats the two cases differently.
   */
  let featured = $derived(
    designScreens.find((screen) => screen.entry === selected.entry) ?? designScreens[0] ?? null
  )
  /** Every other screen, so the grid shows the whole design and not just its entry. */
  let rest = $derived(designScreens.filter((screen) => screen !== featured))

  let refreshLabel = $derived(video ? 'Refresh the composition preview' : 'Refresh the screens')
  let screensLabel = $derived(`Screens in this design (${designScreens.length})`)

  async function loadState(): Promise<void> {
    try {
      designState = await invoke('design:state', projectId, threadId)
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
   * the sweep is done.
   *
   * A composition has no screens, so its single picture keeps coming from the one
   * thumbnail call, which is also what reports the tab the mute button drives.
   */
  async function loadGallery(force = false): Promise<void> {
    if (selected.directory === '') {
      gallery = []
      return
    }
    galleryBusy = true
    try {
      if (video) {
        const shot = await invoke(
          'design:thumbnail',
          projectId,
          threadId,
          selected.directory,
          selected.entry,
          SCREEN_SHOT_WIDTH
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

  /** Serve the work and bring its tab to the user. Main reveals it; the
   *  workspace opens and focuses the sidebar tab from that event, so this panel
   *  never has to know how the browser is laid out. */
  async function openWork(directory: string, entry: string | null): Promise<void> {
    if (directory === '') return
    opening = directory
    try {
      await invoke('design:open', projectId, threadId, directory, entry, true)
      await loadState()
      await loadGallery()
      await loadCanvas()
      error = ''
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'The work could not be opened.'
    } finally {
      opening = ''
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
    // so the card is held back until this folder has its own.
    if (directory !== canvasDirectory) canvasRead = false
    try {
      const state = await invoke('design:canvas', projectId, threadId, directory)
      // A switch that landed while this read was in flight owns the card now.
      if (directory !== selected.directory) return
      canvasState = state
    } catch (failure) {
      if (directory !== selected.directory) return
      // A board that cannot read the canvas still shows the screens, so this is
      // logged rather than shown, and the card falls back to "none yet".
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
   * queued behind a running turn when it is not: the button never steers work in
   * flight, and what happened is said under it either way.
   */
  async function requestCanvas(action: 'create' | 'update' | 'live'): Promise<void> {
    if (selected.directory === '' || canvasBusy !== '') return
    canvasBusy = action
    canvasNotice = ''
    try {
      const text =
        action === 'live'
          ? screenCanvasLiveViewMessage({
              directory: selected.directory,
              sketchTitles: canvasState?.sketchTitles ?? []
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
          : 'Asked the agent to build it.'
      error = ''
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'The canvas request could not be sent.'
    } finally {
      canvasBusy = ''
    }
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

  /** Refresh the board's own reading of the work: the screens and the canvas. */
  function refreshBoard(): void {
    void loadGallery(true)
    void loadCanvas()
  }

  $effect(() => {
    // The agent writes the canvas inside a turn, so the board re-reads when that
    // turn settles. Nothing polls: a canvas that appeared is pictured then, and
    // one that was rewritten is read again then.
    return subscribe('thread:updated', (thread) => {
      if (thread.id !== threadId || thread.projectId !== projectId) return
      if (isThreadBusyStatus(thread.status)) return
      void refreshCanvas()
    })
  })

  onMount(() => {
    void loadState().then(async () => {
      await loadGallery()
      await loadCanvas()
    })
    void loadWorkRoots()
  })

  function updatedLabel(item: DesignEntry): string {
    if (item.updatedAt <= 0) return ''
    return new Date(item.updatedAt).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  {#snippet screenCard(screen: DesignScreenShot, isFeatured: boolean)}
    {@const cardLabel = video
      ? `Open the ${noun} in the in-app browser`
      : `Open the ${noun} screen ${screen.name} in the in-app browser`}
    <button
      type="button"
      class="group relative block overflow-hidden rounded-lg border border-border bg-elevated transition-colors hover:border-primary/60 {isFeatured
        ? 'col-span-2'
        : ''}"
      title={cardLabel}
      aria-label={cardLabel}
      onclick={() => void openWork(selected.directory, screen.entry)}
    >
      {#if screen.dataUrl}
        <img
          src={screen.dataUrl}
          alt={video
            ? `Preview of the ${noun} ${selectedName}`
            : `Preview of the ${noun} screen ${screen.name}`}
          width={screen.width}
          height={screen.height}
          class="block h-auto w-full"
        />
      {:else}
        <span
          class="flex aspect-[4/3] w-full flex-col items-center justify-center gap-1.5 text-dimmed"
        >
          {#if galleryBusy && isFeatured}
            <LoaderCircle size={18} class="animate-spin" />
            <span class="text-[0.6875rem]">Capturing the {noun}…</span>
          {:else}
            <ImageOff size={isFeatured ? 18 : 14} />
            <span class="px-3 text-center text-[0.6875rem]">
              {galleryBusy ? 'Capturing…' : 'No preview of this screen yet.'}
            </span>
          {/if}
        </span>
      {/if}
      <span
        class="absolute inset-x-0 bottom-0 flex items-center bg-gradient-to-t from-black/55 to-transparent px-2 pt-4 pb-1.5"
      >
        <span class="truncate text-[0.6875rem] font-medium text-white">{screen.name}</span>
      </span>
      <span
        class="absolute inset-0 flex items-center justify-center bg-black/35 p-2 opacity-0 transition-opacity group-hover:opacity-100"
      >
        <span class="text-[0.6875rem] font-medium text-white">Open in the in-app browser</span>
      </span>
    </button>
  {/snippet}

  <header class="shrink-0 border-b border-border px-3 py-2">
    <div class="flex items-center justify-between gap-2">
      <span class="flex min-w-0 items-center gap-1.5">
        <WorkIcon size={13} class="shrink-0 text-accent" />
        <span class="truncate text-xs font-semibold text-foreground">
          {selectedName === '' ? nounTitle : selectedName}
        </span>
      </span>
      <span class="flex shrink-0 items-center gap-1">
        {#if video && tabId !== ''}
          <button
            type="button"
            class="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-elevated hover:text-foreground {tabRuntime.muted
              ? 'text-accent'
              : 'text-dimmed'}"
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
          class="flex h-6 w-6 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
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
        <button
          type="button"
          class="flex h-6 items-center gap-1 rounded-md bg-primary px-2 text-[0.6875rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-40"
          disabled={opening !== '' || selected.directory === ''}
          title={`Show this ${noun} in the in-app browser`}
          aria-label={`Show this ${noun} in the in-app browser`}
          onclick={() => void openWork(selected.directory, selected.entry)}
        >
          {#if opening !== ''}
            <LoaderCircle size={11} class="animate-spin" />
          {:else}
            <ExternalLink size={11} />
          {/if}
          Preview {noun}
        </button>
      </span>
    </div>
    <p class="mt-1 truncate text-[0.6875rem] text-muted" title={selected.directory}>
      {selected.directory === '' ? `No ${noun} yet` : selected.directory}
    </p>
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto px-3 py-2">
    {#if error !== ''}
      <p
        class="mb-2 rounded-md border border-danger/20 bg-danger/10 px-2 py-1 text-[0.6875rem] text-danger"
        role="alert"
      >
        {error}
      </p>
    {/if}

    {#if !video && canvasRead}
      <div class="mb-3 rounded-lg border border-border bg-elevated/60 px-2 py-2">
        <div class="flex items-center justify-between gap-2">
          <span class="flex min-w-0 items-center gap-1.5">
            <Frame size={12} class="shrink-0 text-accent" />
            <span class="truncate text-xs font-medium text-foreground">Screen canvas</span>
          </span>
          {#if canvasSummary !== ''}
            <span class="shrink-0 text-[0.625rem] text-dimmed tabular-nums">{canvasSummary}</span>
          {/if}
        </div>

        {#if canvasState === null}
          <p class="mt-1 text-[0.6875rem] text-muted">
            One page that shows every screen and state at once, so the whole product can be panned,
            inspected and commented on in one place.
          </p>
        {:else if canvasShot?.dataUrl}
          <button
            type="button"
            class="mt-1.5 block w-full overflow-hidden rounded-md border border-border transition-colors hover:border-primary/60"
            title="Open the screen canvas in the in-app browser"
            aria-label="Open the screen canvas in the in-app browser"
            onclick={() => void openWork(selected.directory, SCREEN_CANVAS_FILE)}
          >
            <img
              src={canvasShot.dataUrl}
              alt="Preview of the design's screen canvas"
              width={canvasShot.width}
              height={canvasShot.height}
              class="block h-auto w-full"
            />
          </button>
        {/if}

        {#if canvasDrift !== ''}
          <p class="mt-1 text-[0.625rem] text-warning">{canvasDrift}</p>
        {/if}

        <div class="mt-2 flex flex-wrap items-center gap-1.5">
          {#if canvasState === null}
            <button
              type="button"
              class="flex h-6 items-center gap-1 rounded-md bg-primary px-2 text-[0.6875rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-40"
              disabled={canvasBusy !== '' || selected.directory === ''}
              title="Ask the agent to create the screen canvas for this design"
              aria-label="Ask the agent to create the screen canvas for this design"
              onclick={() => void requestCanvas('create')}
            >
              {#if canvasBusy === 'create'}
                <LoaderCircle size={11} class="animate-spin" />
              {:else}
                <Play size={11} />
              {/if}
              Create screen canvas
            </button>
          {:else}
            <button
              type="button"
              class="flex h-6 items-center gap-1 rounded-md border border-border px-2 text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
              disabled={opening === selected.directory}
              title="Open the screen canvas in the in-app browser"
              aria-label="Open the screen canvas in the in-app browser"
              onclick={() => void openWork(selected.directory, SCREEN_CANVAS_FILE)}
            >
              {#if opening === selected.directory}
                <LoaderCircle size={11} class="animate-spin" />
              {:else}
                <ExternalLink size={11} />
              {/if}
              Open canvas
            </button>
            <button
              type="button"
              class="flex h-6 items-center gap-1 rounded-md border border-border px-2 text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
              disabled={canvasBusy !== ''}
              title="Ask the agent to bring the canvas up to date with the screens"
              aria-label="Ask the agent to update the screen canvas"
              onclick={() => void requestCanvas('update')}
            >
              {#if canvasBusy === 'update'}
                <LoaderCircle size={11} class="animate-spin" />
              {:else}
                <RefreshCw size={11} />
              {/if}
              Update canvas
            </button>
            {#if canvasSketches > 0}
              <button
                type="button"
                class="flex h-6 items-center gap-1 rounded-md border border-border px-2 text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
                disabled={canvasBusy !== ''}
                title="Ask the agent to build every sketch on the canvas as a real screen"
                aria-label="Ask the agent to build the canvas sketches as real screens"
                onclick={() => void requestCanvas('live')}
              >
                {#if canvasBusy === 'live'}
                  <LoaderCircle size={11} class="animate-spin" />
                {:else}
                  <Play size={11} />
                {/if}
                Live view ({canvasSketches})
              </button>
            {/if}
          {/if}
        </div>

        {#if canvasNotice !== ''}
          <p class="mt-1 text-[0.625rem] text-dimmed">{canvasNotice}</p>
        {/if}
      </div>
    {/if}

    {#if designScreens.length === 0}
      <div
        class="flex aspect-[4/3] w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-border bg-elevated text-dimmed"
      >
        {#if galleryBusy}
          <LoaderCircle size={18} class="animate-spin" />
          <span class="text-[0.6875rem]">Capturing the {noun}…</span>
        {:else}
          <ImageOff size={18} />
          <span class="px-4 text-center text-[0.6875rem]">
            {items.length === 0
              ? `The agent has not written a ${noun} yet. It will appear here when it does.`
              : video
                ? 'No preview captured yet.'
                : 'This design has no HTML screens yet.'}
          </span>
        {/if}
      </div>
    {:else}
      {#if !video}
        <p class="px-1 pb-1 text-[0.625rem] font-semibold tracking-wide text-dimmed uppercase">
          {screensLabel}
        </p>
      {/if}
      <div class="grid grid-cols-2 gap-2">
        {#if featured}
          {@render screenCard(featured, true)}
        {/if}
        {#each rest as screen (screen.entry)}
          {@render screenCard(screen, false)}
        {/each}
      </div>
    {/if}

    <div class="mt-3">
      <p class="px-1 pb-1 text-[0.625rem] font-semibold tracking-wide text-dimmed uppercase">
        {listLabel} ({items.length})
      </p>
      {#if items.length === 0}
        <p class="px-1 py-1 text-[0.6875rem] text-muted">
          Nothing under <code>{workRoot}</code> for this project yet.
        </p>
      {:else}
        <ul class="flex flex-col">
          {#each items as item (item.directory)}
            {@const isSelected = item.directory === selected.directory}
            <li>
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors {isSelected
                  ? 'bg-accent/10'
                  : 'hover:bg-elevated'}"
                title={item.hasEntry
                  ? `Open ${item.name} in the in-app browser`
                  : `Open the folder listing for ${item.name}`}
                aria-label={`Open ${item.name} in the in-app browser`}
                aria-current={isSelected}
                onclick={() => void openWork(item.directory, null)}
              >
                <WorkIcon size={12} class="shrink-0 {isSelected ? 'text-accent' : 'text-dimmed'}" />
                <span
                  class="min-w-0 flex-1 truncate text-xs {isSelected
                    ? 'font-medium text-foreground'
                    : 'text-muted'}"
                >
                  {item.name}
                </span>
                {#if !item.hasEntry}
                  <span class="shrink-0 text-[0.625rem] text-dimmed">no index.html</span>
                {/if}
                <span class="shrink-0 text-[0.625rem] text-dimmed tabular-nums">
                  {updatedLabel(item)}
                </span>
                {#if opening === item.directory}
                  <LoaderCircle size={11} class="shrink-0 animate-spin text-accent" />
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <div class="mt-3 rounded-lg border border-border px-2 py-2">
      <div class="flex items-center justify-between gap-2">
        <span class="text-[0.625rem] font-semibold tracking-wide text-dimmed uppercase">
          Save path
        </span>
        <span class="flex shrink-0 items-center gap-1">
          {#if !editingRoot}
            <button
              type="button"
              class="flex h-5 w-5 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
              disabled={rootBusy || workRoot === ''}
              title={`Change where new ${noun}s are saved`}
              aria-label={`Change where new ${noun}s are saved`}
              onclick={beginEditRoot}
            >
              <Pencil size={11} />
            </button>
          {/if}
          <button
            type="button"
            class="flex h-5 w-5 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
            disabled={rootBusy || rootIsDefault || defaultRoot === ''}
            title={`Put new ${noun}s back in ${defaultRoot || '.cio'}, and move the ones already there`}
            aria-label={`Reset the ${noun} save path to the default`}
            onclick={() => void applyRoot(defaultRoot)}
          >
            {#if rootBusy}
              <LoaderCircle size={11} class="animate-spin" />
            {:else}
              <RotateCcw size={11} />
            {/if}
          </button>
        </span>
      </div>

      {#if editingRoot}
        <div class="mt-1 flex items-center gap-1">
          <input
            class="h-6 min-w-0 flex-1 rounded-md border border-border bg-elevated px-1.5 font-mono text-[0.6875rem] text-foreground outline-none focus:border-primary"
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
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-accent transition-colors hover:bg-elevated disabled:opacity-40"
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
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
            title="Cancel"
            aria-label="Cancel changing the save path"
            onclick={cancelEditRoot}
          >
            <X size={12} />
          </button>
        </div>
      {:else}
        <p class="mt-0.5 truncate font-mono text-[0.6875rem] text-muted" title={workRoot}>
          {workRoot === '' ? 'Reading the folder...' : workRoot}
        </p>
      {/if}

      {#if rootError !== ''}
        <p class="mt-1 text-[0.6875rem] text-danger" role="alert">{rootError}</p>
      {:else if rootNotice !== ''}
        <p class="mt-1 text-[0.6875rem] text-muted">{rootNotice}</p>
      {/if}
    </div>
  </div>
</div>
