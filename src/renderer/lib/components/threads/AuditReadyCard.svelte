<script lang="ts">
  import { ShieldCheck } from '@lucide/svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import type { AuditReport, ProviderCatalog, ThreadSettings } from '$shared/types'

  interface Props {
    report: AuditReport
    providers?: ProviderCatalog[]
    projectId?: string | null
    settings?: ThreadSettings
    favoriteModels?: string[]
    recentModels?: string[]
    busy?: boolean
    onReview?: () => void
    onViewReport?: () => void
    onComplete?: () => void
    onCancel?: () => void
    onReaudit?: (settings: ThreadSettings) => void
    onModelChange?: (settings: ThreadSettings) => void
    onToggleFavorite?: (providerId: string, modelId: string, harnessId: string) => void
    onReorderFavorite?: (
      draggedKey: string,
      targetKey: string,
      position: 'before' | 'after'
    ) => void
  }

  let {
    report,
    providers = [],
    projectId = null,
    settings,
    favoriteModels = [],
    recentModels = [],
    busy = false,
    onReview,
    onViewReport,
    onComplete,
    onCancel,
    onReaudit,
    onModelChange,
    onToggleFavorite,
    onReorderFavorite
  }: Props = $props()

  function chooseModel(providerId: string, modelId: string, nextHarnessId?: string): void {
    if (!settings) return
    onModelChange?.({
      ...settings,
      harnessId: nextHarnessId ?? settings.harnessId,
      providerId,
      modelId
    })
  }

  function viewReport(): void {
    const action = onViewReport ?? onReview
    action?.()
  }

  function cancelAudit(): void {
    onCancel?.()
  }

  function completeAudit(): void {
    onComplete?.()
  }
</script>

<section class="rounded-xl border bg-surface p-4" aria-label="Auditor is done">
  <div class="flex items-start gap-3">
    <div class="rounded-lg bg-primary/10 p-2 text-primary"><ShieldCheck size={18} /></div>
    <div class="min-w-0 flex-1">
      <h3 class="text-sm font-semibold">Auditor is done</h3>
      <p class="mt-1 text-xs text-muted">
        Review the findings, add annotations, and send required changes to the primary agent.
      </p>
      <p class="mt-1 text-[11px] text-dimmed">
        Audited by {report.provenance.providerId ?? 'provider'} /
        {report.provenance.modelId ?? 'model'}
      </p>
      {#if report.assignmentVersion !== undefined}
        <p class="mt-1 text-[11px] font-medium text-muted">
          Assignment v{report.assignmentVersion} · {report.reworkCycle
            ? `Rework ${report.reworkCycle}`
            : 'Initial implementation'}
        </p>
      {/if}
    </div>
  </div>
  <div class="mt-4 flex flex-wrap items-center justify-between gap-2">
    <button
      class="rounded-lg px-3 py-2 text-xs text-muted hover:bg-overlay"
      disabled={busy || !onCancel}
      title="Cancel this audit cycle"
      onclick={cancelAudit}
    >
      Cancel
    </button>
    <div class="ml-auto flex flex-wrap items-center justify-end gap-2">
      {#if settings}
        <ModelPicker
          {providers}
          {projectId}
          harnessId={settings.harnessId}
          providerId={settings.providerId}
          modelId={settings.modelId}
          {favoriteModels}
          {recentModels}
          side="top"
          label="Change"
          variant="action"
          onSelect={chooseModel}
          {onToggleFavorite}
          {onReorderFavorite}
        />
      {:else}
        <button
          class="rounded-lg border bg-elevated px-3 py-2 text-xs font-medium text-muted disabled:opacity-50"
          disabled
          title="Choose an auditor model before running another audit"
        >
          Change
        </button>
      {/if}
      <button
        class="rounded-lg border bg-elevated px-3 py-2 text-xs font-semibold text-foreground hover:bg-overlay disabled:opacity-50"
        disabled={busy || !settings || !onReaudit}
        title="Run the audit again with the selected auditor model"
        onclick={() => settings && onReaudit?.(settings)}
      >
        Reaudit
      </button>
      <button
        class="rounded-lg border bg-elevated px-3 py-2 text-xs font-semibold text-foreground hover:bg-overlay"
        title="View the audit report"
        onclick={viewReport}
      >
        View report
      </button>
      {#if report.annotations.length === 0}
        <button
          class="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
          disabled={busy || !onComplete}
          title="Complete this audit cycle"
          onclick={completeAudit}
        >
          Complete
        </button>
      {/if}
    </div>
  </div>
</section>
