<script lang="ts">
  import { ArrowUpRight, ChevronUp, Play, ShieldCheck, Target } from '@lucide/svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import ThreadRow from './ThreadRow.svelte'
  import type { ProviderCatalog, Thread, ThreadSettings } from '$shared/types'

  interface Props {
    specTitle: string
    specSummary: string
    auditThread?: Thread
    auditState?: Thread['auditState']
    reportAvailable?: boolean
    selectedThreadId: string
    width: number
    auditorSettings: ThreadSettings
    providers: ProviderCatalog[]
    projectId?: string | null
    favoriteModels?: string[]
    recentModels?: string[]
    coordinatorWorking: boolean
    onOpenAudit?: () => void
    onViewReport?: () => void
    onOpenThread: (thread: Thread) => void
    onResume: () => void
    onModelChange: (settings: ThreadSettings) => void
    onToggleFavorite?: (providerId: string, modelId: string, harnessId: string) => void
    onReorderFavorite?: (
      draggedKey: string,
      targetKey: string,
      position: 'before' | 'after'
    ) => void
    onWidthChange: (width: number) => void
  }

  let {
    specTitle,
    specSummary,
    auditThread,
    auditState,
    reportAvailable = false,
    selectedThreadId,
    width,
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
    onReorderFavorite,
    onWidthChange
  }: Props = $props()

  const WIDTH_STORAGE_KEY = 'codeinoven:achievement-coordinator-width'
  const COLLAPSED_STORAGE_KEY = 'codeinoven:achievement-coordinator-collapsed'
  const MIN_WIDTH = 280
  const MAX_WIDTH = 560

  let collapsed = $state(() => localStorage.getItem(COLLAPSED_STORAGE_KEY) === '1')

  let resizing = $state(false)
  let resizePointerId = 0
  let resizeStartX = 0
  let resizeStartWidth = 0
  let resizeCurrentWidth = 0

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
  let modelLocked = $derived(auditRunning)
  let progress = $derived.by(() => {
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
    return {
      label: 'Coordination paused',
      description: 'Resume the Sr. Engineer to continue implementation or evaluate the next audit.',
      tone: 'text-muted'
    }
  })

  function clampWidth(nextWidth: number): number {
    const viewportMaximum = Math.max(MIN_WIDTH, window.innerWidth - 480)
    return Math.min(Math.max(nextWidth, MIN_WIDTH), Math.min(MAX_WIDTH, viewportMaximum))
  }

  function restoreWidth(): void {
    const stored = Number.parseInt(localStorage.getItem(WIDTH_STORAGE_KEY) ?? '', 10)
    if (Number.isFinite(stored)) onWidthChange(clampWidth(stored))
  }

  function toggleCollapsed(): void {
    collapsed = !collapsed
    localStorage.setItem(COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0')
  }

  function startResize(event: PointerEvent & { currentTarget: HTMLButtonElement }): void {
    resizing = true
    resizePointerId = event.pointerId
    resizeStartX = event.clientX
    resizeStartWidth = width
    resizeCurrentWidth = width
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function resize(event: PointerEvent): void {
    if (!resizing || event.pointerId !== resizePointerId) return
    resizeCurrentWidth = clampWidth(resizeStartWidth + resizeStartX - event.clientX)
    onWidthChange(resizeCurrentWidth)
  }

  function finishResize(event: PointerEvent): void {
    if (!resizing || event.pointerId !== resizePointerId) return
    resizing = false
    localStorage.setItem(WIDTH_STORAGE_KEY, String(resizeCurrentWidth))
  }

  function resizeWithKeyboard(event: KeyboardEvent): void {
    const step = event.shiftKey ? 48 : 16
    const nextWidth =
      event.key === 'ArrowLeft' ? width + step : event.key === 'ArrowRight' ? width - step : null
    if (nextWidth === null) return
    event.preventDefault()
    resizeCurrentWidth = clampWidth(nextWidth)
    onWidthChange(resizeCurrentWidth)
    localStorage.setItem(WIDTH_STORAGE_KEY, String(resizeCurrentWidth))
  }

  function chooseModel(providerId: string, modelId: string, harnessId: string): void {
    onModelChange({ ...auditorSettings, harnessId, providerId, modelId })
  }
</script>

<aside
  {@attach restoreWidth}
  class="achievement-coordinator-panel absolute inset-y-0 right-0 z-10 flex min-h-0 flex-col border-l border-border bg-surface"
  class:select-none={resizing}
  style:width={`${width}px`}
  aria-label="Achievement coordinator"
>
  {#if !collapsed}
    <button
      type="button"
      class="absolute inset-y-0 left-0 z-20 w-1.5 -translate-x-1/2 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-primary/30 focus:bg-primary/30 focus:outline-none"
      title="Resize Achievement coordinator"
      aria-label="Resize Achievement coordinator"
      onpointerdown={startResize}
      onpointermove={resize}
      onpointerup={finishResize}
      onpointercancel={finishResize}
      onkeydown={resizeWithKeyboard}
    ></button>
  {/if}

  <header class="shrink-0 border-b border-border p-4">
    <div class="flex items-center justify-between gap-2">
      <div class="flex min-w-0 items-center gap-2 text-primary">
        <Target size={15} class="shrink-0" />
        <h2 class="text-xs font-semibold uppercase tracking-wide">Achievement coordinator</h2>
      </div>
      <button
        type="button"
        class="flex shrink-0 items-center justify-center rounded-md p-1 text-muted transition-colors hover:bg-elevated hover:text-foreground"
        class:rotate-180={collapsed}
        title={collapsed ? 'Expand Achievement coordinator' : 'Collapse Achievement coordinator'}
        aria-label={collapsed
          ? 'Expand Achievement coordinator'
          : 'Collapse Achievement coordinator'}
        aria-expanded={!collapsed}
        onclick={toggleCollapsed}
      >
        <ChevronUp size={15} />
      </button>
    </div>
    {#if !collapsed}
      <h3 class="mt-3 text-sm font-semibold text-foreground">{specTitle}</h3>
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
    {/if}
  </header>

  {#if !collapsed}
    <div class="min-h-0 flex-1 overflow-y-auto">
      <section class="border-b border-border p-4" aria-label="Achievement progress">
        <p class="text-[10px] font-semibold uppercase tracking-wide text-dimmed">Current state</p>
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
        {#if !coordinatorWorking && !auditRunning && auditState !== 'report_ready'}
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

      <section class="border-b border-border p-4" aria-label="Achievement auditor model">
        <div class="flex items-start gap-3">
          <div class="rounded-lg bg-primary/10 p-2 text-primary">
            <ShieldCheck size={16} />
          </div>
          <div class="min-w-0 flex-1">
            <h3 class="text-xs font-semibold text-foreground">Auditor model</h3>
            <p class="mt-1 truncate text-xs text-muted">
              {selectedAuditor.model?.name ?? auditorSettings.modelId}
            </p>
            <p class="mt-0.5 truncate text-[10px] text-dimmed">
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
            side="bottom"
            disabled={modelLocked}
            label="Change model"
            variant="action"
            onSelect={chooseModel}
            {onToggleFavorite}
            {onReorderFavorite}
          />
        </div>
        {#if modelLocked}
          <p class="mt-2 text-[10px] leading-relaxed text-dimmed">
            The auditor model can be changed before the next audit starts.
          </p>
        {/if}
      </section>

      <section class="py-3" aria-label="Achievement audit thread">
        <h3 class="px-4 pb-2 text-[10px] font-semibold uppercase tracking-wide text-dimmed">
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
  {/if}
</aside>

<style>
  .achievement-coordinator-panel {
    container-type: inline-size;
  }
</style>
