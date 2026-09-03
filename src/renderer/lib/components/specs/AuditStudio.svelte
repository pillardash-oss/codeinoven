<script lang="ts">
  import {
    Check,
    MessageSquare,
    MessageSquarePlus,
    Plus,
    X
  } from '@lucide/svelte'
  import { compactViewport } from '$lib/compact-viewport.svelte'
  import { editorPreference } from '$lib/stores/editor-preference.svelte'
  import type {
    AuditAnnotation,
    AuditFindingSeverity,
    AuditReport,
    AuditSectionId
  } from '$shared/types'
  import { exportAuditReportMarkdown } from '$shared/audit/audit-markdown'
  import RichMarkdownEditor from '../shared/RichMarkdownEditor.svelte'
  import VoiceInputButton from '../speech/VoiceInputButton.svelte'
  import { speechController } from '../../speech/speech-controller.svelte'
  import EditableMarkdown from './EditableMarkdown.svelte'
  import StudioDocumentNavigation from './StudioDocumentNavigation.svelte'
  import StudioShell from './StudioShell.svelte'
  import type { StudioShellSection } from './StudioShell.svelte'
  import StudioSidebarFileActions from './StudioSidebarFileActions.svelte'
  import StudioVersionBar from './StudioVersionBar.svelte'
  import StudioPendingAnnotationPopover from './StudioPendingAnnotationPopover.svelte'
  import StudioAnnotationDetailPopover from './StudioAnnotationDetailPopover.svelte'
  import type { StudioDocumentHistory } from './studio-document-history.svelte'
  import { onDestroy, onMount, tick } from 'svelte'

  type CallbackResult = void | Promise<void>
  interface AnnotationAnchor {
    quote: string
    startLine: number
    endLine: number
    startOffset: number
    endOffset: number
  }

  interface PendingAnnotation extends AnnotationAnchor {
    section: AuditSectionId
    x: number
    y: number
    sectionLevel: boolean
  }

  interface Props {
    report: AuditReport
    versions: AuditReport[]
    history: StudioDocumentHistory<AuditReport>
    busy?: boolean
    error?: string
    brainstormAvailable?: boolean
    prdAvailable?: boolean
    assignmentAvailable?: boolean
    agentMessagesOpen?: boolean
    actionsAvailable?: boolean
    onBack: () => void
    onOpenBrainstorm?: () => void
    onOpenPrd?: () => void
    onOpenSpec: () => void
    onOpenAssignment?: () => void
    onToggleAgentMessages: () => void
    onSelectVersion: (version: number) => CallbackResult
    onSave: (report: AuditReport) => Promise<AuditReport | null>
    onAddAnnotation: (
      section: AuditSectionId,
      body: string,
      anchor?: AnnotationAnchor
    ) => Promise<AuditReport | null>
    onUpdateAnnotation: (annotationId: string, body: string) => Promise<AuditReport | null>
    onResolveAnnotation: (annotationId: string) => Promise<AuditReport | null>
    onExplainSelection?: (selection: string, documentContext: string) => void
    onQuickChatSelection?: (selection: string, documentContext: string) => void
    onReview: (report: AuditReport, notes: string) => Promise<boolean>
    onComplete: () => CallbackResult
    onOpenInEditor?: (report: AuditReport) => CallbackResult
    onRevealInAppFile?: (report: AuditReport) => CallbackResult
  }

  let {
    report,
    versions,
    history,
    busy = false,
    error,
    brainstormAvailable = false,
    prdAvailable = false,
    assignmentAvailable = false,
    agentMessagesOpen = false,
    actionsAvailable = true,
    onBack,
    onOpenBrainstorm,
    onOpenPrd,
    onOpenSpec,
    onOpenAssignment,
    onToggleAgentMessages,
    onSelectVersion,
    onSave,
    onAddAnnotation,
    onUpdateAnnotation,
    onResolveAnnotation,
    onExplainSelection,
    onQuickChatSelection,
    onReview,
    onComplete,
    onOpenInEditor,
    onRevealInAppFile
  }: Props = $props()
  // svelte-ignore state_referenced_locally
  let draft = $state<AuditReport>(history.attach($state.snapshot(report)))
  // svelte-ignore state_referenced_locally
  let dirty = $state(history.dirty)
  let reviewOpen = $state(false)
  let preferredName = $derived(editorPreference.preferredInfo?.name ?? 'System Default')
  let reviewNotes = $state('')
  let reviewSubmitting = $state(false)
  let annotationBody = $state('')
  let pendingAnnotation = $state<PendingAnnotation | null>(null)
  let editingAnnotation = $state<AuditAnnotation | null>(null)
  let editingAnnotationBody = $state('')
  let reviewNotesEditor = $state<RichMarkdownEditor>()
  const pendingSpeechTargetId = `audit-annotation-${crypto.randomUUID()}`
  const reviewSpeechTargetId = `audit-review-${crypto.randomUUID()}`
  const speechScope = $derived({
    kind: 'project',
    projectId: report.projectId,
    threadId: report.threadId
  } as const)

  function reviewSpeechTarget() {
    return reviewNotesEditor?.speechEditorTarget(reviewSpeechTargetId) ?? null
  }
  let editingAnnotationPosition = $state<{ x: number; y: number } | null>(null)
  let annotationEditMode = $state(false)
  let annotationMarkers = $state<Array<{ annotation: AuditAnnotation; x: number; y: number }>>([])
  let severityEditingId = $state<string | null>(null)
  let selectedSection = $state<AuditSectionId>('executive_summary')
  /** Phone only: the section rail is a bottom drawer instead of a column. */
  let sectionsOpen = $state(false)
  let documentScroller = $state<HTMLElement | null>(null)
  let syncedReportUpdatedAt = $state(0)
  // svelte-ignore state_referenced_locally
  let syncedReportKey = $state(`${report.id}:${report.version}`)
  let markerResizeObserver: ResizeObserver | null = null

  const findingSeverities: AuditFindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info']
  const auditSections: Array<{ id: AuditSectionId; label: string }> = [
    { id: 'executive_summary', label: 'Executive summary' },
    { id: 'findings', label: 'Findings' },
    { id: 'resolution_recommendation', label: 'Resolution' },
    { id: 'conclusion', label: 'Conclusion' }
  ]

  const auditMarkdownHeadings: Record<AuditSectionId, string> = {
    executive_summary: 'Executive Summary',
    findings: 'Findings',
    resolution_recommendation: 'Resolution & Recommendation',
    conclusion: 'Conclusion'
  }
  const latestVersion = $derived(
    Math.max(draft.version, ...versions.map((version) => version.version))
  )
  const isLatestVersion = $derived(draft.version === latestVersion)
  const reviewStarted = $derived(draft.annotations.length > 0 || reviewOpen)
  const workflowActionsVisible = $derived(actionsAvailable && isLatestVersion)
  const AUDIT_ANNOTATION_HIGHLIGHT = 'audit-annotation-anchor'

  // Sidebar headings are a projection of the fixed audit sections with open annotation counts.
  const shellSections = $derived<StudioShellSection<AuditSectionId>[]>(
    auditSections.map((section) => {
      const badges: StudioShellSection<AuditSectionId>['badges'] = []
      const commentCount = annotations(section.id).length
      if (commentCount) badges.push({ count: commentCount, tone: 'info', label: 'annotations' })
      if (section.id === 'findings' && draft.content.findings.length) {
        badges.push({ count: draft.content.findings.length, tone: 'danger', label: 'findings' })
      }
      return { id: section.id, title: section.label, badges }
    })
  )
  const statusLabel = $derived(
    draft.outcome === 'passed'
      ? 'Passed'
      : draft.outcome === 'rework_required'
        ? 'Rework required'
        : undefined
  )
  const statusClass = $derived(
    draft.outcome === 'passed' ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'
  )

  async function submitReview(): Promise<void> {
    if (reviewSubmitting || busy || !workflowActionsVisible) return
    reviewSubmitting = true
    try {
      if (await onReview($state.snapshot(draft), reviewNotes)) {
        speechController.observeSent(reviewSpeechTargetId, reviewNotes)
        reviewOpen = false
      }
    } finally {
      reviewSubmitting = false
    }
  }

  $effect(() => {
    const reportKey = `${report.id}:${report.version}`
    if (reportKey !== syncedReportKey) {
      syncedReportKey = reportKey
      syncedReportUpdatedAt = report.updatedAt
      draft = history.attach($state.snapshot(report))
      dirty = history.dirty
      return
    }
    if (report.updatedAt === syncedReportUpdatedAt) return
    syncedReportUpdatedAt = report.updatedAt
    if (!dirty) {
      history.markSaved($state.snapshot(report))
      draft = $state.snapshot(report)
      dirty = history.dirty
    }
  })

  $effect(() => {
    const annotationSignature = draft.annotations
      .map((annotation) => `${annotation.id}:${annotation.status}:${annotation.body}`)
      .join('|')
    if (annotationSignature) void refreshAnnotationMarkers()
    else annotationMarkers = []
  })

  function changed(): void {
    draft.updatedAt = Date.now()
    history.record($state.snapshot(draft))
    dirty = history.dirty
  }

  function applyReport(updated: AuditReport): void {
    history.markSaved($state.snapshot(updated))
    draft = $state.snapshot(updated)
    syncedReportUpdatedAt = updated.updatedAt
    dirty = false
  }

  function undoEdit(): void {
    const previous = history.undo($state.snapshot(draft))
    if (!previous) return
    draft = previous
    dirty = history.dirty
    closePendingAnnotation()
    closeAnnotation()
    severityEditingId = null
    void refreshAnnotationMarkers()
  }

  function redoEdit(): void {
    const next = history.redo($state.snapshot(draft))
    if (!next) return
    draft = next
    dirty = history.dirty
    closePendingAnnotation()
    closeAnnotation()
    severityEditingId = null
    void refreshAnnotationMarkers()
  }

  async function save(): Promise<AuditReport | null> {
    const saved = await onSave($state.snapshot(draft))
    if (saved) applyReport(saved)
    return saved
  }

  function annotations(section: AuditSectionId): AuditAnnotation[] {
    return draft.annotations.filter(
      (annotation) => annotation.section === section && annotation.status === 'open'
    )
  }

  function findingNumber(findingId: string): number {
    const index = draft.content.findings.findIndex((finding) => finding.id === findingId)
    return index < 0 ? 0 : index + 1
  }

  function addFinding(): void {
    draft.content.findings.push({
      id: crypto.randomUUID(),
      title: 'New finding',
      severity: 'medium',
      description: 'Describe the finding.',
      evidence: 'Add concrete evidence.'
    })
    changed()
  }

  async function scrollToFinding(findingId: string): Promise<void> {
    selectedSection = 'findings'
    await tick()
    document.getElementById(`audit-finding-${findingId}`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    })
  }

  function occurrenceIndexes(source: string, quote: string): number[] {
    if (!quote) return []
    const indexes: number[] = []
    let offset = 0
    while (offset <= source.length - quote.length) {
      const index = source.indexOf(quote, offset)
      if (index < 0) break
      indexes.push(index)
      offset = index + Math.max(quote.length, 1)
    }
    return indexes
  }

  function selectionOccurrence(sectionElement: HTMLElement, range: Range, quote: string): number {
    const prefix = document.createRange()
    prefix.selectNodeContents(sectionElement)
    try {
      prefix.setEnd(range.startContainer, range.startOffset)
    } catch {
      return 0
    }
    return occurrenceIndexes(prefix.toString(), quote).length
  }

  function offsetsForRange(
    sectionElement: HTMLElement,
    range: Range
  ): { startOffset: number; endOffset: number } {
    const startPrefix = document.createRange()
    startPrefix.selectNodeContents(sectionElement)
    const endPrefix = document.createRange()
    endPrefix.selectNodeContents(sectionElement)
    try {
      startPrefix.setEnd(range.startContainer, range.startOffset)
      endPrefix.setEnd(range.endContainer, range.endOffset)
    } catch {
      return { startOffset: 0, endOffset: range.toString().length }
    }
    return {
      startOffset: startPrefix.toString().length,
      endOffset: endPrefix.toString().length
    }
  }

  function offsetsForQuote(
    section: AuditSectionId,
    quote: string
  ): {
    startOffset: number
    endOffset: number
  } {
    const sectionElement = document.querySelector<HTMLElement>(`[data-audit-section="${section}"]`)
    const startOffset = sectionElement?.textContent?.indexOf(quote) ?? -1
    return startOffset < 0
      ? { startOffset: 0, endOffset: quote.length }
      : { startOffset, endOffset: startOffset + quote.length }
  }

  function markdownLineForQuote(
    quote: string,
    section: AuditSectionId,
    occurrence = 0
  ): { startLine: number; endLine: number } {
    const markdown = exportAuditReportMarkdown(draft)
    const heading = `## ${auditMarkdownHeadings[section]}`
    const sectionStart = markdown.indexOf(heading)
    if (sectionStart < 0) return { startLine: 1, endLine: 1 }
    const nextHeading = markdown.indexOf('\n## ', sectionStart + heading.length)
    const sectionEnd = nextHeading < 0 ? markdown.length : nextHeading
    const sectionMarkdown = markdown.slice(sectionStart, sectionEnd)
    const escapedQuote = JSON.stringify(quote).slice(1, -1)
    for (const variant of [...new Set([quote, escapedQuote])]) {
      const match = occurrenceIndexes(sectionMarkdown, variant)[occurrence]
      if (match === undefined) continue
      const absoluteIndex = sectionStart + match
      const startLine = markdown.slice(0, absoluteIndex).split('\n').length
      return { startLine, endLine: startLine + variant.split('\n').length - 1 }
    }
    const sectionLine = markdown.slice(0, sectionStart).split('\n').length
    return { startLine: sectionLine, endLine: sectionLine }
  }

  function captureDocumentSelection(): void {
    if (!workflowActionsVisible && (!onExplainSelection || !onQuickChatSelection)) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)
    const commonNode =
      range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement
    const sectionElement = commonNode?.closest<HTMLElement>('[data-audit-section]')
    const section = sectionElement?.dataset.auditSection as AuditSectionId | undefined
    const quote = selection.toString().trim()
    if (!sectionElement || !section || !quote) return
    const rect = range.getBoundingClientRect()
    selectedSection = section
    pendingAnnotation = {
      section,
      quote,
      ...markdownLineForQuote(quote, section, selectionOccurrence(sectionElement, range, quote)),
      ...offsetsForRange(sectionElement, range),
      x: Math.max(12, Math.min(rect.left, window.innerWidth - 396)),
      y: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 272)),
      sectionLevel: false
    }
    annotationBody = ''
  }

  function openSectionAnnotation(section: AuditSectionId, title: string, event: MouseEvent): void {
    if (!workflowActionsVisible) return
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) return
    const rect =
      event.currentTarget instanceof HTMLElement
        ? event.currentTarget.getBoundingClientRect()
        : { left: event.clientX, bottom: event.clientY }
    selectedSection = section
    pendingAnnotation = {
      section,
      quote: title,
      ...markdownLineForQuote(title, section),
      ...offsetsForQuote(section, title),
      x: Math.max(12, Math.min(rect.left, window.innerWidth - 396)),
      y: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 272)),
      sectionLevel: true
    }
    annotationBody = ''
  }

  async function submitAnnotation(): Promise<void> {
    const anchor = pendingAnnotation
    const body = annotationBody.trim()
    if (!anchor || !body) return
    if (dirty && !(await save())) return
    const updated = await onAddAnnotation(anchor.section, body, {
      quote: anchor.quote,
      startLine: anchor.startLine,
      endLine: anchor.endLine,
      startOffset: anchor.startOffset,
      endOffset: anchor.endOffset
    })
    if (!updated) return
    speechController.observeSent(pendingSpeechTargetId, body)
    applyReport(updated)
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
    const documentContext = exportAuditReportMarkdown(draft)
    if (mode === 'explain') onExplainSelection?.(selection.quote, documentContext)
    else onQuickChatSelection?.(selection.quote, documentContext)
    closePendingAnnotation()
  }

  function textNodesWithin(root: HTMLElement): Text[] {
    const nodes: Text[] = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let current = walker.nextNode()
    while (current) {
      if (current instanceof Text) nodes.push(current)
      current = walker.nextNode()
    }
    return nodes
  }

  function rangeForOffsets(
    root: HTMLElement,
    startOffset: number,
    endOffset: number
  ): Range | null {
    const nodes = textNodesWithin(root)
    let cursor = 0
    let startNode: Text | null = null
    let endNode: Text | null = null
    let localStart = 0
    let localEnd = 0
    for (const node of nodes) {
      const next = cursor + node.data.length
      if (!startNode && startOffset >= cursor && startOffset <= next) {
        startNode = node
        localStart = Math.min(startOffset - cursor, node.data.length)
      }
      if (endOffset >= cursor && endOffset <= next) {
        endNode = node
        localEnd = Math.min(endOffset - cursor, node.data.length)
        break
      }
      cursor = next
    }
    if (!startNode || !endNode) return null
    const range = document.createRange()
    range.setStart(startNode, localStart)
    range.setEnd(endNode, localEnd)
    return range
  }

  function rangeForAnnotation(root: HTMLElement, annotation: AuditAnnotation): Range | null {
    if (annotation.startOffset !== undefined && annotation.endOffset !== undefined) {
      const anchored = rangeForOffsets(root, annotation.startOffset, annotation.endOffset)
      if (anchored?.toString().trim() === annotation.quote?.trim()) return anchored
    }
    const quote = annotation.quote?.trim()
    if (!quote) return null
    const sectionText = root.textContent ?? ''
    const startOffset = sectionText.indexOf(quote)
    return startOffset < 0 ? null : rangeForOffsets(root, startOffset, startOffset + quote.length)
  }

  async function refreshAnnotationMarkers(): Promise<void> {
    await tick()
    const scroller = documentScroller
    if (!scroller) return
    const scrollerRect = scroller.getBoundingClientRect()
    annotationMarkers = draft.annotations.flatMap((annotation) => {
      if (annotation.status !== 'open') return []
      const section = document.querySelector<HTMLElement>(
        `[data-audit-section="${annotation.section}"]`
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

  function waitForScrollSettle(scroller: HTMLElement): Promise<void> {
    return new Promise((resolve) => {
      const startedAt = performance.now()
      let previousTop = scroller.scrollTop
      let stableFrames = 0
      const check = (): void => {
        const currentTop = scroller.scrollTop
        stableFrames = Math.abs(currentTop - previousTop) < 0.5 ? stableFrames + 1 : 0
        previousTop = currentTop
        if (stableFrames >= 3 || performance.now() - startedAt >= 900) {
          resolve()
          return
        }
        requestAnimationFrame(check)
      }
      requestAnimationFrame(check)
    })
  }

  async function openAnnotation(annotation: AuditAnnotation): Promise<void> {
    window.getSelection()?.removeAllRanges()
    CSS.highlights?.delete(AUDIT_ANNOTATION_HIGHLIGHT)
    editingAnnotation = null
    editingAnnotationPosition = null
    selectedSection = annotation.section
    pendingAnnotation = null
    await tick()
    const section = document.querySelector<HTMLElement>(
      `[data-audit-section="${annotation.section}"]`
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
      `[data-audit-annotation-marker="${CSS.escape(annotation.id)}"]`
    )
    const rect = marker?.getBoundingClientRect() ?? range?.getBoundingClientRect() ?? initialRect
    if (range && typeof Highlight !== 'undefined' && CSS.highlights) {
      CSS.highlights.set(AUDIT_ANNOTATION_HIGHLIGHT, new Highlight(range))
    }
    editingAnnotation = annotation
    editingAnnotationBody = annotation.body
    annotationEditMode = false
    if (rect) {
      const width = 320
      const preferredX = rect.right + 8
      const x = preferredX + width <= window.innerWidth - 12 ? preferredX : rect.left - width - 8
      editingAnnotationPosition = {
        x: Math.max(12, Math.min(x, window.innerWidth - width - 12)),
        y: Math.max(12, Math.min(rect.top, window.innerHeight - 288))
      }
    } else {
      editingAnnotationPosition = { x: 12, y: 12 }
    }
  }

  function closeAnnotation(): void {
    CSS.highlights?.delete(AUDIT_ANNOTATION_HIGHLIGHT)
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
    speechController.observeSent(`audit-annotation-edit-${annotation.id}`, body)
    applyReport(updated)
    const saved = updated.annotations.find((candidate) => candidate.id === annotation.id)
    if (saved) {
      editingAnnotation = saved
      editingAnnotationBody = saved.body
    }
    annotationEditMode = false
  }

  async function resolveAnnotation(annotationId: string): Promise<void> {
    const updated = await onResolveAnnotation(annotationId)
    if (updated) applyReport(updated)
    closeAnnotation()
  }

  onMount(() => {
    if (!documentScroller) return
    markerResizeObserver = new ResizeObserver(() => void refreshAnnotationMarkers())
    markerResizeObserver.observe(documentScroller)
  })

  onDestroy(() => {
    markerResizeObserver?.disconnect()
    CSS.highlights?.delete(AUDIT_ANNOTATION_HIGHLIGHT)
  })

  function severityClass(severity: AuditFindingSeverity): string {
    if (severity === 'critical') return 'bg-danger/10 text-danger'
    if (severity === 'high') return 'bg-warning/15 text-warning'
    if (severity === 'medium') return 'bg-accent/15 text-accent'
    if (severity === 'low') return 'bg-info/10 text-info'
    return 'bg-raised text-muted'
  }

  function severityDotClass(severity: AuditFindingSeverity): string {
    if (severity === 'critical') return 'bg-danger'
    if (severity === 'high') return 'bg-warning'
    if (severity === 'medium') return 'bg-accent'
    if (severity === 'low') return 'bg-info'
    return 'bg-dimmed'
  }

  function severityTextClass(severity: AuditFindingSeverity): string {
    if (severity === 'critical') return 'text-danger'
    if (severity === 'high') return 'text-warning'
    if (severity === 'medium') return 'text-accent'
    if (severity === 'low') return 'text-info'
    return 'text-muted'
  }
</script>
<StudioShell
  ariaLabel="Audit studio"
  scrollerLabel="Audit report"
  sidebarTitle="Audit report"
  sidebarLabel="Audit sections"
  sectionAnchorPrefix="audit-section"
  sections={shellSections}
  bind:selectedSection
  bind:sectionsOpen
  bind:scroller={documentScroller}
  openAnnotationCount={draft.annotations.filter((annotation) => annotation.status === 'open').length}
  annotationsTitle="Section annotations"
  annotationsEmptyLabel="Select text or click a section heading to annotate."
  sectionAnnotations={annotations}
  onOpenAnnotation={(annotation) => void openAnnotation(annotation)}
  {error}
  onScrollerMouseUp={captureDocumentSelection}
>
  {#snippet navigation()}
    <StudioDocumentNavigation
      active="audit"
      {brainstormAvailable}
      {prdAvailable}
      {assignmentAvailable}
      auditAvailable
      {agentMessagesOpen}
      {onBack}
      {onToggleAgentMessages}
      {sectionsOpen}
      sectionsLabel="audit sections"
      onToggleSections={() => (sectionsOpen = !sectionsOpen)}
      {onOpenBrainstorm}
      {onOpenPrd}
      {onOpenSpec}
      {onOpenAssignment}
    />
  {/snippet}

  {#snippet center()}
    <StudioVersionBar
      versions={[...versions]
        .sort((left, right) => right.version - left.version)
        .map((version) => ({ version: version.version }))}
      currentVersion={draft.version}
      updatedAt={draft.updatedAt}
      statusLabel={statusLabel}
      statusClass={statusClass}
      {dirty}
      canUndo={history.canUndo}
      canRedo={history.canRedo}
      canSave={workflowActionsVisible}
      {busy}
      savePending={false}
      versionMenuTitle="Choose an audit report version"
      versionItemTitle={(version) => `Open audit report version ${version}`}
      onSelectVersion={(version) => void onSelectVersion(version)}
      onUndo={undoEdit}
      onRedo={redoEdit}
      onSave={() => void save()}
    />
  {/snippet}

  {#snippet actions()}
    {#if workflowActionsVisible}
      <button
        class="rounded-lg border bg-elevated px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-overlay"
        disabled={busy || reviewSubmitting}
        title="Send review notes to the primary agent"
        onclick={() => (reviewOpen = true)}
      >
        Review
      </button>
      {#if !reviewStarted}
        <button
          class="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary disabled:opacity-50"
          disabled={busy}
          title="Complete this audit without review notes"
          onclick={onComplete}
        >
          Complete <Check size={13} />
        </button>
      {/if}
    {/if}
  {/snippet}

  {#snippet headerExtra()}
    {#if reviewOpen && workflowActionsVisible}
      <div class="flex flex-col gap-2 border-t px-3 py-2.5 md:flex-row md:items-end md:px-4">
        <label class="min-w-0 flex-1 text-[11px] font-medium text-muted">
          Additional instructions for the primary agent
          <RichMarkdownEditor
            bind:this={reviewNotesEditor}
            class="mt-1 min-h-14 w-full rounded-lg border bg-elevated px-3 py-2 text-xs"
            bind:value={reviewNotes}
            placeholder="Optional rework instructions"
            ariaLabel="Audit review instructions"
          />
        </label>
        <button
          class="rounded-lg px-3 py-2 text-xs text-muted"
          disabled={reviewSubmitting}
          title="Discard review notes"
          onclick={() => (reviewOpen = false)}
        >
          Cancel
        </button>
        <VoiceInputButton
          targetId={reviewSpeechTargetId}
          getTarget={reviewSpeechTarget}
          scope={speechScope}
          disabled={busy || reviewSubmitting}
        />
        <button
          class="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary disabled:opacity-50"
          disabled={busy || reviewSubmitting}
          title="Send review notes to the primary agent"
          onclick={() => void submitReview()}
        >
          {reviewSubmitting ? 'Submitting…' : 'Review'}
        </button>
      </div>
    {/if}
  {/snippet}

  {#snippet sidebarExtra()}
    <div class="border-t p-2">
      {#each findingSeverities as severity (severity)}
        {@const severityFindings = draft.content.findings.filter(
          (finding) => finding.severity === severity
        )}
        {#if severityFindings.length}
          <div class="py-0.5">
            <div class="flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold capitalize">
              <span class="h-1.5 w-1.5 rounded-full {severityDotClass(severity)}"></span>
              <span class={severityTextClass(severity)}>{severity}</span>
              <span class="ml-auto text-dimmed">{severityFindings.length}</span>
            </div>
            {#each severityFindings as finding (finding.id)}
              <button
                class="flex w-full items-baseline gap-1.5 rounded-md px-2 py-1 text-left text-[10px] text-muted hover:bg-elevated hover:text-foreground"
                title={finding.title}
                onclick={() => void scrollToFinding(finding.id)}
              >
                <span class="shrink-0 tabular-nums text-dimmed">{findingNumber(finding.id)}.</span>
                <span class="min-w-0 truncate">{finding.title}</span>
              </button>
            {/each}
          </div>
        {/if}
      {/each}
    </div>
  {/snippet}

  {#snippet sidebarFooter()}
    <StudioSidebarFileActions
      viewTitle="Reveal this audit report as Markdown in the file tree"
      openTitle={`Open this audit report as Markdown in ${preferredName}`}
      {busy}
      onReveal={onRevealInAppFile ? () => onRevealInAppFile(draft) : undefined}
      onOpen={onOpenInEditor ? () => onOpenInEditor(draft) : undefined}
    />
  {/snippet}

  {#snippet markers()}
    {#each annotationMarkers as marker (marker.annotation.id)}
      <button
        data-audit-annotation-marker={marker.annotation.id}
        class="absolute z-10 grid h-7 w-7 place-items-center rounded-full border bg-surface text-info shadow-sm hover:bg-elevated"
        style:left={compactViewport.matches
          ? undefined
          : `${Math.min(marker.x, (documentScroller?.scrollWidth ?? marker.x + 32) - 32)}px`}
        style:top={`${marker.y}px`}
        title={`Open annotation: ${marker.annotation.body}`}
        aria-label={`Open annotation: ${marker.annotation.body}`}
        onclick={() => void openAnnotation(marker.annotation)}
      >
        <MessageSquare size={13} />
      </button>
    {/each}
  {/snippet}

      <article class="mx-auto max-w-4xl space-y-12 px-4 py-6 text-sm leading-7 md:px-8 md:py-8">
        {@render textSection('executive_summary', 'Executive summary', 'executiveSummary')}

        <section id="audit-section-findings" data-audit-section="findings" class="scroll-mt-5">
          {@render sectionHeading('findings', 'Findings')}
          <ol class="mt-3 divide-y divide-border">
            {#each draft.content.findings as finding, index (finding.id)}
              <li
                id={`audit-finding-${finding.id}`}
                class="scroll-mt-20 space-y-3 py-5 first:pt-2 last:pb-2"
              >
                <div class="flex items-start gap-2">
                  <span class="mt-0.5 text-xs font-semibold tabular-nums text-dimmed">
                    {index + 1}.
                  </span>
                  <EditableMarkdown
                    text={finding.title}
                    readOnly={!workflowActionsVisible}
                    class="min-w-0 flex-1 rounded-md px-1 text-base font-semibold outline-none focus:bg-surface"
                    ariaLabel={`Finding ${index + 1} title`}
                    onChange={(value) => {
                      finding.title = value
                      changed()
                    }}
                  />
                  {#if workflowActionsVisible && severityEditingId === finding.id}
                    <select
                      class="rounded-md border bg-elevated px-2 py-1 text-xs"
                      bind:value={finding.severity}
                      onchange={() => {
                        changed()
                        severityEditingId = null
                      }}
                      onblur={() => (severityEditingId = null)}
                      aria-label={`Finding ${index + 1} severity`}
                    >
                      {#each findingSeverities as severity (severity)}
                        <option value={severity}>{severity}</option>
                      {/each}
                    </select>
                  {:else if workflowActionsVisible}
                    <button
                      class="rounded-md px-2 py-1 text-xs font-medium capitalize hover:opacity-80 {severityClass(
                        finding.severity
                      )}"
                      title={`Edit finding severity: ${finding.severity}`}
                      onclick={() => (severityEditingId = finding.id)}
                    >
                      {finding.severity}
                    </button>
                  {/if}
                  {#if workflowActionsVisible}
                    <button
                      class="rounded-md p-1 text-muted hover:bg-danger/10 hover:text-danger"
                      title={`Remove finding ${index + 1}`}
                      aria-label={`Remove finding ${index + 1}`}
                      onclick={() => {
                        draft.content.findings.splice(index, 1)
                        changed()
                      }}
                    >
                      <X size={13} />
                    </button>
                  {/if}
                </div>
                <EditableMarkdown
                  text={finding.description}
                  readOnly={!workflowActionsVisible}
                  class="audit-markdown w-full whitespace-pre-wrap rounded-lg px-2 py-1 text-muted outline-none focus:bg-surface focus:text-foreground"
                  ariaLabel={`Finding ${index + 1} description`}
                  onChange={(value) => {
                    finding.description = value
                    changed()
                  }}
                />
                <div class="mt-4 border-l-2 border-border pl-4">
                  <p class="mb-1 text-xs font-semibold uppercase tracking-wide text-dimmed">
                    Evidence
                  </p>
                  <EditableMarkdown
                    text={finding.evidence}
                    readOnly={!workflowActionsVisible}
                    class="audit-markdown whitespace-pre-wrap rounded-lg px-2 py-1 text-muted outline-none focus:bg-surface focus:text-foreground"
                    ariaLabel={`Finding ${index + 1} evidence`}
                    onChange={(value) => {
                      finding.evidence = value
                      changed()
                    }}
                  />
                </div>
              </li>
            {/each}
          </ol>
          {#if workflowActionsVisible}
            <div class="mt-3">
              <button
                class="flex items-center gap-1 rounded-lg border bg-elevated px-3 py-2 text-xs"
                onclick={addFinding}
              >
                <Plus size={13} /> Add finding
              </button>
            </div>
          {/if}
          {@render AnnotationBubbles({
            annotations: annotations('findings'),
            onOpen: openAnnotation
          })}
        </section>

        {#if draft.content.auditedFiles?.length || draft.content.verification}
          <section class="scroll-mt-5" aria-labelledby="audit-verification-heading">
            <h2 id="audit-verification-heading" class="text-xl font-semibold tracking-tight">
              Verification evidence
            </h2>

            {#if draft.content.auditedFiles?.length}
              <div class="mt-4">
                <h3 class="text-xs font-semibold uppercase tracking-wide text-dimmed">
                  Audited files
                </h3>
                <ul class="mt-2 divide-y divide-border border-y">
                  {#each draft.content.auditedFiles as file (file.path)}
                    <li class="grid gap-1 py-2.5 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                      <code class="break-all text-xs text-foreground">{file.path}</code>
                      <span class="text-xs leading-5 text-muted">{file.reason}</span>
                    </li>
                  {/each}
                </ul>
              </div>
            {/if}

            {#if draft.content.verification}
              <div class="mt-5 space-y-5">
                <div class="grid gap-1 text-xs md:grid-cols-[8rem_minmax(0,1fr)]">
                  <span class="font-semibold text-dimmed">Repository state</span>
                  <code class="break-all text-foreground">
                    {draft.content.verification.repositoryRevision}
                  </code>
                  <span class="font-semibold text-dimmed">Audit scope</span>
                  <span class="text-muted">{draft.content.verification.scope}</span>
                </div>

                <div>
                  <h3 class="text-xs font-semibold uppercase tracking-wide text-dimmed">
                    Scoped checks
                  </h3>
                  <div class="mt-2 divide-y divide-border border-y">
                    {#each draft.content.verification.checks as check (check.id)}
                      <div class="space-y-1.5 py-3">
                        <div class="flex flex-wrap items-center gap-2">
                          <span class="text-xs font-semibold capitalize text-foreground">
                            {check.kind}
                          </span>
                          <span
                            class="rounded-md bg-raised px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted"
                          >
                            {check.status.replace('_', ' ')}
                          </span>
                          {#if check.exitCode !== undefined}
                            <span class="text-[10px] tabular-nums text-dimmed">
                              Exit {check.exitCode}
                            </span>
                          {/if}
                        </div>
                        {#if check.command}
                          <code
                            class="block overflow-x-auto whitespace-pre text-xs text-foreground"
                          >
                            {check.command}
                          </code>
                        {/if}
                        <p class="text-xs leading-5 text-muted">{check.evidence}</p>
                        {#if check.files.length}
                          <p class="break-all text-[10px] leading-4 text-dimmed">
                            {check.files.join(', ')}
                          </p>
                        {/if}
                      </div>
                    {/each}
                  </div>
                </div>

                <div>
                  <h3 class="text-xs font-semibold uppercase tracking-wide text-dimmed">
                    Utilities and MCPs
                  </h3>
                  <ul class="mt-2 space-y-2">
                    {#each draft.content.verification.utilities as utility (utility.name)}
                      <li class="text-xs leading-5 text-muted">
                        <span class="font-semibold text-foreground">{utility.name}</span>
                        <span class="text-dimmed"> · {utility.status.replace('_', ' ')}</span>
                        — {utility.evidence}
                      </li>
                    {/each}
                  </ul>
                </div>

                {#if draft.content.verification.limitations.length}
                  <div>
                    <h3 class="text-xs font-semibold uppercase tracking-wide text-dimmed">
                      Limitations
                    </h3>
                    <ul class="mt-2 list-disc space-y-1 pl-5 text-xs leading-5 text-muted">
                      {#each draft.content.verification.limitations as limitation (limitation)}
                        <li>{limitation}</li>
                      {/each}
                    </ul>
                  </div>
                {/if}
              </div>
            {/if}
          </section>
        {/if}

        {@render textSection(
          'resolution_recommendation',
          'Resolution & recommendation',
          'resolutionRecommendation'
        )}
        {@render textSection('conclusion', 'Conclusion', 'conclusion')}
      </article>
</StudioShell>

{#if pendingAnnotation}
  <StudioPendingAnnotationPopover
    position={{ x: pendingAnnotation.x, y: pendingAnnotation.y }}
    quote={pendingAnnotation.quote}
    canAnnotate={workflowActionsVisible}
    showSelectionActions={!pendingAnnotation.sectionLevel}
    {busy}
    speechTargetId={pendingSpeechTargetId}
    dialogLabel={pendingAnnotation.sectionLevel
      ? 'Annotate section'
      : workflowActionsVisible
        ? 'Comment on selection'
        : 'Actions for selection'}
    headerLabel={pendingAnnotation.sectionLevel
      ? 'Annotate section'
      : workflowActionsVisible
        ? 'Comment on selection'
        : 'Selection'}
    editorLabel="Audit annotation"
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
    canEdit={workflowActionsVisible}
    editorMode={annotationEditMode}
    headerLabel={annotationEditMode ? 'Edit annotation' : 'Annotation'}
    dialogLabel="Audit annotation"
    speechTargetId={`audit-annotation-edit-${editingAnnotation.id}`}
    scope={speechScope}
    bind:body={editingAnnotationBody}
    onResolve={() => {
      if (editingAnnotation) void resolveAnnotation(editingAnnotation.id)
    }}
    onSave={saveAnnotationEdit}
    onCancelEdit={() => (annotationEditMode = false)}
    onEditClick={() => (annotationEditMode = true)}
    onClose={closeAnnotation}
  />
{/if}


{#snippet sectionHeading(section: AuditSectionId, title: string)}
  {#if workflowActionsVisible}
    <button
      class="group flex items-center gap-2 text-left"
      title={`Annotate ${title}`}
      onclick={(event: MouseEvent) => openSectionAnnotation(section, title, event)}
    >
      <span class="text-xl font-semibold tracking-tight">{title}</span>
      <MessageSquarePlus
        size={14}
        class="text-dimmed opacity-0 transition-opacity max-md:opacity-100 group-hover:opacity-100"
      />
    </button>
  {:else}
    <h2 class="text-xl font-semibold tracking-tight">{title}</h2>
  {/if}
{/snippet}

{#snippet textSection(
  section: AuditSectionId,
  title: string,
  key: 'executiveSummary' | 'resolutionRecommendation' | 'conclusion'
)}
  <section id={`audit-section-${section}`} data-audit-section={section} class="scroll-mt-5">
    {@render sectionHeading(section, title)}
    <EditableMarkdown
      text={draft.content[key]}
      readOnly={!workflowActionsVisible}
      class="audit-markdown mt-3 w-full whitespace-pre-wrap rounded-lg px-2 py-1 text-muted outline-none focus:bg-surface focus:text-foreground"
      ariaLabel={title}
      onChange={(value) => {
        draft.content[key] = value
        changed()
      }}
    />
    {@render AnnotationBubbles({ annotations: annotations(section), onOpen: openAnnotation })}
  </section>
{/snippet}

{#snippet AnnotationBubbles(props: {
  annotations: AuditAnnotation[]
  onOpen: (annotation: AuditAnnotation) => void | Promise<void>
})}
  {#if props.annotations.length}
    <div class="mt-4 flex gap-2 overflow-x-auto pb-1" aria-label="Section annotations">
      {#each props.annotations as annotation (annotation.id)}
        <button
          class="max-w-64 shrink-0 rounded-xl border bg-surface px-3 py-2 text-left hover:bg-elevated"
          title="Open annotation"
          onclick={() => void props.onOpen(annotation)}
        >
          <span class="line-clamp-2 block text-xs leading-relaxed">{annotation.body}</span>
          <span class="mt-1 block text-[10px] text-dimmed">{annotation.author}</span>
        </button>
      {/each}
    </div>
  {/if}
{/snippet}

<style>
  :global(.audit-markdown.markdown-body > p) {
    white-space: pre-line;
  }

  :global(.audit-markdown.markdown-body > * + *) {
    margin-top: 0.75rem;
  }
</style>
