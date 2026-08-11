<script lang="ts">
  import { CircleAlert, FileCheck2, Loader2 } from '@lucide/svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import type { ProviderCatalog, Thread, ThreadSettings } from '$shared/types'

  interface Props {
    state?: Thread['auditState'] | 'failed'
    version?: number
    error?: string
    startedAt?: number
    finishedAt?: number
    retryLabel?: string
    reworkCycle?: number
    settings: ThreadSettings
    providers: ProviderCatalog[]
    projectId?: string | null
    favoriteModels?: string[]
    recentModels?: string[]
    busy?: boolean
    onRetry: (settings: ThreadSettings) => void
    onModelChange: (settings: ThreadSettings) => void
    onToggleFavorite?: (providerId: string, modelId: string, harnessId: string) => void
    onReorderFavorite?: (
      draggedKey: string,
      targetKey: string,
      position: 'before' | 'after'
    ) => void
    onViewReport: () => void
  }

  let {
    state,
    version,
    error,
    startedAt,
    finishedAt,
    retryLabel = 'Retry audit',
    reworkCycle,
    settings,
    providers,
    projectId = null,
    favoriteModels = [],
    recentModels = [],
    busy = false,
    onRetry,
    onModelChange,
    onToggleFavorite,
    onReorderFavorite,
    onViewReport
  }: Props = $props()

  let failed = $derived(state === 'failed')
  let interrupted = $derived(state === 'offered')
  let reworking = $derived(state === 'reworking')
  let elapsed = $derived(
    startedAt !== undefined && finishedAt !== undefined
      ? formatDuration(Math.max(0, finishedAt - startedAt))
      : null
  )

  function formatDuration(durationMs: number): string {
    const totalSeconds = Math.floor(durationMs / 1_000)
    const hours = Math.floor(totalSeconds / 3_600)
    const minutes = Math.floor((totalSeconds % 3_600) / 60)
    const seconds = totalSeconds % 60
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
    if (minutes > 0) return `${minutes}m ${seconds}s`
    return `${seconds}s`
  }

  function chooseModel(providerId: string, modelId: string, nextHarnessId?: string): void {
    onModelChange({
      ...settings,
      harnessId: nextHarnessId ?? settings.harnessId,
      providerId,
      modelId
    })
  }
</script>

<section
  class="rounded-xl border bg-surface p-4 {failed ? 'border-danger/40' : 'border-border'}"
  aria-label="Assignment audit status"
>
  <div class="flex items-start gap-3">
    <div
      class="rounded-lg p-2 {failed ? 'bg-danger/10 text-danger' : 'bg-primary/10 text-primary'}"
    >
      {#if busy || state === 'running'}
        <Loader2 size={18} class="animate-spin" />
      {:else if failed || interrupted}
        <CircleAlert size={18} />
      {:else}
        <FileCheck2 size={18} />
      {/if}
    </div>
    <div class="min-w-0 flex-1">
      <h3 class="text-sm font-semibold text-foreground">
        {failed
          ? 'Audit failed'
          : interrupted
            ? 'Audit interrupted'
            : reworking
              ? 'Review sent to Sr. Engineer'
              : version === undefined
                ? reworkCycle
                  ? `Rework ${reworkCycle} complete — audit running again`
                  : 'Audit in progress'
                : `Report generated — Version ${version}`}
      </h3>
      <p
        class="mt-1 text-xs leading-relaxed {failed ? 'text-danger' : 'text-muted'}"
        role={failed ? 'alert' : undefined}
      >
        {failed
          ? error || 'The auditor failed without returning a usable error.'
          : interrupted
            ? error ||
              'The auditor could not finish. Choose another harness or model, then retry the audit.'
            : reworking
              ? `The Sr. Engineer is reviewing audit report v${version ?? 1} and your feedback. It will either handle the correction directly or propose a new Assignment for your review.`
              : version === undefined
                ? reworkCycle
                  ? 'The existing auditor is independently verifying the completed rework.'
                  : 'This dedicated auditor task is locked while the report is being prepared.'
                : 'Review the rendered report, switch versions, and add annotations in Audit Studio.'}
      </p>
      {#if failed && elapsed}
        <p class="mt-2 text-[11px] tabular-nums text-dimmed">Auditor runtime: {elapsed}</p>
      {/if}
    </div>
  </div>
  {#if failed || interrupted}
    <div class="mt-4 flex flex-wrap items-center justify-end gap-2">
      <ModelPicker
        {providers}
        {projectId}
        harnessId={settings.harnessId}
        providerId={settings.providerId}
        modelId={settings.modelId}
        {favoriteModels}
        {recentModels}
        side="top"
        label="Change auditor"
        variant="action"
        onSelect={chooseModel}
        {onToggleFavorite}
        {onReorderFavorite}
      />
      <button
        class="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary disabled:opacity-50"
        disabled={busy}
        onclick={() => onRetry(settings)}
      >
        {#if busy}<Loader2 size={13} class="animate-spin" />{/if}
        {retryLabel}
      </button>
    </div>
  {:else if version !== undefined}
    <div class="mt-4 flex justify-end">
      <button
        class="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary hover:bg-primary-hover"
        title={reworking ? 'Open the source audit report' : 'Open this report in Audit Studio'}
        onclick={onViewReport}
      >
        {reworking ? 'View source report' : 'View report'}
      </button>
    </div>
  {/if}
</section>
