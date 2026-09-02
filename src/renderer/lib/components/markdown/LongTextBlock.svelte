<script lang="ts">
  import { Check, ChevronDown, ChevronUp, Copy } from '@lucide/svelte'
  import { copyText } from '$lib/copy-text'

  interface Props {
    /** A single unbroken run of text that exceeds the markdown long-line
     *  limit. Rendered collapsed by default so neither the markdown parser,
     *  DOMPurify, nor layout ever pay for the full length until asked. */
    text: string
  }

  let { text }: Props = $props()

  /** Characters shown when collapsed — enough context to recognize the run. */
  const COLLAPSED_CHARS = 1_200
  const EXPANDED_MAX_HEIGHT = '18rem'

  let expanded = $state(false)
  let copied = $state(false)
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined

  const head = $derived(text.length > COLLAPSED_CHARS ? text.slice(0, COLLAPSED_CHARS) : text)
  /** 0 when the whole run already fits the collapsed head. */
  const hiddenCount = $derived(text.length - head.length)

  $effect(() => () => clearTimeout(copyResetTimer))

  async function copy(): Promise<void> {
    try {
      await copyText(text)
      copied = true
      clearTimeout(copyResetTimer)
      copyResetTimer = setTimeout(() => (copied = false), 1500)
    } catch {
      // Clipboard unavailable — the button simply stays idle.
    }
  }
</script>

<div class="overflow-hidden rounded-lg border bg-elevated" data-long-text-block={text.length}>
  <div class="flex h-7 items-center justify-between border-b px-3">
    <span class="font-mono text-[10px] uppercase tracking-wide text-dimmed">
      long text · {text.length.toLocaleString()} chars
    </span>
    <div class="flex items-center gap-1">
      <button
        class="flex items-center rounded p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
        aria-label={expanded ? 'Collapse long text' : 'Expand long text'}
        title={expanded ? 'Collapse long text' : 'Expand long text'}
        onclick={() => (expanded = !expanded)}
      >
        {#if expanded}
          <ChevronUp size={12} />
        {:else}
          <ChevronDown size={12} />
        {/if}
      </button>
      <button
        class="flex items-center rounded p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
        aria-label="Copy text"
        title="Copy text"
        onclick={() => void copy()}
      >
        {#if copied}
          <Check size={12} class="text-success" />
        {:else}
          <Copy size={12} />
        {/if}
      </button>
    </div>
  </div>
  {#if expanded}
    <pre
      class="overflow-auto px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-foreground"
      style:max-height={EXPANDED_MAX_HEIGHT}>{text}</pre>
  {:else}
    <p class="px-3 py-2 font-mono text-xs leading-relaxed break-all text-foreground">{head}</p>
    {#if hiddenCount > 0}
      <button
        type="button"
        class="w-full border-t px-3 py-1.5 text-left text-[11px] font-medium text-muted transition-colors hover:bg-overlay hover:text-foreground"
        onclick={() => (expanded = true)}
      >
        Show {hiddenCount.toLocaleString()} more characters…
      </button>
    {/if}
  {/if}
</div>
