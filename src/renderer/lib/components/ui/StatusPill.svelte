<script lang="ts">
  import type { Snippet } from 'svelte'

  /** Semantic tone that maps to a design token (no raw colors). */
  export type StatusTone = 'success' | 'danger' | 'warning' | 'neutral' | 'info'

  interface Props {
    /** Semantic tone driving the token-based pill colour. */
    tone?: StatusTone
    /** Show a small dot before the text. */
    dot?: boolean
    /** Accessible name / custom tooltip text. */
    title?: string
    'aria-label'?: string
    class?: string
    /** Renders the pill text; falls back to `label`. */
    children?: Snippet
  }

  let {
    tone = 'neutral',
    dot = false,
    title,
    'aria-label': ariaLabel,
    class: className = '',
    children
  }: Props = $props()

  const tones: Record<StatusTone, string> = {
    success: 'bg-success/10 text-success',
    danger: 'bg-danger/10 text-danger',
    warning: 'bg-warning/10 text-warning',
    info: 'bg-info/10 text-info',
    neutral: 'bg-elevated text-dimmed'
  }

  const dotTones: Record<StatusTone, string> = {
    success: 'bg-success',
    danger: 'bg-danger',
    warning: 'bg-warning',
    info: 'bg-info',
    neutral: 'bg-dimmed'
  }
</script>

<span
  class="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-wide {tones[
    tone
  ]} {className}"
  {title}
  aria-label={ariaLabel}
>
  {#if dot}
    <span class="h-1.5 w-1.5 shrink-0 rounded-full {dotTones[tone]}" aria-hidden="true"></span>
  {/if}
  {#if children}
    {@render children()}
  {/if}
</span>
