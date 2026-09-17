<script lang="ts">
  import { MessageSquarePlus } from '@lucide/svelte'
  import type {
    CapturableSpecContextType,
    EngineeringSpec,
    SpecAnnotation,
    SpecSectionId
  } from '$shared/types'
  import EditableMarkdown from './EditableMarkdown.svelte'
  import SpecStudioAnnotationBubbles from './SpecStudioAnnotationBubbles.svelte'
  import SpecStudioContextSection from './SpecStudioContextSection.svelte'
  import type { SpecStudioContextPickerController } from './spec-studio-context-picker.svelte'
  import SpecStudioEditableListSection from './SpecStudioEditableListSection.svelte'
  import SpecStudioEditableMiniList from './SpecStudioEditableMiniList.svelte'
  import SpecStudioResolutionSection from './SpecStudioResolutionSection.svelte'
  import type { SpecDraftEdits } from './spec-studio-draft-edits'

  type CallbackResult = void | Promise<void>

  interface Props {
    draft: EngineeringSpec
    edits: SpecDraftEdits
    busy: boolean
    contextPicker: SpecStudioContextPickerController
    onAnnotate: (section: SpecSectionId, event: MouseEvent) => void
    onAnnotateDiagram: (section: SpecSectionId, code: string, event: MouseEvent) => void
    onOpenAnnotation: (annotation: SpecAnnotation) => void
    onAddContext: (type: CapturableSpecContextType, selectedPath?: string) => CallbackResult
    onRemoveContext: (contextId: string) => CallbackResult
  }

  let {
    draft,
    edits,
    busy,
    contextPicker,
    onAnnotate,
    onAnnotateDiagram,
    onOpenAnnotation,
    onAddContext,
    onRemoveContext
  }: Props = $props()

  function annotationsFor(section: SpecSectionId): SpecAnnotation[] {
    return draft.annotations.filter(
      (annotation) => annotation.section === section && annotation.status === 'open'
    )
  }
</script>

