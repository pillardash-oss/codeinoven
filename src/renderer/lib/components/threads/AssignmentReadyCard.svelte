<script lang="ts">
  import { Check, ChevronDown, Loader2, Maximize2, Network, Save } from '@lucide/svelte'
  import { slide } from 'svelte/transition'
  import AssignmentReviewContent from '../specs/AssignmentReviewContent.svelte'
  import { dismissSlide, foldSlide } from '../shared/card-motion'
  import type {
    AssignmentModelSelection,
    AssignmentPlan,
    AssignmentPlanContent,
    ProviderCatalog,
    ScopeChoice
  } from '$shared/types'

  interface Props {
    assignment: AssignmentPlan
    providers: ProviderCatalog[]
    projectId?: string | null
    harnessId: string
    fallbackModel: AssignmentModelSelection
    seniorModel: AssignmentModelSelection
    favoriteModels?: string[]
    recentModels?: string[]
    busy?: boolean
    error?: string
    onSave: (content: AssignmentPlanContent) => void
    onApprove: (content: AssignmentPlanContent) => void
    onOpenFullscreen: () => void
    onWorkerModelChange?: (selection: AssignmentModelSelection) => void
    onSeniorModelChange?: (selection: AssignmentModelSelection) => void
    onTaskScopeChange?: (taskId: string, scope: ScopeChoice) => void | Promise<void>
    /** The Assignment's own scope, i.e. what an `inherit` choice resolves to. */
    assignmentScopeBucketId?: string
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
    assignment,
    providers,
    projectId = null,
    harnessId,
    fallbackModel,
    seniorModel,
    favoriteModels = [],
    recentModels = [],
    busy = false,
    error = '',
    onSave,
    onApprove,
    onOpenFullscreen,
    onWorkerModelChange,
    onSeniorModelChange,
    onTaskScopeChange,
    assignmentScopeBucketId,
    onToggleFavorite,
    onRemoveRecent,
    onReorderFavorite
  }: Props = $props()

  // The card owns an editable snapshot until the user explicitly saves it.
  // svelte-ignore state_referenced_locally
  let draft = $state<AssignmentPlanContent>($state.snapshot(assignment.content))
  let expanded = $state(true)
</script>

<section
  out:slide={dismissSlide()}
  class="overflow-hidden rounded-xl border bg-surface shadow-sm"
  aria-label="Assignment ready"
>
  <button
    type="button"
    class="flex w-full items-center justify-between gap-3 border-b px-4 py-3 text-left hover:bg-elevated/60"
    aria-expanded={expanded}
    aria-controls={`assignment-review-${assignment.id}`}
    title={expanded ? 'Fold assignment' : 'Expand assignment'}
    onclick={() => (expanded = !expanded)}
  >
    <div class="flex min-w-0 items-center gap-2">
      <Network size={16} class="shrink-0 text-primary" />
      <div class="min-w-0">
        <p class="truncate text-sm font-semibold text-foreground">Assignment is ready</p>
        <p class="text-[0.6875rem] text-muted">
          Review assignment · Sr. Engineer execution graph · version {assignment.version}
        </p>
      </div>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <span
        class="rounded-md bg-primary/10 px-2 py-1 text-[0.625rem] font-semibold uppercase text-primary"
      >
        {assignment.status}
      </span>
      <ChevronDown
        size={14}
        class="text-dimmed transition-transform {expanded ? '' : 'rotate-180'}"
      />
    </div>
  </button>

  {#if expanded}
    <div id={`assignment-review-${assignment.id}`} transition:slide={foldSlide()}>
      <div class="max-h-[32rem] overflow-y-auto p-4">
        <AssignmentReviewContent
          content={draft}
          {providers}
          {projectId}
          {harnessId}
          {fallbackModel}
          {seniorModel}
          {favoriteModels}
          {recentModels}
          {onRemoveRecent}
          compact
          onChange={(content) => (draft = content)}
          {onWorkerModelChange}
          {onSeniorModelChange}
          {onTaskScopeChange}
          {assignmentScopeBucketId}
          {onToggleFavorite}
          {onReorderFavorite}
        />

        {#if error}
          <p class="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>
        {/if}
      </div>

      <div class="flex items-center justify-between gap-2 border-t px-4 py-3">
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-muted hover:bg-elevated hover:text-foreground"
          title="Review assignment full screen"
          onclick={onOpenFullscreen}
        >
          <Maximize2 size={13} />
          Full screen
        </button>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-lg border bg-elevated px-3 py-2 text-xs font-semibold text-muted hover:text-foreground disabled:opacity-40"
            disabled={busy}
            onclick={() => onSave($state.snapshot(draft))}
          >
            <Save size={13} />
            Save draft
          </button>
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary disabled:opacity-40"
            disabled={busy}
            onclick={() => onApprove($state.snapshot(draft))}
          >
            {#if busy}<Loader2 size={13} class="animate-spin" />{:else}<Check size={13} />{/if}
            Sign off & assign
          </button>
        </div>
      </div>
    </div>
  {/if}
</section>
