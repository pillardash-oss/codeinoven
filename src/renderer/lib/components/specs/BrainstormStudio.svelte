<script lang="ts">
  import {
    AppWindow,
    ArrowRight,
    Check,
    ChevronDown,
    FileText,
    History,
    MessageSquare,
    MessageSquarePlus,
    Pencil,
    Save,
    X
  } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import { onDestroy, onMount, tick } from 'svelte'
  import { compactViewport } from '$lib/compact-viewport.svelte'
  import { editorPreference } from '$lib/stores/editor-preference.svelte'
  import RichMarkdownEditor from '../shared/RichMarkdownEditor.svelte'
  import EditableMarkdown from './EditableMarkdown.svelte'
  import StudioSelectionActions from './StudioSelectionActions.svelte'
  import StudioHistoryControls from './StudioHistoryControls.svelte'
  import StudioDocumentNavigation from './StudioDocumentNavigation.svelte'
  import StudioSidebarResizeHandle from './StudioSidebarResizeHandle.svelte'
  import {
    offsetsForQuote,
    offsetsForRange,
    rangeForAnnotation,
    waitForScrollSettle
  } from './studio-annotation-anchors'
  import type { StudioDocumentHistory } from './studio-document-history.svelte'
  import type {
    BrainstormAnnotation,
    BrainstormDecisionAction,
    BrainstormDocument,
    BrainstormSection,
    BrainstormSectionId
  } from '$shared/types'

  type CallbackResult = void | Promise<void>

  interface AnnotationAnchor {
    quote: string
    startLine: number
    endLine: number
    startOffset: number
    endOffset: number
  }

  interface PendingAnnotation extends AnnotationAnchor {
    section: BrainstormSectionId
    x: number
    y: number
    sectionLevel: boolean
  }

  interface Props {
    brainstorm: BrainstormDocument
    versions?: BrainstormDocument[]
    busy?: boolean
    error?: string
    agentMessagesOpen?: boolean
    specAvailable?: boolean
    assignmentAvailable?: boolean
    auditAvailable?: boolean
    history: StudioDocumentHistory<BrainstormDocument>
    onBack: () => void
    onToggleAgentMessages: () => void
    onOpenSpec?: () => void
    onOpenAssignment?: () => void
    onOpenAudit?: () => void
    onSelectVersion: (version: number) => CallbackResult
    onSave: (brainstorm: BrainstormDocument) => Promise<BrainstormDocument | null>
    onAddAnnotation: (
      section: BrainstormSectionId,
      body: string,
      anchor: AnnotationAnchor
    ) => Promise<BrainstormDocument | null>
    onUpdateAnnotation: (annotationId: string, body: string) => Promise<BrainstormDocument | null>
    onResolveAnnotation: (annotationId: string) => Promise<BrainstormDocument | null>
    onExplainSelection?: (selection: string, documentContext: string) => void
    onQuickChatSelection?: (selection: string, documentContext: string) => void
    onSubmit: (
      action: BrainstormDecisionAction,
      brainstorm: BrainstormDocument,
      additionalNotes: string
    ) => CallbackResult
    onOpenInEditor?: (brainstorm: BrainstormDocument) => CallbackResult
    onRevealInAppFile?: (brainstorm: BrainstormDocument) => CallbackResult
  }

  let {
    brainstorm,
    versions = [],
    busy = false,
    error,
    agentMessagesOpen = false,
    specAvailable = false,
    assignmentAvailable = false,
    auditAvailable = false,
    history,
    onBack,
    onToggleAgentMessages,
    onOpenSpec,
    onOpenAssignment,
    onOpenAudit,
    onSelectVersion,
    onSave,
    onAddAnnotation,
    onUpdateAnnotation,
    onResolveAnnotation,
    onExplainSelection,
    onQuickChatSelection,
    onSubmit,
    onOpenInEditor,
    onRevealInAppFile
  }: Props = $props()

  const canonicalSections: Array<{ id: BrainstormSectionId; title: string }> = [
    { id: 'context', title: 'Context' },
    { id: 'goals', title: 'Goals' },
    { id: 'decisions', title: 'Decisions' },
    { id: 'open_questions', title: 'Open Questions' },
    { id: 'constraints', title: 'Constraints' },
    { id: 'proposed_direction', title: 'Proposed Direction' },
    { id: 'additional_info', title: 'Additional Info' }
  ]

  // This component is keyed by document identity in ThreadView. The effect below only reconciles
  // a newly selected or persisted version while retaining intentional local edit buffers.
  // svelte-ignore state_referenced_locally
  let draft = $state<BrainstormDocument>(history.attach($state.snapshot(brainstorm)))
  let preferredIcon = $derived(editorPreference.preferredInfo?.iconDataUrl)
  let preferredName = $derived(editorPreference.preferredInfo?.name ?? 'System Default')
  // svelte-ignore state_referenced_locally
  let loadedKey = $state(`${brainstorm.id}:${brainstorm.version}:${brainstorm.updatedAt}`)
  let selectedSection = $state<BrainstormSectionId>('context')
  /** Phone only: the section rail is a bottom drawer instead of a column. */
  let sectionsOpen = $state(false)
  // svelte-ignore state_referenced_locally
  let dirty = $state(history.dirty)
  let savePending = $state(false)
  let pendingAction = $state<BrainstormDecisionAction | null>(null)
  let additionalNotes = $state('')
  let pendingAnnotation = $state<PendingAnnotation | null>(null)
  let annotationBody = $state('')
  let editingAnnotation = $state<BrainstormAnnotation | null>(null)
  let editingAnnotationBody = $state('')
  let annotationEditMode = $state(false)
  let editingAnnotationPosition = $state<{ x: number; y: number } | null>(null)
  let annotationMarkers = $state<Array<{ annotation: BrainstormAnnotation; x: number; y: number }>>(
    []
  )
  let documentScroller = $state<HTMLElement | null>(null)
  let markerResizeObserver: ResizeObserver | null = null
  const BRAINSTORM_ANNOTATION_HIGHLIGHT = 'brainstorm-annotation-anchor'

  const sortedVersions = $derived(
    [...versions]
      .filter((candidate) => candidate.id === draft.id)
      .sort((left, right) => right.version - left.version)
  )
  const latestVersion = $derived(sortedVersions[0]?.version ?? draft.version)
  const canEdit = $derived(draft.status === 'draft' && draft.version === latestVersion)
  const visibleSections = $derived(
    canonicalSections.filter(
      ({ id }) => id !== 'additional_info' || Boolean(sectionFor(id)?.markdown.trim())
    )
  )

  const openAnnotationCount = $derived(
    draft.annotations.filter((annotation) => annotation.status === 'open').length
  )

  $effect(() => {
    const nextKey = `${brainstorm.id}:${brainstorm.version}:${brainstorm.updatedAt}`
    if (nextKey === loadedKey) return
    loadedKey = nextKey
    if (history.dirty) return
    history.markSaved($state.snapshot(brainstorm))
    draft = $state.snapshot(brainstorm)
    dirty = false
    pendingAction = null
    closePendingAnnotation()
    closeAnnotation()
    if (!visibleSections.some((section) => section.id === selectedSection)) {
      selectedSection = 'context'
    }
  })

  $effect(() => {
    draft.annotations
      .map((annotation) => `${annotation.id}:${annotation.status}:${annotation.body}`)
      .join('|')
    void refreshAnnotationMarkers()
  })

  function sectionFor(sectionId: BrainstormSectionId): BrainstormSection | undefined {
    return draft.content.sections.find((section) => section.id === sectionId)
  }

  function annotationsFor(sectionId: BrainstormSectionId): BrainstormAnnotation[] {
    return draft.annotations.filter(
      (annotation) => annotation.section === sectionId && annotation.status === 'open'
    )
  }

  function markDirty(): void {
    draft.updatedAt = Date.now()
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
    closeAnnotation()
    void refreshAnnotationMarkers()
  }

  function redoEdit(): void {
    const next = history.redo($state.snapshot(draft))
    if (!next) return
    draft = $state.snapshot(next)
    dirty = history.dirty
    closePendingAnnotation()
    closeAnnotation()
    void refreshAnnotationMarkers()
  }

  function setSectionMarkdown(sectionId: BrainstormSectionId, markdown: string): void {
    const section = sectionFor(sectionId)
    if (!section) return
    section.markdown = markdown
    markDirty()
  }

  function formatDate(timestamp: number): string {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(timestamp)
  }

  function statusLabel(): string {
    return draft.status === 'draft'
      ? 'Draft'
      : draft.status === 'finalized'
        ? 'Finalized'
        : 'Superseded'
  }

  function statusClass(): string {
    if (draft.status === 'finalized') return 'bg-success/10 text-success'
    if (draft.status === 'superseded') return 'bg-raised text-dimmed'
    return 'bg-warning/10 text-warning'
  }

  function exportMarkdown(): string {
    return [
      `# ${draft.content.title}`,
      '',
      draft.content.summary,
      ...draft.content.sections.flatMap((section) => [
        '',
        `## ${section.title}`,
        '',
        section.markdown
      ])
    ].join('\n')
  }

  function markdownLineForQuote(
    quote: string,
    sectionId: BrainstormSectionId
  ): { startLine: number; endLine: number } {
    const markdown = exportMarkdown()
    const section = sectionFor(sectionId)
    const heading = `## ${section?.title ?? sectionId}`
    const sectionStart = markdown.indexOf(heading)
    const quoteStart = sectionStart < 0 ? -1 : markdown.indexOf(quote, sectionStart)
    const anchorStart = quoteStart < 0 ? Math.max(sectionStart, 0) : quoteStart
    const startLine = markdown.slice(0, anchorStart).split('\n').length
    return { startLine, endLine: startLine + quote.split('\n').length - 1 }
  }

  async function selectAndScroll(sectionId: BrainstormSectionId): Promise<void> {
    sectionsOpen = false
    selectedSection = sectionId
    await tick()
    const target = document.getElementById(`brainstorm-section-${sectionId}`)
    if (!target || !documentScroller) return
    const scrollerTop = documentScroller.getBoundingClientRect().top
    const targetTop = target.getBoundingClientRect().top
    documentScroller.scrollTo({
      top: documentScroller.scrollTop + targetTop - scrollerTop - 20,
      behavior: 'smooth'
    })
  }

  function captureDocumentSelection(): void {
    if (!canEdit && (!onExplainSelection || !onQuickChatSelection)) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)
    const commonNode =
      range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement
    const sectionElement = commonNode?.closest<HTMLElement>('[data-brainstorm-section]')
    const section = sectionElement?.dataset.brainstormSection as BrainstormSectionId | undefined
    const quote = selection.toString().trim()
    if (!sectionElement || !section || !quote) return
    const rect = range.getBoundingClientRect()
    selectedSection = section
    pendingAnnotation = {
      section,
      quote,
      ...markdownLineForQuote(quote, section),
      ...offsetsForRange(sectionElement, range),
      x: Math.max(12, Math.min(rect.left, window.innerWidth - 396)),
      y: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 272)),
      sectionLevel: false
    }
    annotationBody = ''
  }

  function openSectionAnnotation(
    sectionId: BrainstormSectionId,
    title: string,
    event: MouseEvent
  ): void {
    if (!canEdit) return
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) return
    const sectionElement = document.querySelector<HTMLElement>(
      `[data-brainstorm-section="${sectionId}"]`
    )
    const rect =
      event.currentTarget instanceof HTMLElement
        ? event.currentTarget.getBoundingClientRect()
        : { left: event.clientX, bottom: event.clientY }
    selectedSection = sectionId
    pendingAnnotation = {
      section: sectionId,
      quote: title,
      ...markdownLineForQuote(title, sectionId),
      ...offsetsForQuote(sectionElement, title),
      x: Math.max(12, Math.min(rect.left, window.innerWidth - 396)),
      y: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 272)),
      sectionLevel: true
    }
    annotationBody = ''
  }

  async function saveDraft(): Promise<BrainstormDocument | null> {
    if (!dirty || busy || savePending || !canEdit) return null
    savePending = true
    try {
      const saved = await onSave($state.snapshot(draft))
      if (saved) applyDocument(saved)
      return saved
    } finally {
      savePending = false
    }
  }

  function applyDocument(updated: BrainstormDocument): void {
    history.markSaved($state.snapshot(updated))
    draft = $state.snapshot(updated)
    loadedKey = `${updated.id}:${updated.version}:${updated.updatedAt}`
    dirty = false
  }

  async function submitAnnotation(): Promise<void> {
    const anchor = pendingAnnotation
    const body = annotationBody.trim()
    if (!anchor || !body) return
    if (dirty && !(await saveDraft())) return
    const updated = await onAddAnnotation(anchor.section, body, {
      quote: anchor.quote,
      startLine: anchor.startLine,
      endLine: anchor.endLine,
      startOffset: anchor.startOffset,
      endOffset: anchor.endOffset
    })
    if (!updated) return
    applyDocument(updated)
    closePendingAnnotation()
    const added = [...updated.annotations]
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
    const documentContext = exportMarkdown()
    if (mode === 'explain') onExplainSelection?.(selection.quote, documentContext)
    else onQuickChatSelection?.(selection.quote, documentContext)
    closePendingAnnotation()
  }

  async function refreshAnnotationMarkers(): Promise<void> {
    await tick()
    const scroller = documentScroller
    if (!scroller) return
    const scrollerRect = scroller.getBoundingClientRect()
    annotationMarkers = draft.annotations.flatMap((annotation) => {
      if (annotation.status !== 'open') return []
      const section = document.querySelector<HTMLElement>(
        `[data-brainstorm-section="${annotation.section}"]`
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

  async function openAnnotation(annotation: BrainstormAnnotation): Promise<void> {
    window.getSelection()?.removeAllRanges()
    CSS.highlights?.delete(BRAINSTORM_ANNOTATION_HIGHLIGHT)
    closeAnnotation()
    selectedSection = annotation.section
    pendingAnnotation = null
    await tick()
    const section = document.querySelector<HTMLElement>(
      `[data-brainstorm-section="${annotation.section}"]`
    )
    const range = section ? rangeForAnnotation(section, annotation) : null
    const scroller = documentScroller
    const initialRect = range?.getBoundingClientRect() ?? section?.getBoundingClientRect()
    if (scroller && initialRect) {
      const scrollerRect = scroller.getBoundingClientRect()
      const centeredTop =
        scroller.scrollTop +
        initialRect.top -
        scrollerRect.top -
        (scroller.clientHeight - initialRect.height) / 2
      scroller.scrollTo({ top: Math.max(0, centeredTop), behavior: 'smooth' })
      await waitForScrollSettle(scroller)
    }
    await refreshAnnotationMarkers()
    await tick()
    const marker = document.querySelector<HTMLElement>(
      `[data-brainstorm-annotation-marker="${CSS.escape(annotation.id)}"]`
    )
    const rect = marker?.getBoundingClientRect() ?? range?.getBoundingClientRect() ?? initialRect
    if (range && typeof Highlight !== 'undefined' && CSS.highlights) {
      CSS.highlights.set(BRAINSTORM_ANNOTATION_HIGHLIGHT, new Highlight(range))
    }
    editingAnnotation = annotation
    editingAnnotationBody = annotation.body
    annotationEditMode = false
    if (!rect) {
      editingAnnotationPosition = { x: 12, y: 12 }
      return
    }
    const width = 320
    const preferredX = rect.right + 8
    const x = preferredX + width <= window.innerWidth - 12 ? preferredX : rect.left - width - 8
    editingAnnotationPosition = {
      x: Math.max(12, Math.min(x, window.innerWidth - width - 12)),
      y: Math.max(12, Math.min(rect.top, window.innerHeight - 288))
    }
  }

  function closeAnnotation(): void {
    CSS.highlights?.delete(BRAINSTORM_ANNOTATION_HIGHLIGHT)
    editingAnnotation = null
    editingAnnotationBody = ''
    editingAnnotationPosition = null
    annotationEditMode = false
  }

  async function saveAnnotationEdit(): Promise<void> {
    const annotation = editingAnnotation
    const body = editingAnnotationBody.trim()
    if (!annotation || !body) return
    const updated = await onUpdateAnnotation(annotation.id, body)
    if (!updated) return
    applyDocument(updated)
    editingAnnotation =
      updated.annotations.find((candidate) => candidate.id === annotation.id) ?? null
    editingAnnotationBody = editingAnnotation?.body ?? ''
    annotationEditMode = false
  }

  async function resolveAnnotation(annotationId: string): Promise<void> {
    const updated = await onResolveAnnotation(annotationId)
    if (updated) applyDocument(updated)
    closeAnnotation()
  }

  async function submitAction(action: BrainstormDecisionAction): Promise<void> {
    let submitted = $state.snapshot(draft)
    if (dirty) {
      const saved = await saveDraft()
      if (!saved) return
      submitted = saved
    }
    const notes = additionalNotes
    pendingAction = null
    additionalNotes = ''
    await onSubmit(action, submitted, notes)
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      closePendingAnnotation()
      closeAnnotation()
      pendingAction = null
      return
    }
    const saveShortcut =
      event.key.toLowerCase() === 's' &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey
    if (!saveShortcut || event.repeat || event.isComposing) return
    event.preventDefault()
    void saveDraft()
  }

  onMount(() => {
    if (!documentScroller) return
    markerResizeObserver = new ResizeObserver(() => void refreshAnnotationMarkers())
    markerResizeObserver.observe(documentScroller)
  })

  onDestroy(() => {
    markerResizeObserver?.disconnect()
    CSS.highlights?.delete(BRAINSTORM_ANNOTATION_HIGHLIGHT)
  })
</script>

<svelte:window onkeydown={handleWindowKeydown} onresize={() => void refreshAnnotationMarkers()} />

<section class="flex h-full min-h-0 flex-col bg-app" aria-label="Brainstorm studio">
  <header class="shrink-0 border-b bg-surface">
    <div
      class="flex flex-col gap-2 px-2 py-2 md:grid md:min-h-12 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-center md:gap-3 md:px-3 md:py-0"
    >
      <div class="flex min-w-0 items-center gap-2">
        <StudioDocumentNavigation
          active="brainstorm"
          brainstormAvailable
          {specAvailable}
          {assignmentAvailable}
          {auditAvailable}
          {agentMessagesOpen}
          {onBack}
          {onToggleAgentMessages}
          {sectionsOpen}
          sectionsLabel="brainstorm sections"
          onToggleSections={() => (sectionsOpen = !sectionsOpen)}
          onOpenBrainstorm={() => undefined}
          onOpenSpec={specAvailable ? onOpenSpec : undefined}
          {onOpenAssignment}
          {onOpenAudit}
        />
      </div>

      <div
        class="flex items-center gap-2 text-[11px] text-muted max-md:flex-wrap md:justify-center"
      >
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            class="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-elevated hover:text-foreground"
            title="Choose a brainstorm version"
          >
            <History size={12} />
            Version {draft.version}
            <ChevronDown size={11} />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="bottom"
              align="start"
              sideOffset={4}
              collisionPadding={8}
              strategy="fixed"
              class="z-50 max-h-52 min-w-44 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg"
            >
              {#each sortedVersions as version (version.version)}
                <DropdownMenu.Item
                  class="flex cursor-default items-center justify-between gap-3 rounded-md px-2 py-1.5 text-xs outline-none data-[highlighted]:bg-elevated"
                  textValue={`Version ${version.version}`}
                  title={`Open brainstorm version ${version.version}`}
                  onSelect={() => void onSelectVersion(version.version)}
                >
                  <span>Version {version.version}</span>
                  <span class="flex items-center gap-1.5 capitalize text-dimmed">
                    {version.status}
                    {#if version.version === draft.version}<Check
                        size={11}
                        class="text-primary"
                      />{/if}
                  </span>
                </DropdownMenu.Item>
              {/each}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <StudioHistoryControls
          canUndo={history.canUndo}
          canRedo={history.canRedo}
          onUndo={undoEdit}
          onRedo={redoEdit}
        />
        <span>Updated {formatDate(draft.updatedAt)}</span>
        <span
          class="rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide {statusClass()}"
          >{statusLabel()}</span
        >
        {#if dirty && canEdit}
          <button
            class="flex items-center gap-1 rounded-md border bg-elevated px-2 py-1 text-[11px] font-medium hover:bg-overlay disabled:opacity-50"
            disabled={busy || savePending}
            title="Save changes (Cmd/Ctrl+S)"
            onclick={() => void saveDraft()}><Save size={11} /> Save</button
          >
        {/if}
      </div>

      <div class="flex items-center gap-1.5 max-md:*:h-10 max-md:*:flex-1 md:justify-end">
        {#if canEdit}
          <button
            class="rounded-lg border bg-elevated px-3 py-1.5 text-xs font-semibold hover:bg-overlay disabled:opacity-50"
            disabled={busy}
            title="Review this brainstorm with the Sr. Engineer"
            onclick={() => {
              pendingAction = 'review'
              additionalNotes = ''
            }}>Review</button
          >
          <button
            class="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
            disabled={busy}
            title="Finalize this brainstorm and prepare the specification"
            onclick={() => {
              pendingAction = 'finalize'
              additionalNotes = ''
            }}>Finalize <ArrowRight size={13} /></button
          >
        {/if}
      </div>
    </div>

    {#if pendingAction && canEdit}
      <div class="flex flex-col gap-2 border-t px-3 py-2.5 md:flex-row md:items-end md:px-4">
        <label class="min-w-0 flex-1 text-[11px] font-medium text-muted">
          Additional notes
          <RichMarkdownEditor
            class="mt-1 min-h-14 w-full resize-y rounded-lg border bg-elevated px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
            bind:value={additionalNotes}
            placeholder={pendingAction === 'review'
              ? 'Tell the Sr. Engineer what to revise…'
              : 'Add final context for the specification…'}
            ariaLabel="Brainstorm decision notes"
            onSubmit={() => void submitAction(pendingAction!)}
          />
        </label>
        <button
          class="rounded-lg px-3 py-2 text-xs text-muted hover:bg-overlay"
          title="Cancel"
          onclick={() => (pendingAction = null)}>Cancel</button
        >
        <button
          class="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary disabled:opacity-50"
          disabled={busy}
          title={pendingAction === 'review' ? 'Send review' : 'Finalize brainstorm'}
          onclick={() => void submitAction(pendingAction!)}
          >{pendingAction === 'review' ? 'Review' : 'Finalize'}</button
        >
      </div>
    {/if}

    {#if error}
      <p class="border-t bg-danger/10 px-4 py-2 text-xs text-danger" role="alert">{error}</p>
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
      aria-label="Brainstorm sections"
    >
      <StudioSidebarResizeHandle sidebarLabel="Brainstorm sections" />
      <div class="flex h-12 shrink-0 items-center justify-between border-b px-3 md:hidden">
        <p class="text-[10px] font-semibold uppercase tracking-[0.16em] text-dimmed">Brainstorm</p>
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
          {#each visibleSections as section (section.id)}
            {@const annotationCount = annotationsFor(section.id).length}
            <button
              class="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors max-md:py-3 {selectedSection ===
              section.id
                ? 'bg-elevated font-semibold text-foreground'
                : 'text-muted hover:bg-elevated/60 hover:text-foreground'}"
              role="tab"
              aria-selected={selectedSection === section.id}
              title={`Scroll to ${section.title}`}
              onclick={() => void selectAndScroll(section.id)}
            >
              <span>{section.title}</span>
              {#if annotationCount}
                <span class="rounded-full bg-info/10 px-1.5 text-[10px] text-info"
                  >{annotationCount}</span
                >
              {/if}
            </button>
          {/each}
        </div>

        <div class="border-t p-3">
          <div class="flex items-center justify-between">
            <p class="text-[10px] font-semibold uppercase tracking-wide text-muted">Annotations</p>
            <span class="text-[10px] tabular-nums text-dimmed">{openAnnotationCount}</span>
          </div>
          <div class="mt-2 max-h-72 space-y-1.5 overflow-y-auto pr-1">
            {#each annotationsFor(selectedSection) as annotation (annotation.id)}
              <button
                class="block w-full rounded-lg border bg-elevated px-2.5 py-2 text-left hover:bg-overlay"
                title="Open annotation"
                onclick={() => void openAnnotation(annotation)}
              >
                {#if annotation.quote}
                  <span class="block truncate text-[10px] text-dimmed">“{annotation.quote}”</span>
                {/if}
                <span class="mt-0.5 line-clamp-2 block text-xs leading-relaxed"
                  >{annotation.body}</span
                >
              </button>
            {:else}
              <p
                class="rounded-lg border border-dashed px-2.5 py-3 text-center text-[11px] text-dimmed"
              >
                {canEdit
                  ? 'Select text or click a section heading to annotate.'
                  : 'No open annotations.'}
              </p>
            {/each}
          </div>
        </div>

        {#if onRevealInAppFile || onOpenInEditor}
          <div class="flex shrink-0 items-center gap-1 border-t p-2">
            {#if onRevealInAppFile}
              <button
                class="flex h-8 flex-1 items-center justify-center gap-2 rounded-lg px-2.5 text-xs font-medium text-muted hover:bg-elevated hover:text-foreground disabled:opacity-50"
                disabled={busy}
                title="Reveal this brainstorm as Markdown in the file tree"
                onclick={() => void onRevealInAppFile?.(draft)}
              >
                <FileText size={13} />
                View
              </button>
            {/if}
            {#if onOpenInEditor}
              <button
                class="flex h-8 flex-1 items-center justify-center gap-2 rounded-lg px-2.5 text-xs font-medium text-muted hover:bg-elevated hover:text-foreground disabled:opacity-50"
                disabled={busy}
                title={`Open this brainstorm as Markdown in ${preferredName}`}
                onclick={() => void onOpenInEditor?.(draft)}
              >
                {#if preferredIcon}
                  <img src={preferredIcon} alt="" class="h-3.5 w-3.5 shrink-0" />
                {:else}
                  <AppWindow size={14} class="shrink-0" />
                {/if}
                Open
              </button>
            {/if}
          </div>
        {/if}
      </div>
    </aside>

    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <main
      bind:this={documentScroller}
      class="relative min-h-0 overflow-y-auto scroll-smooth bg-app"
      aria-label="Rendered brainstorm"
      onmouseup={captureDocumentSelection}
    >
      <article class="mx-auto max-w-4xl space-y-12 px-4 py-6 text-sm leading-7 md:px-8 md:py-8">
        <header class="space-y-3 border-b pb-8">
          <EditableMarkdown
            text={draft.content.title}
            readOnly={!canEdit}
            class="text-2xl font-semibold tracking-tight text-foreground outline-none focus:bg-surface"
            ariaLabel="Brainstorm title"
            onChange={(value) => {
              draft.content.title = value
              markDirty()
            }}
          />
          <section id="brainstorm-section-tldr" class="space-y-2 scroll-mt-5">
            <h2 class="text-xl font-semibold tracking-tight">TL;DR</h2>
            <EditableMarkdown
              text={draft.content.summary}
              readOnly={!canEdit}
              class="brainstorm-markdown max-w-3xl whitespace-pre-wrap rounded-lg px-2 py-1 text-base text-muted outline-none focus:bg-surface focus:text-foreground"
              ariaLabel="Brainstorm TL;DR"
              onChange={(value) => {
                draft.content.summary = value
                markDirty()
              }}
            />
          </section>
        </header>

        {#each visibleSections as sectionDefinition (sectionDefinition.id)}
          {@const section = sectionFor(sectionDefinition.id)}
          {#if section}
            <section
              id={`brainstorm-section-${section.id}`}
              data-brainstorm-section={section.id}
              class="scroll-mt-5"
            >
              {#if canEdit}
                <button
                  class="group flex items-center gap-2 text-left"
                  title={`Annotate ${section.title}`}
                  onclick={(event: MouseEvent) =>
                    openSectionAnnotation(section.id, section.title, event)}
                >
                  <span class="text-xl font-semibold tracking-tight">{section.title}</span>
                  <MessageSquarePlus
                    size={14}
                    class="text-dimmed opacity-0 transition-opacity max-md:opacity-100 group-hover:opacity-100"
                  />
                </button>
              {:else}
                <h2 class="text-xl font-semibold tracking-tight">{section.title}</h2>
              {/if}
              <EditableMarkdown
                text={section.markdown}
                readOnly={!canEdit}
                class="brainstorm-markdown mt-3 w-full whitespace-pre-wrap rounded-lg px-2 py-1 text-muted outline-none focus:bg-surface focus:text-foreground"
                ariaLabel={section.title}
                onChange={(value) => setSectionMarkdown(section.id, value)}
              />
              {#if annotationsFor(section.id).length}
                <div
                  class="mt-4 flex gap-2 overflow-x-auto pb-1"
                  aria-label={`${section.title} annotations`}
                >
                  {#each annotationsFor(section.id) as annotation (annotation.id)}
                    <button
                      class="max-w-64 shrink-0 rounded-xl border bg-surface px-3 py-2 text-left hover:bg-elevated"
                      title="Open annotation"
                      onclick={() => void openAnnotation(annotation)}
                    >
                      <span class="line-clamp-2 block text-xs leading-relaxed"
                        >{annotation.body}</span
                      >
                      <span class="mt-1 block text-[10px] text-dimmed">{annotation.author}</span>
                    </button>
                  {/each}
                </div>
              {/if}
            </section>
          {/if}
        {/each}
      </article>

      {#each annotationMarkers as marker (marker.annotation.id)}
        <button
          data-brainstorm-annotation-marker={marker.annotation.id}
          class="absolute z-10 grid h-7 w-7 place-items-center rounded-full border bg-surface text-info shadow-sm hover:bg-elevated"
          style:left={compactViewport.matches
            ? undefined
            : `${Math.min(marker.x, (documentScroller?.scrollWidth ?? marker.x + 32) - 32)}px`}
          style:top={`${marker.y}px`}
          title={`Open annotation: ${marker.annotation.body}`}
          aria-label={`Open annotation: ${marker.annotation.body}`}
          onclick={() => void openAnnotation(marker.annotation)}><MessageSquare size={13} /></button
        >
      {/each}
    </main>
  </div>
</section>

{#if pendingAnnotation}
  <div
    class="fixed z-50 w-96 rounded-xl border bg-surface p-3 shadow-xl max-md:inset-x-0 max-md:bottom-0 max-md:w-auto max-md:rounded-b-none max-md:pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
    style:left={compactViewport.matches ? undefined : `${pendingAnnotation.x}px`}
    style:top={compactViewport.matches ? undefined : `${pendingAnnotation.y}px`}
    role="dialog"
    aria-label={pendingAnnotation.sectionLevel
      ? 'Annotate section'
      : canEdit
        ? 'Comment on selection'
        : 'Actions for selection'}
  >
    <p class="text-[10px] font-semibold uppercase tracking-wide text-muted">
      {pendingAnnotation.sectionLevel
        ? 'Annotate section'
        : canEdit
          ? 'Comment on selection'
          : 'Selection'}
    </p>
    <blockquote
      class="mt-2 line-clamp-3 border-l-2 border-accent pl-2 text-[11px] leading-relaxed text-muted"
    >
      “{pendingAnnotation.quote}”
    </blockquote>
    {#if canEdit}
      <RichMarkdownEditor
        class="mt-2 min-h-16 w-full resize-y rounded-lg border bg-elevated px-2.5 py-2 text-xs outline-none focus:border-primary"
        bind:value={annotationBody}
        placeholder="Leave your review note…"
        ariaLabel="Brainstorm annotation"
        onSubmit={() => void submitAnnotation()}
      />
    {/if}
    <div class="mt-2 flex flex-wrap items-center justify-between gap-2">
      {#if !pendingAnnotation.sectionLevel && onExplainSelection && onQuickChatSelection}
        <StudioSelectionActions
          onExplain={() => openSelectionChat('explain')}
          onQuickChat={() => openSelectionChat('quick')}
        />
      {/if}
      <div class="ml-auto flex items-center gap-1.5">
        <button
          class="rounded-lg px-2.5 py-1.5 text-xs text-muted hover:bg-overlay"
          title="Cancel annotation"
          onclick={closePendingAnnotation}>Cancel</button
        >
        {#if canEdit}
          <button
            class="rounded-lg bg-primary px-2.5 py-1.5 text-xs font-semibold text-on-primary disabled:opacity-50"
            disabled={busy || !annotationBody.trim()}
            title="Add annotation"
            onclick={() => void submitAnnotation()}>Comment</button
          >
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if editingAnnotation && editingAnnotationPosition}
  <div
    class="fixed z-50 w-80 rounded-xl border bg-surface p-4 shadow-xl max-md:inset-x-0 max-md:bottom-0 max-md:w-auto max-md:rounded-b-none max-md:pb-[calc(1rem+env(safe-area-inset-bottom))]"
    style:left={compactViewport.matches ? undefined : `${editingAnnotationPosition.x}px`}
    style:top={compactViewport.matches ? undefined : `${editingAnnotationPosition.y}px`}
    role="dialog"
    aria-label="Brainstorm annotation"
  >
    <div class="flex items-center justify-between gap-2">
      <p class="text-[10px] font-semibold uppercase tracking-wide text-muted">
        {annotationEditMode ? 'Edit annotation' : 'Annotation'}
      </p>
      <button
        class="rounded-md p-1 text-muted hover:bg-overlay hover:text-foreground"
        title="Close annotation"
        aria-label="Close annotation"
        onclick={closeAnnotation}><X size={13} /></button
      >
    </div>
    {#if editingAnnotation.quote}
      <blockquote
        class="mt-2 line-clamp-3 border-l-2 border-accent pl-2 text-[11px] leading-relaxed text-muted"
      >
        “{editingAnnotation.quote}”
      </blockquote>
    {/if}
    {#if annotationEditMode}
      <RichMarkdownEditor
        class="mt-3 min-h-24 w-full resize-y rounded-lg border bg-elevated px-3 py-2 text-xs outline-none focus:border-primary"
        bind:value={editingAnnotationBody}
        ariaLabel="Brainstorm annotation body"
        onSubmit={() => void saveAnnotationEdit()}
      />
    {:else}
      <p class="mt-3 text-xs leading-relaxed text-foreground">{editingAnnotation.body}</p>
    {/if}
    <p class="mt-1 text-[10px] text-dimmed">
      {editingAnnotation.author} · {formatDate(editingAnnotation.createdAt)}
    </p>
    {#if canEdit}
      <div class="mt-3 flex items-center justify-between">
        <button
          class="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-success hover:bg-success/10"
          title="Resolve annotation"
          onclick={() => void resolveAnnotation(editingAnnotation!.id)}
          ><Check size={12} /> Resolve</button
        >
        {#if annotationEditMode}
          <div class="flex gap-1.5">
            <button
              class="rounded-lg px-2.5 py-1.5 text-xs text-muted hover:bg-overlay"
              title="Cancel editing"
              onclick={() => (annotationEditMode = false)}>Cancel</button
            >
            <button
              class="rounded-lg bg-primary px-2.5 py-1.5 text-xs font-semibold text-on-primary disabled:opacity-50"
              disabled={!editingAnnotationBody.trim()}
              title="Save annotation"
              onclick={() => void saveAnnotationEdit()}>Save</button
            >
          </div>
        {:else}
          <button
            class="flex items-center gap-1 rounded-lg border bg-elevated px-2.5 py-1.5 text-xs font-semibold hover:bg-overlay"
            title="Edit annotation"
            onclick={() => (annotationEditMode = true)}><Pencil size={12} /> Edit</button
          >
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  :global(.brainstorm-markdown.markdown-body > p) {
    white-space: pre-line;
  }

  :global(.brainstorm-markdown.markdown-body > * + *) {
    margin-top: 0.75rem;
  }

  :global(::highlight(brainstorm-annotation-anchor)) {
    background: color-mix(in srgb, var(--color-accent) 28%, transparent);
  }
</style>
