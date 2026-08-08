<script lang="ts">
  import {
    AppWindow,
    Check,
    FileText,
    MessageSquare,
    MessageSquarePlus,
    Pencil,
    Plus,
    Save,
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
  import EditableMarkdown from './EditableMarkdown.svelte'
  import StudioDocumentNavigation from './StudioDocumentNavigation.svelte'
  import StudioSidebarResizeHandle from './StudioSidebarResizeHandle.svelte'
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
    busy?: boolean
    error?: string
    brainstormAvailable?: boolean
    assignmentAvailable?: boolean
    agentMessagesOpen?: boolean
    actionsAvailable?: boolean
    onBack: () => void
    onOpenBrainstorm?: () => void
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
    onReview: (report: AuditReport, notes: string) => Promise<boolean>
    onComplete: () => CallbackResult
    onOpenInEditor?: (report: AuditReport) => CallbackResult
    onRevealInAppFile?: (report: AuditReport) => CallbackResult
  }

  let {
    report,
    versions,
    busy = false,
    error,
    brainstormAvailable = false,
    assignmentAvailable = false,
    agentMessagesOpen = false,
    actionsAvailable = true,
    onBack,
    onOpenBrainstorm,
    onOpenSpec,
    onOpenAssignment,
    onToggleAgentMessages,
    onSelectVersion,
    onSave,
    onAddAnnotation,
    onUpdateAnnotation,
    onResolveAnnotation,
    onReview,
    onComplete,
    onOpenInEditor,
    onRevealInAppFile
  }: Props = $props()
  // svelte-ignore state_referenced_locally
  let draft = $state<AuditReport>($state.snapshot(report))
  let dirty = $state(false)
  let reviewOpen = $state(false)
  let reviewNotes = $state('')
  let reviewSubmitting = $state(false)
  let preferredIcon = $derived(editorPreference.preferredInfo?.iconDataUrl)
  let preferredName = $derived(editorPreference.preferredInfo?.name ?? 'System Default')
  let annotationBody = $state('')
  let pendingAnnotation = $state<PendingAnnotation | null>(null)
  let editingAnnotation = $state<AuditAnnotation | null>(null)
  let editingAnnotationBody = $state('')
  let editingAnnotationPosition = $state<{ x: number; y: number } | null>(null)
  let annotationEditMode = $state(false)
  let annotationMarkers = $state<Array<{ annotation: AuditAnnotation; x: number; y: number }>>([])
  let severityEditingId = $state<string | null>(null)
  let selectedSection = $state<AuditSectionId>('executive_summary')
  /** Phone only: the section rail is a bottom drawer instead of a column. */
  let sectionsOpen = $state(false)
  let documentScroller = $state<HTMLElement | null>(null)
  let syncedReportUpdatedAt = $state(0)
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

  async function submitReview(): Promise<void> {
    if (reviewSubmitting || busy || !workflowActionsVisible) return
    reviewSubmitting = true
    try {
      if (await onReview($state.snapshot(draft), reviewNotes)) reviewOpen = false
    } finally {
      reviewSubmitting = false
    }
  }

  $effect(() => {
    if (report.updatedAt === syncedReportUpdatedAt) return
    syncedReportUpdatedAt = report.updatedAt
    if (!dirty) draft = $state.snapshot(report)
  })

  $effect(() => {
    const annotationSignature = draft.annotations
      .map((annotation) => `${annotation.id}:${annotation.status}:${annotation.body}`)
      .join('|')
    if (annotationSignature) void refreshAnnotationMarkers()
    else annotationMarkers = []
  })

  function changed(): void {
    dirty = true
    draft.updatedAt = Date.now()
  }

  function applyReport(updated: AuditReport): void {
    draft = $state.snapshot(updated)
    syncedReportUpdatedAt = updated.updatedAt
    dirty = false
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

  async function selectAndScroll(section: AuditSectionId): Promise<void> {
    sectionsOpen = false
    selectedSection = section
    await tick()
    const target = document.getElementById(`audit-section-${section}`)
    if (!target || !documentScroller) return
    const scrollerTop = documentScroller.getBoundingClientRect().top
    const targetTop = target.getBoundingClientRect().top
    documentScroller.scrollTo({
      top: documentScroller.scrollTop + targetTop - scrollerTop - 20,
      behavior: 'smooth'
    })
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
    if (!workflowActionsVisible) return
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
      x: Math.max(12, Math.min(rect.left, window.innerWidth - 304)),
      y: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 224)),
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
      x: Math.max(12, Math.min(rect.left, window.innerWidth - 304)),
      y: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 224)),
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

  function formatDate(timestamp: number): string {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(timestamp)
  }
