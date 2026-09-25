<script lang="ts">
  import { AppWindow, Brain, Loader2, RefreshCw, Zap } from '@lucide/svelte'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import { formatDurationSeconds } from '$lib/format/duration'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import type { ThinkingLevel } from '$shared/types'

  interface Props {
    /** True when this trace was rehydrated from persisted state instead of a live run. */
    rehydrated: boolean
    /** True when this run belongs to another CodeInOven instance. Its live output
     *  and its stop control are in that window, not this one, so the trace
     *  explains the missing stream instead of showing a bare spinner. */
    foreignRun?: boolean
    /** When the agent started working, when known, so the duration can show. */
    startTime: number | undefined
    elapsed: number
    /** Attribution for the model currently working on this trace. */
    modelLabel: string | null
    isFast: boolean
    thinkingLevel: ThinkingLevel | null
    providerName?: string | null
    providerId?: string | null
    harnessId?: string | null
    harnessName?: string | null
    accountLabel?: string | null
  }

  let {
    rehydrated,
    foreignRun = false,
    startTime,
    elapsed,
    modelLabel,
    isFast,
    thinkingLevel,
    providerName,
    providerId,
    harnessId,
    harnessName,
    accountLabel
  }: Props = $props()
</script>

<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
  {#if foreignRun}
    <span class="flex min-w-0 shrink items-center gap-2">
      <AppWindow size={11} class="shrink-0 text-info" />
      <span class="shrink-0 text-[0.625rem] text-info/80">
        Running in another instance · showing last saved activity
      </span>
      {#if startTime}
        <span class="shrink-0 tabular-nums text-[0.625rem] text-info/80">
          · {formatDurationSeconds(elapsed)}
        </span>
      {/if}
    </span>
  {:else if rehydrated}
    <span class="flex min-w-0 shrink items-center gap-2">
      <RefreshCw size={11} class="shrink-0 text-info" />
      <span class="shrink-0 text-[0.625rem] text-info/80">
        Showing last saved activity · live run not confirmed
      </span>
      {#if startTime}
        <span class="shrink-0 tabular-nums text-[0.625rem] text-info/80">
          · {formatDurationSeconds(elapsed)}
        </span>
      {/if}
    </span>
  {:else}
    <span class="flex min-w-0 shrink items-center gap-2">
      <Loader2 size={11} class="shrink-0 animate-spin text-info" />
      <span class="shrink-0 text-[0.625rem] text-info/80">Agent working…</span>
      {#if startTime}
        <span class="shrink-0 tabular-nums text-[0.625rem] text-info/80">
          · {formatDurationSeconds(elapsed)}
        </span>
      {/if}
    </span>
  {/if}
  {#if modelLabel}
    <span
      class="flex min-w-0 items-center gap-1.5 text-[0.625rem] text-dimmed max-sm:basis-full max-sm:pl-[18px] max-sm:text-[0.5625rem] sm:ml-auto"
    >
      {#if harnessId}
        <span class="flex shrink-0 items-center gap-1">
          <AgentIcon agentId={harnessId} size={14} />
          {#if harnessName}<span class="truncate">{harnessName}</span>{/if}
        </span>
        <span>·</span>
      {/if}
      <span class="flex shrink-0 items-center gap-1">
        <VendorIcon name={providerName ?? modelLabel} id={providerId ?? undefined} size={11} />
        <span class="truncate">{modelLabel}</span>
      </span>
      {#if isFast}
        <Zap
          size={10}
          class="shrink-0 text-accent"
          fill="currentColor"
          aria-label="Fast inference"
          title="Fast inference"
        />
      {/if}
      {#if thinkingLevel}
        <span
          class="flex shrink-0 items-center gap-1 rounded-md bg-elevated px-1.5 py-0.5 text-[0.5625rem] capitalize text-muted"
          title={`Thinking level: ${thinkingLevel}`}
          aria-label={`Thinking level: ${thinkingLevel}`}
        >
          <Brain size={9} />
          {thinkingLevel}
        </span>
      {/if}
      {#if accountLabel && accountLabel !== 'Default'}
        <span
          class="flex shrink-0 items-center rounded-md bg-elevated px-1.5 py-0.5 text-[0.5625rem] text-muted"
          title={`Account: ${accountLabel}`}
          aria-label={`Account: ${accountLabel}`}
        >
          {accountLabel}
        </span>
      {/if}
    </span>
  {/if}
</div>
