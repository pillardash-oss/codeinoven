<script lang="ts">
  import { Brain, ChevronRight } from '@lucide/svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import SmoothMarkdown from '../markdown/SmoothMarkdown.svelte'
  import type { AgentPart } from '$shared/types'
  import { ElapsedTimer } from '$lib/elapsed.svelte'
  import { formatDurationSeconds } from '$lib/format/duration'

  interface Props {
    part: Extract<AgentPart, { type: 'reasoning' }>
    active?: boolean
    /** True only while a live session is streaming   gates the ticking clock. */
    live?: boolean
    onCiteFile?: (path: string, line?: number) => void
  }

  let { part, active = false, live = false, onCiteFile }: Props = $props()

  let open = $state(false)
  const clock = new ElapsedTimer()

  let start = $derived(part.time?.start)
  let end = $derived(part.time?.end)

  $effect(() => {
    if (start && active && live) clock.start()
    else {
      clock.stop()
      // Finished, or inactive without an end timestamp: pin one snapshot so
      // the reasoning duration never re-derives from the wall clock.
      if (start && !end) clock.snapshot()
    }
    return () => clock.stop()
  })

  const elapsed = $derived(clock.seconds(start, end))

  $effect(() => {
    if (active) open = true
  })
</script>

<details class="overflow-hidden rounded-lg border border-border/60 bg-elevated/30" bind:open>
  <summary
    class="flex cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs font-medium text-dimmed transition-colors hover:bg-elevated"
  >
    <Brain size={13} class="shrink-0 text-info/70" />
    <span class="shrink-0">Thinking</span>
    <span class="tabular-nums text-[0.625rem] text-dimmed">
      {formatDurationSeconds(elapsed)}
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
        <SmoothMarkdown
          text={part.text}
          streaming={active && live}
          class="text-xs text-muted"
          {onCiteFile}
        />
      {:else if !part.summary?.trim()}
        <p class="text-xs text-muted/70 italic">No thinking text was recorded for this step.</p>
      {/if}
      {#if part.summary?.trim()}
        <div class={part.text.trim() ? 'mt-3 border-t border-border/40 pt-3' : ''}>
          <p class="mb-1 text-[0.625rem] font-medium uppercase tracking-wide text-info/80">
            Thinking summary
          </p>
          <MarkdownView text={part.summary} class="text-xs text-muted" {onCiteFile} />
        </div>
      {/if}
    </div>
  </div>
</details>
