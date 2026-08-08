<script lang="ts">
  import {
    AlertCircle,
    AppWindow,
    ArrowRight,
    Check,
    FileText,
    MessageSquare,
    Network,
    Save,
    X
  } from '@lucide/svelte'
  import { onDestroy, onMount, tick } from 'svelte'
  import AssignmentReviewContent from './AssignmentReviewContent.svelte'
  import RichMarkdownEditor from '../shared/RichMarkdownEditor.svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import StudioDocumentNavigation from './StudioDocumentNavigation.svelte'
  import StudioSidebarResizeHandle from './StudioSidebarResizeHandle.svelte'
  import { compactViewport } from '$lib/compact-viewport.svelte'
  import { editorPreference } from '$lib/stores/editor-preference.svelte'
  import { validateAssignment } from '$shared/assignment/assignment-validation'
  import {
    offsetsForQuote,
    offsetsForRange,
    rangeForAnnotation,
    waitForScrollSettle
  } from './studio-annotation-anchors'
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
    versions?: AssignmentPlan[]
    providers: ProviderCatalog[]
    harnessId: string
    fallbackModel: AssignmentModelSelection
    favoriteModels?: string[]
    recentModels?: string[]
    busy?: boolean
    error?: string
    readOnly?: boolean
    focusTaskId?: string
    agentMessagesOpen?: boolean
    brainstormAvailable?: boolean
    auditAvailable?: boolean
    auditActive?: boolean
    finalComplete?: boolean
    onBack: () => void
    onOpenBrainstorm?: () => void
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
    onTaskModelChange?: (
      taskId: string,
      selection: AssignmentModelSelection
    ) => void | Promise<void>
    onToggleFavorite?: (providerId: string, modelId: string) => void
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
  }

  let {
    assignment,
    versions = [],
    providers,
    harnessId,
    fallbackModel,
    favoriteModels = [],
    recentModels = [],
    busy = false,
    error = '',
    readOnly = false,
    focusTaskId,
    agentMessagesOpen = false,
    brainstormAvailable = false,
    auditAvailable = false,
    auditActive = false,
    finalComplete = false,
    onBack,
    onOpenBrainstorm,
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
    onTaskModelChange,
    onToggleFavorite,
    onReorderFavorite,
    onAddAnnotation,
    onUpdateAnnotation,
    onResolveAnnotation
  }: Props = $props()

  let preferredIcon = $derived(editorPreference.preferredInfo?.iconDataUrl)
  let preferredName = $derived(editorPreference.preferredInfo?.name ?? 'System Default')
  let selectedSection = $state('overview')
  /** Phone only: the section rail is a bottom drawer instead of a column. */
  let sectionsOpen = $state(false)
  // The effect reconciles a saved assignment version with the local editing buffer.
  // svelte-ignore state_referenced_locally
  let draft = $state<AssignmentPlanContent>($state.snapshot(assignment.content))
  // svelte-ignore state_referenced_locally
  let loadedAssignmentKey = $state(`${assignment.id}:${assignment.version}:${assignment.updatedAt}`)
  let dirty = $state(false)
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
  } | null>(null)
  let annotationBody = $state('')
  let editingAnnotation = $state<AssignmentAnnotation | null>(null)
  let editingAnnotationBody = $state('')
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

  function annotationCount(section: string): number {
    return annotations.filter(
      (annotation) => annotation.section === section && annotation.status === 'open'
    ).length
  }

  $effect(() => {
    const nextKey = `${assignment.id}:${assignment.version}:${assignment.updatedAt}`
    if (nextKey !== loadedAssignmentKey) {
      draft = $state.snapshot(assignment.content)
      annotations = $state.snapshot(assignment.annotations ?? [])
      loadedAssignmentKey = nextKey
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
    dirty = true
    void refreshAnnotationMarkers()
  }

  async function saveDraft(): Promise<void> {
    if (readOnly || !dirty || savePending) return
    savePending = true
    try {
      const saved = await onSave($state.snapshot(draft))
      if (saved) dirty = false
    } finally {
      savePending = false
    }
  }

  async function signOff(): Promise<void> {
    if (readOnly || !validation.valid || busy) return
    await onApprove($state.snapshot(draft))
  }

  async function selectAndScroll(sectionId: string): Promise<void> {
    sectionsOpen = false
    selectedSection = sectionId
    await tick()
    const target = document.getElementById(`assignment-section-${sectionId}`)
    if (!target || !documentScroller) return
    const scrollerTop = documentScroller.getBoundingClientRect().top
    const targetTop = target.getBoundingClientRect().top
    documentScroller.scrollTo({
      top: documentScroller.scrollTop + targetTop - scrollerTop - 20,
      behavior: 'smooth'
    })
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
    if (readOnly || !onAddAnnotation) return
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
      x: Math.max(12, Math.min(rect.left, window.innerWidth - 304)),
      y: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 224))
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
      x: Math.max(12, Math.min(rect.left, window.innerWidth - 304)),
      y: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 224))
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
    applyAssignment(updated)
    pendingAnnotation = null
    annotationBody = ''
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

  function formatDate(timestamp: number): string {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(timestamp)
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

<svelte:window onkeydown={handleWindowKeydown} onresize={() => void refreshAnnotationMarkers()} />

<section class="flex h-full min-h-0 flex-col bg-app" aria-label="Assignment studio">
  <header class="shrink-0 border-b bg-surface">
    <div
      class="flex flex-col gap-2 px-2 py-2 md:grid md:min-h-12 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-center md:gap-3 md:px-3 md:py-0"
    >
      <div class="flex min-w-0 items-center gap-2">
        <StudioDocumentNavigation
          active="assignment"
          {brainstormAvailable}
          assignmentAvailable
          {auditAvailable}
          {agentMessagesOpen}
          {onBack}
          {onToggleAgentMessages}
          {sectionsOpen}
          sectionsLabel="assignment sections"
          onToggleSections={() => (sectionsOpen = !sectionsOpen)}
          {onOpenBrainstorm}
          {onOpenSpec}
          {onOpenAudit}
        />
      </div>

      <div
        class="flex items-center gap-2 text-[11px] text-muted max-md:flex-wrap md:justify-center"
      >
        {#if versions.length > 1 && onSelectVersion}
          <label class="sr-only" for="assignment-version">Assignment version</label>
          <select
            id="assignment-version"
            class="rounded-md border bg-elevated px-2 py-1 text-xs text-foreground"
            value={assignment.version}
            onchange={(event: Event & { currentTarget: HTMLSelectElement }) =>
              onSelectVersion?.(Number(event.currentTarget.value))}
          >
            {#each [...versions].sort((left, right) => right.version - left.version) as version (version.version)}
              <option value={version.version}>Version {version.version}</option>
            {/each}
          </select>
        {/if}
        <span>Updated {formatDate(assignment.updatedAt)}</span>
        <span
          class="rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary"
        >
          {assignment.status}
        </span>
        {#if dirty && !readOnly}
          <button
            class="flex items-center gap-1 rounded-md border bg-elevated px-2 py-1 text-[11px] font-medium hover:bg-overlay disabled:opacity-50"
            disabled={busy || savePending}
            title="Save assignment changes (Cmd/Ctrl+S)"
            onclick={() => void saveDraft()}
          >
            <Save size={11} />
            Save
          </button>
        {/if}
      </div>

      <div class="flex items-center gap-1.5 max-md:*:h-10 max-md:*:flex-1 md:justify-end">
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
      </div>
    </div>

    {#if error}
      <p
        class="flex items-start gap-1.5 border-t bg-danger/10 px-4 py-2 text-xs text-danger"
        role="alert"
      >
        <AlertCircle size={14} class="mt-0.5 shrink-0" />
        {error}
      </p>
    {/if}
  </header>

  <div
    class="flex min-h-0 flex-1 flex-col overflow-hidden md:grid md:grid-cols-[13rem_minmax(0,1fr)]"
  >
    {#if sectionsOpen}
      <div
        class="fixed inset-0 z-40 bg-black/50 md:hidden"
        role="presentation"
        onclick={() => (sectionsOpen = false)}
      ></div>
    {/if}
    <aside
      class="relative flex min-h-0 flex-col border-r bg-surface max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:z-50 max-md:max-h-[80dvh] max-md:rounded-t-2xl max-md:border-r-0 max-md:border-t max-md:pb-[env(safe-area-inset-bottom)] max-md:shadow-2xl {sectionsOpen
        ? ''
        : 'max-md:hidden'}"
      aria-label="Assignment sections"
    >
      <StudioSidebarResizeHandle sidebarLabel="Assignment sections" />
      <div class="flex h-12 shrink-0 items-center justify-between border-b px-3 md:hidden">
        <p class="text-[10px] font-semibold uppercase tracking-[0.16em] text-dimmed">Assignment</p>
        <button
          class="flex h-9 w-9 items-center justify-center rounded-lg text-muted"
          aria-label="Close sections"
          title="Close sections"
          onclick={() => (sectionsOpen = false)}
        >
          <X size={16} />
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div class="space-y-0.5 p-2" role="tablist" aria-orientation="vertical">
          {#each sections as section (section.id)}
            <button
              class="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors max-md:py-3 {selectedSection ===
              section.id
                ? 'bg-elevated font-semibold text-foreground'
                : 'text-muted hover:bg-elevated/60 hover:text-foreground'}"
              role="tab"
              aria-selected={selectedSection === section.id}
              title={`Review ${section.label}`}
              onclick={() => void selectAndScroll(section.id)}
            >
              <span class="truncate">{section.label}</span>
              <span class="flex items-center gap-1.5 text-[10px] tabular-nums text-dimmed">
                {#if section.comments}
                  <span
                    class="rounded-full bg-primary/10 px-1.5 text-primary"
                    title={`${section.comments} open comments`}
                  >
                    {section.comments}
                  </span>
                {/if}
                {section.count}
              </span>
            </button>
          {/each}
        </div>

        <div class="border-t p-3">
          <div class="flex items-center justify-between gap-2">
            <p class="text-[10px] font-semibold uppercase tracking-wide text-muted">
              Assignment checks
            </p>
            <span
              class="text-[10px] tabular-nums {validation.issues.length
                ? 'text-danger'
                : 'text-dimmed'}"
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
        {#if annotations.some((annotation) => annotation.status === 'open')}
          <div class="border-t p-3">
            <p class="text-[10px] font-semibold uppercase tracking-wide text-muted">
              Anchored comments
            </p>
            <div class="mt-2 space-y-1.5">
              {#each annotations.filter((annotation) => annotation.status === 'open') as annotation (annotation.id)}
                <button
                  class="block w-full rounded-lg border bg-elevated px-2.5 py-2 text-left hover:bg-overlay"
                  title={`Open comment on ${annotation.section}`}
                  onclick={() => void openAnnotation(annotation)}
                >
                  {#if annotation.quote}
                    <span class="block truncate text-[10px] text-dimmed">“{annotation.quote}”</span>
                  {/if}
                  <span class="mt-0.5 line-clamp-2 block text-xs leading-relaxed"
                    >{annotation.body}</span
                  >
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>

      <div class="flex shrink-0 items-center gap-1 border-t p-2">
        <button
          class="flex h-8 flex-1 items-center justify-center gap-2 rounded-lg px-2.5 text-xs font-medium text-muted hover:bg-elevated hover:text-foreground disabled:opacity-50"
          disabled={busy}
          title="Reveal this assignment as Markdown in the file tree"
          onclick={() => void onRevealInAppFile($state.snapshot(draft))}
        >
          <FileText size={13} />
          View
        </button>
        <button
          class="flex h-8 flex-1 items-center justify-center gap-2 rounded-lg px-2.5 text-xs font-medium text-muted hover:bg-elevated hover:text-foreground disabled:opacity-50"
          disabled={busy}
          title={`Open this assignment as Markdown in ${preferredName}`}
          onclick={() => void onOpenInEditor($state.snapshot(draft))}
        >
          {#if preferredIcon}
            <img src={preferredIcon} alt="" class="h-3.5 w-3.5 shrink-0" />
          {:else}
            <AppWindow size={14} class="shrink-0" />
          {/if}
          Open
        </button>
      </div>
    </aside>

    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <main
      bind:this={documentScroller}
      class="relative min-h-0 overflow-y-auto scroll-smooth bg-app"
      aria-label="Assignment review"
      onmouseup={captureDocumentSelection}
    >
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
      <div bind:this={documentContent} class="mx-auto max-w-4xl px-4 py-6 md:px-8 md:py-8">
        <div class="mb-6 flex items-center gap-2">
          <Network size={18} class="text-primary" />
          <p class="text-sm font-semibold text-foreground">Sr. Engineer execution plan</p>
        </div>
        <AssignmentReviewContent
          content={draft}
          {readOnly}
          {providers}
          {harnessId}
          {fallbackModel}
          {favoriteModels}
          {recentModels}
          {annotations}
          onOpenAnnotation={(annotation) => void openAnnotation(annotation)}
          onAnnotateSection={openSectionAnnotation}
          onChange={updateDraft}
          {onWorkerModelChange}
          {onTaskModelChange}
          {onToggleFavorite}
          {onReorderFavorite}
        />
      </div>
    </main>
  </div>
</section>

{#if pendingAnnotation}
  <div
    class="fixed z-50 w-72 rounded-xl border bg-surface p-3 shadow-xl max-md:inset-x-0 max-md:bottom-0 max-md:w-auto max-md:rounded-b-none max-md:pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
    style:left={compactViewport.matches ? undefined : `${pendingAnnotation.x}px`}
    style:top={compactViewport.matches ? undefined : `${pendingAnnotation.y}px`}
    role="dialog"
    aria-label="Comment on assignment selection"
  >
    <p class="text-[10px] font-semibold uppercase tracking-wide text-muted">Comment on selection</p>
    <blockquote class="mt-2 line-clamp-3 border-l-2 border-accent pl-2 text-[11px] text-muted">
      “{pendingAnnotation.quote}”
    </blockquote>
    <RichMarkdownEditor
      class="mt-2 min-h-16 w-full resize-y rounded-lg border bg-elevated px-2.5 py-2 text-xs outline-none focus:border-primary"
      bind:value={annotationBody}
      placeholder="Leave your review note…"
      ariaLabel="Assignment annotation"
      onSubmit={() => void submitAnnotation()}
    />
    <div class="mt-2 flex justify-end gap-1.5">
      <button
        class="rounded-lg px-2.5 py-1.5 text-xs text-muted hover:bg-overlay"
        title="Cancel annotation"
        onclick={() => {
          pendingAnnotation = null
          annotationBody = ''
        }}>Cancel</button
      >
      <button
        class="rounded-lg bg-primary px-2.5 py-1.5 text-xs font-semibold text-on-primary disabled:opacity-50"
        disabled={busy || !annotationBody.trim()}
        title="Add annotation"
        onclick={() => void submitAnnotation()}>Comment</button
      >
    </div>
  </div>
{/if}

{#if editingAnnotation && editingAnnotationPosition}
  <div
    class="fixed z-50 w-80 rounded-xl border bg-surface p-4 shadow-xl max-md:inset-x-0 max-md:bottom-0 max-md:w-auto max-md:rounded-b-none max-md:pb-[calc(1rem+env(safe-area-inset-bottom))]"
    style:left={compactViewport.matches ? undefined : `${editingAnnotationPosition.x}px`}
    style:top={compactViewport.matches ? undefined : `${editingAnnotationPosition.y}px`}
    role="dialog"
    aria-label="Anchored assignment comment"
  >
    <p class="text-[10px] font-semibold uppercase tracking-wide text-muted">Anchored comment</p>
    {#if editingAnnotation.quote}
      <blockquote class="mt-2 line-clamp-3 border-l-2 border-accent pl-2 text-[11px] text-muted">
        “{editingAnnotation.quote}”
      </blockquote>
    {/if}
    {#if !readOnly}
      <RichMarkdownEditor
        class="mt-3 min-h-24 w-full resize-y rounded-lg border bg-elevated px-3 py-2 text-xs outline-none focus:border-primary"
        bind:value={editingAnnotationBody}
        ariaLabel="Assignment annotation body"
        onSubmit={() => void saveAnnotationEdit()}
      />
    {:else}
      <div class="mt-3 text-xs leading-relaxed text-foreground">
        <MarkdownView text={editingAnnotation.body} />
      </div>
    {/if}
    <p class="mt-1 text-[10px] text-dimmed">{editingAnnotation.author}</p>
    <div class="mt-3 flex items-center justify-between">
      {#if !readOnly}
        <button
          class="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-success hover:bg-success/10"
          title="Resolve annotation"
          onclick={() => void resolveAnnotation(editingAnnotation!.id)}
        >
          <Check size={12} /> Resolve
        </button>
      {:else}
        <span></span>
      {/if}
      <div class="flex gap-1.5">
        <button
          class="rounded-lg px-2.5 py-1.5 text-xs text-muted hover:bg-overlay"
          title="Close annotation"
          onclick={() => {
            CSS.highlights?.delete(ASSIGNMENT_ANNOTATION_HIGHLIGHT)
            editingAnnotation = null
            editingAnnotationPosition = null
          }}>Close</button
        >
        {#if !readOnly}
          <button
            class="rounded-lg bg-primary px-2.5 py-1.5 text-xs font-semibold text-on-primary disabled:opacity-50"
            disabled={!editingAnnotationBody.trim()}
            title="Save annotation"
            onclick={() => void saveAnnotationEdit()}>Save</button
          >
        {/if}
      </div>
    </div>
  </div>
{/if}
