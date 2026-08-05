<script lang="ts">
  import type { Snippet } from 'svelte'
  import { DropdownMenu } from 'bits-ui'
  import {
    Bell,
    Bot,
    BrainCircuit,
    Bug,
    FileDiff,
    Files,
    Info,
    Maximize2,
    MessageCircleDashed,
    PanelBottom,
    PanelRight,
    Plus,
    SquareTerminal,
    X
  } from '@lucide/svelte'
  import type { ContextSidebarTab, TerminalPlacement } from '$lib/stores/context-sidebar.svelte'
  import FileTypeIcon from '../files/FileTypeIcon.svelte'
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'

  interface SidebarAction {
    id: string
    label: string
    description: string
    onSelect: () => void
  }

  const FULLSCREEN_KINDS = new Set(['terminal'])

  interface Props {
    tabs: ContextSidebarTab[]
    activeTabId: string | null
    width: number
    height: number
    placement?: TerminalPlacement
    content: Snippet
    actions: SidebarAction[]
    onSelect: (id: string) => void
    onClose: (id: string) => void
    onFullscreenTab?: (id: string) => void
    /** Callback for drag-to-reorder; position is relative to the target tab. */
    onMoveTab?: (id: string, targetId: string, position: 'before' | 'after') => void
    onWidthChange: (width: number) => void
    onHeightChange: (height: number) => void
    onTerminalPlacementChange: (placement: TerminalPlacement) => void
  }

  let {
    tabs,
    activeTabId,
    width,
    height,
    placement = 'right',
    content,
    actions,
    onSelect,
    onClose,
    onFullscreenTab,
    onMoveTab,
    onWidthChange,
    onHeightChange,
    onTerminalPlacementChange
  }: Props = $props()

  let resizing = $state(false)
  let activeTab = $derived(tabs.find((tab) => tab.id === activeTabId) ?? null)

  let dragTabId = $state<string | null>(null)
  let dropTargetId = $state<string | null>(null)
  let dropPosition = $state<'before' | 'after' | null>(null)

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

  <div class="flex h-10 shrink-0 items-center border-b border-border">
    <div class="min-w-0 flex-1 overflow-x-auto">
      <div class="flex h-10 min-w-max items-stretch">
        {#each tabs as tab (tab.id)}
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
              title={tab.title}
              onclick={() => onSelect(tab.id)}
            >
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
              {:else}
                <Bot size={12} class="shrink-0 text-info" />
              {/if}
              <span
                class="truncate text-[11px] font-medium {tab.kind === 'files' && tab.preview
                  ? 'italic'
                  : ''}"
              >
                {tab.title}
              </span>
              {#if tab.kind === 'subagent' && tab.activity.status === 'running'}
                <StatusBadge stage="working" animated title="Running" />
              {/if}
            </button>
            {#if FULLSCREEN_KINDS.has(tab.kind) && onFullscreenTab}
              <button
                type="button"
                class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-dimmed opacity-70 transition-colors hover:bg-raised hover:text-foreground group-hover:opacity-100"
                aria-label={`Fullscreen ${tab.title}`}
                title="Fullscreen"
                onclick={() => onFullscreenTab(tab.id)}
              >
                <Maximize2 size={11} />
              </button>
            {/if}
            <button
              type="button"
              class="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-dimmed opacity-70 transition-colors hover:bg-raised hover:text-foreground group-hover:opacity-100"
              aria-label={`Close ${tab.title}`}
              title="Close tab"
              onclick={() => onClose(tab.id)}
            >
              <X size={11} />
            </button>
          </div>
        {/each}
      </div>
    </div>

    <div class="flex shrink-0 items-center border-l border-border px-1">
      {#if activeTab?.kind === 'terminal'}
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
      {/if}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          class="flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          aria-label="Add sidebar tab"
          title="Add tab"
          disabled={actions.length === 0}
        >
          <Plus size={13} />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side="bottom"
            align="end"
            sideOffset={6}
            class="z-50 min-w-48 rounded-lg border border-border bg-surface p-1 shadow-lg"
          >
            {#each actions as action (action.id)}
              <DropdownMenu.Item
                class="flex items-center gap-2 rounded-md px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-elevated"
                textValue={action.label}
                onSelect={action.onSelect}
              >
                {#if action.id === 'files'}
                  <Files size={14} class="shrink-0 text-muted" />
                {:else if action.id === 'diff'}
                  <FileDiff size={14} class="shrink-0 text-muted" />
                {:else if action.id === 'terminal'}
                  <SquareTerminal size={14} class="shrink-0 text-muted" />
                {:else if action.id === 'debugger'}
                  <Bug size={14} class="shrink-0 text-muted" />
                {:else if action.id === 'sources'}
                  <Info size={14} class="shrink-0 text-muted" />
                {/if}
                <span class="min-w-0">
                  <span class="block text-xs font-medium text-foreground">
                    {action.label}
                  </span>
                  <span class="block text-[10px] text-dimmed">
                    {action.description}
                  </span>
                </span>
              </DropdownMenu.Item>
            {/each}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  </div>

  <div class="min-h-0 flex-1 overflow-hidden">
    {#if tabs.length === 0}
      <div class="flex h-full items-center justify-center px-6">
        <div class="w-full max-w-64">
          <p
            class="mb-3 text-center text-[10px] font-semibold uppercase tracking-[0.14em] text-dimmed"
          >
            Open in sidebar
          </p>
          <div class="grid gap-2">
            {#each actions as action (action.id)}
              <button
                type="button"
                class="flex min-h-10 w-full items-center gap-3 rounded-lg border border-border bg-elevated px-3 py-2.5 text-left transition-colors hover:bg-overlay"
                onclick={action.onSelect}
              >
                <span
                  class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-raised text-muted"
                >
                  {#if action.id === 'files'}
                    <Files size={14} />
                  {:else if action.id === 'diff'}
                    <FileDiff size={14} />
                  {:else if action.id === 'terminal'}
                    <SquareTerminal size={14} />
                  {:else if action.id === 'debugger'}
                    <Bug size={14} />
                  {:else if action.id === 'sources'}
                    <Info size={14} />
                  {/if}
                </span>
                <span class="min-w-0">
                  <span class="block text-xs font-medium text-foreground">
                    {action.label}
                  </span>
                  <span class="block text-[10px] text-dimmed">
                    {action.description}
                  </span>
                </span>
              </button>
            {/each}
          </div>
        </div>
      </div>
    {:else}
      {@render content()}
    {/if}
  </div>
</aside>
