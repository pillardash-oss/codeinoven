<script lang="ts">
  import { Brain, ChevronRight } from '@lucide/svelte'
  import { slide } from 'svelte/transition'
  import { foldSlide } from '$lib/components/shared/card-motion'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import SmoothMarkdown from '../markdown/SmoothMarkdown.svelte'
  import type { AgentPart } from '$shared/types'
  import { reasoningBlockTitle, reasoningSummaryRepeatsBody } from '$shared/agent-part-merge'
  import { ElapsedTimer } from '$lib/elapsed.svelte'
  import { formatDurationMs } from '$lib/format/duration'

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

  /**
   * A summary that merely repeats the reasoning body is not a summary   it is
   * the same content that reached both channels, and sessions recorded before
   * the Codex channels were separated still carry it. Render it once: the
   * summary formatting is the clean one (the body copy has the streamed line
   * separators collapsed into literal `****`), so it becomes the body and the
   * separate "Thinking summary" section is dropped.
   */
  let repeatsSummary = $derived(reasoningSummaryRepeatsBody(part.text, part.summary ?? ''))
  let body = $derived(repeatsSummary ? (part.summary ?? '') : part.text)
  let summary = $derived(repeatsSummary ? '' : (part.summary ?? ''))

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

  /**
   * The folded row's one-line title. Providers that ship thinking summaries
   * label each block (Codex: `**Evaluating build output**`), and providers that
   * ship only a reasoning body get their first line, so a reader can pick the
   * block they want without opening every one in turn.
   */
  const title = $derived(reasoningBlockTitle(part.text, part.summary ?? ''))
</script>

{#if body.trim() || summary.trim()}
  <div class="min-w-0">
    <button
      type="button"
      class="group/think flex w-full cursor-pointer items-center gap-1.5 py-1 text-left text-[0.6875rem] text-dimmed transition-colors hover:text-foreground"
      aria-expanded={open}
      title={open ? 'Hide thinking' : 'Show thinking'}
      onclick={() => (open = !open)}
    >
      <Brain
        size={13}
        class="shrink-0 text-info/60 transition-colors group-hover/think:text-info"
      />
      <span class="shrink-0">Thinking</span>
      {#if start !== undefined}
        <span
          class="tabular-nums text-[0.625rem] text-dimmed transition-colors group-hover/think:text-muted"
        >
          {formatDurationMs(elapsed * 1000)}
        </span>
      {/if}
      {#if active}
        <span class="h-1.5 w-1.5 rounded-full bg-info animate-pulse"></span>
      {/if}
      {#if title}
        <span
          class="min-w-0 flex-1 truncate text-[0.6875rem] text-dimmed transition-colors group-hover/think:text-muted"
          >{title}</span
        >
      {:else}
        <span class="flex-1"></span>
      {/if}
      <ChevronRight
        size={12}
        class="shrink-0 text-dimmed transition-transform group-hover/think:text-foreground {open
          ? 'rotate-90'
          : ''}"
      />
    </button>
    {#if open}
      <div transition:slide={foldSlide()} class="border-l border-border/60 py-1 pl-3">
        <div class="max-h-80 overflow-y-auto">
          {#if body.trim()}
            <SmoothMarkdown
              text={body}
              streaming={active && live}
              class="text-xs text-muted"
              {onCiteFile}
            />
          {/if}
          {#if summary.trim()}
            <div class={body.trim() ? 'mt-3 border-t border-border/40 pt-3' : ''}>
              <p class="mb-1 text-[0.625rem] font-medium uppercase tracking-wide text-info/80">
                Thinking summary
              </p>
              <MarkdownView text={summary} class="text-xs text-muted" {onCiteFile} />
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
{/if}
