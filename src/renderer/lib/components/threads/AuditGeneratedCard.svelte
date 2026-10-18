<script lang="ts">
  import CioAlertCircle from '@pillardash-oss/cio-icon/CioAlertCircle.svelte'
  import CioExternalLink from '@pillardash-oss/cio-icon/CioExternalLink.svelte'
  import CioEye from '@pillardash-oss/cio-icon/CioEye.svelte'
  import CioFileCheck from '@pillardash-oss/cio-icon/CioFileCheck.svelte'
  import { slide } from 'svelte/transition'
  import CardButton from '../shared/CardButton.svelte'
  import CardFoot from '../shared/CardFoot.svelte'
  import CardFrame from '../shared/CardFrame.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import { type CardChipData } from '../shared/CardTimer.svelte'
  import { dismissSlide, foldSlide } from '../shared/card-motion'
  import { ElapsedTimer } from '$lib/elapsed.svelte'
  import { formatDurationMs } from '$lib/format/duration'
  import type { ProviderCatalog, Thread, ThreadSettings, ThinkingLevel } from '$shared/types'

  interface Props {
    state?: Thread['auditState'] | 'failed' | 'partial'
    version?: number
    error?: string
    /** Evidence gaps surfaced on a partial report (generated but not fully validated). */
    validationIssues?: string[]
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
    /** Removes one model from the recently-used history; shows the "x" on recent rows. */
    onRemoveRecent?: (modelKey: string) => void
    onReorderFavorite?: (
      draggedKey: string,
      targetKey: string,
      position: 'before' | 'after'
    ) => void
    onViewTrace?: () => void
    onViewReport: () => void
  }

  let {
    state: auditState,
    version,
    error,
    validationIssues = [],
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
    onRemoveRecent,
    onReorderFavorite,
    onViewTrace,
    onViewReport
  }: Props = $props()

  let folded = $state(false)
  let failed = $derived(auditState === 'failed')
  /** A report was generated, but some verification facts could not be matched
   *  to executed evidence in the auditor transcript. */
  let partial = $derived(auditState === 'partial')
  let invalidShapeRecovery = $derived(
    failed && error?.includes('Assignment audit made no progress after incremental correction')
  )
  let interrupted = $derived(auditState === 'offered')
  let reworking = $derived(auditState === 'reworking')
  let elapsed = $derived(
    startedAt !== undefined && finishedAt !== undefined
      ? formatDurationMs(Math.max(0, finishedAt - startedAt))
      : null
  )

  // A running audit owns a live clock: it counts only while the audit is
  // genuinely working, and freezes on the recorded end once it settles.
  const clock = new ElapsedTimer()
  const counting = $derived(
    (busy || auditState === 'running' || reworking) &&
      startedAt !== undefined &&
      finishedAt === undefined
  )
  $effect(() => {
    if (counting) clock.start()
    else {
      clock.stop()
      if (startedAt !== undefined && finishedAt === undefined) clock.snapshot()
    }
    return () => clock.stop()
  })
  const runSeconds = $derived(clock.seconds(startedAt, finishedAt))

  function formatClock(seconds: number): string {
    const minutes = Math.floor(seconds / 60)
    const remainder = seconds % 60
    return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
  }

  const headTitle = $derived(
    failed
      ? invalidShapeRecovery
        ? 'Auditor model needs recovery'
        : 'Audit failed'
      : interrupted
        ? 'Audit interrupted'
        : partial
          ? 'Report generated, evidence incomplete'
          : reworking
            ? 'Review sent to Sr. Engineer'
            : version === undefined
              ? reworkCycle
                ? `Rework ${reworkCycle} complete   audit running again`
                : 'Audit in progress'
              : `Report generated   Version ${version}`
  )

  const bodyText = $derived(
    failed
      ? invalidShapeRecovery
        ? 'The auditor model returned an invalid audit shape multiple times. Change the model and retry, or retry once more with the same model.'
        : error || 'The auditor failed without returning a usable error.'
      : interrupted
        ? error ||
          'The auditor could not finish. Choose another harness or model, then retry the audit.'
        : partial
          ? 'The auditor generated a report, but some verification facts could not be matched to executed commands in its transcript. View the report, ask the auditor to validate its facts, or change the model.'
          : reworking
            ? `The Sr. Engineer is reviewing audit report v${version ?? 1} and your feedback. It will either handle the correction directly or propose a new Assignment for your review.`
            : version === undefined
              ? reworkCycle
                ? 'The existing auditor is independently verifying the completed rework.'
                : 'This dedicated auditor task is locked while the report is being prepared.'
              : 'Review the rendered report, switch versions, and add annotations in Audit Studio.'
  )

  const headIcon = $derived(failed || interrupted || partial ? CioAlertCircle : CioFileCheck)
  const headTone = $derived(failed || interrupted || partial ? 'warn' : 'default')

  const chip = $derived.by<CardChipData>(() => {
    if (failed || interrupted) return { text: 'Stopped', tone: 'urgent' }
    if (partial) return { text: 'Waiting', tone: 'paused' }
    if (version !== undefined && !reworking) return { text: 'Ready' }
    if (startedAt !== undefined) {
      return { text: `Running ${formatClock(runSeconds)}`, title: 'Auditor runtime' }
    }
    return { text: 'Running', title: 'The auditor is working' }
  })

  function chooseModel(
    providerId: string,
    modelId: string,
    nextHarnessId?: string,
    accountId?: string
  ): void {
    onModelChange({
      ...settings,
      harnessId: nextHarnessId ?? settings.harnessId,
      accountId,
      providerId,
      modelId
    })
  }

  function chooseThinking(level: ThinkingLevel): void {
    onModelChange({ ...settings, thinkingLevel: level })
  }

  function chooseRuntime(runtime: import('$shared/types').ModelRuntimeSettings): void {
    onModelChange({ ...settings, ...runtime })
  }
