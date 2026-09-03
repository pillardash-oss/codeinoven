<script lang="ts">
  import {
    ArrowRight,
    Check,
    MessageSquare,
    Network
  } from '@lucide/svelte'
  import { onDestroy, onMount, tick } from 'svelte'
  import AssignmentReviewContent from './AssignmentReviewContent.svelte'
  import { speechController } from '../../speech/speech-controller.svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import StudioDocumentNavigation from './StudioDocumentNavigation.svelte'
  import StudioShell from './StudioShell.svelte'
  import type { StudioShellSection } from './StudioShell.svelte'
  import StudioSidebarFileActions from './StudioSidebarFileActions.svelte'
  import StudioVersionBar from './StudioVersionBar.svelte'
  import StudioPendingAnnotationPopover from './StudioPendingAnnotationPopover.svelte'
  import StudioAnnotationDetailPopover from './StudioAnnotationDetailPopover.svelte'
  import { compactViewport } from '$lib/compact-viewport.svelte'
  import { editorPreference } from '$lib/stores/editor-preference.svelte'
  import { validateAssignment } from '$shared/assignment/assignment-validation'
  import { exportAssignmentMarkdown } from '$shared/assignment/assignment-markdown'
  import {
    offsetsForQuote,
    offsetsForRange,
    rangeForAnnotation,
    waitForScrollSettle
  } from './studio-annotation-anchors'
  import type { StudioDocumentHistory } from './studio-document-history.svelte'
  import type {
    AssignmentAnnotation,
    AssignmentModelSelection,
    AssignmentPlan,
    AssignmentPlanContent,
    ProviderCatalog
  } from '$shared/types'

  type CallbackResult = void | Promise<void>

  interface Props {
    assignment: AssignmentPlan
    threadId: string
    versions?: AssignmentPlan[]
    providers: ProviderCatalog[]
    harnessId: string
    fallbackModel: AssignmentModelSelection
    seniorModel: AssignmentModelSelection
    favoriteModels?: string[]
    recentModels?: string[]
    busy?: boolean
    error?: string
    readOnly?: boolean
    focusTaskId?: string
    agentMessagesOpen?: boolean
    brainstormAvailable?: boolean
    prdAvailable?: boolean
    auditAvailable?: boolean
    auditActive?: boolean
    finalComplete?: boolean
    history: StudioDocumentHistory<AssignmentPlanContent>
    onBack: () => void
    onOpenBrainstorm?: () => void
    onOpenPrd?: () => void
    onOpenSpec: () => void
    onToggleAgentMessages: () => void
    onOpenAudit?: () => void
    onOpenAuditWork?: () => void
    onSelectVersion?: (version: number) => void
    onSave: (content: AssignmentPlanContent) => Promise<boolean>
    onApprove: (content: AssignmentPlanContent) => CallbackResult
    onOpenInEditor: (content: AssignmentPlanContent) => CallbackResult
    onRevealInAppFile: (content: AssignmentPlanContent) => CallbackResult
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
    onAddAnnotation?: (
      section: string,
      body: string,
      anchor: {
        quote: string
        startOffset: number
        endOffset: number
      }
    ) => Promise<AssignmentPlan | null>
    onUpdateAnnotation?: (annotationId: string, body: string) => Promise<AssignmentPlan | null>
    onResolveAnnotation?: (annotationId: string) => Promise<AssignmentPlan | null>
    onExplainSelection?: (selection: string, documentContext: string) => void
    onQuickChatSelection?: (selection: string, documentContext: string) => void
  }

  let {
    assignment,
    threadId,
    versions = [],
    providers,
    harnessId,
    fallbackModel,
    seniorModel,
    favoriteModels = [],
    recentModels = [],
    busy = false,
    error = '',
    readOnly = false,
    focusTaskId,
    agentMessagesOpen = false,
    brainstormAvailable = false,
    prdAvailable = false,
    auditAvailable = false,
    auditActive = false,
    finalComplete = false,
    history,
    onBack,
    onOpenBrainstorm,
    onOpenPrd,
    onOpenSpec,
    onToggleAgentMessages,
    onOpenAudit,
    onOpenAuditWork,
    onSelectVersion,
    onSave,
    onApprove,
    onOpenInEditor,
    onRevealInAppFile,
    onWorkerModelChange,
    onSeniorModelChange,
    onTaskModelChange,
    onToggleFavorite,
    onRemoveRecent,
    onReorderFavorite,
    onAddAnnotation,
    onUpdateAnnotation,
    onResolveAnnotation,
    onExplainSelection,
    onQuickChatSelection
  }: Props = $props()

  let preferredName = $derived(editorPreference.preferredInfo?.name ?? 'System Default')
  let selectedSection = $state('overview')
  /** Phone only: the section rail is a bottom drawer instead of a column. */
  let sectionsOpen = $state(false)
  // The effect reconciles a saved assignment version with the local editing buffer.
  // svelte-ignore state_referenced_locally
  let draft = $state<AssignmentPlanContent>(history.attach($state.snapshot(assignment.content)))
  // svelte-ignore state_referenced_locally
  let loadedAssignmentKey = $state(`${assignment.id}:${assignment.version}:${assignment.updatedAt}`)
  // svelte-ignore state_referenced_locally
  let dirty = $state(history.dirty)
  let savePending = $state(false)
  let documentScroller = $state<HTMLElement | null>(null)
  let documentContent = $state<HTMLElement | null>(null)
  let markerResizeObserver: ResizeObserver | null = null
  let focusedTaskId = $state<string | undefined>()
  // The effect below reconciles later Assignment versions into this local annotation buffer.
  // svelte-ignore state_referenced_locally
  let annotations = $state<AssignmentAnnotation[]>($state.snapshot(assignment.annotations ?? []))
  let pendingAnnotation = $state<{
    section: string
    quote: string
    startOffset: number
    endOffset: number
    x: number
    y: number
    sectionLevel: boolean
  } | null>(null)
  let annotationBody = $state('')
  let editingAnnotation = $state<AssignmentAnnotation | null>(null)
  let editingAnnotationBody = $state('')
  const pendingSpeechTargetId = `assignment-annotation-${crypto.randomUUID()}`
  const speechScope = $derived({
    kind: 'project',
    projectId: assignment.projectId,
    threadId
  } as const)

  let editingAnnotationPosition = $state<{ x: number; y: number } | null>(null)
  let annotationMarkers = $state<Array<{ annotation: AssignmentAnnotation; x: number; y: number }>>(
    []
  )
  const ASSIGNMENT_ANNOTATION_HIGHLIGHT = 'assignment-annotation-anchor'

  const validation = $derived(validateAssignment(draft))
  const sections = $derived([
    {
      id: 'overview',
      label: 'Overview',
      count: draft.tasks.length,
      comments: annotationCount('overview')
    },
    {
      id: 'graph',
      label: 'Execution graph',
      count: draft.tasks.length,
      comments: annotationCount('graph')
    },
    ...draft.phases.map((phase) => ({
      id: phase.id,
      label: phase.title,
      count: draft.tasks.filter((task) => task.phaseId === phase.id).length,
      comments:
        annotationCount(`phase:${phase.id}`) +
        draft.tasks
          .filter((task) => task.phaseId === phase.id)
          .reduce((total, task) => total + annotationCount(`task:${task.id}`), 0)
    }))
  ])

  // Sidebar headings mirror the review sections; badges show open comment counts.
  const shellSections = $derived<StudioShellSection<string>[]>(
    sections.map((section) => ({
      id: section.id,
      title: section.label,
      badges: section.comments
        ? [{ count: section.comments, tone: 'info', label: 'open comments' }]
        : undefined
    }))
  )

  const openAnnotationCount = $derived(
    annotations.filter((annotation) => annotation.status === 'open').length
  )

  /** Open annotations for a sidebar section: the section itself, its phase, or its tasks. */
  function sectionAnnotations(sectionId: string): AssignmentAnnotation[] {
    const isPhase = draft.phases.some((phase) => phase.id === sectionId)
    return annotations.filter((annotation) => {
      if (annotation.status !== 'open') return false
      if (annotation.section === sectionId) return true
      if (!isPhase) return false
      if (annotation.section === `phase:${sectionId}`) return true
      if (!annotation.section.startsWith('task:')) return false
      const taskId = annotation.section.slice('task:'.length)
      return draft.tasks.some((task) => task.id === taskId && task.phaseId === sectionId)
    })
  }

  function annotationCount(section: string): number {
    return annotations.filter(
      (annotation) => annotation.section === section && annotation.status === 'open'
    ).length
  }

  $effect(() => {
    const nextKey = `${assignment.id}:${assignment.version}:${assignment.updatedAt}`
    if (nextKey !== loadedAssignmentKey) {
      loadedAssignmentKey = nextKey
      annotations = $state.snapshot(assignment.annotations ?? [])
      if (history.dirty) return
      history.markSaved($state.snapshot(assignment.content))
      draft = $state.snapshot(assignment.content)
      dirty = false
    }
  })

  $effect(() => {
    annotations
      .map((annotation) => `${annotation.id}:${annotation.status}:${annotation.body}`)
      .join('|')
    void refreshAnnotationMarkers()
  })

  $effect(() => {
    const nextTaskId = focusTaskId
    if (!nextTaskId || nextTaskId === focusedTaskId) return
    focusedTaskId = nextTaskId
    void selectTaskAndScroll(nextTaskId)
  })

  function updateDraft(content: AssignmentPlanContent): void {
    draft = content
    history.record($state.snapshot(draft))
    dirty = history.dirty
    void refreshAnnotationMarkers()
  }

  function undoEdit(): void {
    const previous = history.undo($state.snapshot(draft))
    if (!previous) return
    draft = $state.snapshot(previous)
    dirty = history.dirty
    closePendingAnnotation()
    editingAnnotation = null
    editingAnnotationPosition = null
    void refreshAnnotationMarkers()
  }

  function redoEdit(): void {
    const next = history.redo($state.snapshot(draft))
    if (!next) return
    draft = $state.snapshot(next)
    dirty = history.dirty
    closePendingAnnotation()
    editingAnnotation = null
    editingAnnotationPosition = null
    void refreshAnnotationMarkers()
  }

  async function saveDraft(): Promise<void> {
    if (readOnly || !dirty || savePending) return
    savePending = true
    try {
      const saved = await onSave($state.snapshot(draft))
      if (saved) {
        history.markSaved($state.snapshot(draft))
        dirty = history.dirty
      }
    } finally {
      savePending = false
    }
  }

  async function signOff(): Promise<void> {
    if (readOnly || !validation.valid || busy) return
    await onApprove($state.snapshot(draft))
  }

  async function selectTaskAndScroll(taskId: string): Promise<void> {
    const task = draft.tasks.find((candidate) => candidate.id === taskId)
    if (!task) return
    selectedSection = task.phaseId
    await tick()
    const target = document.getElementById(`assignment-task-${taskId}`)
    if (!target || !documentScroller) return
    const scrollerTop = documentScroller.getBoundingClientRect().top
    const targetTop = target.getBoundingClientRect().top
    documentScroller.scrollTo({
      top: documentScroller.scrollTop + targetTop - scrollerTop - 20,
      behavior: 'smooth'
    })
  }

  function captureDocumentSelection(): void {
    if ((readOnly || !onAddAnnotation) && (!onExplainSelection || !onQuickChatSelection)) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)
    const commonNode =
      range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement
    const sectionElement = commonNode?.closest<HTMLElement>('[data-assignment-section]')
    const section = sectionElement?.dataset.assignmentSection
    const quote = selection.toString().trim()
    if (!sectionElement || !section || !quote) return
    const rect = range.getBoundingClientRect()
    pendingAnnotation = {
      section,
      quote,
      ...offsetsForRange(sectionElement, range),
      x: Math.max(12, Math.min(rect.left, window.innerWidth - 396)),
      y: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 272)),
      sectionLevel: false
    }
    annotationBody = ''
  }

  function openSectionAnnotation(section: string, title: string, event: MouseEvent): void {
    if (readOnly || !onAddAnnotation) return
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) return
    const sectionElement = document.querySelector<HTMLElement>(
      `[data-assignment-section="${CSS.escape(section)}"]`
    )
    const rect =
      event.currentTarget instanceof HTMLElement
        ? event.currentTarget.getBoundingClientRect()
        : { left: event.clientX, bottom: event.clientY }
    pendingAnnotation = {
      section,
      quote: title,
      ...offsetsForQuote(sectionElement, title),
      x: Math.max(12, Math.min(rect.left, window.innerWidth - 396)),
      y: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 272)),
      sectionLevel: true
    }
    annotationBody = ''
  }

  function applyAssignment(updated: AssignmentPlan): void {
    annotations = $state.snapshot(updated.annotations ?? [])
    loadedAssignmentKey = `${updated.id}:${updated.version}:${updated.updatedAt}`
  }

  async function submitAnnotation(): Promise<void> {
    const anchor = pendingAnnotation
    const body = annotationBody.trim()
    if (!anchor || !body || !onAddAnnotation) return
    if (dirty) {
      const saved = await onSave($state.snapshot(draft))
      if (!saved) return
      dirty = false
      await tick()
    }
    const updated = await onAddAnnotation(anchor.section, body, {
      quote: anchor.quote,
      startOffset: anchor.startOffset,
      endOffset: anchor.endOffset
    })
    if (!updated) return
    speechController.observeSent(pendingSpeechTargetId, body)
    applyAssignment(updated)
    closePendingAnnotation()
    const added = [...(updated.annotations ?? [])]
      .reverse()
      .find(
        (annotation) =>
          annotation.section === anchor.section &&
          annotation.body === body &&
          annotation.quote === anchor.quote
      )
    if (added) await openAnnotation(added)
  }

  function closePendingAnnotation(): void {
    window.getSelection()?.removeAllRanges()
    pendingAnnotation = null
    annotationBody = ''
  }

  function openSelectionChat(mode: 'explain' | 'quick'): void {
    const selection = pendingAnnotation
    if (!selection || selection.sectionLevel) return
    const documentContext = exportAssignmentMarkdown({
      ...assignment,
      content: $state.snapshot(draft),
      annotations: $state.snapshot(annotations)
    })
    if (mode === 'explain') onExplainSelection?.(selection.quote, documentContext)
    else onQuickChatSelection?.(selection.quote, documentContext)
    closePendingAnnotation()
  }

  async function refreshAnnotationMarkers(): Promise<void> {
    await tick()
    const scroller = documentScroller
    if (!scroller) return
    const scrollerRect = scroller.getBoundingClientRect()
    annotationMarkers = annotations.flatMap((annotation) => {
      if (annotation.status !== 'open') return []
      const section = document.querySelector<HTMLElement>(
        `[data-assignment-section="${CSS.escape(annotation.section)}"]`
      )
      const range = section ? rangeForAnnotation(section, annotation) : null
      const rect = range?.getBoundingClientRect() ?? section?.getBoundingClientRect()
      if (!rect) return []
      return [
        {
          annotation,
          x: Math.max(4, rect.right - scrollerRect.left + scroller.scrollLeft + 6),
          y: Math.max(4, rect.top - scrollerRect.top + scroller.scrollTop)
        }
      ]
    })
  }

  async function openAnnotation(annotation: AssignmentAnnotation): Promise<void> {
    window.getSelection()?.removeAllRanges()
    CSS.highlights?.delete(ASSIGNMENT_ANNOTATION_HIGHLIGHT)
    editingAnnotation = null
    editingAnnotationPosition = null
    if (annotation.section.startsWith('phase:')) {
      selectedSection = annotation.section.slice('phase:'.length)
    } else if (annotation.section.startsWith('task:')) {
      const taskId = annotation.section.slice('task:'.length)
      selectedSection = draft.tasks.find((task) => task.id === taskId)?.phaseId ?? selectedSection
    } else {
      selectedSection = annotation.section
    }
    const section = document.querySelector<HTMLElement>(
      `[data-assignment-section="${CSS.escape(annotation.section)}"]`
    )
    const range = section ? rangeForAnnotation(section, annotation) : null
    const initialRect = range?.getBoundingClientRect() ?? section?.getBoundingClientRect()
    if (documentScroller && initialRect) {
      const scrollerRect = documentScroller.getBoundingClientRect()
      const top =
        documentScroller.scrollTop +
        initialRect.top -
        scrollerRect.top -
        (documentScroller.clientHeight - initialRect.height) / 2
      documentScroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
      await waitForScrollSettle(documentScroller)
    }
    await refreshAnnotationMarkers()
    await tick()
    const marker = document.querySelector<HTMLElement>(
      `[data-assignment-annotation-marker="${CSS.escape(annotation.id)}"]`
    )
    const rect = marker?.getBoundingClientRect() ?? range?.getBoundingClientRect() ?? initialRect
    if (range && typeof Highlight !== 'undefined' && CSS.highlights) {
      CSS.highlights.set(ASSIGNMENT_ANNOTATION_HIGHLIGHT, new Highlight(range))
    }
    editingAnnotation = annotation
    editingAnnotationBody = annotation.body
    editingAnnotationPosition = rect
      ? {
          x: Math.max(12, Math.min(rect.right + 8, window.innerWidth - 332)),
          y: Math.max(12, Math.min(rect.top, window.innerHeight - 288))
        }
      : { x: 12, y: 12 }
  }

  async function saveAnnotationEdit(): Promise<void> {
    if (!editingAnnotation || !editingAnnotationBody.trim() || !onUpdateAnnotation) return
    const updated = await onUpdateAnnotation(editingAnnotation.id, editingAnnotationBody.trim())
    if (!updated) return
    speechController.observeSent(
      `assignment-annotation-edit-${editingAnnotation.id}`,
      editingAnnotationBody.trim()
    )
    applyAssignment(updated)
    editingAnnotation =
      (updated.annotations ?? []).find((item) => item.id === editingAnnotation?.id) ?? null
  }

  async function resolveAnnotation(annotationId: string): Promise<void> {
    if (!onResolveAnnotation) return
    const updated = await onResolveAnnotation(annotationId)
    if (updated) applyAssignment(updated)
    CSS.highlights?.delete(ASSIGNMENT_ANNOTATION_HIGHLIGHT)
    editingAnnotation = null
    editingAnnotationPosition = null
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (readOnly || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return
    event.preventDefault()
    void saveDraft()
  }

  onMount(() => {
    if (!documentContent) return
    markerResizeObserver = new ResizeObserver(() => void refreshAnnotationMarkers())
    markerResizeObserver.observe(documentContent)
  })

  onDestroy(() => {
    markerResizeObserver?.disconnect()
    CSS.highlights?.delete(ASSIGNMENT_ANNOTATION_HIGHLIGHT)
  })
</script>

<svelte:window
  onkeydown={handleWindowKeydown}
  onresize={() => void refreshAnnotationMarkers()}
/>

<StudioShell
  ariaLabel="Assignment studio"
  scrollerLabel="Assignment review"
  sidebarTitle="Assignment"
  sidebarLabel="Assignment sections"
  sectionAnchorPrefix="assignment-section"
  sections={shellSections}
  bind:selectedSection
  bind:sectionsOpen
  bind:scroller={documentScroller}
  {openAnnotationCount}
  annotationsTitle="Anchored comments"
  annotationsEmptyLabel="No open comments in this section."
  sectionAnnotations={sectionAnnotations}
  onOpenAnnotation={(annotation) => void openAnnotation(annotation)}
  {error}
  onScrollerMouseUp={captureDocumentSelection}
>
  {#snippet navigation()}
    <StudioDocumentNavigation
      active="assignment"
      {brainstormAvailable}
      {prdAvailable}
      assignmentAvailable
      {auditAvailable}
      {agentMessagesOpen}
      {onBack}
      {onToggleAgentMessages}
      {sectionsOpen}
      sectionsLabel="assignment sections"
      onToggleSections={() => (sectionsOpen = !sectionsOpen)}
      {onOpenBrainstorm}
      {onOpenPrd}
      {onOpenSpec}
      {onOpenAudit}
    />
  {/snippet}

  {#snippet center()}
    <StudioVersionBar
      versions={[...versions]
        .sort((left, right) => right.version - left.version)
        .map((version) => ({ version: version.version, status: version.status }))}
      currentVersion={assignment.version}
      updatedAt={assignment.updatedAt}
      statusLabel={assignment.status}
      statusClass="bg-primary/10 text-primary"
      {dirty}
      canUndo={history.canUndo}
      canRedo={history.canRedo}
      canSave={!readOnly}
      {busy}
      {savePending}
      versionMenuTitle="Choose an assignment version"
      versionItemTitle={(version) => `Open assignment version ${version}`}
      onSelectVersion={onSelectVersion}
      onUndo={undoEdit}
      onRedo={redoEdit}
      onSave={() => void saveDraft()}
    />
  {/snippet}

  {#snippet actions()}
    {#if readOnly && auditActive && !finalComplete && onOpenAuditWork}
      <button
        class="rounded-lg border bg-elevated px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-overlay"
        title="Open the Assignment audit work"
        onclick={onOpenAuditWork}
      >
        Audit Work
      </button>
    {:else if !readOnly}
      <button
        class="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
        disabled={busy || !validation.valid}
        title="Sign off this assignment and create worker tasks"
        onclick={() => void signOff()}
      >
        Sign off & assign
        <ArrowRight size={13} />
      </button>
    {/if}
  {/snippet}

  {#snippet sidebarExtra()}
    <div class="border-t p-3">
      <div class="flex items-center justify-between gap-2">
        <p class="text-[10px] font-semibold uppercase tracking-wide text-muted">
          Assignment checks
        </p>
        <span
          class="text-[10px] tabular-nums {validation.issues.length ? 'text-danger' : 'text-dimmed'}"
        >
          {validation.issues.length}
        </span>
      </div>
      <div class="mt-2 space-y-1.5">
        {#each validation.issues as issue (`${issue.code}:${issue.path}`)}
          <div class="rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-2">
            <p class="text-xs leading-relaxed text-foreground">{issue.message}</p>
            <p class="mt-0.5 truncate font-mono text-[9px] text-dimmed" title={issue.path}>
              {issue.path}
            </p>
          </div>
        {:else}
          <div class="flex items-center gap-2 rounded-lg border border-dashed px-2.5 py-3">
            <Check size={13} class="text-primary" />
            <p class="text-[11px] text-dimmed">Ready to assign.</p>
          </div>
        {/each}
      </div>
    </div>
  {/snippet}

  {#snippet sidebarFooter()}
    <StudioSidebarFileActions
      viewTitle="Reveal this assignment as Markdown in the file tree"
      openTitle={`Open this assignment as Markdown in ${preferredName}`}
      {busy}
      onReveal={() => onRevealInAppFile($state.snapshot(draft))}
      onOpen={() => onOpenInEditor($state.snapshot(draft))}
    />
  {/snippet}

  {#snippet markers()}
    {#each annotationMarkers as marker (marker.annotation.id)}
      <button
        class="absolute z-20 flex h-7 w-7 items-center justify-center rounded-full border border-primary/30 bg-surface text-primary shadow-md hover:bg-elevated"
        style:left={compactViewport.matches ? undefined : `${marker.x}px`}
        style:top={`${marker.y}px`}
        data-assignment-annotation-marker={marker.annotation.id}
        title="Open anchored comment"
        aria-label="Open anchored comment"
        onclick={() => void openAnnotation(marker.annotation)}
      >
        <MessageSquare size={13} />
      </button>
    {/each}
  {/snippet}

      <div bind:this={documentContent} class="mx-auto max-w-4xl px-4 py-6 md:px-8 md:py-8">
        <div class="mb-6 flex items-center gap-2">
          <Network size={18} class="text-primary" />
          <p class="text-sm font-semibold text-foreground">Sr. Engineer execution plan</p>
        </div>
        <AssignmentReviewContent
          content={draft}
          {readOnly}
          reworkCycle={assignment.auditCycle?.reworkCycle}
          forceRework={assignment.auditCycle?.reworkAssignmentVersion === assignment.version}
          assignmentVersion={assignment.version}
          {providers}
          {harnessId}
          {fallbackModel}
          {seniorModel}
          {favoriteModels}
          {recentModels}
          {onRemoveRecent}
          {annotations}
          onOpenAnnotation={(annotation) => void openAnnotation(annotation)}
          onAnnotateSection={openSectionAnnotation}
          onChange={updateDraft}
          {onWorkerModelChange}
          {onSeniorModelChange}
          {onTaskModelChange}
          {onToggleFavorite}
          {onReorderFavorite}
        />
      </div>
</StudioShell>

{#if pendingAnnotation}
  <StudioPendingAnnotationPopover
    position={{ x: pendingAnnotation.x, y: pendingAnnotation.y }}
    quote={pendingAnnotation.quote}
    canAnnotate={!readOnly && onAddAnnotation !== undefined}
    showSelectionActions={!pendingAnnotation.sectionLevel}
    {busy}
    speechTargetId={pendingSpeechTargetId}
    dialogLabel={pendingAnnotation.sectionLevel
      ? 'Annotate assignment section'
      : !readOnly && onAddAnnotation
        ? 'Comment on assignment selection'
        : 'Actions for assignment selection'}
    headerLabel={pendingAnnotation.sectionLevel
      ? 'Annotate section'
      : !readOnly && onAddAnnotation
        ? 'Comment on selection'
        : 'Selection'}
    editorLabel="Assignment annotation"
    bind:body={annotationBody}
    scope={speechScope}
    onSubmit={() => void submitAnnotation()}
    onCancel={closePendingAnnotation}
    onExplain={onExplainSelection ? () => openSelectionChat('explain') : undefined}
    onQuickChat={onQuickChatSelection ? () => openSelectionChat('quick') : undefined}
  />
{/if}

{#if editingAnnotation && editingAnnotationPosition}
  <StudioAnnotationDetailPopover
    position={editingAnnotationPosition}
    annotation={editingAnnotation}
    canEdit={!readOnly}
    editorMode={!readOnly}
    headerLabel="Anchored comment"
    dialogLabel="Anchored assignment comment"
    speechTargetId={`assignment-annotation-edit-${editingAnnotation.id}`}
    scope={speechScope}
    bind:body={editingAnnotationBody}
    onResolve={() => {
      if (editingAnnotation) void resolveAnnotation(editingAnnotation.id)
    }}
    onSave={saveAnnotationEdit}
    onClose={() => {
      CSS.highlights?.delete(ASSIGNMENT_ANNOTATION_HIGHLIGHT)
      editingAnnotation = null
      editingAnnotationPosition = null
    }}
  >
    {#snippet bodyView(annotation)}
      <div class="mt-3 text-xs leading-relaxed text-foreground">
        <MarkdownView text={annotation.body} />
      </div>
    {/snippet}
  </StudioAnnotationDetailPopover>
{/if}
