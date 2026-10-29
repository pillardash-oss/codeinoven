<script lang="ts">
  import CioArrowUpDown from '@pdslng/cio-icon/CioArrowUpDown.svelte'
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioCopy from '@pdslng/cio-icon/CioCopy.svelte'
  import CioDisplay from '@pdslng/cio-icon/CioDisplay.svelte'
  import CioDownload from '@pdslng/cio-icon/CioDownload.svelte'
  import CioEllipsis from '@pdslng/cio-icon/CioEllipsis.svelte'
  import CioFiles from '@pdslng/cio-icon/CioFiles.svelte'
  import CioForward from '@pdslng/cio-icon/CioForward.svelte'
  import CioHistory from '@pdslng/cio-icon/CioHistory.svelte'
  import CioImageOff from '@pdslng/cio-icon/CioImageOff.svelte'
  import CioLayers from '@pdslng/cio-icon/CioLayers.svelte'
  import CioListTree from '@pdslng/cio-icon/CioListTree.svelte'
  import CioMarquee from '@pdslng/cio-icon/CioMarquee.svelte'
  import CioPalette from '@pdslng/cio-icon/CioPalette.svelte'
  import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioStore from '@pdslng/cio-icon/CioStore.svelte'
  import CioTarget from '@pdslng/cio-icon/CioTarget.svelte'
  import CioThreadBrowser from '@pdslng/cio-icon/CioThreadBrowser.svelte'
  import CioMaximize from '@pdslng/cio-icon/CioMaximize.svelte'
  import CioTrash from '@pdslng/cio-icon/CioTrash.svelte'
  import { ICON_SIZE } from '$lib/components/icons/cio/scale'
  import { ContextMenu, DropdownMenu } from 'bits-ui'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import DesignHistoryActions from '$lib/components/design/DesignHistoryActions.svelte'
  import DesignHistoryPanel from '$lib/components/design/DesignHistoryPanel.svelte'
  import CompositionStage from '$lib/components/design/CompositionStage.svelte'
  import FullscreenPanelDialog from '$lib/components/workspace/FullscreenPanelDialog.svelte'
  import VideoEditWorkspace from '$lib/components/design/VideoEditWorkspace.svelte'
  import { usesThreadWorkspaceMount } from '$shared/types'
  import { openInBrowser } from '$lib/open-in-browser'
  import { DESIGN_EXPORT_FORMATS } from '$shared/design/design-export'
  import type { DesignScreenShot } from '$shared/ipc-contract'
  import DesignNavigator from './DesignNavigator.svelte'
  import WorkDetailsDialog from './WorkDetailsDialog.svelte'
  import { SCREEN_ORDERS } from './DesignCoordinatorPanel/DesignCoordinatorPanel-types'
  import { createDesignBoard } from './DesignCoordinatorPanel/DesignCoordinatorPanel-board.svelte'
  import type { Props } from './DesignCoordinatorPanel/DesignCoordinatorPanel-types'

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
        />
      {/key}
    {:else if !board.gallery.playable}
      <div
        class="flex min-h-0 flex-1 flex-col board.gallery.items-center justify-center gap-1.5 border border-border bg-elevated text-dimmed"
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
          <div
            class="flex min-h-0 flex-1 board.gallery.items-center justify-center gap-1.5 text-dimmed"
          >
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
          class="flex shrink-0 board.gallery.items-center justify-between gap-2 border-t border-border px-2 py-1.5"
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
        <button
          type="button"
          class="group relative block w-full overflow-hidden border bg-elevated transition-colors hover:border-primary/60 {onScreen
            ? 'border-accent/60'
            : 'border-border'}"
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
              class="block max-h-44 w-full object-cover object-top"
            />
          {:else}
            <span
              class="flex aspect-[16/10] w-full flex-col board.gallery.items-center justify-center gap-1 text-dimmed"
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
            class="absolute inset-x-0 bottom-0 flex board.gallery.items-center bg-gradient-to-t from-black/60 to-transparent px-1.5 pt-3 pb-1"
          >
            <span class="truncate text-[0.625rem] font-medium text-white">{screen.name}</span>
          </span>
          <span
            class="absolute inset-0 flex board.gallery.items-center justify-center bg-black/35 p-2 opacity-0 transition-opacity group-hover:opacity-100"
          >
            <span class="text-[0.625rem] font-medium text-white"
              >{board.gallery.video
                ? 'Watch full screen in the in-app browser'
                : 'Open in the in-app browser'}</span
            >
          </span>
        </button>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content class="z-50 min-w-44 border border-border bg-surface p-1 shadow-lg">
          <ContextMenu.Item
            class="flex cursor-pointer board.gallery.items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
            onSelect={() =>
              void board.state.copyDesignPath(board.gallery.selected.directory, screen.entry)}
          >
            <CioCopy size={13} class="shrink-0 text-muted" />
            {copyLabel}
          </ContextMenu.Item>
          {#if !board.gallery.video}
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger
                class="flex cursor-pointer board.gallery.items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-[state=open]:bg-elevated"
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
                      class="flex cursor-pointer board.gallery.items-center gap-2 px-2.5 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
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
          class="flex aspect-[16/10] w-full flex-col board.gallery.items-center justify-center gap-1 text-dimmed"
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
        class="absolute inset-x-0 bottom-0 flex board.gallery.items-center gap-1 bg-gradient-to-t from-black/60 to-transparent px-1.5 pt-3 pb-1"
      >
        <Icon size={11} class="shrink-0 text-white/90" aria-hidden="true" />
        <span class="truncate text-[0.625rem] font-medium text-white">{input.name}</span>
      </span>
      {#if input.ready}
        <span
          class="absolute inset-0 flex board.gallery.items-center justify-center bg-black/35 p-2 opacity-0 transition-opacity group-hover:opacity-100"
        >
          <span class="text-[0.625rem] font-medium text-white">Open in the in-app browser</span>
        </span>
      {/if}
    </button>
  {/snippet}

  <header class="shrink-0 border-b border-border">
    <div class="flex board.gallery.items-center gap-1.5 py-1.5 pl-2.5">
      <!--
        The design in front, and the way to the rest of them.

        A project with a dozen designs used to hide them behind a menu list, which
        answers "which one is this" and nothing else. The name now opens the
        navigator: the project's own designs, grouped and foldable, so the board
        can be arranged instead of scrolled. The tab never moves, so the design in
        front is never lost while the user looks for another one.
      -->
      <button
        type="button"
        class="group flex max-w-56 min-w-0 cursor-pointer board.gallery.items-center gap-1 px-1.5 py-0.5 transition-colors hover:bg-elevated {board
          .state.navigatorOpen
          ? 'bg-elevated'
          : ''}"
        title={board.state.navigatorOpen
          ? `Back to the ${board.gallery.noun} in front`
          : `${board.gallery.switchLabel}, currently ${board.gallery.selectedName === '' ? board.studio.nounTitle : board.gallery.selectedName}`}
        aria-label={board.state.navigatorOpen
          ? `Back to the ${board.gallery.noun} in front`
          : `${board.gallery.switchLabel}, currently ${board.gallery.selectedName === '' ? board.studio.nounTitle : board.gallery.selectedName}`}
        aria-expanded={board.state.navigatorOpen}
        onclick={() => (board.state.navigatorOpen = !board.state.navigatorOpen)}
      >
        <board.studio.WorkIcon size={13} class="shrink-0 text-accent" />
        <span
          class="min-w-0 truncate text-xs font-semibold text-foreground"
          title={board.gallery.selected.directory}
        >
          {board.gallery.selectedName === '' ? board.studio.nounTitle : board.gallery.selectedName}
        </span>
        {#if !board.gallery.video && board.studio.designScreens.length > 0}
          <span
            class="shrink-0 border border-border bg-elevated px-1.5 text-[0.625rem] tabular-nums text-muted"
          >
            {board.studio.designScreens.length}
          </span>
        {/if}
        <span class="flex shrink-0 board.gallery.items-center gap-0.5 pl-0.5">
          {#if board.gallery.items.length > 1}
            <span
              class="text-[0.625rem] font-medium text-dimmed transition-colors group-hover:text-foreground"
            >
              {board.gallery.otherCount} more
            </span>
          {/if}
          <CioChevronDown size={10} class="shrink-0 text-dimmed" />
        </span>
      </button>
      {#if board.studio.selectedCreatorThreadId !== '' && board.studio.selectedCreatorThreadId === board.gallery.selectionThreadId}
        <span
          class="shrink-0 bg-accent/15 px-1 text-[0.5625rem] font-semibold tracking-wide text-accent uppercase"
          title="This conversation created this work">Current</span
        >
      {/if}
      <span class="min-w-0 flex-1"></span>
      <span class="flex shrink-0 board.gallery.items-center gap-0.5">
        <!--
          The way to the designs themselves.

          The design in front is only half of what this panel holds: the rest are
          grouped behind a click, and a name that happens to be clickable is not an
          affordance anyone finds. This is the control that says so, and it is
          there whether the project holds one design or fifty.
        -->
        <button
          type="button"
          class="flex h-6 board.gallery.items-center gap-1 px-1.5 text-[0.625rem] transition-colors {board
            .state.navigatorOpen
            ? 'bg-elevated text-foreground'
            : 'text-dimmed hover:bg-elevated hover:text-foreground'}"
          aria-pressed={board.state.navigatorOpen}
          title={board.state.navigatorOpen
            ? `Back to the ${board.gallery.noun} in front`
            : `Designs: group, fold and switch between the ${board.gallery.noun}s of this project`}
          aria-label={board.state.navigatorOpen
            ? `Back to the ${board.gallery.noun} in front`
            : `Designs: group, fold and switch between the ${board.gallery.noun}s of this project`}
          onclick={() => (board.state.navigatorOpen = !board.state.navigatorOpen)}
        >
          <CioListTree size={12} />
          Designs
        </button>
        {#if board.historyActions.historyActions && board.gallery.selected.directory !== '' && !board.gallery.selectedMissing}
          <DesignHistoryActions
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
              class="flex h-6 w-6 board.gallery.items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground"
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
                  onValueChange={board.studio.handleScreenOrderChange}
                  aria-label="Order the screens"
                >
                  {#each SCREEN_ORDERS as order (order)}
                    <DropdownMenu.RadioItem
                      value={order}
                      class="flex w-full cursor-pointer board.gallery.items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
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
          class="flex h-6 w-6 board.gallery.items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
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
            class="flex h-6 w-6 board.gallery.items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground"
            title={`${board.studio.nounTitle} options`}
            aria-label={`${board.studio.nounTitle} options`}
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
                class="flex w-full cursor-pointer board.gallery.items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
                onSelect={board.gallery.refreshBoard}
              >
                <CioRefresh size={13} class="shrink-0 text-muted" />
                {board.studio.refreshLabel}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                class="flex w-full cursor-pointer board.gallery.items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50"
                disabled={board.gallery.selected.directory === '' || board.gallery.selectedMissing}
                onSelect={() => (board.state.historyOpen = !board.state.historyOpen)}
              >
                <CioHistory size={13} class="shrink-0 text-muted" />
                {`${board.studio.nounTitle} history`}
                <CioCheck
                  size={12}
                  class={[
                    'ml-auto shrink-0',
                    board.state.historyOpen ? 'text-primary' : 'invisible'
                  ]}
                  aria-hidden="true"
                />
              </DropdownMenu.Item>
              <DropdownMenu.Item
                class="flex w-full cursor-pointer board.gallery.items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50"
                disabled={!board.studio.canRevealCreator}
                onSelect={() => void board.studio.revealCreator()}
              >
                <CioTarget size={13} class="shrink-0 text-muted" />
                {board.studio.revealLabel}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                class="flex w-full cursor-pointer board.gallery.items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50"
                disabled={board.gallery.selected.directory === ''}
                onSelect={() => void board.state.copyDesignPath(board.gallery.selected.directory)}
              >
                <CioCopy size={13} class="shrink-0 text-muted" />
                Copy path
              </DropdownMenu.Item>
              <DropdownMenu.Item
                class="flex w-full cursor-pointer board.gallery.items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50"
                disabled={board.gallery.selected.directory === ''}
                onSelect={() => void board.state.revealDesignPath(board.gallery.selected.directory)}
              >
                <CioFiles size={13} class="shrink-0 text-muted" />
                Reveal path
              </DropdownMenu.Item>
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger
                  class="flex w-full cursor-pointer board.gallery.items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-[state=open]:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50"
                  disabled={board.gallery.selected.directory === ''}
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
                    {#if board.gallery.video}
                      <DropdownMenu.Item
                        class="flex w-full cursor-pointer board.gallery.items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50"
                        disabled={board.gallery.selected.directory === '' ||
                          board.studio.videoJobs.some((job) => job.state === 'running')}
                        onSelect={() => void board.gallery.exportVideo()}
                      >
                        Export MP4
                      </DropdownMenu.Item>
                    {:else}
                      {#each DESIGN_EXPORT_FORMATS as format (format)}
                        <DropdownMenu.Item
                          class="flex w-full cursor-pointer board.gallery.items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:opacity-50"
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
                  class="flex w-full cursor-pointer board.gallery.items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:opacity-50"
                  disabled={board.gallery.canvasBusy !== '' ||
                    board.gallery.selected.directory === ''}
                  onSelect={() => void board.gallery.requestDesignAction('contract')}
                >
                  <CioPencil size={13} class="shrink-0 text-muted" />
                  Generate DESIGN.md
                </DropdownMenu.Item>
                <DropdownMenu.Sub>
                  <DropdownMenu.SubTrigger
                    class="flex w-full cursor-pointer board.gallery.items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-[state=open]:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50"
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
                        class="flex w-full cursor-pointer board.gallery.items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:opacity-50"
                        disabled={board.gallery.canvasBusy !== '' ||
                          board.gallery.selected.directory === ''}
                        onSelect={() => void board.gallery.requestDesignAction('critique')}
                        ><CioPalette size={13} class="shrink-0 text-muted" />Review design quality</DropdownMenu.Item
                      >
                      <DropdownMenu.Item
                        class="flex w-full cursor-pointer board.gallery.items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:opacity-50"
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
                  class="flex w-full cursor-pointer board.gallery.items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:opacity-50"
                  disabled={board.gallery.canvasBusy !== '' ||
                    board.gallery.selected.directory === ''}
                  onSelect={board.studio.openReferencePrompt}
                  ><CioThreadBrowser size={ICON_SIZE.inline} class="shrink-0 text-muted" />Extract
                  brand from reference</DropdownMenu.Item
                >

                <DropdownMenu.Item
                  class="flex w-full cursor-pointer board.gallery.items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
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
                  class="flex w-full cursor-pointer board.gallery.items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50"
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
                class="flex w-full cursor-pointer board.gallery.items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50"
                disabled={board.gallery.selected.directory === '' || board.gallery.selectedMissing}
                onSelect={() => (board.state.historyOpen = !board.state.historyOpen)}
              >
                <CioHistory size={13} class="shrink-0 text-muted" />
                {board.state.historyOpen ? 'Hide history' : 'Show history'}
              </DropdownMenu.Item>
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger
                  class="flex w-full cursor-pointer board.gallery.items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
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
                      class="flex w-full cursor-pointer board.gallery.items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
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
        <button
          type="button"
          class="ml-0.5 flex h-6 w-6 board.gallery.items-center justify-center bg-primary text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-40"
          disabled={board.gallery.opening ||
            !board.gallery.playable ||
            board.gallery.selected.directory === '' ||
            board.gallery.selectedMissing}
          title={`Expand this ${board.gallery.noun} to full screen`}
          aria-label={`Expand this ${board.gallery.noun} to full screen`}
          onclick={() => void board.gallery.openPreview(board.gallery.selected.entry)}
        >
          {#if board.gallery.opening}
            <CioSpinner size={12} class="animate-spin" />
          {:else}
            <CioMaximize size={ICON_SIZE.inline} />
          {/if}
        </button>
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

    {#if board.state.navigatorOpen}
      <!--
        The navigator replaces the design in front rather than sitting beside it:
        the panel is narrow, and a listing squeezed next to a preview is neither
        readable nor draggable. Picking a design returns the board to it, which is
        the whole gesture.
      -->
      <DesignNavigator
        projectId={board.props.projectId}
        threadId={board.props.threadId}
        kind={board.gallery.requestedKind}
        items={board.gallery.items}
        selectedDirectory={board.gallery.selected.directory}
        onSelect={(directory) => {
          board.gallery.selectDesign(directory)
          board.state.navigatorOpen = false
        }}
      />
    {:else if board.gallery.selectedMissing}
      <div
        class="flex min-h-0 flex-1 flex-col board.gallery.items-center justify-center gap-3 p-4 text-center"
      >
        <CioImageOff size={20} class="text-warning" />
        <p class="text-sm font-medium">{board.studio.nounTitle} not found</p>
        <p class="break-all font-mono text-xs text-muted">{board.gallery.selected.directory}</p>
        <p class="text-xs text-muted">
          Restore the folder and refresh, or remove this entry from the panel.
        </p>
        <button
          type="button"
          class="flex board.gallery.items-center gap-2 border border-danger/40 px-3 py-1.5 text-xs text-danger"
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
      <div class="min-h-0 flex-1 overflow-y-auto py-2 pl-2.5">
        {#if board.gallery.video}
          <div
            class="flex aspect-[16/10] w-full flex-col board.gallery.items-center justify-center gap-1.5 border border-border bg-elevated text-dimmed"
          >
            <CioImageOff size={16} />
            <span class="px-4 text-center text-[0.6875rem]">
              {`The agent has not written a ${board.gallery.noun} yet. It will appear here when it does.`}
            </span>
          </div>
        {:else if board.gallery.gallery.length === 0}
          <div
            class="flex aspect-[16/10] w-full flex-col board.gallery.items-center justify-center gap-1.5 border border-border bg-elevated text-dimmed"
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
        {:else}
          <div class="grid grid-cols-2 gap-1.5" aria-label={board.studio.screensLabel}>
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
            {#each board.studio.screenCards as screen (screen.entry)}
              {@render screenCard(screen, board.gallery.video)}
            {/each}
          </div>
          {#if !board.gallery.video && board.studio.designScreens.length === 0}
            {#if board.studio.galleryBusy}
              <p
                class="mt-2 flex board.gallery.items-center justify-center gap-1.5 text-[0.6875rem] text-dimmed"
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
    {#if board.gallery.selected.directory !== '' && !board.gallery.selectedMissing && !board.state.navigatorOpen}
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
    onSelect={() => {}}
    onMinimize={board.studio.minimizeCompositionEditor}
  >
    {#await import('$lib/components/browser/BrowserPanel.svelte') then { default: BrowserPanel }}
      {#key shownFullscreenTab.id}
        {#if board.studio.compositionPlaybackOnly}
          <BrowserPanel
            tab={shownFullscreenTab}
            fullscreen
            minimizeTitle="Return to the board.gallery.video editor"
            onMinimize={() => (board.studio.compositionPlaybackOnly = false)}
          />
        {:else}
          <VideoEditWorkspace
            projectId={board.props.projectId}
            threadId={board.props.threadId}
            directory={board.gallery.selected.directory}
            tabId={board.gallery.boardTabId}
            active={board.props.active}
            mode="fullscreen"
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
                onExpandVideo={() => (board.studio.compositionPlaybackOnly = true)}
              />
            {/snippet}
          </VideoEditWorkspace>
        {/if}
      {/key}
    {/await}
  </FullscreenPanelDialog>
{/if}
