<script lang="ts">
  import { Info, MessageSquarePlus } from '@lucide/svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import EditableMarkdown from './EditableMarkdown.svelte'
  import type {
    AssignmentAnnotation,
    AssignmentModelSelection,
    AssignmentPlanContent,
    AssignmentTask,
    ProviderCatalog,
    ThinkingLevel
  } from '$shared/types'

  interface Props {
    content: AssignmentPlanContent
    providers: ProviderCatalog[]
    projectId?: string | null
    harnessId: string
    fallbackModel: AssignmentModelSelection
    seniorModel: AssignmentModelSelection
    favoriteModels?: string[]
    recentModels?: string[]
    compact?: boolean
    readOnly?: boolean
    reworkCycle?: number
    forceRework?: boolean
    assignmentVersion?: number
    onChange: (content: AssignmentPlanContent) => void
    onWorkerModelChange?: (selection: AssignmentModelSelection) => void
    onSeniorModelChange?: (selection: AssignmentModelSelection) => void
    onTaskModelChange?: (
      taskId: string,
      selection: AssignmentModelSelection
    ) => void | Promise<void>
    onToggleFavorite?: (providerId: string, modelId: string, harnessId: string) => void
    /** Removes one model from the recently-used history; shows the "x" on recent rows. */
    onRemoveRecent?: (modelKey: string) => void
    onReorderFavorite?: (
      draggedKey: string,
      targetKey: string,
      position: 'before' | 'after'
    ) => void
    annotations?: AssignmentAnnotation[]
    onOpenAnnotation?: (annotation: AssignmentAnnotation) => void
    onAnnotateSection?: (section: string, title: string, event: MouseEvent) => void
  }

  let {
    content,
    providers,
    projectId = null,
    harnessId,
    fallbackModel,
    seniorModel,
    favoriteModels = [],
    recentModels = [],
    compact = false,
    readOnly = false,
    reworkCycle,
    forceRework = false,
    assignmentVersion,
    onChange,
    onWorkerModelChange,
    onSeniorModelChange,
    onTaskModelChange,
    onToggleFavorite,
    onRemoveRecent,
    onReorderFavorite,
    annotations = [],
    onOpenAnnotation,
    onAnnotateSection
  }: Props = $props()

  function graphMarkdown(): string {
    const lines = ['```mermaid', 'flowchart LR']
    for (const task of content.tasks) {
      lines.push(`  ${task.id}["${task.title.replace(/"/gu, "'")}"]`)
      for (const dependency of task.dependsOn) lines.push(`  ${dependency} --> ${task.id}`)
    }
    lines.push('```')
    return lines.join('\n')
  }

  function update(next: AssignmentPlanContent): void {
    if (readOnly) return
    onChange(next)
  }

  function phaseModel(phaseId: string): AssignmentModelSelection {
    return content.phases.find((phase) => phase.id === phaseId)?.defaultModel ?? fallbackModel
  }

  function resolvedTaskModel(task: AssignmentTask): AssignmentModelSelection {
    if (task.model) return task.model
    return task.owner === 'senior' ? seniorModel : phaseModel(task.phaseId)
  }

  function canUpdateTaskModel(task: AssignmentTask): boolean {
    if (!readOnly) return true
    return (
      onTaskModelChange !== undefined &&
      task.owner === 'worker' &&
      !task.threadId &&
      task.status !== 'completed' &&
      task.status !== 'stopped'
    )
  }

  function taskReworkCycle(task: AssignmentTask): number | undefined {
    if (task.workKind === 'rework') return task.reworkCycle ?? reworkCycle ?? 1
    return forceRework ? (reworkCycle ?? 1) : undefined
  }

  function updatePhaseModel(
    phaseId: string,
    providerId: string,
    modelId: string,
    nextHarnessId?: string,
    thinkingLevel?: ThinkingLevel
  ): void {
    const phaseIndex = content.phases.findIndex((phase) => phase.id === phaseId)
    if (phaseIndex < 0) return
    const current = phaseModel(phaseId)
    const selectedHarnessId = nextHarnessId ?? harnessId
    const selection: AssignmentModelSelection = {
      ...current,
      harnessId: selectedHarnessId,
      providerId,
      modelId,
      thinkingLevel: thinkingLevel ?? current.thinkingLevel
    }
    update({
      ...content,
      // A phase-model change governs that phase and every phase after it
      // (top to bottom). Phases above the changed phase keep their own model,
      // so a mid-list pick never bleeds upward or into other unstamped phases.
      phases: content.phases.map((phase, index) =>
        index < phaseIndex ? phase : { ...phase, defaultModel: selection }
      )
    })
    // Only the topmost phase doubles as the "default phase model" control:
    // changing it reflects from the top to the bottom and seeds the last-used
    // worker model. Deeper phase changes stay local to their own cascade.
    if (phaseIndex === 0) onWorkerModelChange?.(selection)
  }

  function updateTaskModel(
    taskId: string,
    providerId: string,
    modelId: string,
    nextHarnessId?: string,
    thinkingLevel?: ThinkingLevel
  ): void {
    const current = content.tasks.find((task) => task.id === taskId)
    if (!current) return
    const resolved = resolvedTaskModel(current)
    const selectedHarnessId = nextHarnessId ?? harnessId
    const selection: AssignmentModelSelection = {
      ...resolved,
      harnessId: selectedHarnessId,
      providerId,
      modelId,
      thinkingLevel: thinkingLevel ?? resolved.thinkingLevel
    }
    if (readOnly) {
      if (canUpdateTaskModel(current)) void onTaskModelChange?.(taskId, selection)
      return
    }
    update({
      ...content,
      tasks: content.tasks.map((task) => {
        if (task.id !== taskId) return task
        return {
          ...task,
          model: selection
        }
      })
    })
    // The task's own model is local to the task; worker-task edits never
    // mutate the shared worker default, which would drag every unstamped
    // phase along. Senior tasks still own the assignment-wide Sr. Engineer
    // model by design.
    if (current.owner === 'senior') onSeniorModelChange?.(selection)
  }

  function updateTaskText(
    taskId: string,
    field: 'title' | 'description' | 'prompt',
    value: string
  ): void {
    update({
      ...content,
      tasks: content.tasks.map((task) => (task.id === taskId ? { ...task, [field]: value } : task))
    })
  }

  function updatePhaseText(phaseId: string, field: 'title' | 'description', value: string): void {
    update({
      ...content,
      phases: content.phases.map((phase) =>
        phase.id === phaseId ? { ...phase, [field]: value } : phase
      )
    })
  }

  function annotationsFor(section: string): AssignmentAnnotation[] {
    return annotations.filter(
      (annotation) => annotation.section === section && annotation.status === 'open'
    )
  }
