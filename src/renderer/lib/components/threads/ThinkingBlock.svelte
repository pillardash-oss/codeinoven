<script lang="ts">
  import { Brain, ChevronRight } from '@lucide/svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import type { AgentPart } from '$shared/types'

  interface Props {
    part: Extract<AgentPart, { type: 'reasoning' }>
    active?: boolean
    /** True only while a live session is streaming — gates the ticking clock. */
    live?: boolean
    onCiteFile?: (path: string, line?: number) => void
  }

  let { part, active = false, live = false, onCiteFile }: Props = $props()

  let open = $state(false)
  let elapsed = $state(0)

  let start = $derived(part.time?.start)
  let end = $derived(part.time?.end)

  $effect(() => {
    if (start && end) {
      // Finished: the duration is a frozen snapshot of the reasoning itself.
      elapsed = Math.floor((end - start) / 1000)
    } else if (start && active && live) {
      const interval = setInterval(() => {
        elapsed = Math.floor((Date.now() - start) / 1000)
      }, 1000)
      return () => clearInterval(interval)
    } else if (start && elapsed === 0) {
      // Inactive without an end timestamp: snapshot once, never re-derive from
      // the wall clock on later re-renders.
      elapsed = Math.floor((Date.now() - start) / 1000)
    }
  })

  $effect(() => {
    if (active) open = true
  })

  function formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return s > 0 ? `${m}m ${s}s` : `${m}m`
  }
</script>

<details class="overflow-hidden rounded-lg border border-border/60 bg-elevated/30" bind:open>
  <summary
    class="flex cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs font-medium text-dimmed transition-colors hover:bg-elevated"
  >
    <Brain size={13} class="shrink-0 text-info/70" />
    <span class="shrink-0">Thinking</span>
    <span class="tabular-nums text-[10px] text-dimmed">
      {formatDuration(elapsed)}
    </span>
    {#if active}
      <span class="h-1.5 w-1.5 rounded-full bg-info animate-pulse"></span>
    {/if}
    <span class="flex-1"></span>
    <ChevronRight
      size={12}
      class="shrink-0 text-muted transition-transform {open ? 'rotate-90' : ''}"
    />
  </summary>
  <div class="border-t border-border/40 px-3 py-2">
    <div class="max-h-80 overflow-y-auto">
      {#if part.text.trim()}
        <MarkdownView text={part.text} class="text-xs text-muted" {onCiteFile} />
      {/if}
      {#if part.summary?.trim()}
        <div class={part.text.trim() ? 'mt-3 border-t border-border/40 pt-3' : ''}>
          <p class="mb-1 text-[10px] font-medium uppercase tracking-wide text-info/80">
            Thinking summary
          </p>
          <MarkdownView text={part.summary} class="text-xs text-muted" {onCiteFile} />
        </div>
      {/if}
    </div>
  </div>
</details>
