<script lang="ts">
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioCode from '@pdslng/cio-icon/CioCode.svelte'
  import CioCopy from '@pdslng/cio-icon/CioCopy.svelte'
  import CioMaximize from '@pdslng/cio-icon/CioMaximize.svelte'
  import CioMessagePlus from '@pdslng/cio-icon/CioMessagePlus.svelte'
  import { copyText } from '$lib/copy-text'
  import type { Attachment } from 'svelte/attachments'
  import { PanZoom } from '$lib/pan-zoom.svelte'
  import Modal from '../ui/Modal.svelte'
  import PanZoomToolbar from '../ui/PanZoomToolbar.svelte'
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
  /** Bumped to force the attachment to re-run   an in-place retry after a
   *  transient failure, so the user never has to switch threads to recover. */
  let retryKey = $state(0)
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined

  const panZoom = new PanZoom()
  let fullscreenViewport = $state<HTMLDivElement>()

  // The same snippet renders both the inline and fullscreen diagram, so
  // bind:this can't target one instance only   use an attachment instead.
  function bindFullscreenViewport(el: HTMLDivElement): () => void {
    fullscreenViewport = el
    return () => {
      if (fullscreenViewport === el) fullscreenViewport = undefined
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
      const controller = new AbortController()
      let currentRender = 0
      let disposed = false

      async function update(): Promise<void> {
        const renderNumber = ++currentRender
        rendering = true
        error = undefined
        errorDetail = undefined

        try {
          const nextSvg = await renderMermaid(
            `${diagramId}-${renderNumber}`,
            source,
            readTheme(),
            controller.signal
          )
          if (disposed || renderNumber !== currentRender) return
          if (nextSvg.trim() === '') throw new Error('Empty diagram output')
          svg = nextSvg
        } catch (reason) {
          if (disposed || renderNumber !== currentRender) return
          // A re-render failure must never destroy an already-rendered
          // diagram   keep the last good SVG on screen.
          if (svg) return
          error = 'This Mermaid diagram could not be rendered.'
          errorDetail = reason instanceof Error ? reason.message : String(reason)
        } finally {
          if (!disposed && renderNumber === currentRender) rendering = false
        }
      }

      void update()

      return () => {
        disposed = true
        controller.abort()
        clearTimeout(copyResetTimer)
      }
    }
  }

  async function copySource(): Promise<void> {
    try {
      await copyText(code, null)
      copied = true
      clearTimeout(copyResetTimer)
      copyResetTimer = setTimeout(() => (copied = false), 1500)
    } catch {
      // Clipboard unavailable   the button simply stays idle.
    }
  }
</script>