</script>

{#snippet AnnotationBubbles(section: string)}
  {@const sectionAnnotations = annotationsFor(section)}
  {#if sectionAnnotations.length && onOpenAnnotation}
    <div class="mt-3 flex gap-2 overflow-x-auto pb-1" aria-label="Anchored comments">
      {#each sectionAnnotations as annotation (annotation.id)}
        <button
          class="max-w-64 shrink-0 rounded-xl border bg-surface px-3 py-2 text-left hover:bg-elevated"
          title="Open anchored comment"
          onclick={() => onOpenAnnotation?.(annotation)}
        >
          <span class="line-clamp-2 block text-xs leading-relaxed">{annotation.body}</span>
          <span class="mt-1 block text-[10px] text-dimmed">{annotation.author}</span>
        </button>
      {/each}
    </div>
  {/if}
{/snippet}

<div class={compact ? 'space-y-4' : 'space-y-10'}>
  <section
    id="assignment-section-overview"
    data-assignment-section="overview"
    class="scroll-mt-5 space-y-3"
    aria-label="Assignment overview"
  >
    {#if !compact}
      <div class="flex items-center gap-2">
        <h2 class="text-xl font-semibold tracking-tight text-foreground">Assignment overview</h2>
        {#if !readOnly && onAnnotateSection}
          <button
            class="text-dimmed hover:text-primary"
            title="Annotate Assignment overview"
            aria-label="Annotate Assignment overview"
            onclick={(event: MouseEvent) =>
              onAnnotateSection?.('overview', 'Assignment overview', event)}
            ><MessageSquarePlus size={14} /></button
          >
        {/if}
      </div>
    {/if}
    <EditableMarkdown
      {readOnly}
      class="rounded-lg px-2 py-1 text-lg font-semibold text-foreground outline-none focus:bg-surface"
      text={content.title}
      fallback="Untitled assignment"
      ariaLabel="Assignment title"
      onChange={(value) => update({ ...content, title: value })}
    />
    <h3 class="text-sm font-semibold uppercase tracking-wide text-dimmed">TL;DR</h3>
    <EditableMarkdown
      {readOnly}
      class="rounded-lg px-2 py-1 text-sm leading-7 text-muted outline-none focus:bg-surface focus:text-foreground"
      text={content.summary}
      fallback="No assignment TL;DR."
      ariaLabel="Assignment TL;DR"
      onChange={(value) => update({ ...content, summary: value })}
    />
    {@render AnnotationBubbles('overview')}
  </section>

  <section
    id="assignment-section-graph"
    data-assignment-section="graph"
    class="scroll-mt-5 space-y-3"
    aria-label="Assignment execution graph"
  >
    {#if !compact}
      <div class="flex items-center gap-2">
        <h2 class="text-xl font-semibold tracking-tight text-foreground">Execution graph</h2>
        {#if !readOnly && onAnnotateSection}
          <button
            class="text-dimmed hover:text-primary"
            title="Annotate execution graph"
            aria-label="Annotate execution graph"
            onclick={(event: MouseEvent) => onAnnotateSection?.('graph', 'Execution graph', event)}
            ><MessageSquarePlus size={14} /></button
          >
        {/if}
      </div>
    {/if}
    <div class="rounded-lg border bg-elevated/50 p-2">
      <MarkdownView text={graphMarkdown()} />
    </div>
    {@render AnnotationBubbles('graph')}
  </section>

  {#each content.phases as phase (phase.id)}
    {@const selectedPhaseModel = phaseModel(phase.id)}
    <section
      id={`assignment-section-${phase.id}`}
      data-assignment-section={`phase:${phase.id}`}
      class="scroll-mt-5 space-y-3"
      aria-label={phase.title}
    >
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5">
            <EditableMarkdown
              {readOnly}
              class={compact
                ? 'truncate text-xs font-semibold uppercase tracking-wide text-muted outline-none focus:bg-surface'
                : 'text-xl font-semibold tracking-tight text-foreground outline-none focus:bg-surface'}
              text={phase.title}
              fallback="Untitled phase"
              ariaLabel={`Title for ${phase.id}`}
              onChange={(value) => updatePhaseText(phase.id, 'title', value)}
            />
            {#if phase.info}
              <button
                type="button"
                class="text-dimmed hover:text-foreground"
                title={phase.info}
                aria-label={`About ${phase.title}`}
              >
                <Info size={12} />
              </button>
            {/if}
            {#if !readOnly && onAnnotateSection}
              <button
                class="text-dimmed hover:text-primary"
                title={`Annotate ${phase.title}`}
                aria-label={`Annotate ${phase.title}`}
                onclick={(event: MouseEvent) =>
                  onAnnotateSection?.(`phase:${phase.id}`, phase.title, event)}
                ><MessageSquarePlus size={13} /></button
              >
            {/if}
          </div>
          <EditableMarkdown
            {readOnly}
            class="mt-1 text-sm leading-7 text-muted outline-none focus:bg-surface focus:text-foreground"
            text={phase.description}
            fallback="No phase description."
            ariaLabel={`Description for ${phase.title}`}
            onChange={(value) => updatePhaseText(phase.id, 'description', value)}
          />
          {@render AnnotationBubbles(`phase:${phase.id}`)}
        </div>
        {#if !readOnly}
          <div class="flex items-center gap-1.5">
            <ModelPicker
              {providers}
              {projectId}
              {harnessId}
              providerId={selectedPhaseModel.providerId}
              modelId={selectedPhaseModel.modelId}
              {favoriteModels}
              {recentModels}
              {onRemoveRecent}
              side="bottom"
              variant="action"
              label="Phase model"
              onSelect={(providerId, modelId, harnessId) =>
                updatePhaseModel(phase.id, providerId, modelId, harnessId)}
              {onToggleFavorite}
              {onReorderFavorite}
              thinkingLevel={selectedPhaseModel.thinkingLevel}
              onSelectThinking={(level) =>
                updatePhaseModel(
                  phase.id,
                  selectedPhaseModel.providerId,
                  selectedPhaseModel.modelId,
                  selectedPhaseModel.harnessId,
                  level
                )}
            />
          </div>
        {/if}
      </div>

      <div class="space-y-3">
        {#each content.tasks.filter((task) => task.phaseId === phase.id) as task (task.id)}
          {@const selectedTaskModel = resolvedTaskModel(task)}
          {@const displayedReworkCycle = taskReworkCycle(task)}
          <article
            id={`assignment-task-${task.id}`}
            data-assignment-section={`task:${task.id}`}
            class="scroll-mt-5 space-y-2 rounded-lg border bg-surface p-3"
            title={`${task.title} · ${task.workerName ?? (task.owner === 'senior' ? 'Sr. Engineer' : 'Unassigned')}`}
          >
            <div class="flex items-start gap-2">
              <EditableMarkdown
                {readOnly}
                class="min-w-0 flex-1 text-sm font-semibold text-foreground outline-none focus:bg-elevated"
                text={task.title}
                fallback="Untitled task"
                ariaLabel={`Title for task ${task.id}`}
                onChange={(value) => updateTaskText(task.id, 'title', value)}
              />
              {#if task.info}
                <button
                  type="button"
                  class="shrink-0 text-dimmed hover:text-foreground"
                  title={task.info}
                  aria-label={`About ${task.title}`}
                >
                  <Info size={12} />
                </button>
              {/if}
              {#if !readOnly && onAnnotateSection}
                <button
                  class="shrink-0 text-dimmed hover:text-primary"
                  title={`Annotate ${task.title}`}
                  aria-label={`Annotate ${task.title}`}
                  onclick={(event: MouseEvent) =>
                    onAnnotateSection?.(`task:${task.id}`, task.title, event)}
                  ><MessageSquarePlus size={13} /></button
                >
              {/if}
              <span class="rounded bg-overlay px-1.5 py-0.5 text-[10px] text-muted">
                {task.owner === 'senior' ? 'Sr. Engineer' : 'Worker'}
              </span>
              {#if displayedReworkCycle}
                <span
                  class="rounded bg-warning/10 px-1.5 py-0.5 text-[10px] font-semibold text-warning"
                >
                  Rework {displayedReworkCycle} · Assignment v{task.workAssignmentVersion ??
                    assignmentVersion ??
                    '?'}
                </span>
              {/if}
            </div>
            <EditableMarkdown
              {readOnly}
              class="text-sm leading-7 text-muted outline-none focus:bg-elevated focus:text-foreground"
              text={task.description}
              fallback="No task description."
              ariaLabel={`Description for ${task.title}`}
              onChange={(value) => updateTaskText(task.id, 'description', value)}
            />
            <details class="rounded-md bg-elevated/60 px-2 py-1.5">
              <summary class="cursor-pointer text-[10px] font-semibold uppercase text-dimmed">
                Worker prompt
              </summary>
              <EditableMarkdown
                {readOnly}
                class="mt-2 min-h-20 w-full text-xs leading-6 text-muted outline-none focus:bg-surface focus:text-foreground"
                text={task.prompt}
                fallback="No worker prompt."
                ariaLabel={`Worker prompt for ${task.title}`}
                onChange={(value) => updateTaskText(task.id, 'prompt', value)}
              />
            </details>
            <div class="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
              <p class="text-[10px] text-dimmed">
                Waits for: {task.dependsOn.join(', ') || 'nothing'}
              </p>
              {#if canUpdateTaskModel(task)}
                <div class="flex items-center gap-1.5">
                  <ModelPicker
                    {providers}
                    {projectId}
                    {harnessId}
                    providerId={selectedTaskModel.providerId}
                    modelId={selectedTaskModel.modelId}
                    {favoriteModels}
                    {recentModels}
                    {onRemoveRecent}
                    side="top"
                    variant="action"
                    label={task.model ? 'Task model' : 'Use phase model'}
                    onSelect={(providerId, modelId, harnessId) =>
                      updateTaskModel(task.id, providerId, modelId, harnessId)}
                    {onToggleFavorite}
                    {onReorderFavorite}
                    thinkingLevel={selectedTaskModel.thinkingLevel}
                    onSelectThinking={(level) =>
                      updateTaskModel(
                        task.id,
                        selectedTaskModel.providerId,
                        selectedTaskModel.modelId,
                        selectedTaskModel.harnessId,
                        level
                      )}
                  />
                </div>
              {/if}
            </div>
            {@render AnnotationBubbles(`task:${task.id}`)}
          </article>
        {/each}
      </div>
    </section>
  {/each}
</div>
