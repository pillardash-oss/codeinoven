<script lang="ts">
  import { MessageCircle } from '@lucide/svelte'

  interface Props {
    x: number
    y: number
    /** One-based selection number rendered inside the bubble. */
    number: number
    hasComment: boolean
    active: boolean
    title: string
    onClick: () => void
  }

  let { x, y, number, hasComment, active, title, onClick }: Props = $props()
</script>

<button
  type="button"
  class="fixed z-40 flex h-6 w-11 items-center justify-center gap-1 rounded-full border shadow-md transition-colors {active
    ? 'border-accent bg-accent/15 text-accent'
    : hasComment
      ? 'border-accent/40 bg-accent/10 text-accent hover:bg-accent/15'
      : 'border-border bg-surface text-muted hover:bg-overlay hover:text-foreground'}"
  style:left={`${x}px`}
  style:top={`${y}px`}
  {title}
  aria-label={title}
  aria-pressed={active}
  onclick={onClick}
>
  <MessageCircle size={12} class="shrink-0" />
  <span class="text-[11px] leading-none font-semibold tabular-nums">{number}</span>
</button>
