<script lang="ts">
  import {
    Check,
    Code2,
    Copy,
    Expand,
    MessageSquarePlus,
    RotateCcw,
    X,
    ZoomIn,
    ZoomOut
  } from '@lucide/svelte'
  import { Dialog } from 'bits-ui'
  import { copyText } from '$lib/copy-text'
  import type { Attachment } from 'svelte/attachments'
  import CodeBlock from './CodeBlock.svelte'
  import { renderMermaid, type MermaidTheme } from './mermaid'

  interface Props {
    code: string
    onAnnotate?: (code: string, event: MouseEvent) => void
  }

  let { code, onAnnotate }: Props = $props()

  const componentId = $props.id()
  const diagramId = `mermaid-${componentId}`
  let copied = $state(false)
  let error = $state<string>()
  let errorDetail = $state<string>()
  let expanded = $state(false)
  let rendering = $state(true)
  let sourceVisible = $state(false)
  let svg = $state('')
  /** Bumped to force the attachment to re-run — an in-place retry after a
   *  transient failure, so the user never has to switch threads to recover. */
  let retryKey = $state(0)
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined

  const MIN_ZOOM = 0.5
  const MAX_ZOOM = 6
  let zoom = $state(1)
  let panX = $state(0)
  let panY = $state(0)
  let isPanning = $state(false)
  let panStart = { x: 0, y: 0, panX: 0, panY: 0 }
  let fullscreenViewport = $state<HTMLDivElement>()
  let fullscreenSvgEl = $state<HTMLDivElement>()

  $effect(() => {
    if (!expanded) {
      zoom = 1
      panX = 0
      panY = 0
    }
  })

  function clampZoom(value: number): number {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value))
  }

  // Anchors zoom on the cursor by measuring the diagram's live (already
  // transformed) rect rather than assuming its untransformed offset —
  // flex-centering can put that offset anywhere, and guessing it caused
  // the anchor point to drift on repeated zoom steps.
  function zoomAt(clientX: number, clientY: number, nextZoom: number): void {
    const rect = fullscreenSvgEl?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) {
      zoom = nextZoom
      return
    }
    const scaleRatio = nextZoom / zoom
    const fracX = (clientX - rect.left) / rect.width
    const fracY = (clientY - rect.top) / rect.height
    const newLeft = clientX - fracX * rect.width * scaleRatio
    const newTop = clientY - fracY * rect.height * scaleRatio
    panX += newLeft - rect.left
    panY += newTop - rect.top
    zoom = nextZoom
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault()
    const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15
    zoomAt(event.clientX, event.clientY, clampZoom(zoom * factor))
  }

  function zoomByButton(factor: number): void {
    const rect = fullscreenViewport?.getBoundingClientRect()
    const center = rect
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : { x: 0, y: 0 }
    zoomAt(center.x, center.y, clampZoom(zoom * factor))
  }

  function resetView(): void {
    zoom = 1
    panX = 0
    panY = 0
  }

  function onPointerDown(event: PointerEvent): void {
    if (zoom === 1) return
    isPanning = true
    panStart = { x: event.clientX, y: event.clientY, panX, panY }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: PointerEvent): void {
    if (!isPanning) return
    panX = panStart.panX + (event.clientX - panStart.x)
    panY = panStart.panY + (event.clientY - panStart.y)
  }

  function onPointerUp(): void {
    isPanning = false
  }

  // The same snippet renders both the inline and fullscreen diagram, so
  // bind:this can't target one instance only — use attachments instead.
  function bindFullscreenViewport(el: HTMLDivElement): () => void {
    fullscreenViewport = el
    return () => {
      if (fullscreenViewport === el) fullscreenViewport = undefined
    }
  }

  function bindFullscreenSvg(el: HTMLDivElement): () => void {
    fullscreenSvgEl = el
    return () => {
      if (fullscreenSvgEl === el) fullscreenSvgEl = undefined
    }
  }

  function cssToken(style: CSSStyleDeclaration, name: string, fallback: string): string {
    return style.getPropertyValue(name).trim() || fallback
  }

  function readTheme(): MermaidTheme {
    const style = getComputedStyle(document.documentElement)
    return {
      app: cssToken(style, '--color-app', '#0b0b0d'),
      border: cssToken(style, '--color-border', '#27272c'),
      borderStrong: cssToken(style, '--color-border-strong', '#3b3b42'),
      elevated: cssToken(style, '--color-elevated', '#1c1c20'),
      foreground: cssToken(style, '--color-foreground', '#f5f4f0'),
      muted: cssToken(style, '--color-muted', '#9d9da6'),
      overlay: cssToken(style, '--color-overlay', '#242429'),
      surface: cssToken(style, '--color-surface', '#141417'),
      fontFamily: cssToken(style, '--font-sans', 'system-ui, sans-serif')
    }
  }

  function renderDiagram(source: string, _retryKey: number): Attachment<HTMLElement> {
    return () => {
      let currentRender = 0
      let disposed = false

      async function update(): Promise<void> {
        const renderNumber = ++currentRender
        rendering = true
        error = undefined
        errorDetail = undefined

        try {
          const nextSvg = await renderMermaid(`${diagramId}-${renderNumber}`, source, readTheme())
          if (disposed || renderNumber !== currentRender) return
          if (nextSvg.trim() === '') throw new Error('Empty diagram output')
          svg = nextSvg
        } catch (reason) {
          if (disposed || renderNumber !== currentRender) return
          // A re-render failure must never destroy an already-rendered
          // diagram — keep the last good SVG on screen.
          if (svg) return
          error = 'This Mermaid diagram could not be rendered.'
          errorDetail = reason instanceof Error ? reason.message : String(reason)
        } finally {
          if (!disposed && renderNumber === currentRender) rendering = false
        }
      }

      void update()
      const themeObserver = new MutationObserver(() => void update())
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class']
      })

      return () => {
        disposed = true
        themeObserver.disconnect()
        clearTimeout(copyResetTimer)
      }
    }
  }

  async function copySource(): Promise<void> {
    try {
      await copyText(code)
      copied = true
      clearTimeout(copyResetTimer)
      copyResetTimer = setTimeout(() => (copied = false), 1500)
    } catch {
      // Clipboard unavailable — the button simply stays idle.
    }
  }
