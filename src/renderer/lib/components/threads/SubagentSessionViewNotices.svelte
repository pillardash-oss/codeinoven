<script lang="ts">
  import { CheckCircle2, X } from '@lucide/svelte'
  import AgentProviderStatusCard from './AgentProviderStatusCard.svelte'
  import type {
    SubagentProviderStatus,
    SubagentRecoveryNotice
  } from './subagent-session-view-helpers'
  import { formatTime } from './subagent-session-view-helpers'

  interface Props {
    /** A paused or failed provider connection, when there is one. */
    providerStatus: SubagentProviderStatus | null
    providerLabel: string
    recoveryNotice: SubagentRecoveryNotice | null
    actionError: string
    onStop: () => void
    onRetry: () => void
    onDismissRecovery: () => void
  }

  let {
    providerStatus,
    providerLabel,
    recoveryNotice,
    actionError,
    onStop,
    onRetry,
    onDismissRecovery
  }: Props = $props()
</script>

{#if providerStatus}
  <AgentProviderStatusCard
    status={providerStatus}
    providerName={providerLabel}
    {onStop}
    {onRetry}
  />
{/if}

{#if recoveryNotice}
  <div
    class="flex items-start gap-2.5 rounded-xl border border-success/25 bg-success/5 px-3 py-2.5"
    role="status"
    aria-live="polite"
  >
    <CheckCircle2 size={14} class="mt-0.5 shrink-0 text-success" />
    <div class="min-w-0 flex-1">
      <p class="text-xs font-semibold text-foreground">Sub-agent connection recovered</p>
      <p class="mt-0.5 text-[0.6875rem] leading-relaxed text-muted">
        {recoveryNotice.message}
      </p>
      <p class="mt-1 text-[0.625rem] text-dimmed">
        {formatTime(recoveryNotice.recoveredAt)}
      </p>
    </div>
    <button
      type="button"
      class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      aria-label="Dismiss sub-agent recovery notice"
      title="Dismiss sub-agent recovery notice"
      onclick={onDismissRecovery}
    >
      <X size={13} />
    </button>
  </div>
{/if}

{#if actionError}
  <div class="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5" role="alert">
    <p class="text-xs font-medium text-danger">Sub-agent action failed</p>
    <p class="mt-1 text-[0.6875rem] text-muted">{actionError}</p>
  </div>
{/if}
