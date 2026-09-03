<script lang="ts">
  import {
    AlertCircle,
    ArrowRight,
    Check,
    FileText,
    MessageSquare,
    MessageSquarePlus,
    MessageSquareText,
    Paperclip,
    Plus,
    Search,
    ShieldCheck,
    Upload,
    X
  } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import { onDestroy, tick } from 'svelte'
  import { exportEngineeringSpecMarkdown } from '$shared/spec/spec-markdown'
  import { validateEngineeringSpec } from '$shared/spec/spec-validation'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import RichMarkdownEditor from '../shared/RichMarkdownEditor.svelte'
  import VoiceInputButton from '../speech/VoiceInputButton.svelte'
  import { speechController } from '../../speech/speech-controller.svelte'
  import EditableMarkdown from './EditableMarkdown.svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import StudioDocumentNavigation from './StudioDocumentNavigation.svelte'
  import StudioShell from './StudioShell.svelte'
  import type { StudioShellSection } from './StudioShell.svelte'
  import StudioSidebarFileActions from './StudioSidebarFileActions.svelte'
  import StudioVersionBar from './StudioVersionBar.svelte'
  import StudioPendingAnnotationPopover from './StudioPendingAnnotationPopover.svelte'
  import StudioAnnotationDetailPopover from './StudioAnnotationDetailPopover.svelte'
  import {
    offsetsForQuote,
    offsetsForRange,
    rangeForAnnotation,
    waitForScrollSettle
  } from './studio-annotation-anchors'
  import type { StudioDocumentHistory } from './studio-document-history.svelte'
  import { compactViewport } from '$lib/compact-viewport.svelte'
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

  interface PendingAnnotation extends AnnotationAnchor {
    section: SpecSectionId
    x: number
    y: number
    sectionLevel: boolean
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

  const contextTypes: Array<{
    type: CapturableSpecContextType
    label: string
    description: string
  }> = [
    {
      type: 'project_file',
      label: 'Tag project file',
      description: 'Tell the agent which project path to use'
    },
    {
      type: 'project_rule',
      label: 'Add rule or skill',
      description: 'Include project instructions in the run'
    },
    {
      type: 'attachment',
      label: 'Attach file',
      description: 'Copy an external file into this specification'
    }
  ]

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
  const markdownSectionHeadings: Record<SpecSectionId, string> = {
    problem: 'Problem',
    resolution: 'Resolution',
    success_criteria: 'Success Criteria',
    test_strategy: 'Test Strategy',
    documentation: 'Documentation',
    additional_info: 'Additional Info',
    commit_pattern: 'Commit Pattern',
    constraints_risks: 'Constraints & Risks'
  }

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

  let preferredName = $derived(editorPreference.preferredInfo?.name ?? 'System Default')

  function chooseAuditModel(providerId: string, modelId: string, harnessId?: string): void {
    onAuditModelChange({
      ...auditSettings,
      harnessId: harnessId ?? auditSettings.harnessId,
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
  const decisionComments = $derived(draft.decisionComments ?? [])
  // svelte-ignore state_referenced_locally
  let loadedSpecKey = $state(`${spec.id}:${spec.version}:${spec.updatedAt}`)
  // svelte-ignore state_referenced_locally
  let dirty = $state(history.dirty)
  let savePending = $state(false)
  let pendingAction = $state<SpecDecisionAction | null>(null)
  let additionalNotes = $state('')
  let annotationBody = $state('')
  let pendingAnnotation = $state<PendingAnnotation | null>(null)
  let editingAnnotation = $state<SpecAnnotation | null>(null)
  let editingAnnotationBody = $state('')
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
  let editingAnnotationPosition = $state<{ x: number; y: number } | null>(null)
  let annotationMarkers = $state<Array<{ annotation: SpecAnnotation; x: number; y: number }>>([])
  let documentScroller = $state<HTMLElement | null>(null)
  let shellElement = $state<HTMLElement | null>(null)
  let contextPickerType = $state<Exclude<CapturableSpecContextType, 'attachment'> | null>(null)
  let contextQuery = $state('')
  let contextResults = $state<ProjectFileEntry[]>([])
  let contextSearchBusy = $state(false)
  let contextSearchError = $state('')
  let contextSearchRequest = 0
  let contextSearchTimer: ReturnType<typeof setTimeout> | undefined
  let contextDropActive = $state(false)
  const SPEC_ANNOTATION_HIGHLIGHT = 'spec-annotation-anchor'

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
  const selectedContextPaths = $derived(
    new Set(
      draft.context
        .map((reference) => reference.path)
        .filter((path): path is string => typeof path === 'string')
    )
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
      pendingAnnotation = null
      editingAnnotation = null
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
    editingAnnotation = null
    closeContextPicker()
    void refreshAnnotationMarkers()
  }

  function redoEdit(): void {
    const next = history.redo($state.snapshot(draft))
    if (!next) return
    draft = $state.snapshot(next)
    dirty = history.dirty
    closePendingAnnotation()
    editingAnnotation = null
    closeContextPicker()
    void refreshAnnotationMarkers()
  }

  async function searchContext(
    type: Exclude<CapturableSpecContextType, 'attachment'>,
    query: string
  ): Promise<void> {
    const request = ++contextSearchRequest
    contextSearchBusy = true
    contextSearchError = ''
    try {
      const results = await onSearchContext(type, query)
      if (request === contextSearchRequest) contextResults = results
    } catch (error) {
      if (request === contextSearchRequest) {
        contextResults = []
        contextSearchError =
          error instanceof Error ? error.message : 'Project files could not be searched.'
      }
    } finally {
      if (request === contextSearchRequest) contextSearchBusy = false
    }
  }

  async function openContextPicker(
    type: Exclude<CapturableSpecContextType, 'attachment'>
  ): Promise<void> {
    contextPickerType = type
    contextQuery = ''
    contextResults = []
    contextSearchError = ''
    await searchContext(type, '')
  }

  function focusContextSearch(input: HTMLInputElement): void {
    input.focus()
  }

  function closeContextPicker(): void {
    clearTimeout(contextSearchTimer)
    contextSearchRequest += 1
    contextPickerType = null
    contextQuery = ''
    contextResults = []
    contextSearchBusy = false
    contextSearchError = ''
  }

  function updateContextQuery(event: Event): void {
    const target = event.currentTarget
    if (!(target instanceof HTMLInputElement) || !contextPickerType) return
    contextQuery = target.value
    clearTimeout(contextSearchTimer)
    const type = contextPickerType
    contextSearchTimer = setTimeout(() => void searchContext(type, contextQuery), 160)
  }

  async function selectContextPath(
    type: Exclude<CapturableSpecContextType, 'attachment'>,
    path: string
  ): Promise<void> {
    if (selectedContextPaths.has(path)) return
    await onAddContext(type, path)
  }

  function hasDroppedFiles(dataTransfer: DataTransfer | null): boolean {
    return Array.from(dataTransfer?.types ?? []).includes('Files')
  }

  function onContextDragOver(event: DragEvent): void {
    if (!hasDroppedFiles(event.dataTransfer)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    contextDropActive = true
  }

  function onContextDragLeave(event: DragEvent): void {
    if (
      event.clientX <= 0 ||
      event.clientY <= 0 ||
      event.clientX >= window.innerWidth ||
      event.clientY >= window.innerHeight
    ) {
      contextDropActive = false
    }
  }

  async function captureDroppedFiles(dataTransfer: DataTransfer | null): Promise<void> {
    const files = Array.from(dataTransfer?.files ?? [])
    for (const file of files) {
      try {
        const filePath = window.api.getPathForFile(file)
        if (filePath) await onAddContext('attachment', filePath)
      } catch {
        // Browser-only and remote drag sources do not expose a safe local path.
      }
    }
  }

  function onContextDrop(event: DragEvent): void {
    if (!hasDroppedFiles(event.dataTransfer)) return
    event.preventDefault()
    contextDropActive = false
    void captureDroppedFiles(event.dataTransfer)
  }

  onDestroy(() => {
    clearTimeout(contextSearchTimer)
    CSS.highlights?.delete(SPEC_ANNOTATION_HIGHLIGHT)
  })

  function setString(
    key: 'problem' | 'resolutionSummary' | 'testStrategy' | 'additionalInfo' | 'commitPattern',
    value: string
  ): void {
    draft.content[key] = value
    markDirty()
  }

  function setArrayItem(
    key: 'successCriteria' | 'documentationRequirements' | 'constraints' | 'risks',
    index: number,
    value: string
  ): void {
    draft.content[key][index] = value
    markDirty()
  }

  function addArrayItem(
    key: 'successCriteria' | 'documentationRequirements' | 'constraints' | 'risks'
  ): void {
    draft.content[key] = [...draft.content[key], 'New item']
    markDirty()
  }

  function removeArrayItem(
    key: 'successCriteria' | 'documentationRequirements' | 'constraints' | 'risks',
    index: number
  ): void {
    draft.content[key] = draft.content[key].filter((_, itemIndex) => itemIndex !== index)
    markDirty()
  }

  function addPhase(): void {
    const ordinal = draft.content.phases.length + 1
    draft.content.phases.push({
      id: crypto.randomUUID(),
      title: `Phase ${ordinal}`,
      objective: 'Describe the phase objective.',
      checkpoints: [],
      fileOperations: [],
      commit: ''
    })
    markDirty()
  }

  function addCheckpoint(phaseId: string): void {
    const phase = draft.content.phases.find((candidate) => candidate.id === phaseId)
    if (!phase) return
    phase.checkpoints.push({
      id: crypto.randomUUID(),
      description: 'Describe the checkpoint.',
      evidence: 'Describe the required evidence.'
    })
    markDirty()
  }

  function addFileOperation(phaseId: string): void {
    const phase = draft.content.phases.find((candidate) => candidate.id === phaseId)
    if (!phase) return
    phase.fileOperations.push({
      path: 'project/relative/path',
      operation: 'edit',
      reason: 'Reason'
    })
    markDirty()
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

  function markdownLineForQuote(
    quote: string,
    sectionId: SpecSectionId,
    occurrence = 0
  ): { startLine: number; endLine: number } {
    const markdown = exportEngineeringSpecMarkdown(draft)
    const heading = `## ${markdownSectionHeadings[sectionId]}`
    const sectionStart = markdown.indexOf(heading)
    if (sectionStart < 0) return { startLine: 1, endLine: 1 }
    const nextHeading = markdown.indexOf('\n## ', sectionStart + heading.length)
    const sectionEnd = nextHeading < 0 ? markdown.length : nextHeading
    const sectionMarkdown = markdown.slice(sectionStart, sectionEnd)
    const escapedQuote = JSON.stringify(quote).slice(1, -1)
    const variants = [...new Set([quote, escapedQuote])]

    for (const variant of variants) {
      const matches = occurrenceIndexes(sectionMarkdown, variant)
      const match = matches[occurrence]
      if (match === undefined) continue
      const absoluteIndex = sectionStart + match
      const startLine = markdown.slice(0, absoluteIndex).split('\n').length
      return {
        startLine,
        endLine: startLine + variant.split('\n').length - 1
      }
    }

    const sectionLine = markdown.slice(0, sectionStart).split('\n').length
    return { startLine: sectionLine, endLine: sectionLine }
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
      quote,
      sectionId,
      selectionOccurrence(sectionElement, range, quote)
    )
    selectedSection = sectionId
    pendingAnnotation = {
      section: sectionId,
      quote,
      ...lines,
      ...offsetsForRange(sectionElement, range),
      x: Math.max(12, Math.min(rect.left, window.innerWidth - 396)),
      y: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 272)),
      sectionLevel: false,
      selectionActions: true
    }
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
    pendingAnnotation = {
      section: sectionId,
      quote,
      ...markdownLineForQuote(quote, sectionId),
      ...offsetsForQuote(sectionElement, quote),
      x: Math.max(12, Math.min(rect.left, window.innerWidth - 396)),
      y: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 272)),
      sectionLevel: true,
      selectionActions: false
    }
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
    pendingAnnotation = {
      section: sectionId,
      quote,
      ...markdownLineForQuote(quote, sectionId),
      ...offsetsForQuote(sectionElement, quote),
      x: Math.max(12, Math.min(rect.left, window.innerWidth - 396)),
      y: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 272)),
      sectionLevel: false,
      selectionActions: false
    }
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
    pendingAnnotation = {
      section: issue.section,
      quote,
      ...markdownLineForQuote(quote, issue.section),
      ...offsetsForQuote(sectionElement, quote),
      x: Math.max(12, Math.min(rect.left, window.innerWidth - 396)),
      y: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 272)),
      sectionLevel: true,
      selectionActions: false
    }
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
    const updated = await onAddAnnotation(anchor.section, body, {
      quote: anchor.quote,
      startLine: anchor.startLine,
      endLine: anchor.endLine,
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

  async function refreshAnnotationMarkers(): Promise<void> {
    await tick()
    const scroller = documentScroller
    if (!scroller) return
    const scrollerRect = scroller.getBoundingClientRect()
    annotationMarkers = draft.annotations.flatMap((annotation) => {
      if (annotation.status !== 'open') return []
      const section = document.querySelector<HTMLElement>(
        `[data-spec-section="${annotation.section}"]`
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

  async function openAnnotation(annotation: SpecAnnotation): Promise<void> {
    window.getSelection()?.removeAllRanges()
    CSS.highlights?.delete(SPEC_ANNOTATION_HIGHLIGHT)
    editingAnnotation = null
    editingAnnotationPosition = null
    selectedSection = annotation.section
    pendingAnnotation = null
    await tick()
    const section = document.querySelector<HTMLElement>(
      `[data-spec-section="${annotation.section}"]`
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
      `[data-spec-annotation-marker="${CSS.escape(annotation.id)}"]`
    )
    const rect = marker?.getBoundingClientRect() ?? range?.getBoundingClientRect() ?? initialRect
    if (range && typeof Highlight !== 'undefined' && CSS.highlights) {
      CSS.highlights.set(SPEC_ANNOTATION_HIGHLIGHT, new Highlight(range))
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

  function closePendingAnnotation(): void {
    window.getSelection()?.removeAllRanges()
    pendingAnnotation = null
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
      editingAnnotation = saved
      editingAnnotationBody = saved.body
    }
  }

  function closeAnnotation(): void {
    CSS.highlights?.delete(SPEC_ANNOTATION_HIGHLIGHT)
    editingAnnotation = null
    editingAnnotationBody = ''
    editingAnnotationPosition = null
  }

  async function resolveAnnotation(annotationId: string): Promise<void> {
    const updated = await onResolveAnnotation(annotationId)
    if (updated) applySpec(updated)
    closeAnnotation()
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

  function statusLabel(status: EngineeringSpec['status']): string {
    return status.replace('_', ' ')
  }

  function statusClass(status: EngineeringSpec['status']): string {
    if (status === 'approved') return 'bg-success/10 text-success'
    if (status === 'in_review') return 'bg-info/10 text-info'
    if (status === 'superseded') return 'bg-raised text-dimmed'
    return 'bg-warning/10 text-warning'
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
<svelte:document
  ondragover={onContextDragOver}
  ondragleave={onContextDragLeave}
  ondrop={onContextDrop}
/>

{#if contextDropActive}
  <div
    class="pointer-events-none fixed inset-0 z-100 flex items-center justify-center border-2 border-dashed border-primary bg-primary/20 backdrop-blur-sm"
    role="region"
    aria-label="Drop files into specification context"
  >
    <div class="flex flex-col items-center gap-2 text-primary">
      <Upload size={32} />
      <span class="text-base font-medium">Drop files into specification context</span>
    </div>
  </div>
{/if}

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
      onSelectVersion={onSelectVersion}
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
                <p class="mt-0.5 truncate font-mono text-[0.5625rem] text-dimmed" title={issue.path}>
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

  <div class="mx-auto max-w-4xl px-4 py-6 md:px-8 md:py-8">
    <article class="space-y-12 text-[0.8125rem] leading-8">
      <section id="spec-section-tldr" class="scroll-mt-5">
        <h2 class="text-xl font-semibold tracking-tight">TL;DR</h2>
        <EditableMarkdown
          class="mt-3 whitespace-pre-wrap rounded-lg px-2 py-1 text-muted outline-none focus:bg-surface focus:text-foreground"
          text={draft.content.resolutionSummary}
          ariaLabel="Specification TL;DR"
          onChange={(value) => setString('resolutionSummary', value)}
        />
      </section>

      <section id="spec-section-problem" data-spec-section="problem" class="scroll-mt-5">
        <button
          class="group flex items-center gap-2 text-left"
          title="Annotate the Problem section"
          onclick={(event: MouseEvent) => openSectionAnnotation('problem', event)}
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
          onChange={(value) => setString('problem', value)}
        />
        {@render AnnotationBubbles({
          annotations: annotationsFor('problem'),
          onOpen: openAnnotation
        })}
      </section>

      <section id="spec-section-resolution" data-spec-section="resolution" class="scroll-mt-5">
        <div class="flex items-center justify-between gap-3">
          <button
            class="group flex items-center gap-2 text-left"
            title="Annotate the Resolution section"
            onclick={(event: MouseEvent) => openSectionAnnotation('resolution', event)}
          >
            <span class="text-xl font-semibold tracking-tight">Resolution & phases</span>
            <MessageSquarePlus
              size={14}
              class="text-dimmed opacity-0 transition-opacity max-md:opacity-100 group-hover:opacity-100"
            />
          </button>
          <button
            class="flex items-center gap-1 rounded-md border bg-elevated px-2 py-1 text-[0.6875rem] text-muted hover:bg-overlay hover:text-foreground"
            title="Add phase"
            onclick={addPhase}
          >
            <Plus size={11} />
            Phase
          </button>
        </div>
        <ol class="mt-5 space-y-4">
          {#each draft.content.phases as phase, phaseIndex (phase.id)}
            <li class="rounded-xl border bg-surface p-4">
              <div class="flex items-start gap-3">
                <span
                  class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-[0.6875rem] font-semibold text-on-primary"
                >
                  {phaseIndex + 1}
                </span>
                <div class="min-w-0 flex-1">
                  <EditableMarkdown
                    class="font-semibold outline-none focus:bg-elevated"
                    text={phase.title}
                    fallback="Untitled phase"
                    ariaLabel={`Phase ${phaseIndex + 1} title`}
                    onChange={(value) => {
                      phase.title = value
                      markDirty()
                    }}
                  />
                  <EditableMarkdown
                    class="mt-1 text-muted outline-none focus:bg-elevated"
                    text={phase.objective}
                    fallback="No objective."
                    ariaLabel={`Phase ${phaseIndex + 1} objective`}
                    onChange={(value) => {
                      phase.objective = value
                      markDirty()
                    }}
                  />
                </div>
                <button
                  class="rounded-md p-1 text-dimmed hover:bg-danger/10 hover:text-danger"
                  aria-label={`Remove phase ${phaseIndex + 1}`}
                  title={`Remove phase ${phaseIndex + 1}`}
                  onclick={() => {
                    draft.content.phases = draft.content.phases.filter(
                      (candidate) => candidate.id !== phase.id
                    )
                    markDirty()
                  }}
                >
                  <X size={13} />
                </button>
              </div>
              <div class="mt-3 grid gap-3 lg:grid-cols-2">
                <div>
                  <div class="flex items-center justify-between">
                    <p class="text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed">
                      Checkpoints
                    </p>
                    <button
                      class="text-[0.6875rem] text-accent hover:underline"
                      title="Add checkpoint"
                      onclick={() => addCheckpoint(phase.id)}>Add</button
                    >
                  </div>
                  <div class="mt-1.5 space-y-1.5">
                    {#each phase.checkpoints as checkpoint, checkpointIndex (checkpoint.id)}
                      <div class="rounded-lg bg-elevated p-2 text-xs">
                        <EditableMarkdown
                          class="font-medium outline-none focus:bg-surface"
                          text={checkpoint.description}
                          ariaLabel={`Checkpoint ${checkpointIndex + 1}`}
                          onChange={(value) => {
                            checkpoint.description = value
                            markDirty()
                          }}
                        />
                        <EditableMarkdown
                          class="mt-0.5 text-muted outline-none focus:bg-surface"
                          text={checkpoint.evidence}
                          ariaLabel={`Checkpoint ${checkpointIndex + 1} evidence`}
                          onChange={(value) => {
                            checkpoint.evidence = value
                            markDirty()
                          }}
                        />
                      </div>
                    {:else}
                      <p class="text-[0.6875rem] text-dimmed">No checkpoints.</p>
                    {/each}
                  </div>
                </div>
                <div>
                  <div class="flex items-center justify-between">
                    <p class="text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed">
                      File operations
                    </p>
                    <button
                      class="text-[0.6875rem] text-accent hover:underline"
                      title="Add file operation"
                      onclick={() => addFileOperation(phase.id)}>Add</button
                    >
                  </div>
                  <div class="mt-1.5 space-y-1.5">
                    {#each phase.fileOperations as operation, operationIndex (`${phase.id}:${operationIndex}`)}
                      <div class="rounded-lg bg-elevated p-2 text-xs">
                        <div class="flex items-center gap-2">
                          <select
                            class="rounded border bg-surface px-1.5 py-1 text-[0.6875rem]"
                            bind:value={operation.operation}
                            onchange={markDirty}
                            aria-label={`File operation ${operationIndex + 1} type`}
                          >
                            <option value="create">Create</option>
                            <option value="edit">Edit</option>
                            <option value="delete">Delete</option>
                          </select>
                          <EditableMarkdown
                            class="min-w-0 flex-1 font-mono outline-none focus:bg-surface"
                            text={operation.path}
                            ariaLabel={`File operation ${operationIndex + 1} path`}
                            onChange={(value) => {
                              operation.path = value
                              markDirty()
                            }}
                          />
                        </div>
                        <EditableMarkdown
                          class="mt-1 text-muted outline-none focus:bg-surface"
                          text={operation.reason}
                          ariaLabel={`File operation ${operationIndex + 1} reason`}
                          onChange={(value) => {
                            operation.reason = value
                            markDirty()
                          }}
                        />
                      </div>
                    {:else}
                      <p class="text-[0.6875rem] text-dimmed">No file operations.</p>
                    {/each}
                  </div>
                </div>
              </div>
              <EditableMarkdown
                class="mt-3 block rounded-md bg-elevated px-2 py-1 font-mono text-xs outline-none"
                text={phase.commit}
                fallback="No commit specified."
                ariaLabel={`Phase ${phaseIndex + 1} commit`}
                onChange={(value) => {
                  phase.commit = value
                  markDirty()
                }}
              />
            </li>
          {/each}
        </ol>
        {@render AnnotationBubbles({
          annotations: annotationsFor('resolution'),
          onOpen: openAnnotation
        })}
      </section>

      {@render EditableListSection({
        id: 'success_criteria',
        title: 'Success criteria',
        items: draft.content.successCriteria,
        annotations: annotationsFor('success_criteria'),
        onHeading: openSectionAnnotation,
        onEdit: (index, value) => setArrayItem('successCriteria', index, value),
        onAdd: () => addArrayItem('successCriteria'),
        onRemove: (index) => removeArrayItem('successCriteria', index),
        onOpenAnnotation: openAnnotation
      })}

      <section
        id="spec-section-test_strategy"
        data-spec-section="test_strategy"
        class="scroll-mt-5"
      >
        <button
          class="group flex items-center gap-2 text-left"
          title="Annotate Test strategy"
          onclick={(event: MouseEvent) => openSectionAnnotation('test_strategy', event)}
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
          onChange={(value) => setString('testStrategy', value)}
        />
        {@render AnnotationBubbles({
          annotations: annotationsFor('test_strategy'),
          onOpen: openAnnotation
        })}
      </section>

      {@render EditableListSection({
        id: 'documentation',
        title: 'Documentation',
        items: draft.content.documentationRequirements,
        annotations: annotationsFor('documentation'),
        onHeading: openSectionAnnotation,
        onEdit: (index, value) => setArrayItem('documentationRequirements', index, value),
        onAdd: () => addArrayItem('documentationRequirements'),
        onRemove: (index) => removeArrayItem('documentationRequirements', index),
        onOpenAnnotation: openAnnotation
      })}

      {#if draft.content.additionalInfo !== undefined}
        <section
          id="spec-section-additional_info"
          data-spec-section="additional_info"
          class="scroll-mt-5"
        >
          <button
            class="group flex items-center gap-2 text-left"
            title="Annotate Additional info"
            onclick={(event: MouseEvent) => openSectionAnnotation('additional_info', event)}
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
            onChange={(value) => setString('additionalInfo', value)}
            onAnnotateMermaid={(code, event) =>
              openDiagramAnnotation('additional_info', code, event)}
          />
          {@render AnnotationBubbles({
            annotations: annotationsFor('additional_info'),
            onOpen: openAnnotation
          })}
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
          onclick={(event: MouseEvent) => openSectionAnnotation('commit_pattern', event)}
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
          onChange={(value) => setString('commitPattern', value)}
        />
        {@render AnnotationBubbles({
          annotations: annotationsFor('commit_pattern'),
          onOpen: openAnnotation
        })}
      </section>

      <section
        id="spec-section-constraints_risks"
        data-spec-section="constraints_risks"
        class="scroll-mt-5"
      >
        <button
          class="group flex items-center gap-2 text-left"
          title="Annotate Constraints and risks"
          onclick={(event: MouseEvent) => openSectionAnnotation('constraints_risks', event)}
        >
          <span class="text-xl font-semibold tracking-tight">Constraints & risks</span>
          <MessageSquarePlus
            size={14}
            class="text-dimmed opacity-0 transition-opacity max-md:opacity-100 group-hover:opacity-100"
          />
        </button>
        <div class="mt-4 grid gap-5 sm:grid-cols-2">
          {@render EditableMiniList({
            title: 'Constraints',
            items: draft.content.constraints,
            onEdit: (index, value) => setArrayItem('constraints', index, value),
            onAdd: () => addArrayItem('constraints'),
            onRemove: (index) => removeArrayItem('constraints', index)
          })}
          {@render EditableMiniList({
            title: 'Risks',
            items: draft.content.risks,
            onEdit: (index, value) => setArrayItem('risks', index, value),
            onAdd: () => addArrayItem('risks'),
            onRemove: (index) => removeArrayItem('risks', index)
          })}
        </div>
        {@render AnnotationBubbles({
          annotations: annotationsFor('constraints_risks'),
          onOpen: openAnnotation
        })}
      </section>
    </article>

    <section class="mt-12 border-t pt-6" aria-label="Specification context">
      <div class="flex items-center justify-between">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-muted">Context</h2>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            class="flex items-center gap-1 rounded-md border bg-elevated px-2 py-1 text-[0.6875rem] hover:bg-overlay"
            title="Add context to this specification"
          >
            <Plus size={11} />
            Add context
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="bottom"
              align="end"
              sideOffset={4}
              collisionPadding={8}
              strategy="fixed"
              class="z-50 w-64 rounded-lg border border-border bg-surface p-1 shadow-lg"
            >
              {#each contextTypes as item (item.type)}
                <DropdownMenu.Item
                  class="flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-2 text-left outline-none data-[highlighted]:bg-elevated"
                  textValue={item.label}
                  title={item.description}
                  onSelect={() => {
                    if (item.type === 'attachment') {
                      void onAddContext(item.type)
                    } else {
                      void openContextPicker(item.type)
                    }
                  }}
                >
                  {#if item.type === 'project_file'}
                    <Search size={13} class="mt-0.5 shrink-0 text-muted" />
                  {:else if item.type === 'project_rule'}
                    <ShieldCheck size={13} class="mt-0.5 shrink-0 text-muted" />
                  {:else}
                    <Paperclip size={13} class="mt-0.5 shrink-0 text-muted" />
                  {/if}
                  <span class="min-w-0">
                    <span class="block text-xs font-medium">{item.label}</span>
                    <span class="mt-0.5 block text-[0.625rem] leading-tight text-dimmed">
                      {item.description}
                    </span>
                  </span>
                </DropdownMenu.Item>
              {/each}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      {#if contextPickerType}
        {@const activeContextPickerType = contextPickerType}
        <div class="mt-3 rounded-lg border bg-surface p-3">
          <div class="flex items-center justify-between gap-3">
            <div>
              <h3 class="text-xs font-semibold">
                {contextPickerType === 'project_rule'
                  ? 'Add a rule or skill'
                  : 'Tag a project file'}
              </h3>
              <p class="mt-0.5 text-[0.625rem] text-dimmed">
                The project-relative path will be included in review and implementation.
              </p>
            </div>
            <button
              type="button"
              class="rounded-md p-1 text-dimmed hover:bg-elevated hover:text-foreground"
              title="Close context search"
              aria-label="Close context search"
              onclick={closeContextPicker}
            >
              <X size={13} />
            </button>
          </div>
          <label class="relative mt-3 block">
            <span class="sr-only">Search project files</span>
            <Search
              size={13}
              class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dimmed"
            />
            <input
              {@attach focusContextSearch}
              value={contextQuery}
              class="h-8 w-full rounded-md border bg-app pl-8 pr-3 text-xs outline-none"
              placeholder={contextPickerType === 'project_rule'
                ? 'Search AGENTS.md, SKILL.md, rules…'
                : 'Search files by name or path…'}
              oninput={updateContextQuery}
            />
          </label>
          <div class="mt-2 max-h-52 overflow-y-auto">
            {#if contextSearchBusy && contextResults.length === 0}
              <p class="px-2 py-3 text-center text-xs text-dimmed">Searching project…</p>
            {:else if contextSearchError}
              <p class="px-2 py-3 text-center text-xs text-danger">{contextSearchError}</p>
            {:else if contextResults.length === 0}
              <p class="px-2 py-3 text-center text-xs text-dimmed">
                {contextPickerType === 'project_rule'
                  ? 'No project rules or skills match this search.'
                  : 'No project files match this search.'}
              </p>
            {:else}
              {#each contextResults as entry (entry.path)}
                {@const selected = selectedContextPaths.has(entry.path)}
                <button
                  type="button"
                  class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-elevated disabled:cursor-pointer disabled:opacity-60"
                  title={selected
                    ? `${entry.path} is already included`
                    : `Include ${entry.path}`}
                  disabled={selected || busy}
                  onclick={() => void selectContextPath(activeContextPickerType, entry.path)}
                >
                  <FileText size={12} class="shrink-0 text-muted" />
                  <span class="min-w-0 flex-1 truncate">{entry.path}</span>
                  {#if selected}
                    <Check size={12} class="shrink-0 text-success" />
                  {/if}
                </button>
              {/each}
            {/if}
          </div>
        </div>
      {/if}
      <div class="mt-3 grid gap-2 sm:grid-cols-2">
        {#each draft.context as reference (reference.id)}
          <div class="flex items-center gap-2 rounded-lg border bg-surface px-3 py-2">
            <span class="min-w-0 flex-1">
              <span class="block truncate text-xs font-medium">{reference.label}</span>
              <span class="block truncate text-[0.625rem] text-dimmed"
                >{reference.type.replace('_', ' ')}{reference.path
                  ? ` · ${reference.path}`
                  : ''}</span
              >
            </span>
            <button
              class="rounded-md p-1 text-dimmed hover:bg-danger/10 hover:text-danger"
              aria-label={`Remove context ${reference.label}`}
              title={`Remove ${reference.label}`}
              onclick={() => void onRemoveContext(reference.id)}
            >
              <X size={12} />
            </button>
          </div>
        {:else}
          <p
            class="col-span-full rounded-lg border border-dashed p-4 text-center text-xs text-dimmed"
          >
            Tag project files, add rules or skills, attach external files, or drop files
            anywhere in the Studio.
          </p>
        {/each}
      </div>
      <div class="mt-6 border-t pt-4">
        <div class="flex items-center gap-1.5">
          <MessageSquareText size={13} class="text-muted" />
          <h3 class="text-xs font-semibold">Previous comments</h3>
        </div>
        {#if decisionComments.length > 0}
          <div class="mt-3 space-y-3">
            {#each decisionComments as comment (comment.id)}
              <div class="border-l-2 border-border pl-3">
                <div class="mb-1 flex items-center gap-2 text-[0.625rem] text-dimmed">
                  <span class="font-semibold uppercase tracking-wide text-muted">
                    {comment.action === 'review' ? 'Review' : 'Implement'}
                  </span>
                  <span>·</span>
                  <span>{formatDate(comment.createdAt)}</span>
                </div>
                <div class="text-xs text-foreground">
                  <MarkdownView text={comment.body} />
                </div>
              </div>
            {/each}
          </div>
        {:else}
          <p class="mt-2 text-xs text-dimmed">
            No Review or Implement comments were submitted for this version.
          </p>
        {/if}
      </div>
    </section>
  </div>
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
    editorMode={canDecide}
    headerLabel="Anchored comment"
    dialogLabel="Anchored annotation"
    speechTargetId={`spec-annotation-edit-${editingAnnotation.id}`}
    scope={speechScope}
    bind:body={editingAnnotationBody}
    onResolve={() => {
      if (editingAnnotation) void resolveAnnotation(editingAnnotation.id)
    }}
    onSave={saveAnnotationEdit}
    onClose={closeAnnotation}
  >
    {#snippet bodyView(annotation: { body: string })}
      <div class="mt-3 text-xs leading-relaxed text-foreground">
        <MarkdownView text={annotation.body} />
      </div>
    {/snippet}
  </StudioAnnotationDetailPopover>
{/if}

{#snippet AnnotationBubbles(props: {
  annotations: SpecAnnotation[]
  onOpen: (annotation: SpecAnnotation) => void
})}
  {#if props.annotations.length}
    <div class="mt-4 flex gap-2 overflow-x-auto pb-1" aria-label="Section annotations">
      {#each props.annotations as annotation (annotation.id)}
        <button
          class="max-w-64 shrink-0 rounded-xl border bg-surface px-3 py-2 text-left hover:bg-elevated"
          title="Open annotation"
          onclick={() => props.onOpen(annotation)}
        >
          <span class="line-clamp-2 block text-xs leading-relaxed">{annotation.body}</span>
          <span class="mt-1 block text-[0.625rem] text-dimmed">{annotation.author}</span>
        </button>
      {/each}
    </div>
  {/if}
{/snippet}

{#snippet EditableListSection(props: {
  id: SpecSectionId
  title: string
  items: string[]
  annotations: SpecAnnotation[]
  onHeading: (section: SpecSectionId, event: MouseEvent) => void
  onEdit: (index: number, value: string) => void
  onAdd: () => void
  onRemove: (index: number) => void
  onOpenAnnotation: (annotation: SpecAnnotation) => void
})}
  <section id={`spec-section-${props.id}`} data-spec-section={props.id} class="scroll-mt-5">
    <div class="flex items-center justify-between gap-3">
      <button
        class="group flex items-center gap-2 text-left"
        title={`Annotate ${props.title}`}
        onclick={(event: MouseEvent) => props.onHeading(props.id, event)}
      >
        <span class="text-xl font-semibold tracking-tight">{props.title}</span>
        <MessageSquarePlus
          size={14}
          class="text-dimmed opacity-0 transition-opacity max-md:opacity-100 group-hover:opacity-100"
        />
      </button>
      <button
        class="flex items-center gap-1 rounded-md border bg-elevated px-2 py-1 text-[0.6875rem] text-muted hover:bg-overlay"
        title={`Add ${props.title.toLowerCase()} item`}
        onclick={props.onAdd}
      >
        <Plus size={11} />
        Add
      </button>
    </div>
    <ul class="mt-3 space-y-2">
      {#each props.items as item, index (`${props.id}:${index}`)}
        <li class="group flex items-start gap-2 rounded-lg px-2 py-1 text-muted hover:bg-surface">
          <Check size={13} class="mt-1.5 shrink-0 text-success" />
          <EditableMarkdown
            class="min-w-0 flex-1 outline-none focus:text-foreground"
            text={item}
            ariaLabel={`${props.title} item ${index + 1}`}
            onChange={(value) => props.onEdit(index, value)}
          />
          <button
            class="mt-0.5 rounded p-1 text-dimmed opacity-0 hover:bg-danger/10 hover:text-danger group-hover:opacity-100"
            aria-label={`Remove item ${index + 1}`}
            title={`Remove item ${index + 1}`}
            onclick={() => props.onRemove(index)}
          >
            <X size={11} />
          </button>
        </li>
      {:else}
        <li class="text-muted">Not defined.</li>
      {/each}
    </ul>
    {@render AnnotationBubbles({ annotations: props.annotations, onOpen: props.onOpenAnnotation })}
  </section>
{/snippet}

{#snippet EditableMiniList(props: {
  title: string
  items: string[]
  onEdit: (index: number, value: string) => void
  onAdd: () => void
  onRemove: (index: number) => void
})}
  <div class="rounded-xl border bg-surface p-4">
    <div class="flex items-center justify-between">
      <h3 class="font-semibold">{props.title}</h3>
      <button
        class="rounded-md p-1 text-dimmed hover:bg-elevated hover:text-foreground"
        aria-label={`Add ${props.title.toLowerCase()}`}
        title={`Add ${props.title.toLowerCase()}`}
        onclick={props.onAdd}><Plus size={12} /></button
      >
    </div>
    <ul class="mt-2 space-y-1.5">
      {#each props.items as item, index (`${props.title}:${index}`)}
        <li class="group flex items-start gap-2 text-muted">
          <span>•</span>
          <EditableMarkdown
            class="min-w-0 flex-1 outline-none focus:text-foreground"
            text={item}
            ariaLabel={`${props.title} item ${index + 1}`}
            onChange={(value) => props.onEdit(index, value)}
          />
          <button
            class="rounded p-1 text-dimmed opacity-0 hover:text-danger group-hover:opacity-100"
            aria-label={`Remove ${props.title} item ${index + 1}`}
            title="Remove item"
            onclick={() => props.onRemove(index)}><X size={10} /></button
          >
        </li>
      {:else}
        <li class="text-muted">None recorded.</li>
      {/each}
    </ul>
  </div>
{/snippet}
