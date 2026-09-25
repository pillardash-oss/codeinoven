<script lang="ts">
  import { formatDurationSeconds } from '$lib/format/duration'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import type { AgentToolStatus } from '$shared/types'
  import SubagentModeBadge from './SubagentModeBadge.svelte'
  import SubagentStatusIcon from './SubagentStatusIcon.svelte'

  interface Props {
    taskLabel: string
    taskDetail: string | null
    /** Lifecycle chip: its glyph, wording, and tone. */
    headerStatus: { icon: AgentToolStatus; label: string; tone: string }
    showDuration: boolean
    elapsed: number
    busy: boolean
    modelLabel: string | null
    providerName?: string
    providerId?: string
    background: boolean
    providerTaskId?: string
    sessionId?: string
  }

  let {
    taskLabel,
    taskDetail,
    headerStatus,
    showDuration,
    elapsed,
    busy,
    modelLabel,
    providerName,
    providerId,
    background,
    providerTaskId,
    sessionId
  }: Props = $props()
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
    {#if modelLabel}
      <span class="flex min-w-0 items-center gap-1">
        <VendorIcon name={providerName ?? modelLabel} id={providerId} size={11} />
        <span class="truncate">
          {providerName ? `${providerName} · ${modelLabel}` : modelLabel}
        </span>
      </span>
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
