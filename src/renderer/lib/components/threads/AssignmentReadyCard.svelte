<script lang="ts">
  import CioCheck from '@codeio/icon/CioCheck.svelte'
  import CioMaximize from '@codeio/icon/CioMaximize.svelte'
  import CioNetwork from '@codeio/icon/CioNetwork.svelte'
  import CioSave from '@codeio/icon/CioSave.svelte'
  import { slide } from 'svelte/transition'
  import AssignmentReviewContent from '../specs/AssignmentReviewContent.svelte'
  import CardButton from '../shared/CardButton.svelte'
  import CardFoot from '../shared/CardFoot.svelte'
  import CardFrame from '../shared/CardFrame.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import CardNotice from '../shared/CardNotice.svelte'
  import { type CardChipData } from '../shared/CardTimer.svelte'
  import { dismissSlide, foldSlide } from '../shared/card-motion'
  import type {
    AssignmentModelSelection,
    AssignmentPlan,
    AssignmentPlanContent,
    ProviderCatalog,
    ScopeChoice,
    Thread
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
    /** The Assignment-wide worker scope, the level above a phase and a task. */
    onWorkerScopeChange?: (scope: ScopeChoice) => void | Promise<void>
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
    /** Opens a dispatched task's current worker thread. */
    onOpenTaskThread?: (threadId: string) => void | Promise<void>
    /** Resolves a task's thread as it exists right now; undefined when the task
     *  is unassigned or its worker thread was deleted. */
    resolveTaskThread?: (threadId: string | undefined) => Thread | undefined
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
    onWorkerScopeChange,
    assignmentScopeBucketId,
    onToggleFavorite,
    onRemoveRecent,
    onReorderFavorite,
    onOpenTaskThread,
    resolveTaskThread
  }: Props = $props()

  // The card owns an editable snapshot until the user explicitly saves it.
  // svelte-ignore state_referenced_locally
  let draft = $state<AssignmentPlanContent>($state.snapshot(assignment.content))
  let folded = $state(false)

  const chip: CardChipData = {
    text: 'Draft',
    tone: 'paused',
    title: 'Nothing runs until you sign off'
  }
</script>

<div out:slide={dismissSlide()}>
  <CardFrame placement="replace" label="Assignment ready">
    <CardHead
      icon={CioNetwork}
      title="Assignment is ready"
      {chip}
      bind:folded
      foldLabel="assignment"
    >
      {#snippet meta()}
        <span class="min-w-0 truncate text-[0.6875rem] text-dimmed">
          Review assignment · Sr. Engineer execution graph · v{assignment.version}
        </span>
      {/snippet}
    </CardHead>

    {#if !folded}
      <div transition:slide={foldSlide()}>
        <div
          id={`assignment-review-${assignment.id}`}
          class="max-h-[32rem] overflow-y-auto px-3 py-2.5"
        >
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
            {onWorkerScopeChange}
            {assignmentScopeBucketId}
            {onToggleFavorite}
            {onReorderFavorite}
            {onOpenTaskThread}
            {resolveTaskThread}
          />

          {#if error}
            <CardNotice tone="danger" class="mt-2">{error}</CardNotice>
          {/if}
        </div>

        <CardFoot>
          {#snippet left()}
            <CardButton
              label="Save draft"
              title="Save the assignment draft"
              icon={CioSave}
              variant="secondary"
              disabled={busy}
              onclick={() => onSave($state.snapshot(draft))}
            />
          {/snippet}
          {#snippet right()}
            <CardButton
              label="Full screen"
              title="Open the assignment full screen"
              icon={CioMaximize}
              variant="secondary"
              onclick={onOpenFullscreen}
            />
            <CardButton
              label="Sign off & assign"
              title="Sign off the assignment and run it"
              icon={busy ? undefined : CioCheck}
              variant="primary"
              disabled={busy}
              loading={busy}
              onclick={() => onApprove($state.snapshot(draft))}
            />
          {/snippet}
        </CardFoot>
      </div>
    {/if}
  </CardFrame>
</div>
