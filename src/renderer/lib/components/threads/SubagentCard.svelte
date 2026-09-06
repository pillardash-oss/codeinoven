<script lang="ts">
  import { Bot, CheckCircle2, Clock, ExternalLink, Layers3, Loader2, XCircle } from '@lucide/svelte'
  import type { AgentPart } from '$shared/types'

  interface Props {
    part: Extract<AgentPart, { type: 'subagent' }>
    /** True only while a live session is streaming this sub-agent. */
    live?: boolean
    onOpen?: (part: Extract<AgentPart, { type: 'subagent' }>) => void
  }

  let { part, live = false, onOpen }: Props = $props()

  let elapsed = $state(0)
  const start = $derived(part.activity.time?.start)
  const end = $derived(part.activity.time?.end)
  const running = $derived(part.activity.status === 'running')

  $effect(() => {
    if (!start) return
    if (end) {
      elapsed = Math.max(0, Math.floor((end - start) / 1000))
      return
    }
    if (!running || !live) {
      // Terminal, or historical/restored without an end timestamp: snapshot
      // once, never re-derive from the wall clock on later re-renders.
      if (elapsed === 0) elapsed = Math.max(0, Math.floor((Date.now() - start) / 1000))
      return
    }
    elapsed = Math.max(0, Math.floor((Date.now() - start) / 1000))
    const interval = setInterval(() => {
      elapsed = Math.max(0, Math.floor((Date.now() - start) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  })

  const statusLabel = $derived(
    part.activity.status === 'running'
      ? 'Working'
      : part.activity.status === 'completed'
        ? 'Completed'
        : part.activity.status === 'error'
          ? 'Failed'
          : 'Starting'
  )

  function formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const remainder = seconds % 60
    return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`
  }
</script>

<div class="overflow-hidden rounded-lg border border-border bg-surface">
  <button
    type="button"
    class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-elevated"
    title="Open sub-agent session"
    onclick={() => onOpen?.(part)}
  >
    {#if part.activity.status === 'running'}
      <Loader2 size={14} class="shrink-0 animate-spin text-info" />
    {:else if part.activity.status === 'completed'}
      <CheckCircle2 size={14} class="shrink-0 text-success" />
    {:else if part.activity.status === 'error'}
      <XCircle size={14} class="shrink-0 text-danger" />
    {:else}
      <Clock size={14} class="shrink-0 text-dimmed" />
    {/if}

    <Bot size={13} class="shrink-0 text-info" />
    <span class="shrink-0 text-[0.6875rem] font-semibold text-foreground">
      {part.activity.agent || 'Sub-agent'}
    </span>
    <span class="min-w-0 flex-1 truncate text-[0.6875rem] text-muted">
      {part.activity.description}
    </span>
    {#if part.activity.background}
      <span
        class="flex shrink-0 items-center gap-1 rounded-md bg-raised px-1.5 py-0.5 text-[0.5625rem] text-dimmed"
      >
        <Layers3 size={9} />
        Background
      </span>
    {/if}
    {#if start}
      <span class="shrink-0 tabular-nums text-[0.625rem] text-dimmed">
        {formatDuration(elapsed)}
      </span>
    {/if}
    <span
      class="shrink-0 text-[0.625rem] {part.activity.status === 'error'
        ? 'text-danger'
        : part.activity.status === 'running'
          ? 'text-info'
          : 'text-dimmed'}"
      aria-live="polite"
    >
      {statusLabel}
    </span>
    <ExternalLink size={12} class="shrink-0 text-dimmed" />
  </button>
</div>
