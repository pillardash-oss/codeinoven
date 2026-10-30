<script lang="ts">
  import CioArrowUpDown from '@pdslng/cio-icon/CioArrowUpDown.svelte'
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioCopy from '@pdslng/cio-icon/CioCopy.svelte'
  import CioDisplay from '@pdslng/cio-icon/CioDisplay.svelte'
  import CioUpload from '@pdslng/cio-icon/CioUpload.svelte'
  import CioEllipsis from '@pdslng/cio-icon/CioEllipsis.svelte'
  import CioFiles from '@pdslng/cio-icon/CioFiles.svelte'
  import CioFolder from '@pdslng/cio-icon/CioFolder.svelte'
  import CioFolderPlus from '@pdslng/cio-icon/CioFolderPlus.svelte'
  import CioForward from '@pdslng/cio-icon/CioForward.svelte'
  import CioHistory from '@pdslng/cio-icon/CioHistory.svelte'
  import CioImageOff from '@pdslng/cio-icon/CioImageOff.svelte'
  import CioGrip from '@pdslng/cio-icon/CioGrip.svelte'
  import CioLayers from '@pdslng/cio-icon/CioLayers.svelte'
  import CioLayoutGrid from '@pdslng/cio-icon/CioLayoutGrid.svelte'
  import CioListTree from '@pdslng/cio-icon/CioListTree.svelte'
  import CioMarquee from '@pdslng/cio-icon/CioMarquee.svelte'
  import CioPalette from '@pdslng/cio-icon/CioPalette.svelte'
  import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioStore from '@pdslng/cio-icon/CioStore.svelte'
  import CioTarget from '@pdslng/cio-icon/CioTarget.svelte'
  import CioThreadBrowser from '@pdslng/cio-icon/CioThreadBrowser.svelte'
  import CioTrash from '@pdslng/cio-icon/CioTrash.svelte'
  import { ICON_SIZE } from '$lib/components/icons/cio/scale'
  import { ContextMenu, DropdownMenu } from 'bits-ui'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import DesignHistoryActions from '$lib/components/design/DesignHistoryActions.svelte'
  import DesignHistoryPanel from '$lib/components/design/DesignHistoryPanel.svelte'
  import CompositionStage from '$lib/components/design/CompositionStage.svelte'
  import FullscreenPanelDialog from '$lib/components/workspace/FullscreenPanelDialog.svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import { slide } from 'svelte/transition'
  import { screenBoardState } from '$lib/stores/screen-board.svelte'
  import VideoEditWorkspace from '$lib/components/design/VideoEditWorkspace.svelte'
  import { usesThreadWorkspaceMount } from '$shared/types'
  import { openInBrowser } from '$lib/open-in-browser'
  import { DESIGN_EXPORT_FORMATS } from '$shared/design/design-export'
  import type { DesignScreenShot } from '$shared/ipc-contract'
  import WorkDetailsDialog from './WorkDetailsDialog.svelte'
  import { SCREEN_ORDERS } from './DesignCoordinatorPanel/DesignCoordinatorPanel-types'
  import { createDesignBoard } from './DesignCoordinatorPanel/DesignCoordinatorPanel-board.svelte'
  import type { Props } from './DesignCoordinatorPanel/DesignCoordinatorPanel-types'
  import type { ScreenGroup } from '$shared/ipc-contract'

  let { projectId, threadId, viewingThreadId, kind: forcedKind, active = true }: Props = $props()
  const board = createDesignBoard(() => ({
    projectId,
    threadId,
    viewingThreadId,
    kind: forcedKind,
    active
  }))
  /**
   * The tab the full screen panel shows, held locally because the markup narrows it
   * inside an `{#if}` and a narrowed property access does not survive the callback
   * Svelte compiles that branch into.
   */
  const shownFullscreenTab = $derived(board.studio.shownFullscreenTab)

  /**
   * Where the caret lands when the composition's full screen surface opens.
   *
   * A modal focuses its first field, and a player's first field is a search box, so
   * the space that means "pause the video" was typed into that box instead. The
   * picture's own play control is what a viewer reaches for, so it takes the caret
   * and the play/pause key works from the first press.
   */
  function claimPlayerFocus(panel: HTMLElement): boolean {
    const play = panel.querySelector<HTMLElement>('[data-video-play]')
    if (!play) return false
    play.focus({ preventScroll: true })
    return true
  }

  // The arrangement of the design in front is read when it changes, so a board a
  // window reopens on shows the user's own groups without waiting for a drag.
  $effect(() => {
    const directory = board.gallery.selected.directory
    if (directory !== '') void screenBoardState.ensure(board.props.projectId, directory)
  })
</script>

