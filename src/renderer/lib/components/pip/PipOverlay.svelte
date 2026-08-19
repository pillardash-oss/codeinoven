<script lang="ts">
  import { MousePointer2, X, PictureInPicture2 } from '@lucide/svelte'
  import { onMount } from 'svelte'
  import { pipState } from '$lib/stores/pip.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'

  const DEFAULT_POSITION = { x: 24, y: 24 }
  let position = $state({ ...DEFAULT_POSITION })
  let dragging = $state(false)
  let dragStart = $state({ x: 0, y: 0 })
  let dragOrigin = $state({ x: 0, y: 0 })
  let windowSize = $state({ width: 0, height: 0 })
  let overlayElement = $state<HTMLDivElement | undefined>()
  let userMoved = $state(false)

  const isThreadView = $derived(
    rendererRecovery.activeView === 'projects' ||
      rendererRecovery.activeView === 'chats' ||
      rendererRecovery.activeView === 'threads'
  )

  const visible = $derived(
    pipState.active &&
      pipState.frameDataUrl !== null &&
      isThreadView &&
      pipState.threadId !== null &&
      pipState.threadId === workspaceState.selectedThread?.id
  )

  const PREVIEW_WIDTH = 224
  const PREVIEW_HEIGHT = 144
  const cursorPosition = $derived.by(() => {
    if (!pipState.cursorVisible || pipState.frameWidth <= 0 || pipState.frameHeight <= 0) {
      return null
    }
    const scale = Math.min(
      PREVIEW_WIDTH / pipState.frameWidth,
      PREVIEW_HEIGHT / pipState.frameHeight
    )
    const renderedWidth = pipState.frameWidth * scale
    const renderedHeight = pipState.frameHeight * scale
    return {
      left: (PREVIEW_WIDTH - renderedWidth) / 2 + pipState.cursorX * scale,
      top: (PREVIEW_HEIGHT - renderedHeight) / 2 + pipState.cursorY * scale
    }
  })

  /** Anchor the overlay to the bottom-right corner on first appearance. */
  function anchorOverlay(node: HTMLDivElement): () => void {
    overlayElement = node
    if (!userMoved) {
      const rect = node.getBoundingClientRect()
      position = {
        x: Math.max(0, window.innerWidth - rect.width - 24),
        y: Math.max(0, window.innerHeight - rect.height - 24)
      }
    }
    return () => {
      if (overlayElement === node) overlayElement = undefined
    }
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return
    dragging = true
    dragStart = { x: event.clientX, y: event.clientY }
    dragOrigin = { ...position }
    if (overlayElement) {
      const rect = overlayElement.getBoundingClientRect()
      windowSize = { width: rect.width, height: rect.height }
    }
    const target = event.currentTarget
    if (target instanceof HTMLElement) target.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging) return
    userMoved = true
    const dx = event.clientX - dragStart.x
    const dy = event.clientY - dragStart.y
    const maxX = Math.max(0, window.innerWidth - windowSize.width)
    const maxY = Math.max(0, window.innerHeight - windowSize.height)
    position = {
      x: Math.min(Math.max(0, dragOrigin.x + dx), maxX),
      y: Math.min(Math.max(0, dragOrigin.y + dy), maxY)
    }
  }

  function onPointerUp(event: PointerEvent): void {
    if (!dragging) return
    dragging = false
    const target = event.currentTarget
    if (target instanceof HTMLElement && target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId)
    }
  }

  onMount(() => {
    pipState.init()
    return () => pipState.destroy()
  })
</script>

{#if visible}
  <div
    {@attach anchorOverlay}
    class="fixed z-50 select-none rounded-xl border bg-surface shadow-2xl"
    style="left: {position.x}px; top: {position.y}px;"
    role="group"
    aria-label="Computer-use preview for {pipState.appName}"
  >
    <div
      role="group"
      aria-label="Computer-use preview controls"
      class="flex cursor-grab items-center justify-between gap-2 border-b px-2 py-1.5"
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      class:cursor-grabbing={dragging}
      title="Drag to move · click preview to bring the app to the front"
    >
      <span class="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground">
        <PictureInPicture2 size={13} class="shrink-0 text-accent" />
        <span class="truncate">{pipState.appName}</span>
      </span>
      <button
        type="button"
        class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title="Close computer-use preview"
        aria-label="Close computer-use preview"
        onclick={() => void pipState.dismiss()}
      >
        <X size={13} />
      </button>
    </div>

    <button
      type="button"
      class="block w-full p-1.5"
      title="Bring {pipState.appName} to the front"
      aria-label="Bring {pipState.appName} to the front"
      onclick={() => void pipState.bringToFront()}
    >
      <div class="relative h-36 w-56 overflow-hidden rounded-md border border-border bg-app">
        <img
          src={pipState.frameDataUrl}
          alt="Live preview of {pipState.appName}"
          class="h-full w-full object-contain"
          draggable="false"
        />
        {#if cursorPosition}
          <MousePointer2
            size={18}
            strokeWidth={2.5}
            class="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 text-accent drop-shadow-md"
            style="left: {cursorPosition.left}px; top: {cursorPosition.top}px;"
            aria-hidden="true"
          />
        {/if}
      </div>
    </button>
  </div>
{/if}
