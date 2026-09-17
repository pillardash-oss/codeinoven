<script lang="ts">
  import type { Component } from 'svelte'

  interface Props {
    /** Icon identifying what is being counted (threads, chats…). */
    icon: Component
    /** How many items are currently active; the badge renders nothing at zero. */
    count: number
    /** Accessible name and tooltip text describing the real count. */
    label: string
    /** Counts above this render as `<max>+` so the pill never grows past two glyphs. */
    max?: number
    class?: string
  }

  let { icon, count, label, max = 9, class: className = '' }: Props = $props()

  let display = $derived(count > max ? `${max}+` : String(count))
</script>

{#if count > 0}
  {@const Icon = icon}
  <span
    class="flex h-3.5 min-w-3.5 items-center justify-center gap-px rounded-full border border-border bg-elevated px-1 text-[0.5625rem] font-semibold tabular-nums text-thread-working shadow-sm animate-pulse motion-reduce:animate-none {className}"
    role="status"
    aria-label={label}
    title={label}
  >
    <Icon size={8} strokeWidth={2.6} aria-hidden="true" />
    {display}
  </span>
{/if}
