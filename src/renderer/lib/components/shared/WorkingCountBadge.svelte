<script lang="ts">
  import type { Component } from 'svelte'

  interface Props {
    /** Icon identifying what is being counted (threads, chats…). */
    icon: Component
    /** How many items are currently active; the badge renders nothing at zero. */
    count: number
    /** Accessible name and tooltip text describing the real count. */
    label: string
    /** Status tone driving the badge color: working (info), attention
     *  (warning), error (danger), or retry (warning). */
    tone?: 'working' | 'attention' | 'error' | 'retry'
    /** Optional explicit status accents, used for unread notification colours. */
    colors?: string[]
    /** Counts above this render as `<max>+` so the pill never grows past two glyphs. */
    max?: number
    class?: string
  }

  let {
    icon,
    count,
    label,
    tone = 'working',
    colors,
    max = 9,
    class: className = ''
  }: Props = $props()

  let toneClass = $derived.by((): string => {
    switch (tone) {
      case 'attention':
      case 'retry':
        return 'text-warning'
      case 'error':
        return 'text-danger'
      default:
        return 'text-thread-working'
    }
  })

  let display = $derived(count > max ? `${max}+` : String(count))
</script>

{#if count > 0}
  {@const Icon = icon}
  <span
    class="flex h-3.5 min-w-3.5 items-center justify-center gap-px rounded-full border border-border bg-elevated px-1 text-[0.5625rem] font-semibold tabular-nums shadow-sm animate-pulse motion-reduce:animate-none {colors?.length
      ? ''
      : toneClass} {className}"
    role="status"
    aria-label={label}
    title={label}
  >
    {#if colors?.length}
      <span class="flex items-center gap-px" aria-hidden="true">
        {#each colors as accent (accent)}
          <span class="h-1.5 w-1.5 rounded-full" style:background={accent}></span>
        {/each}
      </span>
      <span class="sr-only">{display}</span>
    {:else}
      <Icon size={8} strokeWidth={2.6} aria-hidden="true" />
      {display}
    {/if}
  </span>
{/if}
