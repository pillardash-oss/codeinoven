<script lang="ts">
  import { Check, Copy, WrapText } from '@lucide/svelte'
  import { copyText } from '$lib/copy-text'
  import { highlightCode } from './markdown'
  import { wrapTextState, wrapToggleLabel } from '$lib/stores/wrap-text.svelte'

  interface Props {
    code: string
    /** Fence language tag, e.g. `ts` — plain text when omitted or unknown. */
    lang?: string
  }

  let { code, lang }: Props = $props()

  let copied = $state(false)
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined

  const wrapped = $derived(wrapTextState.wrapped)

  const html = $derived(highlightCode(code, lang))

  $effect(() => () => clearTimeout(copyResetTimer))

  async function copy(): Promise<void> {
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

<div class="overflow-hidden rounded-lg border bg-elevated">
  <div class="flex h-7 items-center justify-between border-b px-3">
    <span class="font-mono text-[0.625rem] uppercase tracking-wide text-dimmed">{lang || 'text'}</span>
    <div class="flex items-center gap-1">
      <button
        class="flex items-center rounded p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
        aria-label={wrapToggleLabel(wrapped)}
        title={wrapToggleLabel(wrapped)}
        aria-pressed={wrapped}
        onclick={() => wrapTextState.toggle()}
      >
        <WrapText size={12} class={wrapped ? 'text-primary' : ''} />
      </button>
      <button
        class="flex items-center gap-1 rounded p-1 text-[0.625rem] text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
        aria-label="Copy code"
        title="Copy code"
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
  <!-- eslint-disable svelte/no-at-html-tags -- hljs output is escaped text + spans -->
  <pre
    class="p-3 font-mono text-xs leading-relaxed text-foreground"
    class:overflow-x-auto={!wrapped}
    class:whitespace-pre-wrap={wrapped}
    class:break-words={wrapped}><code>{@html html}</code></pre>
  <!-- eslint-enable svelte/no-at-html-tags -->
</div>