{#snippet diagramContent(fullscreen = false)}
  <div
    {@attach fullscreen ? bindFullscreenViewport : () => {}}
    class={[
      'relative flex min-h-32 items-center justify-center p-4',
      fullscreen ? 'h-full min-h-0 touch-none overflow-hidden' : 'overflow-auto',
      fullscreen && panZoom.zoom > 1 && (panZoom.isPanning ? 'cursor-grabbing' : 'cursor-grab')
    ]}
    aria-label="Mermaid diagram"
    role={fullscreen ? 'group' : undefined}
    onwheel={fullscreen && svg ? panZoom.onWheel : undefined}
    onpointerdown={fullscreen ? panZoom.onPointerDown : undefined}
    onpointermove={fullscreen ? panZoom.onPointerMove : undefined}
    onpointerup={fullscreen ? panZoom.onPointerUp : undefined}
    onpointercancel={fullscreen ? panZoom.onPointerUp : undefined}
    ondblclick={fullscreen ? () => panZoom.reset() : undefined}
  >
    {#if svg}
      <div
        {@attach fullscreen ? panZoom.bindTarget : () => {}}
        class={['mermaid-svg min-w-full', fullscreen && 'mermaid-svg-fullscreen']}
        style={fullscreen ? panZoom.transform : undefined}
      >
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- Pele SVG is DOMPurify-sanitized -->
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
      <span class="absolute right-3 bottom-3 text-[0.625rem] text-dimmed" role="status">
        Updating…
      </span>
    {/if}

    {#if fullscreen && svg}
      <PanZoomToolbar {panZoom} viewport={fullscreenViewport} class="absolute right-3 bottom-3" />
    {/if}
  </div>
{/snippet}

{#snippet diagramControls(withExpand: boolean, withSource = true)}
  {#if onAnnotate}
    <button
      class="p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
      aria-label="Annotate Mermaid diagram"
      title="Annotate Mermaid diagram"
      onclick={(event: MouseEvent) => {
        event.stopPropagation()
        onAnnotate(code, event)
      }}
    >
      <CioMessagePlus size={13} />
    </button>
  {/if}
  {#if withSource}
    <button
      class={[
        'p-1 transition-colors hover:bg-overlay hover:text-foreground',
        sourceVisible ? 'bg-overlay text-foreground' : 'text-dimmed'
      ]}
      aria-label={sourceVisible ? 'Hide Mermaid source' : 'Show Mermaid source'}
      title={sourceVisible ? 'Hide Mermaid source' : 'Show Mermaid source'}
      aria-pressed={sourceVisible}
      onclick={() => (sourceVisible = !sourceVisible)}
    >
      <CioCode size={13} />
    </button>
  {/if}
  <button
    class="p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
    aria-label="Copy Mermaid source"
    title="Copy Mermaid source"
    onclick={() => void copySource()}
  >
    {#if copied}
      <CioCheck size={13} class="text-success" />
    {:else}
      <CioCopy size={13} />
    {/if}
  </button>
  {#if withExpand && svg}
    <button
      class="p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
      aria-label="Expand Mermaid diagram"
      title="Expand Mermaid diagram"
      onclick={() => (expanded = true)}
    >
      <CioMaximize size={13} />
    </button>
  {/if}
{/snippet}

<!-- The reader's controls, in the header of the reading surface. The diagram
     itself carries no chrome: hovering it is not a mode change in a full screen
     reader, the tools sit where the surface's own tools sit. -->
{#snippet fullscreenActions()}
  <div
    class="flex items-center gap-0.5 border border-border bg-elevated p-0.5"
    role="group"
    aria-label="Mermaid diagram controls"
  >
    {@render diagramControls(false, false)}
  </div>
{/snippet}

<!-- The diagram is content of the message rather than a boxed widget beside it:
     no frame around it, no fixed height, and a control strip that appears while
     the diagram is under the pointer or holding focus. -->
<div class="group/mermaid relative" {@attach renderDiagram(code.trim(), retryKey)}>
  <div
    class="pointer-events-none absolute top-1 right-1 z-20 flex items-center gap-0.5 border border-border bg-surface p-1 opacity-0 shadow-lg transition-opacity duration-150 group-hover/mermaid:pointer-events-auto group-hover/mermaid:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100"
    role="group"
    aria-label="Mermaid diagram controls"
  >
    {@render diagramControls(true)}
  </div>

  {#if error}
    <div class="border-b bg-danger/5 px-3 py-2 text-xs text-danger" role="alert">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p>{error}</p>
          {#if errorDetail}
            <p
              class="mt-0.5 break-words font-mono text-[0.625rem] text-danger/70"
              title={errorDetail}
            >
              {errorDetail.slice(0, 240)}{errorDetail.length > 240 ? '…' : ''}
            </p>
          {/if}
        </div>
        <button
          type="button"
          class="shrink-0 border border-danger/30 bg-danger/10 px-2 py-1 text-[0.625rem] font-semibold text-danger transition-colors hover:bg-danger/20"
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
    <div class="[&>div]:border-0 [&>div]:border-t">
      <CodeBlock {code} lang="mermaid" />
    </div>
  {/if}
</div>

<Modal
  open={expanded}
  title="Mermaid diagram"
  onClose={() => {
    expanded = false
    panZoom.reset()
  }}
  placement="fullscreen"
  panelClass="bg-surface"
  contentClass="flex flex-col overflow-hidden p-0"
  headerActions={fullscreenActions}
>
  <div class="relative min-h-0 flex-1">
    {@render diagramContent(true)}
  </div>
</Modal>

<style>
  .mermaid-svg {
    --pele-bg: var(--color-app);
    --pele-fg: var(--color-foreground);
    --pele-muted: var(--color-muted);
    --pele-line: var(--color-muted);
    --pele-surface: var(--color-surface);
    --pele-surface-alt: var(--color-elevated);
    --pele-border: var(--color-border-strong);
    --pele-accent: var(--color-primary);
    --pele-font: var(--font-app);
    --pele-font-mono: var(--font-mono);
    --pele-radius: 0;
  }

  .mermaid-svg :global(svg) {
    display: block;
    max-width: 100%;
    height: auto;
    margin-inline: auto;
  }

  .mermaid-svg-fullscreen :global(svg) {
    max-height: 100%;
  }
</style>
