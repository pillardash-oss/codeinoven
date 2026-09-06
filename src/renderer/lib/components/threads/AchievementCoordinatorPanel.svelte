<script lang="ts">
  import { ArrowUpRight, Play, ShieldCheck, Target } from '@lucide/svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import ThreadRow from './ThreadRow.svelte'
  import type { ProviderCatalog, Thread, ThreadSettings, ThinkingLevel } from '$shared/types'

  interface Props {
    mode?: 'achievement' | 'audit'
    specTitle: string
    specSummary: string
    auditThread?: Thread
    auditState?: Thread['auditState']
    reportAvailable?: boolean
    /** The achievement loop verified the goal and closed itself; no further work remains. */
    achievementReached?: boolean
    selectedThreadId: string
    auditorSettings: ThreadSettings
    providers: ProviderCatalog[]
    projectId?: string | null
    favoriteModels?: string[]
    recentModels?: string[]
    coordinatorWorking: boolean
    onOpenAudit?: () => void
    onViewReport?: () => void
    onOpenThread: (thread: Thread) => void
    onResume?: () => void
    onModelChange: (settings: ThreadSettings) => void
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
    mode = 'achievement',
    specTitle,
    specSummary,
    auditThread,
    auditState,
    reportAvailable = false,
    achievementReached = false,
    selectedThreadId,
    auditorSettings,
    providers,
    projectId = null,
    favoriteModels = [],
    recentModels = [],
    coordinatorWorking,
    onOpenAudit,
    onViewReport,
    onOpenThread,
    onResume,
    onModelChange,
    onToggleFavorite,
    onRemoveRecent,
    onReorderFavorite
  }: Props = $props()

  let selectedAuditor = $derived.by(() => {
    const provider =
      providers.find(
        (candidate) =>
          candidate.id === auditorSettings.providerId &&
          candidate.harnessId === auditorSettings.harnessId
      ) ?? providers.find((candidate) => candidate.id === auditorSettings.providerId)
    const model = provider?.models.find((candidate) => candidate.id === auditorSettings.modelId)
    return { provider, model }
  })

  let auditRunning = $derived(auditState === 'running')
  let loopComplete = $derived(mode === 'achievement' && achievementReached)
  let coordinatorLabel = $derived(
    mode === 'achievement' ? 'Achievement coordinator' : 'Audit coordinator'
  )
  let modelLocked = $derived(auditRunning)
  let progress = $derived.by(() => {
    if (loopComplete) {
      return {
        label: 'Achievement reached',
        description: 'The auditor verified the goal. The achievement loop is complete.',
        tone: 'text-success'
      }
    }
    if (auditState === 'report_ready') {
      return {
        label: 'Audit report ready',
        description: 'Review the auditor findings and continue the feedback loop if needed.',
        tone: 'text-success'
      }
    }
    if (auditState === 'running') {
      return {
        label: 'Audit in progress',
        description: 'The dedicated auditor is checking the implementation against the spec.',
        tone: 'text-info'
      }
    }
    if (auditState === 'reworking') {
      return {
        label: 'Rework in progress',
        description: 'The Sr. Engineer is applying auditor feedback before the next audit.',
        tone: 'text-warning'
      }
    }
    if (auditState === 'offered') {
      return {
        label: 'Ready for audit',
        description: 'Implementation is ready. Confirm the auditor model and start the audit.',
        tone: 'text-warning'
      }
    }
    if (coordinatorWorking) {
      return {
        label: 'Implementation in progress',
        description: 'The Sr. Engineer is working toward the approved specification.',
        tone: 'text-info'
      }
    }
    return mode === 'achievement'
      ? {
          label: 'Coordination paused',
          description:
            'Resume the Sr. Engineer to continue implementation or evaluate the next audit.',
          tone: 'text-muted'
        }
      : {
          label: 'Audit coordinator ready',
          description: 'Choose the auditor model and start the durable implementation audit.',
          tone: 'text-muted'
        }
  })

  function chooseModel(providerId: string, modelId: string, harnessId: string): void {
    onModelChange({ ...auditorSettings, harnessId, providerId, modelId })
  }

  function chooseThinking(level: ThinkingLevel): void {
    onModelChange({ ...auditorSettings, thinkingLevel: level })
  }
</script>

<!--
  Docked into the context sidebar: the sidebar owns the width, the visibility,
  and the tab chrome, so this panel is just a column that fills whatever space
  it is given.
-->
<div
  class="achievement-coordinator-panel flex h-full min-h-0 flex-col"
  aria-label={coordinatorLabel}
