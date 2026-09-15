<script lang="ts">
  import { Bot, ExternalLink } from '@lucide/svelte'
  import type { AgentPart } from '$shared/types'
  import { ElapsedTimer } from '$lib/elapsed.svelte'
  import { formatDurationSeconds } from '$lib/format/duration'
  import {
    subagentModelLabel,
    subagentTaskDetail,
    subagentTaskLabel
  } from '$lib/subagent-presentation'
  import SubagentModeBadge from './SubagentModeBadge.svelte'
  import SubagentStatusIcon from './SubagentStatusIcon.svelte'

  interface Props {
    part: Extract<AgentPart, { type: 'subagent' }>
    /** True only while a live session is streaming this sub-agent. */
    live?: boolean
    onOpen?: (part: Extract<AgentPart, { type: 'subagent' }>) => void
  }

  let { part, live = false, onOpen }: Props = $props()

  const clock = new ElapsedTimer()
  const activity = $derived(part.activity)
  const start = $derived(activity.time?.start)
  const end = $derived(activity.time?.end)
  const status = $derived(activity.status)
  const taskLabel = $derived(subagentTaskLabel(activity))
  const taskDetail = $derived(subagentTaskDetail(activity))
  const modelLabel = $derived(subagentModelLabel(activity, true))

  // The row keeps counting only while this worker is genuinely live: a settled
  // or restored run freezes at its recorded end (or at the last observed tick),
  // never at whatever the wall clock says when the trace re-renders.
  $effect(() => {
    if (status === 'running' && live) clock.start()
    else {
      clock.stop()
      if (!end) clock.snapshot()
    }
    return () => clock.stop()
  })

  const elapsed = $derived(clock.seconds(start, end))
</script>

<div class="overflow-hidden rounded-lg border border-border bg-surface">
  <button
    type="button"
    class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-elevated"
    title="Open sub-agent session"
    onclick={() => onOpen?.(part)}
  >
    <SubagentStatusIcon {status} size={14} />

    <Bot size={13} class="shrink-0 text-info" />
    <span
      class="max-w-40 shrink-0 truncate text-[0.6875rem] font-semibold text-foreground"
      title={taskLabel}
    >
      {taskLabel}
    </span>
    {#if taskDetail}
      <span class="min-w-0 flex-1 truncate text-[0.6875rem] text-muted">{taskDetail}</span>
    {:else}
      <span class="min-w-0 flex-1"></span>
    {/if}
    <SubagentModeBadge background={activity.background} />
    {#if modelLabel}
      <span
        class="hidden max-w-32 shrink-0 truncate text-[0.625rem] text-dimmed sm:block"
        title={activity.modelId ?? modelLabel}
      >
        {modelLabel}
      </span>
    {/if}
    {#if start}
      <span class="shrink-0 tabular-nums text-[0.625rem] text-dimmed">
        {formatDurationSeconds(elapsed)}
      </span>
    {/if}
    <ExternalLink size={12} class="shrink-0 text-dimmed" />
  </button>
</div>
