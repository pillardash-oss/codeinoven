<script lang="ts">
  import CioCheckCircle from '@pdslng/cio-icon/CioCheckCircle.svelte'
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import AgentProviderStatusCard from './AgentProviderStatusCard.svelte'
  import { noticeDismissals } from '$lib/stores/notice-dismissals.svelte'
  import ErrorStrip from '../ui/ErrorStrip.svelte'
  import MessageTimestamp from '../shared/MessageTimestamp.svelte'
  import type {
    SubagentProviderStatus,
    SubagentRecoveryNotice
  } from './subagent-session-view-helpers'

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

  /** Keyed to the error text, so the next failed action raises its own notice
   *  rather than hiding under the dismissal of this one. */
  const actionErrorId = 'subagent.actionError'
  const actionErrorCondition = $derived(actionError)
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
    class="flex items-start gap-2.5 border border-success/25 bg-success/5 px-3 py-2.5"
    role="status"
    aria-live="polite"
  >
    <CioCheckCircle size={14} class="mt-0.5 shrink-0 text-success" />
    <div class="min-w-0 flex-1">
      <p class="text-xs font-semibold text-foreground">Sub-agent connection recovered</p>
      <p class="mt-0.5 text-[0.6875rem] leading-relaxed text-muted">
        {recoveryNotice.message}
      </p>
      <p class="mt-1 text-[0.625rem] text-dimmed">
        <MessageTimestamp at={recoveryNotice.recoveredAt} />
      </p>
    </div>
    <button
      type="button"
      class="flex h-7 w-7 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      aria-label="Dismiss sub-agent recovery notice"
      title="Dismiss sub-agent recovery notice"
      onclick={onDismissRecovery}
    >
      <CioClose size={13} />
    </button>
  </div>
{/if}

{#if actionError && !noticeDismissals.isDismissed(actionErrorId, actionErrorCondition)}
  <ErrorStrip
    title="Sub-agent action failed"
    message={actionError}
    tone="danger"
    folded={false}
    onDismiss={() => noticeDismissals.dismiss(actionErrorId, actionErrorCondition)}
    dismissTitle="Dismiss the sub-agent action error"
  />
{/if}