>
  <header class="shrink-0 border-b border-border p-4">
    <div class="flex min-w-0 items-center gap-2 text-primary">
      {#if mode === 'achievement'}
        <Target size={15} class="shrink-0" />
      {:else}
        <ShieldCheck size={15} class="shrink-0" />
      {/if}
      <h2 class="text-xs font-semibold uppercase tracking-wide">{coordinatorLabel}</h2>
    </div>
    <p class="mt-3 text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed">Goal</p>
    <h3 class="mt-1 text-sm font-semibold text-foreground">{specTitle}</h3>
    <p class="mt-1 line-clamp-4 text-xs leading-relaxed text-muted">{specSummary}</p>
    <div class="mt-3 flex gap-2">
      {#if auditState === 'offered' && onOpenAudit}
        <button
          type="button"
          class="flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary hover:bg-primary-hover"
          title="Start an audit of the current implementation"
          onclick={onOpenAudit}
        >
          Audit work
          <ShieldCheck size={13} />
        </button>
      {/if}
      {#if reportAvailable && onViewReport}
        <button
          type="button"
          class="flex flex-1 items-center justify-center gap-2 rounded-lg border border-border bg-elevated px-3 py-2 text-xs font-semibold text-foreground hover:bg-overlay"
          title="Open the latest report in Audit Studio"
          onclick={onViewReport}
        >
          View report
          <ArrowUpRight size={13} />
        </button>
      {/if}
    </div>
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <section class="border-b border-border p-4" aria-label={`${coordinatorLabel} progress`}>
      <p class="text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed">Current state</p>
      <div class="mt-2 flex items-start gap-2">
        <span
          class="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-current {progress.tone}"
          aria-hidden="true"
        ></span>
        <div class="min-w-0">
          <p class="text-xs font-semibold {progress.tone}">{progress.label}</p>
          <p class="mt-1 text-xs leading-relaxed text-muted">{progress.description}</p>
        </div>
      </div>
      {#if onResume && !loopComplete && !coordinatorWorking && !auditRunning && auditState !== 'report_ready'}
        <button
          type="button"
          class="mt-3 flex h-8 w-full items-center justify-center gap-2 rounded-lg border border-border bg-elevated px-3 text-xs font-semibold text-foreground hover:bg-overlay"
          title="Ask the Sr. Engineer to continue working toward the achievement"
          onclick={onResume}
        >
          <Play size={12} />
          Resume coordination
        </button>
      {/if}
    </section>

    <section class="border-b border-border p-4" aria-label={`${coordinatorLabel} auditor model`}>
      <div class="flex items-start gap-3">
        <div class="rounded-lg bg-primary/10 p-2 text-primary">
          <ShieldCheck size={16} />
        </div>
        <div class="min-w-0 flex-1">
          <h3 class="text-xs font-semibold text-foreground">Auditor model</h3>
          <p class="mt-1 truncate text-xs text-muted">
            {selectedAuditor.model?.name ?? auditorSettings.modelId}
          </p>
          <p class="mt-0.5 truncate text-[0.625rem] text-dimmed">
            {selectedAuditor.provider?.name ?? auditorSettings.providerId}
          </p>
        </div>
      </div>
      <div class="mt-3">
        <ModelPicker
          {providers}
          {projectId}
          harnessId={auditorSettings.harnessId}
          providerId={auditorSettings.providerId}
          modelId={auditorSettings.modelId}
          {favoriteModels}
          {recentModels}
          {onRemoveRecent}
          side="bottom"
          disabled={modelLocked}
          label="Change model"
          variant="action"
          onSelect={chooseModel}
          thinkingLevel={auditorSettings.thinkingLevel}
          onSelectThinking={chooseThinking}
          {onToggleFavorite}
          {onReorderFavorite}
        />
      </div>
      {#if modelLocked}
        <p class="mt-2 text-[0.625rem] leading-relaxed text-dimmed">
          The auditor model can be changed before the next audit starts.
        </p>
      {/if}
    </section>

    <section class="py-3" aria-label={`${coordinatorLabel} audit thread`}>
      <h3 class="px-4 pb-2 text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed">
        Audit thread
      </h3>
      {#if auditThread}
        <div class="px-2">
          <ThreadRow
            thread={auditThread}
            compact
            selected={auditThread.id === selectedThreadId}
            showChangeScope={false}
            onOpen={onOpenThread}
          />
        </div>
      {:else}
        <p class="px-4 py-2 text-xs leading-relaxed text-muted">
          A durable audit thread will appear here when the first audit starts.
        </p>
      {/if}
    </section>
  </div>
</div>

<style>
  .achievement-coordinator-panel {
    container-type: inline-size;
  }
</style>