</script>

<div out:slide={dismissSlide()}>
  <CardFrame placement="replace" label="Audit status">
    <CardHead
      icon={headIcon}
      title={headTitle}
      {chip}
      tone={headTone}
      bind:folded
      foldLabel="audit status"
    />

    {#if !folded}
      <div transition:slide={foldSlide()}>
        <div class="flex flex-col gap-2 px-3 py-2.5">
          <p
            class="text-xs leading-relaxed {failed
              ? 'text-danger'
              : partial
                ? 'text-warning'
                : 'text-muted'}"
            role={failed || partial ? 'alert' : undefined}
          >
            {bodyText}
          </p>
          {#if partial && validationIssues.length > 0}
            <details class="text-xs text-muted">
              <summary class="cursor-pointer font-medium text-foreground">
                Unvalidated verification facts
              </summary>
              <ul class="mt-2 list-disc space-y-1 pl-5 leading-relaxed">
                {#each validationIssues as issue (issue)}
                  <li>{issue}</li>
                {/each}
              </ul>
            </details>
          {/if}
          {#if failed && elapsed}
            <p class="text-[0.6875rem] tabular-nums text-dimmed">Auditor runtime: {elapsed}</p>
          {/if}
          {#if invalidShapeRecovery && error}
            <details class="text-xs text-muted">
              <summary class="cursor-pointer font-medium text-foreground"
                >Validation details</summary
              >
              <pre
                class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap bg-raised p-3 font-mono text-[0.6875rem] leading-relaxed text-muted">{error}</pre>
            </details>
          {/if}
        </div>

        <CardFoot>
          {#snippet right()}
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
              variant="action"
              disabled={busy || auditState === 'running'}
              onSelect={chooseModel}
              thinkingLevel={settings.thinkingLevel}
              runtimeSettings={settings}
              onSelectThinking={chooseThinking}
              onSelectRuntime={chooseRuntime}
              {onToggleFavorite}
              {onReorderFavorite}
            />
            {#if failed || interrupted}
              <CardButton
                label={retryLabel}
                title="Retry the audit"
                variant="primary"
                disabled={busy}
                loading={busy}
                onclick={() => onRetry(settings)}
              />
            {:else if partial}
              <CardButton
                label={retryLabel}
                title="Ask the auditor to re-run the unvalidated verification facts and update the report"
                variant="secondary"
                disabled={busy}
                loading={busy}
                onclick={() => onRetry(settings)}
              />
              <CardButton
                label="View report"
                title="Open this report in Audit Studio"
                icon={CioExternalLink}
                variant="primary"
                onclick={onViewReport}
              />
            {:else if auditState === 'running' && onViewTrace}
              <CardButton
                label="View trace"
                title="Open the durable auditor thread and its live working trace"
                icon={CioEye}
                variant="secondary"
                onclick={onViewTrace}
              />
            {:else if version !== undefined}
              <CardButton
                label={reworking ? 'View source report' : 'View report'}
                title={reworking
                  ? 'Open the source audit report'
                  : 'Open this report in Audit Studio'}
                icon={CioExternalLink}
                variant="primary"
                onclick={onViewReport}
              />
            {/if}
          {/snippet}
        </CardFoot>
      </div>
    {/if}
  </CardFrame>
</div>