</script>

<section class="flex h-full min-h-0 flex-col bg-app" aria-label="Audit studio">
  <header class="shrink-0 border-b bg-surface">
    <div
      class="flex flex-col gap-2 px-2 py-2 md:grid md:min-h-12 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-center md:gap-3 md:px-3 md:py-0"
    >
      <div class="flex min-w-0 items-center gap-2">
        <StudioDocumentNavigation
          active="audit"
          {brainstormAvailable}
          {assignmentAvailable}
          auditAvailable
          {agentMessagesOpen}
          {onBack}
          {onToggleAgentMessages}
          {sectionsOpen}
          sectionsLabel="audit sections"
          onToggleSections={() => (sectionsOpen = !sectionsOpen)}
          {onOpenBrainstorm}
          {onOpenSpec}
          {onOpenAssignment}
        />
      </div>
      <div class="flex items-center gap-2 max-md:flex-wrap">
        <label class="sr-only" for="audit-version">Audit report version</label>
        <select
          id="audit-version"
          class="rounded-md border bg-elevated px-2 py-1 text-xs"
          value={draft.version}
          onchange={(event: Event & { currentTarget: HTMLSelectElement }) =>
            void onSelectVersion(Number((event.currentTarget as HTMLSelectElement).value))}
        >
          {#each [...versions].sort((a, b) => b.version - a.version) as version (version.version)}
            <option value={version.version}>Version {version.version}</option>
          {/each}
        </select>
        {#if dirty && workflowActionsVisible}
          <button
            class="flex items-center gap-1 rounded-md border bg-elevated px-2 py-1 text-xs"
            disabled={busy}
            onclick={() => void save()}
          >
            <Save size={12} /> Save
          </button>
        {/if}
      </div>
      <div class="flex items-center gap-2 max-md:*:h-10 max-md:*:flex-1 md:justify-end">
        {#if workflowActionsVisible}
          <button
            class="rounded-lg border bg-elevated px-3 py-1.5 text-xs font-semibold hover:bg-overlay"
            disabled={busy || reviewSubmitting}
            onclick={() => (reviewOpen = true)}
          >
            Review
          </button>
          {#if !reviewStarted}
            <button
              class="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary disabled:opacity-50"
              disabled={busy}
              onclick={onComplete}
            >
              Complete <Check size={13} />
            </button>
          {/if}
        {/if}
      </div>
    </div>
    {#if reviewOpen && workflowActionsVisible}
      <div class="flex flex-col gap-2 border-t px-3 py-2.5 md:flex-row md:items-end md:px-4">
        <label class="min-w-0 flex-1 text-[11px] font-medium text-muted">
          Additional instructions for the primary agent
          <RichMarkdownEditor
            class="mt-1 min-h-14 w-full rounded-lg border bg-elevated px-3 py-2 text-xs"
            bind:value={reviewNotes}
            placeholder="Optional rework instructions"
            ariaLabel="Audit review instructions"
          />
        </label>
        <button
          class="rounded-lg px-3 py-2 text-xs text-muted"
          disabled={reviewSubmitting}
          onclick={() => (reviewOpen = false)}
        >
          Cancel
        </button>
        <button
          class="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary disabled:opacity-50"
          disabled={busy || reviewSubmitting}
          onclick={() => void submitReview()}
        >
          {reviewSubmitting ? 'Submitting…' : 'Review'}
        </button>
      </div>
    {/if}
    {#if error}<p class="border-t bg-danger/10 px-4 py-2 text-xs text-danger">{error}</p>{/if}
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
      aria-label="Audit sections"
    >
      <StudioSidebarResizeHandle sidebarLabel="Audit sections" />
      <div class="flex h-12 shrink-0 items-center justify-between border-b px-3 md:hidden">
        <p class="text-[10px] font-semibold uppercase tracking-[0.16em] text-dimmed">
          Audit report
        </p>
        <button
          class="flex h-9 w-9 items-center justify-center rounded-lg text-muted"
          aria-label="Close sections"
          title="Close sections"
          onclick={() => (sectionsOpen = false)}
        >
          <X size={16} />
        </button>
      </div>
      <div class="min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain p-2">
        {#each auditSections as section (section.id)}
          {@const annotationCount = annotations(section.id).length}
          <button
            class="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors max-md:py-3 {selectedSection ===
            section.id
              ? 'bg-elevated font-semibold text-foreground'
              : 'text-muted hover:bg-elevated/60 hover:text-foreground'}"
            title={`Scroll to ${section.label}`}
            onclick={() => void selectAndScroll(section.id)}
          >
            <span>{section.label}</span>
            <span class="flex items-center gap-1">
              {#if annotationCount}
                <span class="rounded-full bg-info/10 px-1.5 text-[10px] text-info">
                  {annotationCount}
                </span>
              {/if}
              {#if section.id === 'findings'}
                <span class="text-[10px] tabular-nums text-dimmed">
                  {draft.content.findings.length}
                </span>
              {/if}
            </span>
          </button>
          {#if section.id === 'findings'}
            <div class="ml-3 border-l pl-2">
              {#each findingSeverities as severity (severity)}
                {@const severityFindings = draft.content.findings.filter(
                  (finding) => finding.severity === severity
                )}
                {#if severityFindings.length}
                  <div class="py-0.5">
                    <div
                      class="flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold capitalize"
                    >
                      <span class="h-1.5 w-1.5 rounded-full {severityDotClass(severity)}"></span>
                      <span class={severityTextClass(severity)}>{severity}</span>
                      <span class="ml-auto text-dimmed">{severityFindings.length}</span>
                    </div>
                    {#each severityFindings as finding (finding.id)}
                      <button
                        class="block w-full truncate rounded-md px-2 py-1 text-left text-[10px] text-muted hover:bg-elevated hover:text-foreground"
                        title={finding.title}
                        onclick={() => void scrollToFinding(finding.id)}
                      >
                        {finding.title}
                      </button>
                    {/each}
                  </div>
                {/if}
              {/each}
            </div>
          {/if}
        {/each}

        <div class="mt-3 border-t pt-3">
          <div class="flex items-center justify-between px-2">
            <p class="text-[10px] font-semibold uppercase tracking-wide text-muted">
              Section annotations
            </p>
            <span class="text-[10px] tabular-nums text-dimmed">
              {annotations(selectedSection).length}
            </span>
          </div>
          <div class="mt-2 space-y-1.5 px-1">
            {#each annotations(selectedSection) as annotation (annotation.id)}
              <button
                class="block w-full rounded-lg border bg-elevated px-2.5 py-2 text-left hover:bg-overlay"
                title="Open and edit annotation"
                onclick={() => openAnnotation(annotation)}
              >
                {#if annotation.quote}
                  <span class="block truncate text-[10px] text-dimmed">“{annotation.quote}”</span>
                {/if}
                <span class="mt-0.5 line-clamp-2 block text-xs leading-relaxed">
                  {annotation.body}
                </span>
              </button>
            {:else}
              <p
                class="rounded-lg border border-dashed px-2.5 py-3 text-center text-[11px] text-dimmed"
              >
                Select text or click a section heading to annotate.
              </p>
            {/each}
          </div>
        </div>
      </div>

      {#if onRevealInAppFile || onOpenInEditor}
        <div class="flex shrink-0 items-center gap-1 border-t p-2">
          {#if onRevealInAppFile}
            <button
              class="flex h-8 flex-1 items-center justify-center gap-2 rounded-lg px-2.5 text-xs font-medium text-muted hover:bg-elevated hover:text-foreground disabled:opacity-50"
              disabled={busy}
              title="Reveal this audit report as Markdown in the file tree"
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
              title={`Open this audit report as Markdown in ${preferredName}`}
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
    </aside>
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <main
      bind:this={documentScroller}
      class="relative min-h-0 overflow-y-auto scroll-smooth"
      aria-label="Audit report"
      onmouseup={captureDocumentSelection}
    >
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

        {@render textSection(
          'resolution_recommendation',
          'Resolution & recommendation',
          'resolutionRecommendation'
        )}
        {@render textSection('conclusion', 'Conclusion', 'conclusion')}
      </article>
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
    </main>
  </div>
</section>

{#if pendingAnnotation}
  <div
    class="fixed z-50 w-72 rounded-xl border bg-surface p-3 shadow-xl max-md:inset-x-0 max-md:bottom-0 max-md:w-auto max-md:rounded-b-none max-md:pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
    style:left={compactViewport.matches ? undefined : `${pendingAnnotation.x}px`}
    style:top={compactViewport.matches ? undefined : `${pendingAnnotation.y}px`}
    role="dialog"
    aria-label={pendingAnnotation.sectionLevel ? 'Annotate section' : 'Comment on selection'}
  >
    <p class="text-[10px] font-semibold uppercase tracking-wide text-muted">
      {pendingAnnotation.sectionLevel ? 'Annotate section' : 'Comment on selection'}
    </p>
    <blockquote
      class="mt-2 line-clamp-3 border-l-2 border-accent pl-2 text-[11px] leading-relaxed text-muted"
    >
      “{pendingAnnotation.quote}”
    </blockquote>
    <RichMarkdownEditor
      class="mt-2 min-h-16 w-full resize-y rounded-lg border bg-elevated px-2.5 py-2 text-xs outline-none focus:border-primary"
      bind:value={annotationBody}
      placeholder="Leave your review note…"
      ariaLabel="Audit annotation"
      onSubmit={() => void submitAnnotation()}
    />
    <div class="mt-2 flex justify-end gap-1.5">
      <button
        class="rounded-lg px-2.5 py-1.5 text-xs text-muted hover:bg-overlay"
        title="Cancel annotation"
        onclick={closePendingAnnotation}>Cancel</button
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
    aria-label="Audit annotation"
  >
    <div class="flex items-center justify-between gap-2">
      <p class="text-[10px] font-semibold uppercase tracking-wide text-muted">
        {annotationEditMode ? 'Edit annotation' : 'Annotation'}
      </p>
      <button
        class="rounded-md p-1 text-muted hover:bg-overlay hover:text-foreground"
        title="Close annotation"
        aria-label="Close annotation"
        onclick={closeAnnotation}
      >
        <X size={13} />
      </button>
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
        ariaLabel="Audit annotation body"
        onSubmit={() => void saveAnnotationEdit()}
      />
    {:else}
      <p class="mt-3 text-xs leading-relaxed text-foreground">{editingAnnotation.body}</p>
    {/if}
    <p class="mt-1 text-[10px] text-dimmed">
      {editingAnnotation.author} · {formatDate(editingAnnotation.createdAt)}
    </p>
    <div class="mt-3 flex items-center justify-between">
      {#if workflowActionsVisible}
        <button
          class="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-success hover:bg-success/10"
          title="Resolve annotation"
          onclick={() => void resolveAnnotation(editingAnnotation!.id)}
        >
          <Check size={12} /> Resolve
        </button>
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
            onclick={() => (annotationEditMode = true)}
          >
            <Pencil size={12} /> Edit
          </button>
        {/if}
      {/if}
    </div>
  </div>
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
