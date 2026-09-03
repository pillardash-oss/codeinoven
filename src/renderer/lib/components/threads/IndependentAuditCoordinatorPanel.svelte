<script lang="ts">
  import { ArrowUpRight, FileSearch, ShieldCheck } from '@lucide/svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import ThreadRow from './ThreadRow.svelte'
  import type { ProviderCatalog, Thread, ThreadSettings, ThinkingLevel } from '$shared/types'

  interface Props {
    /** True while an independent audit run is in flight. */
    running?: boolean
    auditThread?: Thread
    reportAvailable?: boolean
    selectedThreadId: string
    auditorSettings: ThreadSettings
    providers: ProviderCatalog[]
    projectId?: string | null
    favoriteModels?: string[]
    recentModels?: string[]
    onOpenAudit?: () => void
    onViewReport?: () => void
    onOpenThread: (thread: Thread) => void
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
    running = false,
    auditThread,
    reportAvailable = false,
    selectedThreadId,
    auditorSettings,
    providers,
    projectId = null,
    favoriteModels = [],
    recentModels = [],
    onOpenAudit,
    onViewReport,
    onOpenThread,
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

  let progress = $derived.by(() => {
    if (running) {
      return {
        label: 'Independent audit in progress',
        description:
          'The auditor is judging the thread work against its transcript and verifying it in the repository.',
        tone: 'text-info'
      }
    }
    if (reportAvailable) {
      return {
        label: 'Audit report ready',
        description: 'Review the auditor findings in Spec Studio or run another audit.',
        tone: 'text-success'
      }
    }
    return {
      label: 'Audit coordinator ready',
      description: 'Choose the auditor model and start the independent audit.',
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
<div class="independent-audit-panel flex h-full min-h-0 flex-col" aria-label="Audit coordinator">
  <header class="shrink-0 border-b border-border p-4">
    <div class="flex min-w-0 items-center gap-2 text-primary">
      <ShieldCheck size={15} class="shrink-0" />
      <h2 class="text-xs font-semibold uppercase tracking-wide">Audit coordinator</h2>
    </div>
    <p class="mt-3 text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed">Scope</p>
    <h3 class="mt-1 text-sm font-semibold text-foreground">Independent audit</h3>
    <p class="mt-1 text-xs leading-relaxed text-muted">
      The auditor judges the work from this thread's requests and outputs, then verifies it
      against the repository with read-only checks.
    </p>
    <div class="mt-3 flex gap-2">
      {#if !running && onOpenAudit}
        <button
          type="button"
          class="flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary hover:bg-primary-hover"
          title="Start an independent audit of the current thread work"
          onclick={onOpenAudit}
        >
          Run audit
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
    <section class="border-b border-border p-4" aria-label="Independent audit progress">
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
    </section>

    <section class="border-b border-border p-4" aria-label="Independent auditor model">
      <div class="flex items-start gap-3">
        <div class="rounded-lg bg-primary/10 p-2 text-primary">
          <FileSearch size={16} />
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
          disabled={running}
          label="Change model"
          variant="action"
          onSelect={chooseModel}
          thinkingLevel={auditorSettings.thinkingLevel}
          onSelectThinking={chooseThinking}
          {onToggleFavorite}
          {onReorderFavorite}
        />
      </div>
      {#if running}
        <p class="mt-2 text-[0.625rem] leading-relaxed text-dimmed">
          The auditor model can be changed before the next audit starts.
        </p>
      {/if}
    </section>

    <section class="py-3" aria-label="Independent audit thread">
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
  .independent-audit-panel {
    container-type: inline-size;
  }
</style>
