<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    /** Short word or phrase; the tag is uppercase and never wraps. */
    text?: string
    tone?: 'default' | 'ok' | 'warn' | 'err' | 'info'
    children?: Snippet
    class?: string
  }

  let { text, tone = 'default', children, class: className = '' }: Props = $props()

  const toneClass = $derived(
    tone === 'ok'
      ? 'border-success text-success'
      : tone === 'warn'
        ? 'border-warning text-warning'
        : tone === 'err'
          ? 'border-danger text-danger'
          : tone === 'info'
            ? 'border-info text-info'
            : 'border-border bg-elevated text-muted'
  )
</script>

<!-- The design's tag: a small uppercase stamp for a state that rides beside a
title, such as Recommended or Sends after this turn. -->
<span
  class="inline-flex shrink-0 items-center gap-1 border px-1.5 py-0.5 text-[0.625rem] font-semibold tracking-[0.06em] whitespace-nowrap uppercase {toneClass} {className}"
>
  {#if children}
    {@render children()}
  {:else}
    {text}
  {/if}
</span>