<div class="flex h-full min-h-0 flex-col" {@attach board.studio.watchViewingThread}>
  {#snippet videoStage()}
    {#if board.gallery.liveTab && !board.studio.compositionFullscreen}
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
      {#key board.gallery.liveTab.tabId}
        <!-- The tab's identity is the stage's identity: a re-keyed tab builds a
             new stage, so the frame this pane claims, the view it places and the
             transport it draws all belong to the same tab. -->
        <CompositionStage
          tab={board.gallery.liveTab}
          active={board.props.active}
          covered={board.menus.menuOpen}
          layoutRevision={Number(board.state.historyOpen)}
          ownsPlaybackKey={board.gallery.video}
        />
      {/key}
    {:else if !board.gallery.playable}
      <div
        class="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 border border-border bg-elevated text-dimmed"
      >
        <CioImageOff size={16} />
        <span class="px-4 text-center text-[0.6875rem]">
          {`This ${board.gallery.noun} has no entry page yet, so there is nothing to play. The agent writes one when it starts the ${board.gallery.noun}.`}
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
        aria-label={`${board.studio.nounTitle} preview`}
      >
        {#if board.studio.exportPath}
          <video
            {@attach board.state.attachExport}
            class="min-h-0 flex-1 object-contain"
            src={`appfile://project/${board.props.projectId}/${board.studio.exportPath}`}
            controls
            playsinline
            preload="metadata"
            aria-label={`Exported ${board.gallery.noun} ${board.gallery.selectedName}`}
          >
            <track kind="captions" />
          </video>
        {:else if board.gallery.gallery[0]?.dataUrl}
          <img
            src={board.gallery.gallery[0].dataUrl}
            alt={`Preview of the ${board.gallery.noun} ${board.gallery.selectedName}`}
            class="min-h-0 flex-1 object-contain"
          />
        {:else}
          <div class="flex min-h-0 flex-1 items-center justify-center gap-1.5 text-dimmed">
            {#if board.studio.galleryBusy}
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
            {board.gallery.composing === board.gallery.selected.directory
              ? `Opening the ${board.gallery.noun}…`
              : board.studio.exportPath
                ? `Latest export · ${board.studio.exportPath.split('/').at(-1)}`
                : `Waiting for the ${board.gallery.noun} preview`}
          </span>
          <button
            type="button"
            class="shrink-0 border border-border px-1.5 py-0.5 text-[0.625rem] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
            title={`Open the ${board.gallery.noun} preview again`}
            aria-label={`Open the ${board.gallery.noun} preview again`}
            disabled={board.gallery.composing !== ''}
            onclick={() =>
              void board.gallery.ensureComposition(board.gallery.selected.directory, true)}
          >
            Try again
          </button>
        </div>
      </div>
    {/if}
  {/snippet}

  {#snippet screenCard(screen: DesignScreenShot, full: boolean)}
    {@const cardLabel = board.gallery.video
      ? `Watch the ${board.gallery.noun} full screen in the in-app browser`
      : `Open the ${board.gallery.noun} screen ${screen.name} in the in-app browser`}
    {@const onScreen = !board.gallery.video && screen.entry === board.gallery.selected.entry}
    {@const copyLabel = board.gallery.video
      ? `Copy the path of this ${board.gallery.noun}`
      : `Copy ${board.gallery.noun} screen: ${screen.name}`}
    <ContextMenu.Root bind:open={board.menus.menus.card}>
      <ContextMenu.Trigger class={full ? 'col-span-2' : ''}>
        <div
          class="flex flex-col overflow-hidden border bg-elevated transition-colors hover:border-primary/60 {onScreen
            ? 'border-accent/60'
            : 'border-border'}"
        >
          <button
            type="button"
            class="group relative block w-full overflow-hidden"
            title={cardLabel}
            aria-label={cardLabel}
            onclick={() => void board.gallery.openPreview(screen.entry)}
          >
            {#if screen.dataUrl}
              <img
                src={screen.dataUrl}
                alt={board.gallery.video
                  ? `Preview of the ${board.gallery.noun} ${board.gallery.selectedName}`
                  : `Preview of the ${board.gallery.noun} screen ${screen.name}`}
                class="block max-h-64 w-full object-cover object-top"
              />
            {:else}
              <span
                class="flex aspect-[4/3] w-full flex-col items-center justify-center gap-1 text-dimmed"
              >
                {#if board.studio.galleryBusy}
                  <CioSpinner size={14} class="animate-spin" />
                  <span class="text-[0.625rem]">Capturing…</span>
                {:else}
                  <CioImageOff size={14} />
                  <span class="px-2 text-center text-[0.625rem]">No preview yet.</span>
                {/if}
              </span>
            {/if}
            <span
              class="absolute inset-0 flex items-center justify-center bg-black/35 p-2 opacity-0 transition-opacity group-hover:opacity-100"
            >
              <span class="text-[0.625rem] font-medium text-white"
                >{board.gallery.video
                  ? 'Watch full screen in the in-app browser'
                  : 'Open in the in-app browser'}</span
              >
            </span>
          </button>
          <!-- The card's own bar: the drag handle, the selection and the screen's
               name, on the card rather than floating over its picture. It sits at
               the bottom so the group's bar above the cards never collides with it. -->
          <div class="flex items-center gap-1 border-t border-border px-0.5 py-px">
            {@render screenGrip(screen.entry)}
            {@render screenSelection(screen.entry)}
            <button
              type="button"
              class="min-w-0 flex-1 truncate text-left text-[0.625rem] font-medium text-foreground"
              title={cardLabel}
              aria-label={cardLabel}
              onclick={() => void board.gallery.openPreview(screen.entry)}
            >
              {screen.name}
            </button>
          </div>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content class="z-50 min-w-44 border border-border bg-surface p-1 shadow-lg">
          <ContextMenu.Item
            class="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
            onSelect={() =>
              void board.state.copyDesignPath(board.gallery.selected.directory, screen.entry)}
          >
            <CioCopy size={13} class="shrink-0 text-muted" />
            {copyLabel}
          </ContextMenu.Item>
          {#if !board.gallery.video}
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger
                class="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-[state=open]:bg-elevated"
              >
                <CioUpload size={13} class="shrink-0 text-muted" />
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
                      onSelect={() => board.studio.startExport(screen.entry, format)}
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

  {#snippet screenRow(input: {
    icon?: typeof CioDisplay
    shot: DesignScreenShot | null
    name: string
    detail: string
    label: string
    busy?: boolean
    onOpen: () => void
  })}
    <button
      type="button"
      class="group flex w-full items-center gap-2 border border-border bg-elevated p-1 text-left transition-colors hover:border-primary/60"
      title={input.label}
      aria-label={input.label}
      onclick={input.onOpen}
    >
      <span
        class="flex h-9 w-14 shrink-0 items-center justify-center overflow-hidden border border-border bg-app text-dimmed"
      >
        {#if input.busy}
          <CioSpinner size={12} class="animate-spin" />
        {:else if input.shot?.dataUrl}
          <img src={input.shot.dataUrl} alt="" class="h-full w-full object-cover object-top" />
        {:else if input.icon}
          {@const RowIcon = input.icon}
          <RowIcon size={14} />
        {:else}
          <CioImageOff size={14} />
        {/if}
      </span>
      <span class="min-w-0 flex-1 truncate text-[0.6875rem] font-medium text-foreground"
        >{input.name}</span
      >
      <span class="max-w-28 shrink-0 truncate text-[0.625rem] text-dimmed">{input.detail}</span>
    </button>
  {/snippet}

  {#snippet screenSelection(entry: string)}
    <Switch
      checked={board.studio.selectedScreens.has(entry)}
      title="Select this screen to group or move it"
      aria-label="Select this screen to group or move it"
      onchange={() => board.studio.toggleScreenSelection(entry)}
    />
  {/snippet}

  {#snippet screenGrip(entry: string)}
    <button
      type="button"
      class="flex h-5 w-4 cursor-grab items-center justify-center text-dimmed hover:text-foreground"
      draggable="true"
      title="Drag to reorder this screen"
      aria-label="Drag to reorder this screen"
      ondragstart={(event) => {
        event.dataTransfer?.setData('text/plain', entry)
        board.studio.beginScreenDrag(entry)
      }}
      ondragend={() => board.studio.endScreenDrag()}
    >
      <CioGrip size={11} />
    </button>
  {/snippet}

  {#snippet screenListRow(screen: DesignScreenShot, groupId: string | null)}
    <div
      role="listitem"
      class="flex items-center gap-1 border border-border bg-elevated transition-colors hover:border-primary/60 {board
        .studio.dropTarget?.before === screen.entry
        ? 'border-primary'
        : ''}"
      ondragover={(event) => {
        event.preventDefault()
        board.studio.hoverScreenDrop(groupId, screen.entry)
      }}
      ondrop={(event) => {
        event.preventDefault()
        void board.studio.dropScreens(groupId, screen.entry)
      }}
    >
      {@render screenGrip(screen.entry)}
      {@render screenSelection(screen.entry)}
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center gap-2 py-1 pr-2 text-left"
        title={`Open the ${board.gallery.noun} screen ${screen.name} in the in-app browser`}
        aria-label={`Open the ${board.gallery.noun} screen ${screen.name} in the in-app browser`}
        onclick={() => void board.gallery.openPreview(screen.entry)}
      >
        <span
          class="flex h-8 w-12 shrink-0 items-center justify-center overflow-hidden border border-border bg-app text-dimmed"
        >
          {#if screen.dataUrl}
            <img src={screen.dataUrl} alt="" class="h-full w-full object-cover object-top" />
          {:else}
            <CioImageOff size={12} />
          {/if}
        </span>
        <span class="min-w-0 flex-1 truncate text-[0.6875rem] font-medium text-foreground"
          >{screen.name}</span
        >
        <span class="max-w-24 shrink-0 truncate text-[0.625rem] text-dimmed">{screen.entry}</span>
      </button>
    </div>
  {/snippet}

  {#snippet screenCardItem(screen: DesignScreenShot, groupId: string | null)}
    <div
      role="listitem"
      class="relative {board.studio.dropTarget?.before === screen.entry
        ? 'ring-1 ring-primary'
        : ''}"
      ondragover={(event) => {
        event.preventDefault()
        board.studio.hoverScreenDrop(groupId, screen.entry)
      }}
      ondrop={(event) => {
        event.preventDefault()
        void board.studio.dropScreens(groupId, screen.entry)
      }}
    >
      {@render screenCard(screen, board.gallery.video)}
    </div>
  {/snippet}

  {#snippet screenGroupHeader(group: ScreenGroup | null, count: number)}
    <div
      role="group"
      class="flex w-full items-center gap-1 {group ? 'bg-elevated' : ''} px-1 py-0.5"
      ondragover={(event) => {
        if (!group) return
        event.preventDefault()
        if (board.studio.dragGroup !== '') board.studio.hoverGroupDrop(group.id)
        else board.studio.hoverScreenDrop(group.id, null)
      }}
      ondrop={(event) => {
        if (!group) return
        event.preventDefault()
        if (board.studio.dragGroup !== '') void board.studio.dropGroupOnto(group.id)
        else void board.studio.dropScreens(group.id, null)
      }}
    >
      {#if group}
        <button
          type="button"
          class="flex h-5 w-4 shrink-0 cursor-grab items-center justify-center text-dimmed hover:text-foreground"
          draggable="true"
          title={`Drag to reorder the group ${group.name}`}
          aria-label={`Drag to reorder the group ${group.name}`}
          ondragstart={(event) => {
            event.dataTransfer?.setData('text/plain', group.id)
            board.studio.beginGroupDrag(group.id)
          }}
          ondragend={() => board.studio.endScreenDrag()}
        >
          <CioGrip size={11} />
        </button>
        <button
          type="button"
          class="flex h-5 w-5 shrink-0 items-center justify-center text-dimmed hover:text-foreground"
          title={group.collapsed ? `Open the group ${group.name}` : `Fold the group ${group.name}`}
          aria-label={group.collapsed
            ? `Open the group ${group.name}`
            : `Fold the group ${group.name}`}
          aria-expanded={!group.collapsed}
          onclick={() => void board.studio.foldScreenGroup(group.id, !group.collapsed)}
        >
          <CioChevronDown
            size={11}
            class="transition-transform {group.collapsed ? '-rotate-90' : ''}"
          />
        </button>
        {#if board.studio.renamingGroup === group.id}
          <input
            class="min-w-0 flex-1 border border-border bg-app px-1 text-[0.6875rem] font-semibold text-foreground outline-none focus:border-primary"
            aria-label={`Rename the group ${group.name}`}
            bind:value={board.studio.renameDraft}
            onkeydown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void board.studio.commitGroupRename()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                board.studio.cancelGroupRename()
              }
            }}
            onblur={() => void board.studio.commitGroupRename()}
          />
        {:else}
          <button
            type="button"
            class="min-w-0 flex-1 truncate text-left text-[0.6875rem] font-semibold text-foreground"
            title={`${group.collapsed ? 'Open' : 'Fold'} the group ${group.name}`}
            aria-label={`${group.collapsed ? 'Open' : 'Fold'} the group ${group.name}`}
            onclick={() => void board.studio.foldScreenGroup(group.id, !group.collapsed)}
          >
            {group.name}
          </button>
        {/if}
        <span class="shrink-0 text-[0.625rem] tabular-nums text-dimmed">{count}</span>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            class="flex h-5 w-5 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-surface hover:text-foreground"
            title={`Group actions for ${group.name}`}
            aria-label={`Group actions for ${group.name}`}
          >
            <CioEllipsis size={11} />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              class="z-50 min-w-40 border border-border bg-surface p-1 shadow-lg"
            >
              <DropdownMenu.Item
                class="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
                onSelect={() => board.studio.beginGroupRename(group)}>Rename</DropdownMenu.Item
              >
              <DropdownMenu.Item
                class="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-danger outline-none data-highlighted:bg-elevated"
                onSelect={() => void board.studio.removeScreenGroup(group.id)}
                >Delete group</DropdownMenu.Item
              >
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      {:else}
        <span class="shrink-0 px-1 text-[0.625rem] font-semibold text-dimmed uppercase"
          >Ungrouped</span
        >
        <span class="shrink-0 text-[0.625rem] tabular-nums text-dimmed">{count}</span>
      {/if}
    </div>
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
          class="block max-h-64 w-full object-cover object-top"
        />
      {:else}
        <span
          class="flex aspect-[4/3] w-full flex-col items-center justify-center gap-1 text-dimmed"
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
      <!--
        The design in front, and the way to the rest of them.

        One design is in front and every other design of the project waits behind
        the name beside it: a project accumulates designs faster than it deletes
        them, and a strip of tabs would only scroll them out of reach. Picking a row
        brings that design on screen, which is the whole gesture.
      -->
      {#if board.gallery.items.length > 1}
        <DropdownMenu.Root bind:open={board.menus.menus.list}>
          <DropdownMenu.Trigger
            class="group flex h-6 max-w-56 min-w-0 cursor-pointer items-center gap-1 px-1.5 transition-colors hover:bg-elevated data-[state=open]:bg-elevated"
            title={`${board.gallery.switchLabel}, currently ${board.gallery.selectedName === '' ? board.studio.nounTitle : board.gallery.selectedName}`}
            aria-label={`${board.gallery.switchLabel}, currently ${board.gallery.selectedName === '' ? board.studio.nounTitle : board.gallery.selectedName}`}
          >
            <board.studio.WorkIcon size={13} class="shrink-0 text-accent" />
            <span
              class="min-w-0 truncate text-xs font-semibold text-foreground"
              title={board.gallery.selected.directory}
            >
              {board.gallery.selectedName === ''
                ? board.studio.nounTitle
                : board.gallery.selectedName}
            </span>
            {#if !board.gallery.video && board.studio.designScreens.length > 0}
              <span
                class="shrink-0 border border-border bg-elevated px-1.5 text-[0.625rem] tabular-nums text-muted"
              >
                {board.studio.designScreens.length}
              </span>
            {/if}
            <span
              class="flex shrink-0 items-center gap-0.5 pl-0.5 text-[0.625rem] font-medium text-dimmed transition-colors group-hover:text-foreground"
            >
              {board.gallery.otherCount} more
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
              aria-label={`Other ${board.gallery.noun}s in this project`}
            >
              <DropdownMenu.RadioGroup
                value={board.gallery.selected.directory}
                onValueChange={(directory) => board.gallery.selectDesign(directory)}
              >
                {#each board.gallery.items as item (item.directory)}
                  <DropdownMenu.RadioItem
                    value={item.directory}
                    class="flex w-full min-w-0 cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
                    title={item.directory}
                  >
                    <board.studio.WorkIcon size={12} class="shrink-0 text-dimmed" />
                    <span class="min-w-0 flex-1 truncate">{item.name}</span>
                    {#if item.missing}
                      <span class="shrink-0 text-[0.625rem] text-warning">Not found</span>
                    {/if}
                    {#if item.creatorThreadId === board.gallery.selectionThreadId}
                      <span
                        class="shrink-0 bg-accent/15 px-1 text-[0.5625rem] font-semibold tracking-wide text-accent uppercase"
                      >
                        Current
                      </span>
                    {/if}
                    <CioCheck
                      size={12}
                      class={[
                        'shrink-0',
                        item.directory === board.gallery.selected.directory
                          ? 'text-primary'
                          : 'invisible'
                      ]}
                      aria-hidden="true"
                    />
                  </DropdownMenu.RadioItem>
                {/each}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      {:else}
        <span class="flex h-6 min-w-0 max-w-56 items-center gap-1 px-1.5">
          <board.studio.WorkIcon size={13} class="shrink-0 text-accent" />
          <span
            class="min-w-0 truncate text-xs font-semibold text-foreground"
            title={board.gallery.selected.directory}
          >
            {board.gallery.selectedName === ''
              ? board.studio.nounTitle
              : board.gallery.selectedName}
          </span>
        </span>
      {/if}
      {#if board.studio.selectedCreatorThreadId !== '' && board.studio.selectedCreatorThreadId === board.gallery.selectionThreadId}
        <span
          class="shrink-0 bg-accent/15 px-1 text-[0.5625rem] font-semibold tracking-wide text-accent uppercase"
          title="This conversation created this work">Current</span
        >
      {/if}
      <span class="min-w-0 flex-1"></span>
      <span class="flex shrink-0 items-center gap-0.5">
        <!--
          The two readings of this design's screens, one control.

          Cards is the board's grid: the Screen Canvas, the live preview, then every
          screen pictured. List is the same screens as rows, which is how a design of
          thirty screens is read and arranged. The label always names what the click
          will show, and the design in front never changes.

          A composition is not a folder of screens: it is one page with a timeline,
          so there is no second reading of it to switch to, and the control is not
          offered there at all.
        -->
        {#if !board.gallery.video}
          <button
            type="button"
            class="flex h-6 items-center gap-1 px-1.5 text-[0.625rem] text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
            aria-pressed={board.studio.screensView === 'list'}
            title={board.studio.screensView === 'cards'
              ? 'Show the screens of this design as a list'
              : 'Show the screens of this design as cards'}
            aria-label={board.studio.screensView === 'cards'
              ? 'Show the screens of this design as a list'
              : 'Show the screens of this design as cards'}
            onclick={() => board.studio.toggleScreensView()}
          >
            {#if board.studio.screensView === 'cards'}
              <CioListTree size={12} />
              List
            {:else}
              <CioLayoutGrid size={12} />
              Cards
            {/if}
          </button>
        {/if}
        {#if board.historyActions.historyActions && board.gallery.selected.directory !== '' && !board.gallery.selectedMissing}
          <DesignHistoryActions
            compact
            canUndo={board.historyActions.historyActions.canUndo}
            canRedo={board.historyActions.historyActions.canRedo}
            undoTitle={`Undo the last change to this ${board.gallery.noun}`}
            redoTitle={`Redo the change to this ${board.gallery.noun}`}
            onUndo={board.historyActions.historyActions.undo}
            onRedo={board.historyActions.historyActions.redo}
          />
        {/if}
        {#if !board.gallery.video && board.studio.designScreens.length > 1}
          <!--
            The order of the screens grid, one click from the grid itself.

            A design is a folder of screens, and the one that moved last is
            usually the one the user came for, so the board starts there. It is a
            dropdown rather than a row of buttons because the header has one line
            to give, and the tooltip names the order in use.
          -->
          <DropdownMenu.Root bind:open={board.menus.menus.sort}>
            <DropdownMenu.Trigger
              class="flex h-6 w-6 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground"
              title={`Sort the screens (${board.state.SCREEN_ORDER_LABELS[board.studio.screenOrder]})`}
              aria-label={`Sort the screens (${board.state.SCREEN_ORDER_LABELS[board.studio.screenOrder]})`}
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
                  value={board.studio.screenOrder}
                  onValueChange={(value) => {
                    if (board.studio.isScreenOrder(value)) board.studio.setScreenOrder(value)
                  }}
                  aria-label="Order the screens"
                >
                  {#each SCREEN_ORDERS as order (order)}
                    <DropdownMenu.RadioItem
                      value={order}
                      class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
                    >
                      <span class="min-w-0 flex-1 truncate"
                        >{board.state.SCREEN_ORDER_LABELS[order]}</span
                      >
                      <CioCheck
                        size={12}
                        class={[
                          'shrink-0',
                          order === board.studio.screenOrder ? 'text-primary' : 'invisible'
                        ]}
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
          disabled={board.studio.galleryBusy || board.gallery.selected.directory === ''}
          title={board.studio.refreshLabel}
          aria-label={board.studio.refreshLabel}
          onclick={board.gallery.refreshBoard}
        >
          {#if board.studio.galleryBusy}
            <CioSpinner size={12} class="animate-spin" />
          {:else}
            <CioRefresh size={12} />
          {/if}
        </button>
        <DropdownMenu.Root bind:open={board.menus.menus.options}>
          <DropdownMenu.Trigger
            class="flex h-6 w-6 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground"
            title={`${board.studio.nounTitle} options`}
            aria-label={`${board.studio.nounTitle} options`}
          >
            <CioEllipsis size={12} />
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
                class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50"
                disabled={board.gallery.selected.directory === ''}
                onSelect={() => void board.state.copyDesignPath(board.gallery.selected.directory)}
              >
                <CioCopy size={13} class="shrink-0 text-muted" />
                Copy path
              </DropdownMenu.Item>
              <DropdownMenu.Item
                class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50"
                disabled={board.gallery.selected.directory === ''}
                onSelect={() => void board.state.revealDesignPath(board.gallery.selected.directory)}
              >
                <CioFiles size={13} class="shrink-0 text-muted" />
                Reveal path
              </DropdownMenu.Item>
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger
                  class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-[state=open]:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50"
                  disabled={board.gallery.selected.directory === ''}
                >
                  <CioUpload size={13} class="shrink-0 text-muted" />
                  Export
                  <CioForward size={13} class="ml-auto text-muted" />
                </DropdownMenu.SubTrigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.SubContent
                    class="z-50 w-56 border border-border bg-surface p-1 shadow-lg"
                    sideOffset={4}
                  >
                    {#if board.gallery.video}
                      <DropdownMenu.Item
                        class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50"
                        disabled={board.gallery.selected.directory === '' ||
                          board.studio.videoJobs.some((job) => job.state === 'running')}
                        onSelect={() => void board.gallery.exportVideo()}
                      >
                        Export MP4
                      </DropdownMenu.Item>
                    {:else}
                      {#each DESIGN_EXPORT_FORMATS as format (format)}
                        <DropdownMenu.Item
                          class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:opacity-50"
                          disabled={board.gallery.selected.directory === ''}
                          onSelect={() => board.studio.startExport(null, format)}
                          >Export design as {format.toUpperCase()}</DropdownMenu.Item
                        >
                      {/each}
                    {/if}
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              </DropdownMenu.Sub>
              {#if !board.gallery.video}
                <DropdownMenu.Item
                  class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:opacity-50"
                  disabled={board.gallery.canvasBusy !== '' ||
                    board.gallery.selected.directory === ''}
                  onSelect={() => void board.gallery.requestDesignAction('contract')}
                >
                  <CioPencil size={13} class="shrink-0 text-muted" />
                  Generate DESIGN.md
                </DropdownMenu.Item>
                <DropdownMenu.Sub>
                  <DropdownMenu.SubTrigger
                    class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-[state=open]:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50"
                    disabled={board.gallery.canvasBusy !== '' ||
                      board.gallery.selected.directory === ''}
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
                        disabled={board.gallery.canvasBusy !== '' ||
                          board.gallery.selected.directory === ''}
                        onSelect={() => void board.gallery.requestDesignAction('critique')}
                        ><CioPalette size={13} class="shrink-0 text-muted" />Review design quality</DropdownMenu.Item
                      >
                      <DropdownMenu.Item
                        class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:opacity-50"
                        disabled={board.gallery.canvasBusy !== '' ||
                          board.gallery.selected.directory === ''}
                        onSelect={() => void board.gallery.requestDesignAction('tweaks')}
                      >
                        <CioMarquee size={13} class="shrink-0 text-muted" />
                        Inspect Designs
                      </DropdownMenu.Item>
                    </DropdownMenu.SubContent>
                  </DropdownMenu.Portal>
                </DropdownMenu.Sub>
                <DropdownMenu.Item
                  class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:opacity-50"
                  disabled={board.gallery.canvasBusy !== '' ||
                    board.gallery.selected.directory === ''}
                  onSelect={board.studio.openReferencePrompt}
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
              {#if !board.gallery.video && board.gallery.canvasRead && (!board.gallery.liveReady || (board.gallery.canvasState?.sketches.length ?? 0) > 0)}
                <DropdownMenu.Item
                  class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50"
                  disabled={board.gallery.canvasBusy !== '' ||
                    board.gallery.selected.directory === ''}
                  onSelect={() => void board.gallery.requestLivePreview()}
                >
                  <CioLayers size={13} class="shrink-0 text-muted" />
                  Generate Live Preview
                </DropdownMenu.Item>
              {/if}
              <DropdownMenu.Separator class="my-1 h-px bg-border" />
              <DropdownMenu.Item
                class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50"
                disabled={!board.studio.canRevealCreator}
                onSelect={() => void board.studio.revealCreator()}
              >
                <CioTarget size={13} class="shrink-0 text-muted" />
                {board.studio.revealLabel}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50"
                disabled={board.gallery.selected.directory === '' || board.gallery.selectedMissing}
                onSelect={() => (board.state.historyOpen = !board.state.historyOpen)}
              >
                <CioHistory size={13} class="shrink-0 text-muted" />
                {board.state.historyOpen ? 'Hide history' : 'Show history'}
              </DropdownMenu.Item>
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger
                  class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
                  disabled={board.gallery.selected.directory === '' ||
                    board.gallery.selectedMissing}
                >
                  <CioPencil size={13} class="shrink-0 text-muted" />
                  Update {board.gallery.noun} details
                  <CioForward size={12} class="ml-auto" />
                </DropdownMenu.SubTrigger>
                <DropdownMenu.SubContent
                  class="z-50 min-w-48 border border-border bg-surface p-1 shadow-xl"
                  sideOffset={4}
                >
                  {#each [{ mode: 'this', label: 'Change this save path' }, { mode: 'all', label: 'Change all save paths' }, { mode: 'rename', label: `Rename ${board.gallery.noun}` }] as action (action.mode)}
                    <DropdownMenu.Item
                      class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
                      onSelect={() => {
                        if (
                          action.mode === 'this' ||
                          action.mode === 'all' ||
                          action.mode === 'rename'
                        )
                          board.state.detailsMode = action.mode
                      }}>{action.label}</DropdownMenu.Item
                    >
                  {/each}
                </DropdownMenu.SubContent>
              </DropdownMenu.Sub>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </span>
    </div>

    {#if board.gallery.canvasNotice !== ''}
      <p class="pb-1.5 pl-2.5 text-[0.625rem] text-dimmed">{board.gallery.canvasNotice}</p>
    {/if}
  </header>

  {#if !board.gallery.video && board.studio.canvasHint !== ''}
    <p class="shrink-0 px-2.5 pb-1 text-[0.625rem] text-dimmed">{board.studio.canvasHint}</p>
  {/if}

  <div class="flex min-h-0 flex-1 flex-col">
    {#if board.gallery.error !== '' || board.studio.compositionError !== ''}
      <p
        class="mx-2.5 mt-2 shrink-0 border border-danger/20 bg-danger/10 px-2 py-1 text-[0.6875rem] text-danger"
        role="alert"
      >
        {board.gallery.error !== '' ? board.gallery.error : board.studio.compositionError}
      </p>
    {/if}

    {#if true}
      <div class="flex min-h-0 flex-1 flex-col">
        {#if board.gallery.selectedMissing}
          <div
            class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-center"
          >
            <CioImageOff size={20} class="text-warning" />
            <p class="text-sm font-medium">{board.studio.nounTitle} not found</p>
            <p class="break-all font-mono text-xs text-muted">{board.gallery.selected.directory}</p>
            <p class="text-xs text-muted">
              Restore the folder and refresh, or remove this entry from the panel.
            </p>
            <button
              type="button"
              class="flex items-center gap-2 border border-danger/40 px-3 py-1.5 text-xs text-danger"
              onclick={() => (board.studio.removeRequested = board.gallery.selectedItem)}
              ><CioTrash size={13} />Remove from panel</button
            >
          </div>
        {:else if board.gallery.video && board.gallery.selected.directory !== ''}
          <!--
        The composition above, the tools below.

        The picture takes the space the panel has, and the timeline and controls
        sit under it in their own scroller. That is what keeps the frame whole: a
        native page cannot be clipped by `overflow`, so a picture sharing a
        scrolling column with the controls would be drawn past the panel at the
        sizes where the column is taller than the panel.
      -->
          <div class="flex min-h-0 flex-1 flex-col">
            <div class="flex min-h-0 flex-1 flex-col pt-2 pl-2.5">
              {@render videoStage()}
            </div>
            <div class="flex shrink-0 flex-col border-t border-border pb-2 pl-2.5">
              {#key `${board.props.projectId}:${board.props.threadId}:${board.gallery.selected.directory}:${board.studio.boardRevision}`}
                <VideoEditWorkspace
                  projectId={board.props.projectId}
                  threadId={board.props.threadId}
                  directory={board.gallery.selected.directory}
                  tabId={board.gallery.boardTabId}
                  active={board.props.active && !board.studio.compositionFullscreen}
                  onDirtyChange={board.studio.setStudioDirty}
                  onSaved={board.studio.setStudioSaved}
                  onExport={board.gallery.exportVideo}
                  onExpand={() => void board.gallery.openPreview(null)}
                />
              {/key}
            </div>
          </div>
        {:else}
          <div class="screen-board-scope min-h-0 flex-1 overflow-y-auto py-2 pl-2.5">
            {#if board.gallery.video}
              <div
                class="flex aspect-[16/10] w-full flex-col items-center justify-center gap-1.5 border border-border bg-elevated text-dimmed"
              >
                <CioImageOff size={16} />
                <span class="px-4 text-center text-[0.6875rem]">
                  {`The agent has not written a ${board.gallery.noun} yet. It will appear here when it does.`}
                </span>
              </div>
            {:else if board.gallery.gallery.length === 0}
              <div
                class="flex aspect-[16/10] w-full flex-col items-center justify-center gap-1.5 border border-border bg-elevated text-dimmed"
              >
                {#if board.studio.galleryBusy}
                  <CioSpinner size={16} class="animate-spin" />
                  <span class="text-[0.6875rem]">Capturing the {board.gallery.noun}…</span>
                {:else}
                  <CioImageOff size={16} />
                  <span class="px-4 text-center text-[0.6875rem]">
                    {board.gallery.items.length === 0
                      ? `The agent has not written a ${board.gallery.noun} yet. It will appear here when it does.`
                      : 'No preview captured yet.'}
                  </span>
                {/if}
              </div>
            {:else if board.studio.screensView === 'list'}
              <div class="flex flex-col gap-2" aria-label={board.studio.screensLabel}>
                {#if !board.gallery.video}
                  <div class="flex flex-col gap-1">
                    {@render screenRow({
                      icon: CioDisplay,
                      shot: board.studio.canvasShot,
                      name: 'Screen Canvas',
                      detail: 'canvas',
                      label: 'Open the Screen Canvas in the in-app browser',
                      busy: !board.gallery.canvasRead || board.gallery.openingCanvas,
                      onOpen: () => void board.gallery.openCanvas()
                    })}
                    {@render screenRow({
                      icon: CioLayers,
                      shot: board.studio.liveShot,
                      name: 'Live preview',
                      detail: board.studio.LIVE_PREVIEW_ENTRY,
                      label: `Open the live preview of this ${board.gallery.noun} in the in-app browser`,
                      busy: board.gallery.opening,
                      onOpen: () => void board.gallery.openPreview(board.studio.LIVE_PREVIEW_ENTRY)
                    })}
                  </div>
                {/if}
                {#each board.studio.screenSections as section (section.group?.id ?? 'ungrouped')}
                  <div class="flex flex-col gap-1">
                    {#if section.group || board.studio.screenGroups.length > 0}
                      {@render screenGroupHeader(section.group, section.screens.length)}
                    {/if}
                    {#if !section.group?.collapsed}
                      <div
                        class="flex flex-col gap-1 {section.group ? 'pl-3' : ''}"
                        transition:slide={{ duration: 140 }}
                      >
                        {#each section.screens as screen (screen.entry)}
                          {@render screenListRow(screen, section.group?.id ?? null)}
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            {:else}
              <div class="screen-cards" aria-label={board.studio.screensLabel}>
                {#if !board.gallery.video}
                  {@render entryCard({
                    icon: CioDisplay,
                    name: 'Screen Canvas',
                    shot: board.studio.canvasShot,
                    label: 'Open the Screen Canvas in the in-app browser',
                    empty: board.studio.canvasEntryNote,
                    busy: !board.gallery.canvasRead || board.gallery.openingCanvas,
                    ready: board.gallery.canvasState !== null,
                    onOpen: () => void board.gallery.openCanvas()
                  })}
                  {@render entryCard({
                    icon: CioLayers,
                    name: 'Live preview',
                    shot: board.studio.liveShot,
                    label: `Open the live preview of this ${board.gallery.noun} in the in-app browser`,
                    empty: board.studio.liveEntryNote,
                    busy: board.gallery.opening,
                    ready: board.gallery.liveReady,
                    onOpen: () => void board.gallery.openPreview(board.studio.LIVE_PREVIEW_ENTRY)
                  })}
                {/if}
                {#each board.studio.screenSections as section (section.group?.id ?? 'ungrouped')}
                  {#if section.group || section.screens.length > 0}
                    <div class="col-span-full">
                      {#if section.group || board.studio.screenGroups.length > 0}
                        {@render screenGroupHeader(section.group, section.screens.length)}
                      {/if}
                    </div>
                    {#if !section.group?.collapsed}
                      <div class="screen-cards col-span-full" transition:slide={{ duration: 140 }}>
                        {#each section.screens as screen (screen.entry)}
                          {@render screenCardItem(screen, section.group?.id ?? null)}
                        {/each}
                      </div>
                    {/if}
                  {/if}
                {/each}
              </div>
              {#if !board.gallery.video && board.studio.designScreens.length === 0}
                {#if board.studio.galleryBusy}
                  <p
                    class="mt-2 flex items-center justify-center gap-1.5 text-[0.6875rem] text-dimmed"
                  >
                    <CioSpinner size={12} class="animate-spin" />
                    Capturing the {board.gallery.noun}…
                  </p>
                {:else}
                  <p class="mt-2 text-center text-[0.6875rem] text-muted">
                    {`The agent has not written a ${board.gallery.noun} yet. It will appear here when it does.`}
                  </p>
                {/if}
              {/if}
            {/if}
          </div>
        {/if}
      </div>
    {/if}
    {#if board.gallery.selected.directory !== '' && !board.gallery.selectedMissing}
      {#key `${board.props.projectId}:${board.props.threadId}:${board.gallery.selected.directory}`}
        <DesignHistoryPanel
          projectId={board.props.projectId}
          threadId={board.props.threadId}
          directory={board.gallery.selected.directory}
          noun={board.gallery.noun}
          unit={board.gallery.video ? 'file' : 'screen'}
          open={board.state.historyOpen}
          onRestored={board.studio.restoreBoard}
          onClose={() => (board.state.historyOpen = false)}
          onActions={board.historyActions.handleHistoryActions}
        />
      {/key}
    {/if}
    {#if board.studio.namingGroup}
      <form
        class="flex shrink-0 items-center gap-1 border-t border-border bg-surface px-2.5 py-1.5"
        onsubmit={(event) => {
          event.preventDefault()
          void board.studio.groupSelection()
        }}
      >
        <input
          class="min-w-0 flex-1 border border-border bg-app px-1.5 py-0.5 text-[0.6875rem] text-foreground outline-none focus:border-primary"
          placeholder="Group name"
          aria-label="New group name"
          bind:value={board.studio.groupDraft}
        />
        <button
          type="submit"
          class="flex h-6 shrink-0 items-center gap-1 bg-primary px-1.5 text-[0.6875rem] text-on-primary transition-colors hover:bg-primary-hover"
          title="Group the selected screens">Create</button
        >
        <button
          type="button"
          class="flex h-6 shrink-0 items-center px-1.5 text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
          title="Cancel grouping"
          onclick={() => board.studio.clearScreenSelection()}>Cancel</button
        >
      </form>
    {/if}
    {#if board.studio.selectedScreens.size > 0}
      <div
        class="flex shrink-0 items-center gap-1.5 border-t border-border bg-surface px-2.5 py-1.5"
      >
        <span class="shrink-0 text-[0.625rem] tabular-nums text-muted"
          >{board.studio.selectedScreens.size} selected</span
        >
        <span class="min-w-0 flex-1"></span>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            class="flex h-6 items-center gap-1 px-1.5 text-[0.625rem] text-dimmed transition-colors hover:bg-elevated hover:text-foreground data-[state=open]:bg-elevated"
            title="Move the selected screens to a group"
            aria-label="Move the selected screens to a group"
          >
            <CioLayers size={12} />
            Move to group
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="top"
              align="end"
              sideOffset={4}
              class="z-50 max-h-72 w-56 overflow-y-auto border border-border bg-surface p-1 shadow-lg"
            >
              {#each board.studio.screenGroups as group (group.id)}
                <DropdownMenu.Item
                  class="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
                  onSelect={() => void board.studio.moveSelectionTo(group.id)}
                >
                  <CioFolder size={12} class="shrink-0 text-muted" />
                  <span class="min-w-0 flex-1 truncate">{group.name}</span>
                </DropdownMenu.Item>
              {/each}
              <DropdownMenu.Item
                class="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
                onSelect={() => void board.studio.moveSelectionTo(null)}
              >
                <CioFiles size={12} class="shrink-0 text-muted" />
                Ungrouped
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <button
          type="button"
          class="flex h-6 items-center gap-1 px-1.5 text-[0.625rem] text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          title="Put the selected screens in a new group"
          aria-label="Put the selected screens in a new group"
          onclick={() => (board.studio.namingGroup = true)}
        >
          <CioFolderPlus size={12} />
          New group
        </button>
        <button
          type="button"
          class="flex h-6 items-center px-1.5 text-[0.625rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
          title="Clear the selection"
          onclick={() => board.studio.clearScreenSelection()}>Clear</button
        >
      </div>
    {/if}
  </div>
</div>

<Modal
  open={board.studio.referenceOpen}
  title="Extract brand from reference"
  description="Enter the reference site to measure for this design."
  size="md"
  onClose={() => {
    board.studio.referenceOpen = false
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
      bind:value={board.studio.referenceUrl}
      aria-invalid={board.studio.referenceError !== ''}
      aria-describedby={board.studio.referenceError !== ''
        ? 'reference-url-board.gallery.error'
        : undefined}
      class="h-8 w-full border border-border bg-elevated px-2 text-[0.8125rem] text-foreground outline-none focus:border-primary"
      onkeydown={(event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        board.studio.confirmReferencePrompt()
      }}
    />
    {#if board.studio.referenceError !== ''}
      <p id="reference-url-board.gallery.error" class="text-[0.75rem] text-danger" role="alert">
        {board.studio.referenceError}
      </p>
    {:else}
      <p class="text-[0.75rem] text-muted">
        The agent measures this site, then writes the brand into DESIGN.md for {board.gallery
          .selectedName === ''
          ? `this ${board.gallery.noun}`
          : board.gallery.selectedName}.
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
        board.studio.referenceOpen = false
      }}
    >
      Cancel
    </button>
    <button
      type="button"
      data-modal-primary-action
      class="bg-primary px-3 py-1.5 text-xs font-medium text-on-primary transition-colors hover:opacity-90 disabled:opacity-50"
      disabled={board.studio.referenceUrl.trim() === '' || board.gallery.canvasBusy !== ''}
      title="Extract the brand from this reference site"
      aria-label="Extract the brand from this reference site"
      onclick={board.studio.confirmReferencePrompt}
    >
      Extract brand
    </button>
  {/snippet}
</Modal>

<ConfirmDialog
  open={board.studio.reloadRequested}
  title="Discard unsaved board.gallery.video controls?"
  confirmLabel="Discard and reload"
  cancelLabel="Keep editing"
  onCancel={() => {
    board.studio.reloadRequested = false
  }}
  onConfirm={() => {
    board.studio.reloadRequested = false
    board.gallery.reloadVideoBoard()
  }}
>
  <p>Your unsaved control and caption edits will be replaced with the saved version.</p>
</ConfirmDialog>

{#if board.state.detailsMode}
  <WorkDetailsDialog
    projectId={board.props.projectId}
    threadId={board.props.threadId}
    directory={board.gallery.selected.directory}
    kind={board.gallery.kind}
    root={board.gallery.workRoot}
    projectScope={!usesThreadWorkspaceMount(board.props.projectId)}
    mode={board.state.detailsMode}
    onClose={() => (board.state.detailsMode = null)}
    onUpdated={board.gallery.detailsUpdated}
  />
{/if}

<ConfirmDialog
  open={board.studio.removeRequested !== null}
  title={`Remove missing ${board.gallery.noun}?`}
  confirmLabel="Remove from panel"
  cancelLabel="Cancel"
  busy={board.gallery.removeBusy}
  onCancel={() => {
    if (!board.gallery.removeBusy) board.studio.removeRequested = null
  }}
  onConfirm={board.gallery.removeMissingWork}
>
  <p>
    Remove {board.studio.removeRequested?.name ?? ''} from {board.studio.ownerLabel}'s {board
      .gallery.noun} panel? This removes its saved folder record. No files are deleted.
  </p>
</ConfirmDialog>

{#if board.gallery.fullscreenCompositionTab && shownFullscreenTab}
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
    claimInitialFocus={claimPlayerFocus}
    onSelect={() => {}}
    onMinimize={board.studio.minimizeCompositionEditor}
  >
    {#await import('$lib/components/browser/BrowserPanel.svelte') then { default: BrowserPanel }}
      {#key shownFullscreenTab.id}
        <!--
          Watching the composition full screen is the same editor with the work put
          away, never a second player.

          The preview keeps the page, the transport and the playhead the editor already
          has, so the second the user stopped on, the run state and the picture carry
          straight over. A separate player started a row of its own at zero beside a
          video that was already playing, which is the whole of the bug this replaces.
        -->
        <VideoEditWorkspace
          projectId={board.props.projectId}
          threadId={board.props.threadId}
          directory={board.gallery.selected.directory}
          tabId={board.gallery.boardTabId}
          active={true}
          mode="fullscreen"
          playerOnly={board.studio.compositionPlaybackOnly}
          onMinimize={board.studio.minimizeCompositionEditor}
          onDirtyChange={board.studio.setStudioDirty}
          onSaved={board.studio.setStudioSaved}
          onExport={board.gallery.exportVideo}
        >
          {#snippet preview()}
            <BrowserPanel
              tab={shownFullscreenTab}
              fullscreen
              playerInEditor
              minimizeTitle="Back to the editor"
              onMinimize={board.studio.compositionPlaybackOnly
                ? () => (board.studio.compositionPlaybackOnly = false)
                : undefined}
              onExpandVideo={board.studio.compositionPlaybackOnly
                ? undefined
                : () => (board.studio.compositionPlaybackOnly = true)}
            />
          {/snippet}
        </VideoEditWorkspace>
      {/key}
    {/await}
  </FullscreenPanelDialog>
{/if}

<style>
  /*
   * Two screens across until the panel has room for a third.
   *
   * The board is a panel that the user widens and narrows, so its column count is
   * a question about the room it has, not about the window: the scope below is the
   * width a card may share, and three columns arrive once the panel has been
   * widened past the width it opens at, not merely because it has a few pixels
   * more than two cards need.
   */
  .screen-board-scope {
    container-type: inline-size;
  }
  .screen-cards {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.375rem;
  }
  @container (min-width: 34rem) {
    .screen-cards {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }
</style>
