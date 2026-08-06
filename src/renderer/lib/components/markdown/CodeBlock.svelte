<script lang="ts">
  import { Check, Copy } from '@lucide/svelte'
  import { highlightCode } from './markdown'

  interface Props {
    code: string
    /** Fence language tag, e.g. `ts` — plain text when omitted or unknown. */
    lang?: string
  }

  let { code, lang }: Props = $props()

  let copied = $state(false)
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined

  const html = $derived(highlightCode(code, lang))

  $effect(() => () => clearTimeout(copyResetTimer))

  async function copy(): Promise<void> {
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

<div class="overflow-hidden rounded-lg border bg-elevated">
  <div class="flex h-7 items-center justify-between border-b px-3">
    <span class="font-mono text-[10px] uppercase tracking-wide text-dimmed">{lang || 'text'}</span>
    <button
      class="flex items-center gap-1 rounded p-1 text-[10px] text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
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
  <!-- eslint-disable svelte/no-at-html-tags -- hljs output is escaped text + spans -->
  <pre class="overflow-x-auto p-3 font-mono text-xs leading-relaxed text-foreground"><code
      >{@html html}</code
    ></pre>
  <!-- eslint-enable svelte/no-at-html-tags -->
</div>
