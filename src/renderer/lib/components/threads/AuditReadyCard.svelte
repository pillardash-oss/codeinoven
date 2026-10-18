<script lang="ts">
  import CioCheck from '@codeinoven/icons/CioCheck.svelte'
  import CioExternalLink from '@codeinoven/icons/CioExternalLink.svelte'
  import CioRefresh from '@codeinoven/icons/CioRefresh.svelte'
  import CioShieldCheck from '@codeinoven/icons/CioShieldCheck.svelte'
  import { slide } from 'svelte/transition'
  import CardButton from '../shared/CardButton.svelte'
  import CardFoot from '../shared/CardFoot.svelte'
  import CardFrame from '../shared/CardFrame.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import { type CardChipData } from '../shared/CardTimer.svelte'
  import { dismissSlide, foldSlide } from '../shared/card-motion'
  import type { AuditReport, ProviderCatalog, ThreadSettings, ThinkingLevel } from '$shared/types'

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
    /** Removes one model from the recently-used history; shows the "x" on recent rows. */
    onRemoveRecent?: (modelKey: string) => void
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
    onRemoveRecent,
    onReorderFavorite
  }: Props = $props()

  let folded = $state(false)

  const chip: CardChipData = {
    text: 'Ready',
    title: 'The audit report is ready to read'
  }

  function chooseModel(
    providerId: string,
    modelId: string,
    nextHarnessId?: string,
    accountId?: string
  ): void {
    if (!settings) return
    onModelChange?.({
      ...settings,
      harnessId: nextHarnessId ?? settings.harnessId,
      accountId,
      providerId,
      modelId
    })
  }

  function chooseThinking(level: ThinkingLevel): void {
    if (!settings) return
    onModelChange?.({ ...settings, thinkingLevel: level })
  }

  function chooseRuntime(runtime: import('$shared/types').ModelRuntimeSettings): void {
    if (!settings) return
    onModelChange?.({ ...settings, ...runtime })
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

<div out:slide={dismissSlide()}>
  <CardFrame placement="replace" label="Auditor is done">
    <CardHead
      icon={CioShieldCheck}
      title="Auditor is done"
      {chip}
      bind:folded
      foldLabel="audit report"
    />

    {#if !folded}
      <div transition:slide={foldSlide()}>
        <div class="flex flex-col gap-1.5 px-3 py-2.5">
          <p class="text-xs leading-relaxed text-muted">
            Read the findings, add annotations, and send required changes to the primary agent.
          </p>
          <p class="text-[0.6875rem] text-dimmed">
            Audited by {report.provenance.providerId ?? 'provider'} /
            {report.provenance.modelId ?? 'model'}
          </p>
          {#if report.assignmentVersion !== undefined}
            <p class="text-[0.6875rem] font-medium text-muted">
              Assignment v{report.assignmentVersion} · {report.reworkCycle
                ? `Rework ${report.reworkCycle}`
                : 'Initial implementation'}
            </p>
          {/if}
        </div>

        <CardFoot>
          {#snippet left()}
            <CardButton
              label="Cancel"
              title="Cancel this audit cycle"
              variant="ghost"
              disabled={busy || !onCancel}
              onclick={cancelAudit}
            />
          {/snippet}
          {#snippet right()}
            {#if settings}
              <ModelPicker
                {providers}
                {projectId}
                harnessId={settings.harnessId}
                providerId={settings.providerId}
                modelId={settings.modelId}
                accountId={settings.accountId}
                {favoriteModels}
                {recentModels}
                {onRemoveRecent}
                side="top"
                label="Change"
                variant="action"
                onSelect={chooseModel}
                thinkingLevel={settings.thinkingLevel}
                runtimeSettings={settings}
                onSelectThinking={chooseThinking}
                onSelectRuntime={chooseRuntime}
                {onToggleFavorite}
                {onReorderFavorite}
              />
            {:else}
              <CardButton
                label="Change"
                title="Choose an auditor model before running another audit"
                variant="secondary"
                disabled
              />
            {/if}
            <CardButton
              label="Reaudit"
              title="Run the audit again with the selected auditor model"
              icon={CioRefresh}
              variant="secondary"
              disabled={busy || !settings || !onReaudit}
              onclick={() => settings && onReaudit?.(settings)}
            />
            <CardButton
              label="View report"
              title="View the audit report"
              icon={CioExternalLink}
              variant="secondary"
              onclick={viewReport}
            />
            {#if report.annotations.length === 0}
              <CardButton
                label="Complete"
                title="Complete this audit cycle"
                icon={CioCheck}
                variant="primary"
                disabled={busy || !onComplete}
                onclick={completeAudit}
              />
            {/if}
          {/snippet}
        </CardFoot>
      </div>
    {/if}
  </CardFrame>
</div>
