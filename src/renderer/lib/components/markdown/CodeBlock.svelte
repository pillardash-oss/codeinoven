<script lang="ts">
  import { onMount } from 'svelte'
  import { Check, Copy, WrapText } from '@lucide/svelte'
  import { copyText } from '$lib/copy-text'
  import { wrapTextState, wrapToggleLabel } from '$lib/stores/wrap-text.svelte'

  interface Props {
    code: string
    /** Fence language tag, e.g. `ts`   plain text when omitted or unknown. */
    lang?: string
    /**
     * Hide the header toolbar (language label, wrap, copy). Used when the
     * caller already owns those controls, e.g. the artifact card header.
     */
    hideHeader?: boolean
  }

  let { code, lang, hideHeader = false }: Props = $props()

  let copied = $state(false)
  let highlightCode = $state<((source: string, language?: string) => string) | null>(null)
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined

  const wrapped = $derived(wrapTextState.wrapped)

  const html = $derived(highlightCode ? highlightCode(code, lang) : escapeHtml(code))

  onMount(() => {
    void import('./highlight-code')
      .then((module) => {
        highlightCode = module.highlightCode
      })
      .catch(() => {
        // Plain escaped text remains readable if the optional highlighter fails to load.
      })
  })

  $effect(() => () => clearTimeout(copyResetTimer))

  async function copy(): Promise<void> {
    try {
      await copyText(code)
      copied = true
      clearTimeout(copyResetTimer)
      copyResetTimer = setTimeout(() => (copied = false), 1500)
    } catch {
      // Clipboard unavailable   the button simply stays idle.
    }
  }

  function escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
</script>

<div class="overflow-hidden rounded-lg border bg-elevated">
  {#if !hideHeader}
    <div class="flex h-7 items-center justify-between border-b px-3">
      <span class="font-mono text-[0.625rem] uppercase tracking-wide text-dimmed"
        >{lang || 'text'}</span
      >
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
  {/if}
  <!-- eslint-disable svelte/no-at-html-tags -- hljs output is escaped text + spans -->
  <pre
    class="p-3 font-mono text-xs leading-relaxed text-foreground"
    class:overflow-x-auto={!wrapped}
    class:whitespace-pre-wrap={wrapped}
    class:break-words={wrapped}><code>{@html html}</code></pre>
  <!-- eslint-enable svelte/no-at-html-tags -->
</div>
