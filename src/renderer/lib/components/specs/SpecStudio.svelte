<script lang="ts">
  import { AlertCircle, ArrowRight, MessageSquare, ShieldCheck, X } from '@lucide/svelte'
  import { onDestroy, tick } from 'svelte'
  import { exportEngineeringSpecMarkdown } from '$shared/spec/spec-markdown'
  import { validateEngineeringSpec } from '$shared/spec/spec-validation'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import RichMarkdownEditor from '../shared/RichMarkdownEditor.svelte'
  import VoiceInputButton from '../speech/VoiceInputButton.svelte'
  import { speechController } from '../../speech/speech-controller.svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import StudioDocumentNavigation from './StudioDocumentNavigation.svelte'
  import StudioShell from './StudioShell.svelte'
  import type { StudioShellSection } from './StudioShell.svelte'
  import StudioSidebarFileActions from './StudioSidebarFileActions.svelte'
  import StudioVersionBar from './StudioVersionBar.svelte'
  import StudioPendingAnnotationPopover from './StudioPendingAnnotationPopover.svelte'
  import StudioAnnotationDetailPopover from './StudioAnnotationDetailPopover.svelte'
  import SpecStudioDocument from './SpecStudioDocument.svelte'
  import { offsetsForQuote, offsetsForRange } from '$lib/selection-anchors'
  import { StudioAnnotationOverlay, clampPendingPosition } from './studio-annotation-overlay.svelte'
  import type { StudioDocumentHistory } from './studio-document-history.svelte'
  import type { PendingOverlayAnchor } from './studio-annotation-overlay.svelte'
  import { markdownLineForQuote, selectionOccurrence } from './spec-studio-document-anchors'
  import { SpecStudioContextPickerController } from './spec-studio-context-picker.svelte'
  import { statusClass, statusLabel } from './spec-studio-formatting'
  import {
    addSpecArrayItem,
    addSpecCheckpoint,
    addSpecFileOperation,
    addSpecPhase,
    removeSpecArrayItem,
    removeSpecPhase,
    setSpecArrayItem,
    setSpecCheckpointField,
    setSpecFileOperationField,
    setSpecPhaseField,
    setSpecString,
    type SpecDraftEdits
  } from './spec-studio-draft-edits'
  import { compactViewport } from '$lib/compact-viewport.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { editorPreference } from '$lib/stores/editor-preference.svelte'
  import type {
    CapturableSpecContextType,
    EngineeringSpec,
    ProjectFileEntry,
    ProviderCatalog,
    SpecAnnotation,
    SpecDecisionAction,
    SpecSectionId,
    SpecValidationIssue,
    SpecValidationResult,
    ThinkingLevel,
    ThreadSettings
  } from '$shared/types'

  type CallbackResult = void | Promise<void>

  interface AnnotationAnchor {
    quote: string
    startLine: number
    endLine: number
    startOffset: number
    endOffset: number
  }

  interface PendingAnnotation extends PendingOverlayAnchor {
    startLine: number
    endLine: number
    selectionActions: boolean
  }

  interface Props {
    spec: EngineeringSpec
    validation: SpecValidationResult
    versions?: EngineeringSpec[]
    busy?: boolean
    error?: string
    agentMessagesOpen?: boolean
    brainstormAvailable?: boolean
    prdAvailable?: boolean
    assignmentAvailable?: boolean
    assignmentMode?: boolean
    auditAvailable?: boolean
    implementationAuditAvailable?: boolean
    implementationAuditReady?: boolean
    implementationAuditRunning?: boolean
    auditSettings: ThreadSettings
    providers: ProviderCatalog[]
    projectId?: string | null
    favoriteModels?: string[]
    recentModels?: string[]
    history: StudioDocumentHistory<EngineeringSpec>
    onBack: () => void
    onOpenInEditor: (spec: EngineeringSpec) => CallbackResult
    onRevealInAppFile: (spec: EngineeringSpec) => CallbackResult
    onToggleAgentMessages: () => void
    onOpenBrainstorm?: () => void
    onOpenPrd?: () => void
    onOpenAssignment?: () => void
    onGenerateAssignment?: (spec: EngineeringSpec) => CallbackResult
    onOpenAudit?: () => void
    onRunImplementationAudit?: () => CallbackResult
    onAuditModelChange: (settings: ThreadSettings) => void
    onToggleFavorite?: (providerId: string, modelId: string, harnessId: string) => void
    /** Removes one model from the recently-used history; shows the "x" on recent rows. */
    onRemoveRecent?: (modelKey: string) => void
    onReorderFavorite?: (
      draggedKey: string,
      targetKey: string,
      position: 'before' | 'after'
    ) => void
    onMarkImplementationComplete?: () => CallbackResult
    onSave: (spec: EngineeringSpec) => Promise<EngineeringSpec | null>
    onSelectVersion: (version: number) => CallbackResult
    onAddAnnotation: (
      section: SpecSectionId,
      body: string,
      anchor?: AnnotationAnchor
    ) => Promise<EngineeringSpec | null>
    onUpdateAnnotation: (annotationId: string, body: string) => Promise<EngineeringSpec | null>
    onResolveAnnotation: (annotationId: string) => Promise<EngineeringSpec | null>
    onExplainSelection?: (selection: string, documentContext: string) => void
    onQuickChatSelection?: (selection: string, documentContext: string) => void
    onDismissValidationIssue: (issue: SpecValidationIssue) => CallbackResult
    onSearchContext: (
      type: Exclude<CapturableSpecContextType, 'attachment'>,
      query: string
    ) => Promise<ProjectFileEntry[]>
    onAddContext: (type: CapturableSpecContextType, selectedPath?: string) => CallbackResult
    onRemoveContext: (contextId: string) => CallbackResult
    onSubmit: (
      action: SpecDecisionAction,
      spec: EngineeringSpec,
      additionalNotes: string
    ) => CallbackResult
  }

  const allSections: Array<{ id: SpecSectionId; label: string; shortLabel: string }> = [
    { id: 'problem', label: 'Problem', shortLabel: 'Problem' },
    { id: 'resolution', label: 'Resolution & phases', shortLabel: 'Resolution' },
    { id: 'success_criteria', label: 'Success criteria', shortLabel: 'Criteria' },
    { id: 'test_strategy', label: 'Test strategy', shortLabel: 'Tests' },
    { id: 'documentation', label: 'Documentation', shortLabel: 'Docs' },
    { id: 'additional_info', label: 'Additional info', shortLabel: 'Additional' },
    { id: 'commit_pattern', label: 'Commit pattern', shortLabel: 'Commits' },
    {
      id: 'constraints_risks',
      label: 'Constraints & risks',
      shortLabel: 'Guardrails'
    }
  ]
  let {
    spec,
    validation,
    versions = [],
    busy = false,
    error,
    agentMessagesOpen = false,
    brainstormAvailable = false,
    prdAvailable = false,
    assignmentAvailable = false,
    assignmentMode = false,
    auditAvailable = false,
    implementationAuditAvailable = false,
    implementationAuditReady = false,
    implementationAuditRunning = false,
    auditSettings,
    providers,
    projectId = null,
    favoriteModels = [],
    recentModels = [],
    history,
    onBack,
    onOpenInEditor,
    onRevealInAppFile,
    onToggleAgentMessages,
    onOpenBrainstorm,
    onOpenPrd,
    onOpenAssignment,
    onGenerateAssignment,
    onOpenAudit,
    onRunImplementationAudit,
    onAuditModelChange,
    onToggleFavorite,
    onRemoveRecent,
    onReorderFavorite,
    onMarkImplementationComplete,
    onSave,
    onSelectVersion,
    onAddAnnotation,
    onUpdateAnnotation,
    onResolveAnnotation,
    onExplainSelection,
    onQuickChatSelection,
    onDismissValidationIssue,
    onSearchContext,
    onAddContext,
    onRemoveContext,
    onSubmit
  }: Props = $props()

  const contextPicker = new SpecStudioContextPickerController({
    search: (type, query) => onSearchContext(type, query)
  })

  let preferredName = $derived(editorPreference.preferredInfo?.name ?? 'System Default')

  function chooseAuditModel(
    providerId: string,
    modelId: string,
    harnessId?: string,
    accountId?: string
  ): void {
    onAuditModelChange({
      ...auditSettings,
      harnessId: harnessId ?? auditSettings.harnessId,
      accountId,
      providerId,
      modelId
    })
  }

  function chooseAuditThinking(level: ThinkingLevel): void {
    onAuditModelChange({ ...auditSettings, thinkingLevel: level })
  }

  let selectedSection = $state<SpecSectionId>('problem')
  let sectionsOpen = $state(false)
  // The effect below reconciles later prop versions; these are intentional local edit buffers.
  // svelte-ignore state_referenced_locally
  let draft = $state<EngineeringSpec>(history.attach($state.snapshot(spec)))
  const sections = $derived(
    allSections.filter(
      (section) => section.id !== 'additional_info' || draft.content.additionalInfo !== undefined
    )
  )
  // svelte-ignore state_referenced_locally
  let loadedSpecKey = $state(`${spec.id}:${spec.version}:${spec.updatedAt}`)
  // svelte-ignore state_referenced_locally
  let dirty = $state(history.dirty)
  let savePending = $state(false)
  let pendingAction = $state<SpecDecisionAction | null>(null)
  let additionalNotes = $state('')
  let annotationBody = $state('')
  const overlay = new StudioAnnotationOverlay<SpecAnnotation>('spec-annotation-anchor')
  const pendingAnnotation = $derived(overlay.pending as PendingAnnotation | null)
  const editingAnnotation = $derived(overlay.editing)
  const editingAnnotationBody = $derived(overlay.editingBody)
  const annotationEditMode = $derived(overlay.editMode)
  const editingAnnotationPosition = $derived(overlay.editingPosition)
  const annotationMarkers = $derived(overlay.markers)
  let decisionNotesEditor = $state<RichMarkdownEditor>()
  const pendingSpeechTargetId = `spec-annotation-${crypto.randomUUID()}`
  const decisionSpeechTargetId = `spec-decision-${crypto.randomUUID()}`
  const speechScope = $derived({
    kind: 'project',
    projectId: spec.projectId,
    threadId: spec.threadId
  } as const)

  function decisionSpeechTarget() {
    return decisionNotesEditor?.speechEditorTarget(decisionSpeechTargetId) ?? null
  }
  let documentScroller = $state<HTMLElement | null>(null)
  let shellElement = $state<HTMLElement | null>(null)
  const sortedVersions = $derived(
    [...versions]
      .filter((candidate) => candidate.id === spec.id)
      .sort((left, right) => right.version - left.version)
  )
  const isLatestVersion = $derived(draft.version === (sortedVersions[0]?.version ?? draft.version))
  const canDecide = $derived(
    isLatestVersion && (draft.status === 'draft' || draft.status === 'in_review')
  )
  const selectedIndex = $derived(sections.findIndex((section) => section.id === selectedSection))
  const openAnnotationCount = $derived(
    draft.annotations.filter((annotation) => annotation.status === 'open').length
  )
  const currentValidation = $derived(dirty ? validateEngineeringSpec(draft) : validation)
  const selectedSectionIssues = $derived(
    currentValidation.issues.filter((issue) => issue.section === selectedSection)
  )
  const shellSections = $derived.by<StudioShellSection<SpecSectionId>[]>(() => {
    return sections.map((section) => {
      const annotationCount = annotationsFor(section.id).length
      const issueCount = currentValidation.issues.filter(
        (issue) => issue.section === section.id
      ).length
      return {
        id: section.id,
        title: section.label,
        badges: [
          ...(annotationCount
            ? [{ count: annotationCount, tone: 'info' as const, label: 'annotations' }]
            : []),
          ...(issueCount
            ? [
                {
                  count: issueCount,
                  tone: 'danger' as const,
                  label: `${issueCount} validation ${issueCount === 1 ? 'issue' : 'issues'}`
                }
              ]
            : [])
        ]
      }
    })
  })

  $effect(() => {
    const nextKey = `${spec.id}:${spec.version}:${spec.updatedAt}`
    if (nextKey !== loadedSpecKey) {
      loadedSpecKey = nextKey
      if (history.dirty) return
      history.markSaved($state.snapshot(spec))
      draft = $state.snapshot(spec)
      dirty = false
      overlay.closePending()
      overlay.closeEditing()
      annotationBody = ''
      if (selectedSection === 'additional_info' && spec.content.additionalInfo === undefined) {
        selectedSection = 'documentation'
      }
    }
  })

  $effect(() => {
    draft.annotations
      .map((annotation) => `${annotation.id}:${annotation.status}:${annotation.body}`)
      .join('|')
    void refreshAnnotationMarkers()
  })

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
    overlay.closeEditing()
    contextPicker.close()
    void refreshAnnotationMarkers()
  }

  function redoEdit(): void {
    const next = history.redo($state.snapshot(draft))
    if (!next) return
    draft = $state.snapshot(next)
    dirty = history.dirty
    closePendingAnnotation()
    overlay.closeEditing()
    contextPicker.close()
    void refreshAnnotationMarkers()
  }

  onDestroy(() => {
    contextPicker.dispose()
    overlay.clearHighlight()
  })

  const draftEdits: SpecDraftEdits = {
    setString: (key, value) => {
      setSpecString(draft, key, value)
      markDirty()
    },
    setArrayItem: (key, index, value) => {
      setSpecArrayItem(draft, key, index, value)
      markDirty()
    },
    addArrayItem: (key) => {
      addSpecArrayItem(draft, key)
      markDirty()
    },
    removeArrayItem: (key, index) => {
      removeSpecArrayItem(draft, key, index)
      markDirty()
    },
    addPhase: () => {
      addSpecPhase(draft)
      markDirty()
    },
    removePhase: (phaseId) => {
      removeSpecPhase(draft, phaseId)
      markDirty()
    },
    addCheckpoint: (phaseId) => {
      addSpecCheckpoint(draft, phaseId)
      markDirty()
    },
    addFileOperation: (phaseId) => {
      addSpecFileOperation(draft, phaseId)
      markDirty()
    },
    setPhaseField: (phaseId, field, value) => {
      setSpecPhaseField(draft, phaseId, field, value)
      markDirty()
    },
    setCheckpointField: (phaseId, checkpointId, field, value) => {
      setSpecCheckpointField(draft, phaseId, checkpointId, field, value)
      markDirty()
    },
    setFileOperationField: (phaseId, index, field, value) => {
      setSpecFileOperationField(draft, phaseId, index, field, value)
      markDirty()
    }
  }

  function annotationsFor(section: SpecSectionId): SpecAnnotation[] {
    return draft.annotations.filter(
      (annotation) => annotation.section === section && annotation.status === 'open'
    )
  }

  function sectionLabel(sectionId: SpecSectionId): string {
    return sections.find((section) => section.id === sectionId)?.label ?? sectionId
  }

  async function selectAndScroll(sectionId: SpecSectionId): Promise<void> {
    await shellScrollToSection(sectionId)
  }

  async function shellScrollToSection(sectionId: SpecSectionId): Promise<void> {
    selectedSection = sectionId
    sectionsOpen = false
    await tick()
    const target = document.getElementById(`spec-section-${sectionId}`)
    if (!target || !documentScroller) return
    const scrollerTop = documentScroller.getBoundingClientRect().top
    const targetTop = target.getBoundingClientRect().top
    documentScroller.scrollTo({
      top: documentScroller.scrollTop + targetTop - scrollerTop - 20,
      behavior: 'smooth'
    })
  }

  function navigateSections(event: KeyboardEvent): void {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    let nextIndex = selectedIndex
    if (event.key === 'ArrowDown') nextIndex = (selectedIndex + 1) % sections.length
    if (event.key === 'ArrowUp') nextIndex = (selectedIndex - 1 + sections.length) % sections.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = sections.length - 1
    void selectAndScroll(sections[nextIndex].id)
  }

  function captureDocumentSelection(): void {
    if (!canDecide && (!onExplainSelection || !onQuickChatSelection)) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)
    const commonNode =
      range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement
    const sectionElement = commonNode?.closest<HTMLElement>('[data-spec-section]')
    const sectionId = sectionElement?.dataset.specSection as SpecSectionId | undefined
    const quote = selection.toString().trim()
    if (!sectionElement || !sectionId || !quote) return
    const rect = range.getBoundingClientRect()
    const lines = markdownLineForQuote(
      draft,
      quote,
      sectionId,
      selectionOccurrence(sectionElement, range, quote)
    )
    selectedSection = sectionId
    const anchor: PendingAnnotation = {
      section: sectionId,
      quote,
      ...lines,
      ...offsetsForRange(sectionElement, range),
      ...clampPendingPosition(rect),
      sectionLevel: false,
      selectionActions: true
    }
    overlay.beginPending(anchor)
    annotationBody = ''
  }

  function openSectionAnnotation(sectionId: SpecSectionId, event: MouseEvent): void {
    if (!canDecide) return
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) return
    const rect =
      event.currentTarget instanceof HTMLElement
        ? event.currentTarget.getBoundingClientRect()
        : { left: event.clientX, bottom: event.clientY }
    const quote = sectionLabel(sectionId)
    const sectionElement = document.querySelector<HTMLElement>(`[data-spec-section="${sectionId}"]`)
    selectedSection = sectionId
    const anchor: PendingAnnotation = {
      section: sectionId,
      quote,
      ...markdownLineForQuote(draft, quote, sectionId),
      ...offsetsForQuote(sectionElement, quote),
      ...clampPendingPosition(rect),
      sectionLevel: true,
      selectionActions: false
    }
    overlay.beginPending(anchor)
    annotationBody = ''
  }

  function openDiagramAnnotation(sectionId: SpecSectionId, code: string, event: MouseEvent): void {
    if (!canDecide) return
    const quote = code.trim()
    if (!quote) return
    const rect =
      event.currentTarget instanceof HTMLElement
        ? event.currentTarget.getBoundingClientRect()
        : { left: event.clientX, bottom: event.clientY }
    selectedSection = sectionId
    const sectionElement = document.querySelector<HTMLElement>(`[data-spec-section="${sectionId}"]`)
    const anchor: PendingAnnotation = {
      section: sectionId,
      quote,
      ...markdownLineForQuote(draft, quote, sectionId),
      ...offsetsForQuote(sectionElement, quote),
      ...clampPendingPosition(rect),
      sectionLevel: false,
      selectionActions: false
    }
    overlay.beginPending(anchor)
    annotationBody = ''
  }

  function openValidationAnnotation(issue: SpecValidationIssue, event: MouseEvent): void {
    if (!canDecide) return
    const rect =
      event.currentTarget instanceof HTMLElement
        ? event.currentTarget.getBoundingClientRect()
        : { left: event.clientX, bottom: event.clientY }
    selectedSection = issue.section
    const quote = sectionLabel(issue.section)
    const sectionElement = document.querySelector<HTMLElement>(
      `[data-spec-section="${issue.section}"]`
    )
    const anchor: PendingAnnotation = {
      section: issue.section,
      quote,
      ...markdownLineForQuote(draft, quote, issue.section),
      ...offsetsForQuote(sectionElement, quote),
      ...clampPendingPosition(rect),
      sectionLevel: true,
      selectionActions: false
    }
    overlay.beginPending(anchor)
    annotationBody = `Please address this validation gap: ${issue.message}`
  }

  async function dismissValidationIssue(issue: SpecValidationIssue): Promise<void> {
    if (dirty && !(await saveDraft())) return
    await onDismissValidationIssue(issue)
  }

  async function submitAnnotation(): Promise<void> {
    const anchor = pendingAnnotation
    const body = annotationBody.trim()
    if (!anchor || !body) return
    if (dirty && !(await saveDraft())) return
    const updated = await onAddAnnotation(anchor.section as SpecSectionId, body, {
      quote: anchor.quote,
      startLine: anchor.startLine ?? 0,
      endLine: anchor.endLine ?? 0,
      startOffset: anchor.startOffset,
      endOffset: anchor.endOffset
    })
    if (!updated) return
    speechController.observeSent(pendingSpeechTargetId, body)
    applySpec(updated)
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

  function applySpec(updated: EngineeringSpec): void {
    history.markSaved($state.snapshot(updated))
    draft = $state.snapshot(updated)
    loadedSpecKey = `${updated.id}:${updated.version}:${updated.updatedAt}`
    dirty = false
  }

  function sectionElementFor(annotation: SpecAnnotation): HTMLElement | null {
    return document.querySelector<HTMLElement>(
      `[data-spec-section="${CSS.escape(annotation.section)}"]`
    )
  }

  async function refreshAnnotationMarkers(): Promise<void> {
    await overlay.refreshMarkers(draft.annotations, {
      scroller: documentScroller,
      sectionFor: sectionElementFor
    })
  }

  async function openAnnotation(annotation: SpecAnnotation): Promise<void> {
    selectedSection = annotation.section
    await overlay.openAnnotation(annotation, {
      scroller: documentScroller,
      sectionElement: sectionElementFor(annotation),
      markerAttribute: 'data-spec-annotation-marker',
      annotations: draft.annotations,
      sectionFor: sectionElementFor
    })
    overlay.editMode = canDecide
  }

  function closePendingAnnotation(): void {
    window.getSelection()?.removeAllRanges()
    overlay.closePending()
    annotationBody = ''
  }

  function openSelectionChat(mode: 'explain' | 'quick'): void {
    const selection = pendingAnnotation
    if (!selection || !selection.selectionActions) return
    const documentContext = exportEngineeringSpecMarkdown(draft)
    if (mode === 'explain') onExplainSelection?.(selection.quote, documentContext)
    else onQuickChatSelection?.(selection.quote, documentContext)
    closePendingAnnotation()
  }

  async function saveAnnotationEdit(): Promise<void> {
    const annotation = editingAnnotation
    const body = editingAnnotationBody.trim()
    if (!annotation || !body) return
    const updated = await onUpdateAnnotation(annotation.id, body)
    if (!updated) return
    speechController.observeSent(`spec-annotation-edit-${annotation.id}`, body)
    applySpec(updated)
    const saved = updated.annotations.find((candidate) => candidate.id === annotation.id)
    if (saved) {
      overlay.editing = saved
      overlay.editingBody = saved.body
    }
  }

  function closeAnnotation(): void {
    overlay.closeEditing()
  }

  async function resolveAnnotation(annotationId: string): Promise<void> {
    const updated = await onResolveAnnotation(annotationId)
    if (updated) applySpec(updated)
    overlay.closeEditing()
  }

  async function submitAction(action: SpecDecisionAction, notes: string): Promise<void> {
    let submittedDraft = $state.snapshot(draft)
    if (dirty) {
      const saved = await saveDraft()
      if (!saved) return
      submittedDraft = saved
    }
    pendingAction = null
    additionalNotes = ''
    await onSubmit(action, submittedDraft, notes)
    speechController.observeSent(decisionSpeechTargetId, notes)
  }

  async function generateAssignment(): Promise<void> {
    let submittedDraft = $state.snapshot(draft)
    if (dirty) {
      const saved = await saveDraft()
      if (!saved) return
      submittedDraft = saved
    }
    await onGenerateAssignment?.(submittedDraft)
  }

  async function saveDraft(): Promise<EngineeringSpec | null> {
    if (!dirty || busy || savePending) return null
    savePending = true
    try {
      const saved = await onSave($state.snapshot(draft))
      if (saved) applySpec(saved)
      return saved
    } finally {
      savePending = false
    }
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (keymapState.matches('studio-cancel-annotation', event)) {
      closePendingAnnotation()
      closeAnnotation()
      pendingAction = null
      return
    }
    if (!keymapState.matches('studio-save', event) || event.repeat || event.isComposing) return
    const activeElement = document.activeElement
    event.preventDefault()
    if (
      shellElement &&
      activeElement instanceof HTMLElement &&
      shellElement.contains(activeElement) &&
      activeElement.isContentEditable
    ) {
      activeElement.blur()
    }
    void tick().then(saveDraft)
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} onresize={() => void refreshAnnotationMarkers()} />
<StudioShell
  ariaLabel="Specification studio"
  scrollerLabel="Rendered specification"
  sidebarTitle="Specification"
  sidebarLabel="Specification sections"
  sectionAnchorPrefix="spec-section"
  sections={shellSections}
  bind:selectedSection
  bind:sectionsOpen
  bind:scroller={documentScroller}
  bind:shellElement
  {openAnnotationCount}
  annotationsTitle="Section annotations"
  annotationsEmptyLabel="Select text or click a section heading to annotate."
  sectionAnnotations={annotationsFor}
  onOpenAnnotation={(annotation) => void openAnnotation(annotation)}
  {error}
  onScrollerMouseUp={captureDocumentSelection}
  onSectionKeydown={navigateSections}
>
  {#snippet navigation()}
    <StudioDocumentNavigation
      active="spec"
      {brainstormAvailable}
      {prdAvailable}
      {assignmentAvailable}
      {auditAvailable}
      {agentMessagesOpen}
      {onBack}
      {onToggleAgentMessages}
      {sectionsOpen}
      sectionsLabel="spec sections"
      onToggleSections={() => (sectionsOpen = !sectionsOpen)}
      {onOpenBrainstorm}
      {onOpenPrd}
      {onOpenAssignment}
      {onOpenAudit}
    />
  {/snippet}

  {#snippet center()}
    <StudioVersionBar
      versions={sortedVersions.map((version) => ({
        version: version.version,
        status: statusLabel(version.status)
      }))}
      currentVersion={draft.version}
      updatedAt={draft.updatedAt}
      statusLabel={statusLabel(draft.status)}
      statusClass={statusClass(draft.status)}
      {dirty}
      canSave={true}
      canUndo={history.canUndo}
      canRedo={history.canRedo}
      {busy}
      {savePending}
      versionMenuTitle="Choose a specification version"
      versionItemTitle={(version) => `Open version ${version}`}
      {onSelectVersion}
      onUndo={undoEdit}
      onRedo={redoEdit}
      onSave={() => void saveDraft()}
    />
  {/snippet}

  {#snippet actions()}
    {#if implementationAuditAvailable}
      {#if !implementationAuditReady && !implementationAuditRunning}
        <ModelPicker
          {providers}
          {projectId}
          harnessId={auditSettings.harnessId}
          providerId={auditSettings.providerId}
          modelId={auditSettings.modelId}
          accountId={auditSettings.accountId}
          {favoriteModels}
          {recentModels}
          {onRemoveRecent}
          side="top"
          variant="action"
          onSelect={chooseAuditModel}
          thinkingLevel={auditSettings.thinkingLevel}
          onSelectThinking={chooseAuditThinking}
          {onToggleFavorite}
          {onReorderFavorite}
        />
      {/if}
      {#if !implementationAuditRunning}
        <button
          class="flex-1 rounded-lg border bg-elevated px-3 py-1.5 text-xs font-semibold max-md:h-10 md:flex-none hover:bg-overlay disabled:opacity-50"
          disabled={busy}
          title="Mark this implementation complete without an audit"
          onclick={() => void onMarkImplementationComplete?.()}
        >
          Mark complete
        </button>
      {/if}
      <button
        class="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary max-md:h-10 md:flex-none hover:bg-primary-hover disabled:opacity-50"
        disabled={busy}
        title={implementationAuditReady
          ? 'Open the implementation audit'
          : implementationAuditRunning
            ? 'Open the live auditor trace'
            : 'Audit the completed implementation'}
        onclick={() => void onRunImplementationAudit?.()}
      >
        <ShieldCheck size={13} />
        {implementationAuditReady
          ? 'View audit'
          : implementationAuditRunning
            ? 'View trace'
            : 'Audit'}
      </button>
    {:else if canDecide}
      <button
        class="flex-1 rounded-lg border bg-elevated px-3 py-1.5 text-xs font-semibold max-md:h-10 md:flex-none hover:bg-overlay disabled:opacity-50"
        disabled={busy}
        title="Review this specification with the agent"
        onclick={() => {
          pendingAction = 'review'
          additionalNotes = ''
        }}
        ondblclick={(event: MouseEvent) => {
          event.preventDefault()
          void submitAction('review', '')
        }}
      >
        Review
      </button>
    {/if}
    {#if isLatestVersion && assignmentMode}
      <button
        class="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary max-md:h-10 md:flex-none hover:bg-primary-hover disabled:opacity-50"
        disabled={busy || (!assignmentAvailable && !currentValidation.valid)}
        title={assignmentAvailable
          ? 'Open the Assignment'
          : 'Generate an Assignment from this specification'}
        onclick={() => (assignmentAvailable ? onOpenAssignment?.() : void generateAssignment())}
      >
        {assignmentAvailable ? 'View Assignment' : 'Generate Assignment'}
        <ArrowRight size={13} />
      </button>
    {:else if canDecide}
      <button
        class="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary max-md:h-10 md:flex-none hover:bg-primary-hover disabled:opacity-50"
        disabled={busy || !currentValidation.valid}
        title="Sign off and implement this specification"
        onclick={() => {
          pendingAction = 'implement'
          additionalNotes = ''
        }}
        ondblclick={(event: MouseEvent) => {
          event.preventDefault()
          if (currentValidation.valid) void submitAction('implement', '')
        }}
      >
        Implement
        <ArrowRight size={13} />
      </button>
    {/if}
  {/snippet}

  {#snippet headerExtra()}
    {#if pendingAction && canDecide && (!assignmentMode || pendingAction === 'review')}
      <div class="flex flex-col gap-2 border-t px-3 py-2.5 md:flex-row md:items-end md:px-4">
        <label class="min-w-0 flex-1 text-[0.6875rem] font-medium text-muted">
          Additional notes
          <RichMarkdownEditor
            bind:this={decisionNotesEditor}
            class="mt-1 min-h-14 w-full resize-y rounded-lg border bg-elevated px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
            bind:value={additionalNotes}
            placeholder="Additional notes"
            ariaLabel="Additional notes"
            onSubmit={() => pendingAction && void submitAction(pendingAction, additionalNotes)}
          />
        </label>
        <div class="flex shrink-0 items-center gap-2">
          <button
            class="flex-1 rounded-lg px-3 py-2 text-xs text-muted max-md:h-10 md:flex-none hover:bg-overlay"
            title="Cancel"
            onclick={() => (pendingAction = null)}
          >
            Cancel
          </button>
          <VoiceInputButton
            targetId={decisionSpeechTargetId}
            getTarget={decisionSpeechTarget}
            scope={speechScope}
            disabled={busy}
          />
          <button
            class="flex-1 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary max-md:h-10 md:flex-none disabled:opacity-50"
            disabled={busy || (pendingAction === 'implement' && !currentValidation.valid)}
            title={`${pendingAction === 'review' ? 'Review' : 'Implement'} with these notes`}
            onclick={() => pendingAction && void submitAction(pendingAction, additionalNotes)}
          >
            {pendingAction === 'review' ? 'Review' : 'Implement'}
          </button>
        </div>
      </div>
    {/if}
  {/snippet}

  {#snippet sidebarExtra()}
    <div class="shrink-0 border-t p-3">
      <div class="flex items-center justify-between gap-2">
        <p class="text-[0.625rem] font-semibold uppercase tracking-wide text-muted">
          Validation gaps
        </p>
        <span
          class="text-[0.625rem] tabular-nums {selectedSectionIssues.length
            ? 'text-danger'
            : 'text-dimmed'}"
        >
          {selectedSectionIssues.length}
        </span>
      </div>
      <div class="mt-2 max-h-56 space-y-1.5 overflow-y-auto pr-1">
        {#each selectedSectionIssues as issue (`${issue.code}:${issue.path}`)}
          <div class="rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-2">
            <div class="flex items-start gap-2">
              <AlertCircle size={13} class="mt-0.5 shrink-0 text-danger" />
              <div class="min-w-0 flex-1">
                <p class="text-xs leading-relaxed text-foreground">{issue.message}</p>
                <p
                  class="mt-0.5 truncate font-mono text-[0.5625rem] text-dimmed"
                  title={issue.path}
                >
                  {issue.path}
                </p>
                <button
                  class="mt-1.5 text-[0.625rem] font-semibold text-danger hover:underline"
                  title="Create an annotation asking the agent to address this validation gap"
                  onclick={(event: MouseEvent) => openValidationAnnotation(issue, event)}
                >
                  Ask agent to address
                </button>
              </div>
              <button
                class="shrink-0 rounded-md p-1 text-dimmed hover:bg-surface hover:text-foreground disabled:opacity-50"
                disabled={busy || savePending}
                title="Dismiss this validation issue as a false positive"
                aria-label={`Dismiss validation issue: ${issue.message}`}
                onclick={() => void dismissValidationIssue(issue)}
              >
                <X size={12} />
              </button>
            </div>
          </div>
        {:else}
          <p
            class="rounded-lg border border-dashed px-2.5 py-3 text-center text-[0.6875rem] text-dimmed"
          >
            This section has no validation gaps.
          </p>
        {/each}
      </div>
    </div>
  {/snippet}

  {#snippet sidebarFooter()}
    <StudioSidebarFileActions
      viewTitle="Reveal this specification as Markdown in the file tree"
      openTitle={`Open this specification as Markdown in ${preferredName}`}
      {busy}
      onReveal={() => onRevealInAppFile($state.snapshot(draft))}
      onOpen={() => onOpenInEditor($state.snapshot(draft))}
    />
  {/snippet}

  {#snippet markers()}
    {#each annotationMarkers as marker (marker.annotation.id)}
      <button
        class="absolute z-20 flex h-7 w-7 items-center justify-center rounded-full border border-primary/30 bg-surface text-primary shadow-md max-md:right-2 hover:bg-elevated"
        style:left={compactViewport.matches ? undefined : `${marker.x}px`}
        style:top={`${marker.y}px`}
        data-spec-annotation-marker={marker.annotation.id}
        title="Open anchored comment"
        aria-label="Open anchored comment"
        onclick={() => void openAnnotation(marker.annotation)}
      >
        <MessageSquare size={13} />
      </button>
    {/each}
  {/snippet}

  <SpecStudioDocument
    {draft}
    edits={draftEdits}
    {busy}
    {contextPicker}
    onAnnotate={(section, event) => openSectionAnnotation(section, event)}
    onAnnotateDiagram={(section, code, event) => openDiagramAnnotation(section, code, event)}
    onOpenAnnotation={(annotation) => void openAnnotation(annotation)}
    {onAddContext}
    {onRemoveContext}
  />
</StudioShell>

{#if pendingAnnotation}
  <StudioPendingAnnotationPopover
    position={{ x: pendingAnnotation.x, y: pendingAnnotation.y }}
    quote={pendingAnnotation.quote}
    canAnnotate={canDecide}
    showSelectionActions={pendingAnnotation.selectionActions}
    {busy}
    speechTargetId={pendingSpeechTargetId}
    dialogLabel={pendingAnnotation.sectionLevel
      ? 'Annotate section'
      : canDecide
        ? 'Comment on selection'
        : 'Actions for selection'}
    headerLabel={pendingAnnotation.sectionLevel
      ? 'Annotate section'
      : canDecide
        ? 'Comment on selection'
        : 'Selection'}
    editorLabel="Annotation"
    bind:body={annotationBody}
    scope={speechScope}
    onSubmit={() => void submitAnnotation()}
    onCancel={closePendingAnnotation}
    onExplain={() => openSelectionChat('explain')}
    onQuickChat={() => openSelectionChat('quick')}
  />
{/if}

{#if editingAnnotation && editingAnnotationPosition}
  <StudioAnnotationDetailPopover
    position={editingAnnotationPosition}
    annotation={editingAnnotation}
    canEdit={canDecide}
    editorMode={annotationEditMode}
    headerLabel="Anchored comment"
    dialogLabel="Anchored annotation"
    speechTargetId={`spec-annotation-edit-${editingAnnotation.id}`}
    scope={speechScope}
    bind:body={overlay.editingBody}
    onResolve={() => {
      if (overlay.editing) void resolveAnnotation(overlay.editing.id)
    }}
    onSave={saveAnnotationEdit}
    onCancelEdit={() => overlay.cancelEdit()}
    onEditClick={() => overlay.startEdit()}
    onClose={closeAnnotation}
  >
    {#snippet bodyView(annotation: { body: string })}
      <div class="mt-3 text-xs leading-relaxed text-foreground">
        <MarkdownView text={annotation.body} />
      </div>
    {/snippet}
  </StudioAnnotationDetailPopover>
{/if}
