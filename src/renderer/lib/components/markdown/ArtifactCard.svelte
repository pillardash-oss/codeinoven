<script lang="ts">
  import { Check, Code2, Copy, Expand, Eye } from '@lucide/svelte'
  import { copyText } from '$lib/copy-text'
  import Modal from '../ui/Modal.svelte'
  import CodeBlock from './CodeBlock.svelte'
  import { buildArtifactSrcdoc, type ArtifactKind } from './artifact'

  interface Props {
    code: string
    kind: ArtifactKind
  }

  let { code, kind }: Props = $props()

  let copied = $state(false)
  let expanded = $state(false)
  let showSource = $state(false)
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined

  const label = $derived(kind === 'html' ? 'HTML artifact' : 'SVG artifact')
  const srcdoc = $derived(buildArtifactSrcdoc(kind, code))

  $effect(() => () => clearTimeout(copyResetTimer))

  async function copySource(): Promise<void> {
    try {
      await copyText(code)
      copied = true
      clearTimeout(copyResetTimer)
      copyResetTimer = setTimeout(() => (copied = false), 1500)
    } catch {
      // Clipboard unavailable   the button simply stays idle.
    }
  }
</script>

{#snippet artifactBody(fullscreen = false)}
  {#if showSource && !fullscreen}
    <div class="[&>div]:rounded-none [&>div]:border-0 [&>div]:border-t">
      <CodeBlock {code} lang={kind === 'html' ? 'artifact-html' : 'artifact-svg'} />
    </div>
  {:else}
    <iframe
      title="{label} preview"
      sandbox=""
      {srcdoc}
      class={['block w-full border-0 bg-white', fullscreen ? 'h-full min-h-0' : 'h-80']}
    ></iframe>
  {/if}
{/snippet}

<div class="overflow-hidden rounded-lg border bg-elevated">
  <div class="flex h-8 items-center justify-between border-b px-2">
    <span class="px-1 font-mono text-[0.625rem] uppercase tracking-wide text-dimmed">{label}</span>
    <div class="flex items-center gap-0.5">
      <div
        class="mr-1 flex items-center rounded-md border border-border"
        role="group"
        aria-label="{label} view"
      >
        <button
          type="button"
          class={[
            'rounded-l-md px-2 py-1 text-[0.625rem] font-medium transition-colors',
            !showSource ? 'bg-overlay text-foreground' : 'text-dimmed hover:text-foreground'
          ]}
          aria-pressed={!showSource}
          title="Show rendered {label} preview"
          onclick={() => (showSource = false)}
        >
          <span class="flex items-center gap-1"><Eye size={12} />Preview</span>
        </button>
        <button
          type="button"
          class={[
            'rounded-r-md px-2 py-1 text-[0.625rem] font-medium transition-colors',
            showSource ? 'bg-overlay text-foreground' : 'text-dimmed hover:text-foreground'
          ]}
          aria-pressed={showSource}
          title="Show {label} source"
          onclick={() => (showSource = true)}
        >
          <span class="flex items-center gap-1"><Code2 size={12} />Code</span>
        </button>
      </div>
      <button
        class="rounded p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
        aria-label="Copy {label} source"
        title="Copy {label} source"
        onclick={() => void copySource()}
      >
        {#if copied}
          <Check size={13} class="text-success" />
        {:else}
          <Copy size={13} />
        {/if}
      </button>
      <button
        class="rounded p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
        aria-label="Expand {label}"
        title="Expand {label}"
        onclick={() => (expanded = true)}
      >
        <Expand size={13} />
      </button>
    </div>
  </div>

  {@render artifactBody()}
</div>

<Modal
  open={expanded}
  title={label}
  onClose={() => (expanded = false)}
  size="full"
  fill
  contentClass="flex flex-col overflow-hidden p-0"
>
  <div class="min-h-0 flex-1">
    {@render artifactBody(true)}
  </div>
</Modal>
