<script lang="ts">
  import { formatDurationSeconds } from '$lib/format/duration'
  import type { AgentToolStatus, ThinkingLevel } from '$shared/types'
  import SubagentModeBadge from './SubagentModeBadge.svelte'
  import SubagentStatusIcon from './SubagentStatusIcon.svelte'
  import WorkingTraceMetadata from './WorkingTraceMetadata.svelte'

  interface Props {
    taskLabel: string
    taskDetail: string | null
    /** The agent definition that ran the task, when it is not the title. */
    agentType: string | null
    /** Lifecycle chip: its glyph, wording, and tone. */
    headerStatus: { icon: AgentToolStatus; label: string; tone: string }
    showDuration: boolean
    elapsed: number
    busy: boolean
    modelLabel: string | null
    providerName?: string
    providerId?: string
    harnessId?: string | null
    harnessName?: string | null
    thinkingLevel: ThinkingLevel | null
    background: boolean
    providerTaskId?: string
    sessionId?: string
  }

  let {
    taskLabel,
    taskDetail,
    agentType,
    headerStatus,
    showDuration,
    elapsed,
    busy,
    modelLabel,
    providerName,
    providerId,
    harnessId,
    harnessName,
    thinkingLevel,
    background,
    providerTaskId,
    sessionId
  }: Props = $props()

  /** The attribution line explains how this worker ran, so it appears as soon
   *  as any of those facts is known, even before the model catalog resolves. */
  const showAttribution = $derived(
    modelLabel !== null || harnessId !== undefined || thinkingLevel !== null
  )
</script>

<header class="shrink-0 border-b border-border px-4 py-3">
  <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
    <h2 class="min-w-0 truncate text-xs font-semibold text-foreground">{taskLabel}</h2>
    <span
      class="flex shrink-0 items-center gap-1 text-[0.625rem] {headerStatus.tone}"
      aria-live="polite"
    >
      <SubagentStatusIcon status={headerStatus.icon} size={11} />
      {headerStatus.label}
    </span>
    {#if showDuration}
      <span
        class="ml-auto shrink-0 tabular-nums text-[0.625rem] text-muted"
        title={busy ? 'Elapsed time for this sub-agent' : 'Total time this sub-agent took'}
      >
        {formatDurationSeconds(elapsed)}
      </span>
    {/if}
  </div>
  <div class="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.625rem] text-dimmed">
    {#if agentType}
      <span
        class="shrink-0 border border-border px-1.5 py-0.5 text-[0.5625rem] font-semibold tracking-wide text-muted"
        title="Agent definition that ran this task"
        aria-label="Agent definition: {agentType}"
      >
        {agentType}
      </span>
    {/if}
    {#if showAttribution}
      <WorkingTraceMetadata
        {modelLabel}
        isFast={false}
        {thinkingLevel}
        {providerName}
        {providerId}
        {harnessId}
        {harnessName}
      />
    {/if}
    <SubagentModeBadge {background} variant="chip" />
    {#if providerTaskId && providerTaskId !== sessionId}
      <span class="truncate font-mono" title={providerTaskId}>task {providerTaskId}</span>
    {/if}
  </div>
  {#if taskDetail}
    <p class="mt-1 min-w-0 truncate text-[0.625rem] text-muted">{taskDetail}</p>
  {/if}
</header>
