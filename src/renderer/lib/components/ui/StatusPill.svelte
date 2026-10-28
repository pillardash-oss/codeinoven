<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { StatusTone } from './status-tone'

  interface Props {
    /** Semantic tone driving the token-based pill colour. */
    tone?: StatusTone
    /** Show a small dot before the text. */
    dot?: boolean
    /** Accessible name / custom tooltip text. */
    title?: string
    'aria-label'?: string
    class?: string
    /**
     * Let the pill give way before the controls beside it do. The label clips
     * inside its own box instead of pushing the row wider, which matters where
     * the pill shares a fixed column with the app's name.
     */
    truncate?: boolean
    /** Renders the pill text; falls back to `label`. */
    children?: Snippet
  }

  let {
    tone = 'neutral',
    dot = false,
    title,
    'aria-label': ariaLabel,
    class: className = '',
    truncate = false,
    children
  }: Props = $props()

  /** Tone fill plus a tone-tinted edge. The edge is what most of the app already
   *  draws on a status chip, so the canonical primitive carries it too instead of
   *  being the one status shape in the app without a rule around it. */
  const tones: Record<StatusTone, string> = {
    success: 'border-success/30 bg-success/10 text-success',
    danger: 'border-danger/30 bg-danger/10 text-danger',
    warning: 'border-warning/30 bg-warning/10 text-warning',
    info: 'border-info/30 bg-info/10 text-info',
    /* The specification's own colour. A build marker wears it for probe runs so a
       pill narrowed to a couple of letters still says which build it is. */
    spec: 'border-thread-spec/30 bg-thread-spec/10 text-thread-spec',
    neutral: 'border-border bg-elevated text-dimmed'
  }

  const dotTones: Record<StatusTone, string> = {
    success: 'bg-success',
    danger: 'bg-danger',
    warning: 'bg-warning',
    info: 'bg-info',
    spec: 'bg-thread-spec',
    neutral: 'bg-dimmed'
  }
</script>

<span
  class="inline-flex items-center gap-1 border px-1.5 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-wide {truncate
    ? 'min-w-0 shrink'
    : 'shrink-0'} {tones[tone]} {className}"
  {title}
  aria-label={ariaLabel}
>
  {#if dot}
    <span class="h-1.5 w-1.5 shrink-0 {dotTones[tone]}" aria-hidden="true"></span>
  {/if}
  {#if children}
    {#if truncate}
      <span class="min-w-0 truncate">{@render children()}</span>
    {:else}
      {@render children()}
    {/if}
  {/if}
</span>