</script>

{#snippet diagramContent(fullscreen = false)}
  <div
    {@attach fullscreen ? bindFullscreenViewport : () => {}}
    class={[
      'relative flex min-h-32 items-center justify-center bg-surface p-4',
      fullscreen ? 'h-full min-h-0 touch-none overflow-hidden' : 'overflow-auto',
      fullscreen && zoom > 1 && (isPanning ? 'cursor-grabbing' : 'cursor-grab')
    ]}
    aria-label="Mermaid diagram"
    role={fullscreen ? 'group' : undefined}
    onwheel={fullscreen && svg ? onWheel : undefined}
    onpointerdown={fullscreen ? onPointerDown : undefined}
    onpointermove={fullscreen ? onPointerMove : undefined}
    onpointerup={fullscreen ? onPointerUp : undefined}
    onpointercancel={fullscreen ? onPointerUp : undefined}
    ondblclick={fullscreen ? resetView : undefined}
  >
    {#if svg}
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- Mermaid SVG is strict-mode rendered and DOMPurify-sanitized -->
      <div
        {@attach fullscreen ? bindFullscreenSvg : () => {}}
        class={['mermaid-svg min-w-full', fullscreen && 'mermaid-svg-fullscreen']}
        style={fullscreen
          ? `transform: translate(${panX}px, ${panY}px) scale(${zoom}); transform-origin: 0 0;`
          : undefined}
      >
        {@html svg}
      </div>
    {:else if rendering}
      <div class="flex items-center gap-2 text-xs text-dimmed" role="status">
        <span class="size-3 animate-spin rounded-full border border-dimmed border-t-transparent"
        ></span>
        Rendering diagram…
      </div>
    {/if}

    {#if rendering && svg}
      <span class="absolute right-3 bottom-3 text-[10px] text-dimmed" role="status">
        Updating…
      </span>
    {/if}

    {#if fullscreen && svg}
      <div
        class="absolute right-3 bottom-3 flex items-center gap-0.5 rounded-lg border bg-elevated/95 p-1 shadow-lg backdrop-blur-sm"
      >
        <button
          type="button"
          class="rounded p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
          aria-label="Zoom out"
          title="Zoom out"
          disabled={zoom <= MIN_ZOOM}
          onclick={() => zoomByButton(1 / 1.4)}
        >
          <ZoomOut size={14} />
        </button>
        <span class="w-10 text-center font-mono text-[10px] text-dimmed">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          class="rounded p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
          aria-label="Zoom in"
          title="Zoom in"
          disabled={zoom >= MAX_ZOOM}
          onclick={() => zoomByButton(1.4)}
        >
          <ZoomIn size={14} />
        </button>
        <div class="mx-0.5 h-4 w-px bg-border/60" aria-hidden="true"></div>
        <button
          type="button"
          class="rounded p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
          aria-label="Reset zoom and pan"
          title="Reset zoom and pan"
          disabled={zoom === 1 && panX === 0 && panY === 0}
          onclick={resetView}
        >
          <RotateCcw size={14} />
        </button>
      </div>
    {/if}
  </div>
{/snippet}

<div
  class="overflow-hidden rounded-lg border bg-elevated"
  {@attach renderDiagram(code.trim(), retryKey)}
>
  <div class="flex h-8 items-center justify-between border-b px-2">
    <span class="px-1 font-mono text-[10px] uppercase tracking-wide text-dimmed">Mermaid</span>
    <div class="flex items-center gap-0.5">
      {#if onAnnotate}
        <button
          class="rounded p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
          aria-label="Annotate Mermaid diagram"
          title="Annotate Mermaid diagram"
          onclick={(event: MouseEvent) => {
            event.stopPropagation()
            onAnnotate(code, event)
          }}
        >
          <MessageSquarePlus size={13} />
        </button>
      {/if}
      <button
        class={[
          'rounded p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground',
          sourceVisible && 'bg-overlay text-foreground'
        ]}
        aria-label={sourceVisible ? 'Hide Mermaid source' : 'Show Mermaid source'}
        title={sourceVisible ? 'Hide Mermaid source' : 'Show Mermaid source'}
        aria-pressed={sourceVisible}
        onclick={() => (sourceVisible = !sourceVisible)}
      >
        <Code2 size={13} />
      </button>
      <button
        class="rounded p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
        aria-label="Copy Mermaid source"
        title="Copy Mermaid source"
        onclick={() => void copySource()}
      >
        {#if copied}
          <Check size={13} class="text-success" />
        {:else}
          <Copy size={13} />
        {/if}
      </button>
      {#if svg}
        <button
          class="rounded p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
          aria-label="Expand Mermaid diagram"
          title="Expand Mermaid diagram"
          onclick={() => (expanded = true)}
        >
          <Expand size={13} />
        </button>
      {/if}
    </div>
  </div>

  {#if error}
    <div class="border-b bg-danger/5 px-3 py-2 text-xs text-danger" role="alert">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p>{error}</p>
          {#if errorDetail}
            <p class="mt-0.5 break-words font-mono text-[10px] text-danger/70" title={errorDetail}>
              {errorDetail.slice(0, 240)}{errorDetail.length > 240 ? '…' : ''}
            </p>
          {/if}
        </div>
        <button
          type="button"
          class="shrink-0 rounded-md border border-danger/30 bg-danger/10 px-2 py-1 text-[10px] font-semibold text-danger transition-colors hover:bg-danger/20"
          title="Try rendering this Mermaid diagram again"
          aria-label="Try rendering this Mermaid diagram again"
          onclick={() => (retryKey += 1)}
        >
          Try again
        </button>
      </div>
    </div>
  {/if}

  {#if !error}
    {@render diagramContent()}
  {/if}

  {#if sourceVisible || error}
    <div class="[&>div]:rounded-none [&>div]:border-0 [&>div]:border-t">
      <CodeBlock {code} lang="mermaid" />
    </div>
  {/if}
</div>

<Dialog.Root bind:open={expanded}>
  <Dialog.Portal>
    <Dialog.Overlay class="titlebar-no-drag fixed inset-0 z-50 bg-overlay/80 backdrop-blur-sm" />
    <Dialog.Content
      class="titlebar-no-drag fixed inset-6 z-50 flex min-h-0 flex-col overflow-hidden rounded-xl border bg-surface shadow-2xl outline-none"
    >
      <div class="flex h-10 shrink-0 items-center justify-between border-b px-3">
        <Dialog.Title class="text-xs font-semibold text-foreground">Mermaid diagram</Dialog.Title>
        <Dialog.Description class="sr-only">
          Expanded view of the generated Mermaid diagram
        </Dialog.Description>
        <Dialog.Close
          class="rounded p-1 text-muted transition-colors hover:bg-overlay hover:text-foreground"
          aria-label="Close expanded Mermaid diagram"
          title="Close expanded Mermaid diagram"
        >
          <X size={15} />
        </Dialog.Close>
      </div>
      <div class="min-h-0 flex-1">
        {@render diagramContent(true)}
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  .mermaid-svg :global(svg) {
    display: block;
    width: 100%;
    min-width: 28rem;
    height: auto;
    max-height: 70vh;
    margin-inline: auto;
  }

  .mermaid-svg-fullscreen :global(svg) {
    max-height: 100%;
  }
</style>