<div class="px-6 py-6 md:px-14 md:py-8">
  <article class="space-y-12 text-[0.8125rem] leading-8">
    <section id="spec-section-tldr" class="scroll-mt-5">
      <h2 class="text-xl font-semibold tracking-tight">TL;DR</h2>
      <EditableMarkdown
        class="mt-3 whitespace-pre-wrap rounded-lg px-2 py-1 text-muted outline-none focus:bg-surface focus:text-foreground"
        text={draft.content.resolutionSummary}
        ariaLabel="Specification TL;DR"
        onChange={(value) => edits.setString('resolutionSummary', value)}
      />
    </section>

    <section id="spec-section-problem" data-spec-section="problem" class="scroll-mt-5">
      <button
        class="group flex items-center gap-2 text-left"
        title="Annotate the Problem section"
        onclick={(event: MouseEvent) => onAnnotate('problem', event)}
      >
        <span class="text-xl font-semibold tracking-tight">Problem</span>
        <MessageSquarePlus
          size={14}
          class="text-dimmed opacity-0 transition-opacity max-md:opacity-100 group-hover:opacity-100"
        />
      </button>
      <EditableMarkdown
        class="mt-3 whitespace-pre-wrap rounded-lg px-2 py-1 text-muted outline-none focus:bg-surface focus:text-foreground"
        text={draft.content.problem}
        ariaLabel="Problem statement"
        onChange={(value) => edits.setString('problem', value)}
      />
      <SpecStudioAnnotationBubbles
        annotations={annotationsFor('problem')}
        onOpen={onOpenAnnotation}
      />
    </section>

    <SpecStudioResolutionSection
      phases={draft.content.phases}
      annotations={annotationsFor('resolution')}
      {edits}
      onAnnotate={(section, event) => onAnnotate(section, event)}
      {onOpenAnnotation}
    />

    <SpecStudioEditableListSection
      id="success_criteria"
      title="Success criteria"
      items={draft.content.successCriteria}
      annotations={annotationsFor('success_criteria')}
      onHeading={onAnnotate}
      onEdit={(index, value) => edits.setArrayItem('successCriteria', index, value)}
      onAdd={() => edits.addArrayItem('successCriteria')}
      onRemove={(index) => edits.removeArrayItem('successCriteria', index)}
      {onOpenAnnotation}
    />

    <section id="spec-section-test_strategy" data-spec-section="test_strategy" class="scroll-mt-5">
      <button
        class="group flex items-center gap-2 text-left"
        title="Annotate Test strategy"
        onclick={(event: MouseEvent) => onAnnotate('test_strategy', event)}
      >
        <span class="text-xl font-semibold tracking-tight">Test strategy</span>
        <MessageSquarePlus
          size={14}
          class="text-dimmed opacity-0 transition-opacity max-md:opacity-100 group-hover:opacity-100"
        />
      </button>
      <EditableMarkdown
        class="mt-3 whitespace-pre-wrap rounded-lg px-2 py-1 text-muted outline-none focus:bg-surface focus:text-foreground"
        text={draft.content.testStrategy}
        ariaLabel="Test strategy"
        onChange={(value) => edits.setString('testStrategy', value)}
      />
      <SpecStudioAnnotationBubbles
        annotations={annotationsFor('test_strategy')}
        onOpen={onOpenAnnotation}
      />
    </section>

    <SpecStudioEditableListSection
      id="documentation"
      title="Documentation"
      items={draft.content.documentationRequirements}
      annotations={annotationsFor('documentation')}
      onHeading={onAnnotate}
      onEdit={(index, value) => edits.setArrayItem('documentationRequirements', index, value)}
      onAdd={() => edits.addArrayItem('documentationRequirements')}
      onRemove={(index) => edits.removeArrayItem('documentationRequirements', index)}
      {onOpenAnnotation}
    />

    {#if draft.content.additionalInfo !== undefined}
      <section
        id="spec-section-additional_info"
        data-spec-section="additional_info"
        class="scroll-mt-5"
      >
        <button
          class="group flex items-center gap-2 text-left"
          title="Annotate Additional info"
          onclick={(event: MouseEvent) => onAnnotate('additional_info', event)}
        >
          <span class="text-xl font-semibold tracking-tight">Additional info</span>
          <MessageSquarePlus
            size={14}
            class="text-dimmed opacity-0 transition-opacity max-md:opacity-100 group-hover:opacity-100"
          />
        </button>
        <EditableMarkdown
          class="mt-3 whitespace-pre-wrap rounded-lg px-2 py-1 text-muted outline-none focus:bg-surface focus:text-foreground"
          text={draft.content.additionalInfo}
          ariaLabel="Additional info"
          onChange={(value) => edits.setString('additionalInfo', value)}
          onAnnotateMermaid={(code, event) => onAnnotateDiagram('additional_info', code, event)}
        />
        <SpecStudioAnnotationBubbles
          annotations={annotationsFor('additional_info')}
          onOpen={onOpenAnnotation}
        />
      </section>
    {/if}

    <section
      id="spec-section-commit_pattern"
      data-spec-section="commit_pattern"
      class="scroll-mt-5"
    >
      <button
        class="group flex items-center gap-2 text-left"
        title="Annotate Commit pattern"
        onclick={(event: MouseEvent) => onAnnotate('commit_pattern', event)}
      >
        <span class="text-xl font-semibold tracking-tight">Commit pattern</span>
        <MessageSquarePlus
          size={14}
          class="text-dimmed opacity-0 transition-opacity max-md:opacity-100 group-hover:opacity-100"
        />
      </button>
      <EditableMarkdown
        class="mt-3 block rounded-lg bg-surface px-3 py-2 font-mono text-xs outline-none"
        text={draft.content.commitPattern}
        ariaLabel="Commit pattern"
        onChange={(value) => edits.setString('commitPattern', value)}
      />
      <SpecStudioAnnotationBubbles
        annotations={annotationsFor('commit_pattern')}
        onOpen={onOpenAnnotation}
      />
    </section>

    <section
      id="spec-section-constraints_risks"
      data-spec-section="constraints_risks"
      class="scroll-mt-5"
    >
      <button
        class="group flex items-center gap-2 text-left"
        title="Annotate Constraints and risks"
        onclick={(event: MouseEvent) => onAnnotate('constraints_risks', event)}
      >
        <span class="text-xl font-semibold tracking-tight">Constraints & risks</span>
        <MessageSquarePlus
          size={14}
          class="text-dimmed opacity-0 transition-opacity max-md:opacity-100 group-hover:opacity-100"
        />
      </button>
      <div class="mt-4 grid gap-5 sm:grid-cols-2">
        <SpecStudioEditableMiniList
          title="Constraints"
          items={draft.content.constraints}
          onEdit={(index, value) => edits.setArrayItem('constraints', index, value)}
          onAdd={() => edits.addArrayItem('constraints')}
          onRemove={(index) => edits.removeArrayItem('constraints', index)}
        />
        <SpecStudioEditableMiniList
          title="Risks"
          items={draft.content.risks}
          onEdit={(index, value) => edits.setArrayItem('risks', index, value)}
          onAdd={() => edits.addArrayItem('risks')}
          onRemove={(index) => edits.removeArrayItem('risks', index)}
        />
      </div>
      <SpecStudioAnnotationBubbles
        annotations={annotationsFor('constraints_risks')}
        onOpen={onOpenAnnotation}
      />
    </section>
  </article>

  <SpecStudioContextSection
    context={draft.context}
    decisionComments={draft.decisionComments ?? []}
    {busy}
    picker={contextPicker}
    {onAddContext}
    {onRemoveContext}
  />
</div>
