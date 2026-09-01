<script lang="ts">
  import type { Snippet } from 'svelte'
  import { DropdownMenu } from 'bits-ui'
  import {
    Bell,
    Bot,
    BrainCircuit,
    Bug,
    ChevronDown,
    Cloud,
    FileDiff,
    MonitorCog,
    Files,
    GitBranch,
    Globe2,
    Info,
    Maximize2,
    MessageCircleDashed,
    Network,
    PanelBottom,
    PanelRight,
    Plus,
    SquareTerminal,
    StickyNote,
    X
  } from '@lucide/svelte'
  import type { ContextSidebarTab, TerminalPlacement } from '$lib/stores/context-sidebar.svelte'
  import { agentRuns } from '$lib/stores/agent-runs.svelte'
  import FileTypeIcon from '../files/FileTypeIcon.svelte'
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'

  interface Props {
    tabs: ContextSidebarTab[]
    activeTabId: string | null
    width: number
    height: number
    placement?: TerminalPlacement
    content: Snippet
    onSelect: (id: string) => void
    onClose: (id: string) => void
    onFullscreenTab?: (id: string) => void
    /** Callback for drag-to-reorder; position is relative to the target tab.
     *  Only tabbed kinds render a strip, so this only reorders those. */
    onMoveTab?: (id: string, targetId: string, position: 'before' | 'after') => void
    onWidthChange: (width: number) => void
    onHeightChange: (height: number) => void
    onTerminalPlacementChange: (placement: TerminalPlacement) => void
    /** Fold the bottom terminal dock away. Only wired for the bottom dock; the
     *  right sidebar is closed from the context dock rail instead. */
    onTerminalDockToggle?: () => void
    /** Spawn another shell. The terminal is the only tool that still offers a
     *  "+"; temporary chats are tabbed but are only ever opened from a thread. */
    onNewTerminal?: () => void
    onNewBrowser?: () => void
  }

  let {
    tabs,
    activeTabId,
    width,
    height,
    placement = 'right',
    content,
    onSelect,
    onClose,
    onFullscreenTab,
    onMoveTab,
    onWidthChange,
    onHeightChange,
    onTerminalPlacementChange,
    onTerminalDockToggle,
    onNewTerminal,
    onNewBrowser
  }: Props = $props()

  let resizing = $state(false)
  let activeTab = $derived(tabs.find((tab) => tab.id === activeTabId) ?? null)

  // Every other tool opens from the context dock rail and owns the whole panel,
  // so only these kinds get a tab strip — the rest get a plain titled header.
  // Sub-agents share one panel toggle, so their tabs stay together here rather
  // than competing with the other context tools.
  const TABBED_KINDS = new Set<ContextSidebarTab['kind']>([
    'terminal',
    'browser',
    'temporary-chat',
    'subagent'
  ])

  // These tools are opened and closed from their own rail icon, and each one
  // already owns its full-height content — the generic title-and-close header
  // was a redundant layer stacked on top of a panel that either has its own
  // internal toolbar (files, diff, debugger) or needs no title at all (sources,
  // memory, cloud deployment). Terminal keeps its header because it needs tabs.
  const HEADERLESS_KINDS = new Set<ContextSidebarTab['kind']>([
    'files',
    'diff',
    'sources',
    'memory',
    'cloud-deployment',
    'debugger',
    'notifications',
    'git',
    'actions',
    'thread-note',
    'coordinator'
  ])

  /** Files are headerless like the other single-panel tools right up until a
   *  second file is open — then a real tab strip is the only way back to the
   *  first one, so it earns the same tabbed treatment as terminals. */
  let openFilesCount = $derived(tabs.filter((tab) => tab.kind === 'files').length)
  let tabbedMode = $derived(
    activeTab
      ? TABBED_KINDS.has(activeTab.kind) || (activeTab.kind === 'files' && openFilesCount > 1)
      : false
  )
  let headerless = $derived(activeTab ? HEADERLESS_KINDS.has(activeTab.kind) && !tabbedMode : false)
  /** The strip never mixes tools: it lists siblings of the active kind only. */
  let stripTabs = $derived(
    activeTab && tabbedMode ? tabs.filter((tab) => tab.kind === activeTab.kind) : []
  )
  /** Terminals alone own the placement toggle, fullscreen and the "+". */
  let terminalMode = $derived(activeTab?.kind === 'terminal')
  let browserMode = $derived(activeTab?.kind === 'browser')
  /** Other open panels of the active tool, e.g. several open files. Without a
   *  strip these would be unreachable, so the header offers them in a picker. */
  let siblingTabs = $derived(
    activeTab && !tabbedMode ? tabs.filter((tab) => tab.kind === activeTab.kind) : []
  )
  /** Temporary chats close from their own tab, so they need no header cluster —
   *  rendering it anyway would leave a stray divider on the right edge. */
  let showHeaderControls = $derived(
    terminalMode || browserMode || (activeTab !== null && !tabbedMode)
  )

  let dragTabId = $state<string | null>(null)
  let dropTargetId = $state<string | null>(null)
  let dropPosition = $state<'before' | 'after' | null>(null)
  let stripScroller = $state<HTMLDivElement>()

  // Keep the active tab visible in the strip: whenever the strip mounts or the
  // active tab changes (a link opened a new browser tab, a tab was selected,
  // the workspace came back from fullscreen), scroll it into view horizontally
  // so it is never hidden past the strip's scroll edge. Mirrors the fullscreen
  // dialog strip's behavior.
  $effect(() => {
    const scroller = stripScroller
    if (!scroller || !activeTabId) return
    const activeButton = scroller.querySelector<HTMLElement>('[data-active-tab="true"]')
    activeButton?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  })

  function setDragImage(e: DragEvent, label: string): void {
    const ghost = document.createElement('div')
    ghost.textContent = label
    ghost.style.cssText =
      'position:absolute;top:-1000px;left:-1000px;padding:3px 8px;background:var(--color-surface);border:1px solid var(--color-border);border-radius:6px;font-size:13px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.15)'
    document.body.appendChild(ghost)
    e.dataTransfer!.setDragImage(ghost, 0, 0)
    requestAnimationFrame(() => document.body.removeChild(ghost))
  }

  function handleDragStart(e: DragEvent, tab: ContextSidebarTab): void {
    if (!onMoveTab) return
    dragTabId = tab.id
    e.dataTransfer!.setData('text/plain', tab.id)
    e.dataTransfer!.effectAllowed = 'move'
    setDragImage(e, tab.title)
  }

  function handleDragEnd(): void {
    dragTabId = null
    dropTargetId = null
    dropPosition = null
  }

  function handleDragOver(e: DragEvent, tab: ContextSidebarTab): void {
    if (!onMoveTab || dragTabId === tab.id) return
    e.preventDefault()
    dropTargetId = tab.id
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    dropPosition = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
  }

  function handleDrop(e: DragEvent, tab: ContextSidebarTab): void {
    e.preventDefault()
    const draggedId = e.dataTransfer!.getData('text/plain')
    if (draggedId && draggedId !== tab.id && onMoveTab) {
      onMoveTab(draggedId, tab.id, dropPosition ?? 'after')
    }
    dragTabId = null
    dropTargetId = null
    dropPosition = null
  }

  function startResize(event: PointerEvent): void {
    event.preventDefault()
    resizing = true
    const startX = event.clientX
    const startY = event.clientY
    const startWidth = width
    const startHeight = height

    const onMove = (moveEvent: PointerEvent): void => {
      if (placement === 'bottom') {
        onHeightChange(startHeight + (startY - moveEvent.clientY))
      } else {
        onWidthChange(startWidth + (startX - moveEvent.clientX))
      }
    }
    const onUp = (): void => {
      resizing = false
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
</script>

<aside
  class="relative flex h-full min-h-0 w-full min-w-0 flex-col border-border bg-surface {placement ===
  'bottom'
    ? 'border-t'
    : 'border-l'}"
  class:select-none={resizing}
  aria-label="Context sidebar"
  data-region="context-sidebar"
  data-placement={placement}
>
  <div
    class="absolute z-10 transition-colors hover:bg-primary/20 {placement === 'bottom'
      ? 'inset-x-0 top-0 h-1.5 cursor-row-resize'
      : 'inset-y-0 left-0 w-1.5 cursor-col-resize'} {resizing ? 'bg-primary/30' : ''}"
    role="separator"
    aria-label="Resize context sidebar"
    aria-orientation={placement === 'bottom' ? 'horizontal' : 'vertical'}
    onpointerdown={startResize}
  ></div>

  {#snippet tabIcon(tab: ContextSidebarTab)}
    {#if tab.kind === 'files'}
      {#if tab.fileTabId}
        <FileTypeIcon path={tab.path ?? tab.title} size={12} />
      {:else}
        <Files size={12} class="shrink-0" />
      {/if}
    {:else if tab.kind === 'diff'}
      <FileDiff size={12} class="shrink-0" />
    {:else if tab.kind === 'terminal'}
      <SquareTerminal size={12} class="shrink-0" />
    {:else if tab.kind === 'actions'}
      <MonitorCog size={12} class="shrink-0" />
    {:else if tab.kind === 'browser'}
      <Globe2 size={12} class="shrink-0" />
    {:else if tab.kind === 'debugger'}
      <Bug size={12} class="shrink-0 text-accent" />
    {:else if tab.kind === 'sources'}
      <Info size={12} class="shrink-0" />
    {:else if tab.kind === 'temporary-chat'}
      <MessageCircleDashed size={12} class="shrink-0 text-info" />
    {:else if tab.kind === 'notifications'}
      <Bell size={12} class="shrink-0" />
    {:else if tab.kind === 'memory'}
      <BrainCircuit size={12} class="shrink-0" />
    {:else if tab.kind === 'git'}
      <GitBranch size={12} class="shrink-0" />
    {:else if tab.kind === 'cloud-deployment'}
      <Cloud size={12} class="shrink-0" />
    {:else if tab.kind === 'thread-note'}
      <StickyNote size={12} class="shrink-0" />
    {:else if tab.kind === 'coordinator'}
      <Network size={12} class="shrink-0 text-primary" />
    {:else}
      <Bot size={12} class="shrink-0 text-info" />
    {/if}
  {/snippet}

  {#if !headerless}
    <div class="flex h-10 shrink-0 items-center border-b border-border">
      {#if tabbedMode}
        <div class="min-w-0 flex-1 overflow-x-auto" bind:this={stripScroller}>
          <div class="flex h-10 min-w-max items-stretch">
            {#each stripTabs as tab (tab.id)}
              <div
                class="group relative flex max-w-52 items-center border-r border-border {activeTabId ===
                tab.id
                  ? 'bg-app text-foreground'
                  : 'text-muted hover:bg-elevated hover:text-foreground'} {onMoveTab
                  ? 'cursor-grab active:cursor-grabbing'
                  : ''}"
                draggable={onMoveTab ? 'true' : 'false'}
                role="listitem"
                ondragstart={(e: DragEvent) => handleDragStart(e, tab)}
                ondragend={handleDragEnd}
                ondragover={(e: DragEvent) => handleDragOver(e, tab)}
                ondrop={(e: DragEvent) => handleDrop(e, tab)}
                ondragleave={() => {
                  if (dropTargetId === tab.id) {
                    dropTargetId = null
                    dropPosition = null
                  }
                }}
              >
                <div
                  class="pointer-events-none absolute left-0 top-0 bottom-0 w-[2px] transition-opacity duration-100 {dropTargetId ===
                    tab.id && dropPosition === 'before'
                    ? 'bg-primary opacity-100'
                    : 'opacity-0'}"
                ></div>
                <div
                  class="pointer-events-none absolute right-0 top-0 bottom-0 w-[2px] transition-opacity duration-100 {dropTargetId ===
                    tab.id && dropPosition === 'after'
                    ? 'bg-primary opacity-100'
                    : 'opacity-0'}"
                ></div>
                <button
                  type="button"
                  class="flex min-w-0 flex-1 items-center gap-1.5 py-2 pl-3 text-left"
                  aria-current={activeTabId === tab.id ? 'page' : undefined}
                  data-active-tab={activeTabId === tab.id ? 'true' : undefined}
                  title={tab.title}
                  onclick={() => onSelect(tab.id)}
                >
                  {@render tabIcon(tab)}
                  <span
                    class="truncate text-[11px] font-medium {tab.kind === 'files' && tab.preview
                      ? 'italic'
                      : ''}">{tab.title}</span
                  >
                  {#if tab.kind === 'temporary-chat' && agentRuns.isBusy(tab.projectId, tab.temporaryChatId)}
                    <StatusBadge stage="working" animated title="Working" />
                  {/if}
                </button>
                <button
                  type="button"
                  class="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-dimmed opacity-70 transition-colors hover:bg-raised hover:text-foreground group-hover:opacity-100"
                  aria-label={`Close ${tab.title}`}
                  title={`Close ${tab.title}`}
                  onclick={() => onClose(tab.id)}
                >
                  <X size={11} />
                </button>
              </div>
            {/each}
          </div>
        </div>
      {:else if activeTab}
        <div class="flex min-w-0 flex-1 items-center gap-1.5 py-2 pl-3 text-foreground">
          {@render tabIcon(activeTab)}
          <span
            class="truncate text-[11px] font-medium {activeTab.kind === 'files' && activeTab.preview
              ? 'italic'
              : ''}"
          >
            {activeTab.title}
          </span>
          {#if activeTab.kind === 'subagent' && activeTab.activity.status === 'running'}
            <StatusBadge stage="working" animated title="Running" />
          {/if}
          {#if siblingTabs.length > 1}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger
                class="flex h-6 shrink-0 items-center gap-0.5 rounded px-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                aria-label="Switch to another open panel"
                title="Switch open panel"
              >
                <span class="text-[10px] font-medium">{siblingTabs.length}</span>
                <ChevronDown size={11} />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  side="bottom"
                  align="start"
                  sideOffset={6}
                  class="z-50 min-w-52 rounded-lg border border-border bg-surface p-1 shadow-lg"
                >
                  {#each siblingTabs as tab (tab.id)}
                    <DropdownMenu.Item
                      class="flex items-center gap-2 rounded-md px-2.5 py-1.5 outline-none transition-colors data-[highlighted]:bg-elevated"
                      textValue={tab.title}
                      onSelect={() => onSelect(tab.id)}
                    >
                      {@render tabIcon(tab)}
                      <span class="min-w-0 flex-1 truncate text-xs text-foreground"
                        >{tab.title}</span
                      >
                      {#if tab.id === activeTabId}
                        <span class="text-[10px] text-dimmed">open</span>
                      {/if}
                    </DropdownMenu.Item>
                  {/each}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          {/if}
        </div>
      {/if}

      {#if showHeaderControls}
        <div class="flex shrink-0 items-center border-l border-border px-1">
          {#if browserMode}
            {#if onNewBrowser}
              <button
                type="button"
                class="flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                aria-label="Open another browser tab"
                title="New browser tab"
                onclick={onNewBrowser}
              >
                <Plus size={13} />
              </button>
            {/if}
            <button
              type="button"
              class="flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
              aria-label="Fullscreen"
              title="Fullscreen"
              onclick={() => activeTabId && onFullscreenTab?.(activeTabId)}
            >
              <Maximize2 size={13} />
            </button>
          {:else if terminalMode}
            {#if onNewTerminal}
              <button
                type="button"
                class="flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                aria-label="Open another terminal"
                title="New terminal"
                onclick={onNewTerminal}
              >
                <Plus size={13} />
              </button>
            {/if}
            {#if placement === 'bottom' && onTerminalDockToggle}
              <button
                type="button"
                class="flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                aria-label="Hide terminal dock"
                title="Hide terminal dock"
                onclick={onTerminalDockToggle}
              >
                <ChevronDown size={13} />
              </button>
            {/if}
            <button
              type="button"
              class="flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
              aria-label="Fullscreen"
              title="Fullscreen"
              onclick={() => activeTabId && onFullscreenTab?.(activeTabId)}
            >
              <Maximize2 size={13} />
            </button>
            <button
              type="button"
              class="flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
              aria-label={placement === 'bottom'
                ? 'Move terminal to the right'
                : 'Move terminal to the bottom'}
              title={placement === 'bottom'
                ? 'Move terminal to the right'
                : 'Move terminal to the bottom'}
              onclick={() => onTerminalPlacementChange(placement === 'bottom' ? 'right' : 'bottom')}
            >
              {#if placement === 'bottom'}
                <PanelRight size={13} />
              {:else}
                <PanelBottom size={13} />
              {/if}
            </button>
          {:else if activeTab}
            <button
              type="button"
              class="flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
              aria-label={`Close ${activeTab.title}`}
              title="Close panel"
              onclick={() => onClose(activeTab.id)}
            >
              <X size={13} />
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  <div class="min-h-0 flex-1 overflow-hidden">
    {#if tabs.length === 0}
      <div class="flex h-full items-center justify-center px-6">
        <p
          class="max-w-64 text-center text-[10px] font-semibold uppercase tracking-[0.14em] text-dimmed"
        >
          Nothing open
        </p>
      </div>
    {:else}
      {@render content()}
    {/if}
  </div>
</aside>
