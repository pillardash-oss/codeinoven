<script lang="ts">
  import { onMount } from 'svelte'
  import {
    ExternalLink,
    Film,
    Frame,
    ImageOff,
    LoaderCircle,
    RefreshCw,
    Volume2,
    VolumeX
  } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { designCoordinatorState } from '$lib/stores/design-coordinator.svelte'
  import { DESIGN_OUTPUT_ROOT } from '$shared/design-skill'
  import type { DesignEntry, ThreadDesignState } from '$shared/ipc-contract'
  import { VIDEO_PROJECT_ROOT } from '$shared/video/project'

  /**
   * The coordinator board for a thread's authored work.
   *
   * A session's work is a folder of HTML, and the user's question after a restart is
   * "where did my design go?" or "where did my video go?". This panel answers it: the
   * folder in use, a picture of it, every folder of that kind the project holds, and
   * one button that brings its browser tab forward. A design session and a video
   * session share the board, so the words come from the kind and nothing else does.
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

  // Seeded from whatever the workspace already fetched, so the panel paints on
  // its first frame instead of flashing a spinner.
  // svelte-ignore state_referenced_locally
  let designState = $state<ThreadDesignState | null>(
    designCoordinatorState.stateFor(projectId, threadId)
  )
  let thumbnail = $state('')
  let thumbnailSize = $state<{ width: number; height: number } | null>(null)
  let thumbnailBusy = $state(false)
  let opening = $state('')
  let error = $state('')
  /** The tab holding the work, so the board can reach its own controls. Empty
   *  until the first capture opens one, and an empty id reads as idle state. */
  let tabId = $state('')

  /** The session's words and icon: a design session and a video session share this
   *  board, so nothing below hard-codes the word "design". */
  let video = $derived(designState?.kind === 'video')
  let noun = $derived(video ? 'composition' : 'design')
  let nounTitle = $derived(video ? 'Composition' : 'Design')
  let listLabel = $derived(video ? 'Compositions in this project' : 'Designs in this project')
  let WorkIcon = $derived(video ? Film : Frame)
  let workRoot = $derived(video ? VIDEO_PROJECT_ROOT : DESIGN_OUTPUT_ROOT)

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

  async function loadState(): Promise<void> {
    try {
      designState = await invoke('design:state', projectId, threadId)
      error = ''
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'The work state could not be read.'
    }
  }

  /**
   * Capture the work for the preview.
   *
   * This also puts it in the thread's browser tab, off screen, which is
   * deliberate: a picture has to come from a page the app is rendering, and the
   * tab has to exist anyway for the Preview button to be instant. The capture is
   * asked for on demand, never on a timer. A composition is captured as it plays,
   * because a frame is what a composition exists to draw.
   */
  async function loadThumbnail(): Promise<void> {
    if (selected.directory === '') return
    thumbnailBusy = true
    try {
      const shot = await invoke(
        'design:thumbnail',
        projectId,
        threadId,
        selected.directory,
        selected.entry,
        560
      )
      thumbnail = shot.dataUrl ?? ''
      thumbnailSize = shot.dataUrl ? { width: shot.width, height: shot.height } : null
      tabId = shot.tabId ?? ''
    } catch {
      thumbnail = ''
      thumbnailSize = null
    } finally {
      thumbnailBusy = false
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
      await loadThumbnail()
      error = ''
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'The work could not be opened.'
    } finally {
      opening = ''
    }
  }

  onMount(() => {
    void loadState().then(loadThumbnail)
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
          disabled={thumbnailBusy || selected.directory === ''}
          title={`Refresh the ${noun} preview`}
          aria-label={`Refresh the ${noun} preview`}
          onclick={() => void loadThumbnail()}
        >
          {#if thumbnailBusy}
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

    <button
      type="button"
      class="group relative block w-full overflow-hidden rounded-lg border border-border bg-elevated transition-colors hover:border-primary/60 disabled:cursor-default"
      disabled={selected.directory === ''}
      title={`Open this ${noun} in the in-app browser`}
      aria-label={`Open this ${noun} in the in-app browser`}
      onclick={() => void openWork(selected.directory, selected.entry)}
    >
      {#if thumbnail !== '' && thumbnailSize}
        <img
          src={thumbnail}
          alt={`Preview of the ${noun} ${selectedName}`}
          width={thumbnailSize.width}
          height={thumbnailSize.height}
          class="block h-auto w-full"
        />
        <span
          class="absolute inset-0 flex items-end justify-center bg-gradient-to-t from-black/45 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100"
        >
          <span class="text-[0.6875rem] font-medium text-white">Open in the in-app browser</span>
        </span>
      {:else}
        <span
          class="flex aspect-[4/3] w-full flex-col items-center justify-center gap-1.5 text-dimmed"
        >
          {#if thumbnailBusy}
            <LoaderCircle size={18} class="animate-spin" />
            <span class="text-[0.6875rem]">Capturing the {noun}…</span>
          {:else}
            <ImageOff size={18} />
            <span class="px-4 text-center text-[0.6875rem]">
              {items.length === 0
                ? `The agent has not written a ${noun} yet. It will appear here when it does.`
                : 'No preview captured yet.'}
            </span>
          {/if}
        </span>
      {/if}
    </button>

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
  </div>
</div>
