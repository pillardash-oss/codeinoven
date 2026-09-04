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
  class="fixed z-40 flex h-6 w-11 items-center justify-center gap-1 rounded-full border bg-white text-black shadow-md transition-colors {active
    ? 'border-black/90 ring-2 ring-black/20'
    : hasComment
      ? 'border-accent hover:bg-zinc-100'
      : 'border-black/90 hover:bg-zinc-100'}"
  style:left={`${x}px`}
  style:top={`${y}px`}
  {title}
  aria-label={title}
  aria-pressed={active}
  onclick={onClick}
>
  <MessageCircle size={12} class="shrink-0" />
  <span class="text-[0.6875rem] leading-none font-semibold tabular-nums">{number}</span>
</button>
