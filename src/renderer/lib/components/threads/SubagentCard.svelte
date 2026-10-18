<script lang="ts">
  import CioExternalLink from '@codeinoven/icons/CioExternalLink.svelte'
  import CioSubagent from '@codeinoven/icons/CioSubagent.svelte'
  import type { AgentPart } from '$shared/types'
  import { ElapsedTimer } from '$lib/elapsed.svelte'
  import {
    subagentModelLabel,
    subagentStatusLabel,
    subagentTaskLabel
  } from '$lib/subagent-presentation'
  import CardButton from '../shared/CardButton.svelte'
  import CardFrame from '../shared/CardFrame.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import type { CardChipData } from '../shared/CardTimer.svelte'
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
  const modelLabel = $derived(subagentModelLabel(activity, true))

  // The card keeps counting only while this worker is genuinely live: a settled
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

  /** The run duration as `m:ss`, the reading the head chip shows. */
  function elapsedClock(seconds: number): string {
    const minutes = Math.floor(seconds / 60)
    const remainder = seconds % 60
    return `${minutes}:${String(remainder).padStart(2, '0')}`
  }

  /** A live run reads `Running m:ss`; a settled one is frozen at its total. */
  const chip = $derived.by<CardChipData>(() => {
    if (!start) return { text: subagentStatusLabel(status), tone: 'paused' }
    const total = elapsedClock(elapsed)
    return clock.ticking ? { text: `Running ${total}` } : { text: total }
  })
</script>

<CardFrame placement="top" label="Sub-agent">
  <CardHead {chip} icon={CioSubagent} title={taskLabel} divider={false}>
    {#snippet meta()}
      <SubagentStatusIcon {status} size={12} />
      <SubagentModeBadge background={activity.background} />
      {#if modelLabel}
        <span
          class="hidden max-w-32 min-w-0 truncate text-[0.625rem] text-dimmed sm:block"
          title={activity.modelId ?? modelLabel}
        >
          {modelLabel}
        </span>
      {/if}
    {/snippet}
    {#snippet controls()}
      {#if onOpen}
        <CardButton
          label="Open session"
          title="Open the sub-agent session"
          icon={CioExternalLink}
          size="xs"
          onclick={() => onOpen?.(part)}
        />
      {/if}
    {/snippet}
  </CardHead>
</CardFrame>
