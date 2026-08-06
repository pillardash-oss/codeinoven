<script lang="ts">
  import { Check, Code2, Copy, Expand, MessageSquarePlus, X } from '@lucide/svelte'
  import { Dialog } from 'bits-ui'
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
  let expanded = $state(false)
  let rendering = $state(true)
  let sourceVisible = $state(false)
  let svg = $state('')
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined

  function cssToken(style: CSSStyleDeclaration, name: string): string {
    return style.getPropertyValue(name).trim()
  }

  function readTheme(): MermaidTheme {
    const style = getComputedStyle(document.documentElement)
    return {
      app: cssToken(style, '--color-app'),
      border: cssToken(style, '--color-border'),
      borderStrong: cssToken(style, '--color-border-strong'),
      elevated: cssToken(style, '--color-elevated'),
      foreground: cssToken(style, '--color-foreground'),
      muted: cssToken(style, '--color-muted'),
      overlay: cssToken(style, '--color-overlay'),
      surface: cssToken(style, '--color-surface'),
      fontFamily: cssToken(style, '--font-sans')
    }
  }

  function renderDiagram(source: string): Attachment<HTMLElement> {
    return () => {
      let currentRender = 0
      let disposed = false

      async function update(): Promise<void> {
        const renderNumber = ++currentRender
        rendering = true
        error = undefined

        try {
          const nextSvg = await renderMermaid(`${diagramId}-${renderNumber}`, source, readTheme())
          if (disposed || renderNumber !== currentRender) return
          svg = nextSvg
        } catch {
          if (disposed || renderNumber !== currentRender) return
          error = 'This Mermaid diagram could not be rendered.'
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
      await navigator.clipboard.writeText(code)
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
    class={[
      'relative flex min-h-32 items-center justify-center overflow-auto bg-surface p-4',
      fullscreen && 'h-full min-h-0'
    ]}
    aria-label="Mermaid diagram"
  >
    {#if svg}
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- Mermaid SVG is strict-mode rendered and DOMPurify-sanitized -->
      <div class="mermaid-svg min-w-full">{@html svg}</div>
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
  </div>
{/snippet}

<div class="overflow-hidden rounded-lg border bg-elevated" {@attach renderDiagram(code.trim())}>
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
    <div class="border-b bg-danger/5 px-3 py-2 text-xs text-danger" role="alert">{error}</div>
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
    <Dialog.Overlay class="fixed inset-0 z-50 bg-overlay/80 backdrop-blur-sm" />
    <Dialog.Content
      class="fixed inset-6 z-50 flex min-h-0 flex-col overflow-hidden rounded-xl border bg-surface shadow-2xl outline-none"
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
</style>
