<script lang="ts">
  import { AppWindow, Brain, Loader2, RefreshCw, Zap } from '@lucide/svelte'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import { formatDurationSeconds } from '$lib/format/duration'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import { getIconSvgDataUrl } from '$lib/project-svg-icons'
  import { getCustomSvgDataUrl } from '../../../../lib/custom-svg'
  import type { ThinkingLevel } from '$shared/types'
  import type { OvenAppearance } from '$shared/ovens'

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
    accountId?: string | null
    ovenLabel?: string | null
    ovenAppearance?: OvenAppearance
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
    accountLabel,
    accountId,
    ovenLabel,
    ovenAppearance
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
      {#if accountId || accountLabel}
        <span
          class="flex shrink-0 items-center gap-1 rounded-md bg-elevated px-1.5 py-0.5 text-[0.5625rem] text-muted"
          title={`Account: ${accountLabel ?? 'Default'}`}
          aria-label={`Account: ${accountLabel ?? 'Default'}`}
        >
          <VendorIcon name={providerName ?? 'Account'} id={providerId ?? undefined} size={11} />
          {#if accountLabel && accountLabel !== 'Default'}{accountLabel}{/if}
        </span>
      {/if}
      {#if ovenLabel}
        <span
          class="flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[0.5625rem] text-muted"
          style={`background-color: color-mix(in srgb, ${ovenAppearance?.color ?? '#6b7280'} 10%, transparent); border-color: color-mix(in srgb, ${ovenAppearance?.color ?? '#6b7280'} 25%, transparent);`}
          title={`Oven: ${ovenLabel}`}
          aria-label={`Oven: ${ovenLabel}`}
        >
          {#if ovenAppearance}
            <img
              class="h-3 w-3 shrink-0"
              alt=""
              src={ovenAppearance.customSvg
                ? getCustomSvgDataUrl(ovenAppearance.customSvg, ovenAppearance.color)
                : getIconSvgDataUrl(ovenAppearance.icon, ovenAppearance.color)}
            />
          {/if}
          {ovenLabel}
        </span>
      {/if}
    </span>
  {/if}
</div>
