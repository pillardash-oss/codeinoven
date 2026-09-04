<script lang="ts">
  import { tick, onDestroy, onMount } from 'svelte'
  import {
    ArrowUp,
    AudioLines,
    Clock,
    Plus,
    Paperclip,
    Square,
    X,
    Folder,
    GitBranch,
    Monitor,
    Globe,
    Shield,
    ShieldCheck,
    FileText,
    Upload,
    MessageSquare,
    HardDrive,
    Zap,
    Flame,
    ShieldAlert,
    Eye,
    Image as ImageIcon,
    Video,
    Check
  } from '@lucide/svelte'
  import { threadSettings as threadSettingsStore } from '$lib/stores/thread-settings.svelte'
  import { baseUrlProviderStore } from '$lib/stores/base-url-providers.svelte'
  import {
    fastMultiplierFor,
    fastSelectionModelId,
    supportsFastInference
  } from '$shared/fast-inference'
  import { DEFAULT_HARNESS } from '$shared/harness-default'
  import { STANDARD_THINKING_PRESETS, resolveDefaultThinkingLevel } from '$shared/thinking-presets'
  import { invoke } from '$lib/ipc.svelte'
  import { isEscapeClaimed } from '$lib/stores/page-surface.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { modelKey } from '$lib/model-keys'
  import ProjectSwitch from '$lib/components/shared/ProjectSwitch.svelte'
  import ProjectIdentity from '$lib/components/shared/ProjectIdentity.svelte'
  import { hasProjectNameCollision, projectIdentityTitle } from '$lib/project-location'
  import { projectRemotes } from '$lib/stores/project-remotes.svelte'
  import {
    getInlineFileTypeIconDataUri,
    getInlineFolderTypeIconDataUri
  } from '../files/file-type-icons'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { visionModels } from '$lib/stores/vision-models.svelte'
  import { attachmentPreviewKind, fileUrlToPath, mimeFromPath, pathToFileUrl } from '$lib/mime'
  import { placeCaretAtEnd } from '../shared/rich-markdown'
  import AttachmentPreview from './AttachmentPreview.svelte'
  import SelectionListPopover from './SelectionListPopover.svelte'
  import StartAfterThreadPicker from './StartAfterThreadPicker.svelte'
  import Switch from '../ui/Switch.svelte'
  import ContextUsageIndicator from './ContextUsageIndicator.svelte'
  import ProjectFileMentionMenu from './ProjectFileMentionMenu.svelte'
  import { cioSearchVisibility, isCioScratchPath } from '$lib/stores/cio-search-visibility.svelte'
  import {
    composerMentionQuery,
    normalizeComposerMessage,
    type ComposerMentionEntry
  } from './composer-mentions'
  import SlashActionMenu from '../actions/SlashActionMenu.svelte'
  import RichMarkdownEditor from '../shared/RichMarkdownEditor.svelte'
  import VoiceInputButton from '../speech/VoiceInputButton.svelte'
  import EngineeringToolbox from './EngineeringToolbox.svelte'
  import { speechController } from '../../speech/speech-controller.svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import { mergeProviderCatalogEntries, providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { filterActions } from '$lib/actions'
  import { APP_NAME } from '$shared/brand'
  import { getVendorIconDataUri } from '$lib/vendor-icons/registry'
  import { isRemotePwaRuntime } from '$lib/runtime-context'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import type { SpeechEditorApplyResult, SpeechEditorTarget } from '../../speech/editor-target'
  import type { ActionDefinition, ActionSelection, ActionSource } from '$lib/actions'
  import type { RichInlineBadge } from '../shared/rich-markdown'
  import type {
    ThreadSettings,
    ThinkingLevel,
    ThinkingPreset,
    InferenceMode,
    PermissionLevel,
    ProviderCatalog,
    PromptAttachment,
    PromptAssignmentTaskReference,
    PromptProjectReference,
    ComposerProject,
    AgentContextUsage,
    AgentHarnessUsage,
    PromptReference,
    AssignmentTask,
    AgentModelSelection,
    AttachmentStorageScope,
    UsageEfficiencyKpis,
    Thread,
    EngineeringLifecycleSelectionInput,
    EngineeringLifecycleState
  } from '$shared/types'

  type StartAfterSelection = Pick<Thread, 'id' | 'title'>
  const MAX_PROMPT_CHARACTERS = 200_000
  const LONG_PASTE_ATTACHMENT_CHARACTERS = 100_000
  const codeInOvenIconUrl = getVendorIconDataUri(APP_NAME)

  interface Props {
    /** Called with the trimmed message and attachments when the user sends.
     *  `direct` is true when the message must be force-delivered as a steer
     *  into a live turn (Cmd/Ctrl+Shift+Enter); busy parents queue otherwise. */
    onSend: (
      message: string,
      attachments: PromptAttachment[],
      direct?: boolean,
      projectReferences?: PromptProjectReference[],
      taskReferences?: PromptAssignmentTaskReference[],
      startAfterThreads?: StartAfterSelection[]
    ) => void
    disabled?: boolean
    /** True while the agent is running — turns the send button into a stop button. */
    working?: boolean
    /** Called when the user asks to abort the running turn (stop button / double Escape). */
    onStop?: () => void
    placeholder?: string
    autofocus?: boolean
    /** Current thread settings (drives toolbar state). Falls back to last-used. */
    settings?: ThreadSettings
    /** Called when any toolbar setting changes. */
    onSettingsChange?: (settings: ThreadSettings) => void
    /** Thread-scoped actions available through the composer slash menu. */
    actions?: readonly ActionDefinition[]
    /** Executes a non-command action selected from the slash menu. */
    onActionSelect?: (selection: ActionSelection) => void | Promise<void>
    /** Executes an active-harness slash command with explicit arguments. */
    onSlashCommand?: (commandId: string, args: string) => void | Promise<void>
    /** Id of the harness's native "switch to API usage credits" command, when
     *  it exposes one. Present only when the harness driver reports it — this
     *  is what shows the flame icon shortcut in the toolbar. */
    usageCreditsCommandId?: string
    /** Available providers + models from the harness. */
    providers?: ProviderCatalog[]
    /** Id of the agent harness serving the models (shown on each model row). */
    harnessId?: string
    /** Project context row shown before the first message of the thread. */
    projectContext?: ComposerProject
    /** Active project ID for the project switcher dropdown. */
    projectId?: string | null
    /** Active thread ID used to prevent selecting the current thread as a dependency. */
    threadId?: string
    /** Project or app scratch destination for pasted/ephemeral attachment files. */
    attachmentStorage?: AttachmentStorageScope
    /** Called when the user selects a different project from the switcher. */
    onSwitchProject?: (projectId: string) => void
    /** Local project whose files can be referenced with bare @ tags. */
    fileTagProjectId?: string
    /** Active Assignment tasks available through the composer @ picker. */
    assignmentId?: string
    assignmentTasks?: AssignmentTask[]
    /** Restart-safe draft restored by the owning thread/view. */
    initialValue?: string
    onValueChange?: (value: string) => void
    /** Restart-safe file attachments restored by the owning thread/view. */
    initialAttachments?: PromptAttachment[]
    onAttachmentsChange?: (attachments: PromptAttachment[]) => void
    /** Restart-safe project files and directories tagged for the next prompt. */
    initialProjectReferences?: PromptProjectReference[]
    onProjectReferencesChange?: (references: PromptProjectReference[]) => void
    /** Restart-safe Assignment task references tagged for the next prompt. */
    initialTaskReferences?: PromptAssignmentTaskReference[]
    onTaskReferencesChange?: (references: PromptAssignmentTaskReference[]) => void
    /** Restart-safe source threads the next prompt waits for before it starts. */
    initialStartAfterThreads?: StartAfterSelection[]
    /** Persists or clears the source threads selected for the next prompt. */
    onStartAfterThreadsChange?: (threads: StartAfterSelection[]) => void
    /** Opens a selected source thread from the composer badge popover. */
    onOpenStartAfterThread?: (threadId: string) => void | Promise<void>
    /** Assistant-response excerpts referenced by the next message. */
    references?: readonly PromptReference[]
    onRemoveReference?: (id: string) => void
    /** Removes every attached selection. */
    onRemoveAllReferences?: () => void
    /** Jump to a reference's highlight and open its comment editor. */
    onEditReference?: (id: string) => void
    /** False on the Chats tab — plain chats never surface the engineer toggle. */
    showEngineeringMode?: boolean
    engineeringLifecycle?: EngineeringLifecycleState | null
    /** Overrides the settings-derived Engineering activity for the toolbox
     *  icon so staged (send-deferred) selections light or dim it live. */
    engineeringActive?: boolean
    onEngineeringLifecycleSelect?: (
      input: EngineeringLifecycleSelectionInput
    ) => void | Promise<void>
    /** True on the Chats tab — surfaces the chat-only Engineering and File System toggles. */
    showChatModes?: boolean
    /** Independent (spec-less) audit: the thread has work and the audit was never initialized. */
    independentAuditAvailable?: boolean
    /** Independent (spec-less) audit is currently enabled for this thread. */
    independentAuditEnabled?: boolean
    /** Called when the user toggles the independent audit switch. */
    onIndependentAuditToggle?: (enabled: boolean) => void | Promise<void>
    /** Engineering toolbox is hidden (Independent Audit staged or enabled —
     *  the two controls are mutually exclusive before a send commits either). */
    engineeringToolboxHidden?: boolean
    /** Hides the permission level selector and forces auto review — chats are
     *  for questions and research, so they always run with auto permissions. */
    hidePermissionSelector?: boolean
    /** Hides mutating controls and file attachment entry points. */
    readOnlyMode?: boolean
    /** Lets read-only composers still attach media files for context.
     *  Ignored when readOnlyMode is false (attachments are always allowed). */
    allowAttachments?: boolean
    /** Model keys (providerId:modelId) the user has favorited. */
    favoriteModels?: string[]
    /** Called when the user toggles a model as favorite. */
    onToggleFavorite?: (providerId: string, modelId: string, harnessId: string) => void
    /** Removes one model from the recently-used history; shows the "x" on recent rows. */
    onRemoveRecent?: (modelKey: string) => void
    /** Called when the user reorders a favorite relative to another favorite. */
    onReorderFavorite?: (
      draggedKey: string,
      targetKey: string,
      position: 'before' | 'after'
    ) => void
    /** Model keys (providerId:modelId) the user has recently used, most recent first. */
    recentModels?: string[]
    /** Called when the user selects a model — for tracking recently used. */
    onModelUsed?: (modelKey: string) => void
    /** Current provider-reported context and account usage. */
    contextUsage?: AgentContextUsage
    /** Normalized per-turn efficiency and cost-coverage KPIs for this thread. */
    efficiencyKpis?: UsageEfficiencyKpis
    /** Per-harness quota telemetry when a thread used more than one harness. */
    harnessUsage?: AgentHarnessUsage[]
    /** Flushes the rendered usage snapshot to the latest value (e.g. on hover). */
    onRevealUsage?: () => void
    /** Called when the user stops hovering the usage indicator. */
    onHideUsage?: () => void
    /** Whether live account usage is currently being fetched from the harness. */
    usageRefreshing?: boolean
    /** Whether this harness can explicitly compact conversation context. */
    canCompact?: boolean
    compacting?: boolean
    onCompact?: () => void
    /** Opens the destructive confirmation dialog for redeeming a banked Codex reset. */
    onActivateBankedReset?: () => void
    /** Previous user messages for terminal-like up-arrow history recall. */
    historyMessages?: string[]
    /** Global default vision model used to describe images for text-only models. */
    imageDescriptorDefault?: AgentModelSelection
    /** When true, the vision-model picker card is skipped on image sends. */
    imageDescriptorAskAgain?: boolean
    /** Persists a new global image-descriptor default (Agents settings). */
    onImageDescriptorDefaultChange?: (selection: AgentModelSelection) => void
    /** Persists the "don't ask again" flag for image-descriptor picks. */
    onImageDescriptorAskAgainChange?: (value: boolean) => void
    /** Enables the image-to-text-only-model gate card. Off in side-chats. */
    enableImageDescriptorGate?: boolean
    /** Hides the inline context-usage indicator — for hosts that surface the
     *  same detail elsewhere (e.g. the mobile header). */
    hideUsageIndicator?: boolean
  }

  let {
    onSend,
    disabled = false,
    working = false,
    onStop,
    placeholder = 'Send a message...',
    autofocus = false,
    settings,
    onSettingsChange,
    actions = [],
    onActionSelect,
    onSlashCommand,
    usageCreditsCommandId,
    providers = [],
    harnessId = DEFAULT_HARNESS,
    projectContext,
    projectId = null,
    threadId = '',
    attachmentStorage,
    onSwitchProject,
    fileTagProjectId,
    assignmentId,
    assignmentTasks = [],
    initialValue = '',
    onValueChange,
    initialAttachments = [],
    onAttachmentsChange,
    initialProjectReferences = [],
    onProjectReferencesChange,
    initialTaskReferences = [],
    onTaskReferencesChange,
    initialStartAfterThreads = [],
    onStartAfterThreadsChange,
    onOpenStartAfterThread,
    references = [],
    onRemoveReference,
    onRemoveAllReferences,
    onEditReference,
    showEngineeringMode = true,
    engineeringLifecycle = null,
    engineeringActive,
    onEngineeringLifecycleSelect,
    showChatModes = false,
    independentAuditAvailable = false,
    independentAuditEnabled = false,
    onIndependentAuditToggle,
    engineeringToolboxHidden = false,
    hidePermissionSelector = false,
    readOnlyMode = false,
    allowAttachments = false,
    favoriteModels = [],
    onToggleFavorite,
    onRemoveRecent,
    onReorderFavorite,
    recentModels = [],
    onModelUsed,
    contextUsage,
    efficiencyKpis,
    harnessUsage = [],
    onRevealUsage,
    onHideUsage,
    usageRefreshing = false,
    canCompact = false,
    compacting = false,
    onCompact,
    onActivateBankedReset,
    historyMessages = [],
    imageDescriptorDefault,
    imageDescriptorAskAgain = false,
    onImageDescriptorDefaultChange,
    onImageDescriptorAskAgainChange,
    enableImageDescriptorGate = true,
    hideUsageIndicator = false
  }: Props = $props()

  /** Base composer settings — the prop when provided, else the global last-used. */
  const baseSettings = $derived(settings ?? threadSettingsStore.lastUsed)
  /** Resolved settings — chats run with auto permission review until File System
   *  is enabled, so the level stays pinned to `auto_review` while File System is
   *  off and unlocks (selector visible, up to Full Access) once it is turned on. */
  let resolved = $derived<ThreadSettings>(
    hidePermissionSelector && baseSettings.fileSystemMode !== true
      ? { ...baseSettings, permissionLevel: 'auto_review' as const }
      : baseSettings
  )

  function projectReferenceToken(reference: Pick<PromptProjectReference, 'path'>): string {
    return `@${reference.path}`
  }

  function taskReferenceToken(reference: Pick<PromptAssignmentTaskReference, 'taskId'>): string {
    return `@task:${reference.taskId}`
  }

  function abbreviatedTaskTitle(title: string): string {
    return title.length > 36 ? `${title.slice(0, 35).trimEnd()}…` : title
  }

  function restoredDraft(): string {
    const missingTokens = [
      ...initialProjectReferences.map(projectReferenceToken),
      ...initialTaskReferences.map(taskReferenceToken)
    ].filter((token) => !initialValue.includes(token))
    // Trim trailing spaces so reference tokens aren't glued to them, but keep
    // any trailing newlines the user typed so the draft round-trips exactly.
    return [initialValue.replace(/[ \t]+$/u, ''), ...missingTokens].filter(Boolean).join(' ')
  }

  let value = $state(restoredDraft())
  // The composer is remounted by the parent when a restore is required, so we
  // intentionally capture only the initial attachments passed at creation time.
  // svelte-ignore state_referenced_locally
  let attachments = $state<PromptAttachment[]>([...initialAttachments])
  let remoteFileInput = $state<HTMLInputElement>()
  // svelte-ignore state_referenced_locally
  let projectReferences = $state<PromptProjectReference[]>([...initialProjectReferences])
  // svelte-ignore state_referenced_locally
  let taskReferences = $state<PromptAssignmentTaskReference[]>([...initialTaskReferences])
  let projectReferenceIcons = $state<Record<string, string>>({})

  $effect(() => {
    const references = projectReferences.map((reference) => ({ ...reference }))
    let current = true
    void Promise.all(
      references.map(
        async (reference) =>
          [
            projectReferenceToken(reference),
            reference.kind === 'directory'
              ? await getInlineFolderTypeIconDataUri(reference.name)
              : await getInlineFileTypeIconDataUri(reference.path)
          ] as const
      )
    ).then((entries) => {
      if (current) projectReferenceIcons = Object.fromEntries(entries)
    })
    return () => {
      current = false
    }
  })

  let projectReferenceBadges = $derived<RichInlineBadge[]>([
    ...(value.includes('@cio-utility')
      ? [
          {
            iconSrc: codeInOvenIconUrl,
            label: 'utility',
            title: `${APP_NAME} utility`,
            value: '@cio-utility'
          }
        ]
      : []),
    ...projectReferences.map((reference) => ({
      iconSrc: projectReferenceIcons[projectReferenceToken(reference)],
      label: reference.name,
      title: `${reference.kind === 'directory' ? 'Directory' : 'File'}: ${reference.path}`,
      value: projectReferenceToken(reference)
    })),
    ...taskReferences.map((reference) => ({
      label: abbreviatedTaskTitle(reference.title),
      title: `Task: ${reference.title} · Worker: ${reference.workerName ?? 'Unassigned'}`,
      value: taskReferenceToken(reference)
    }))
  ])
  /** Git remote origin URL for the active project, surfaced on the branch pill. */
  let remoteOriginUrl = $derived(projectRemotes.get(projectId ?? '') ?? null)
  let branchPillTitle = $derived(
    remoteOriginUrl ?? (projectContext ? projectIdentityTitle(projectContext) : undefined)
  )

  // Resolve the project's GitHub repo so hovering the branch pill can reveal it.
  $effect(() => {
    const id = projectId
    const path = projectContext?.path
    if (!id || !path) return
    void projectRemotes.ensure(id, path)
  })
  let isDragging = $state(false)
  let previewFile = $state<PromptAttachment | null>(null)
  /** Object URLs for image/PDF/media/document downloads, keyed by attachment file:// URL. */
  let previewUrls = $state<Record<string, string>>({})
  /** Decoded text content for markdown/plain-text previews, keyed by url. */
  let previewTexts = $state<Record<string, string>>({})
  /** Converted Word document HTML, loaded only when the preview is opened. */
  let previewDocuments = $state<Record<string, string>>({})
  let previewDocumentLoading = $state<Record<string, boolean>>({})
  /** Image-descriptor gate state: intercepts sending an image to a text-only model. */
  let imageDescriptorGateOpen = $state(false)
  let gateVisionSelection = $state<AgentModelSelection | null>(null)
  let gateDonotAsk = $state(false)
  let gateDirect = $state<boolean | undefined>(undefined)
  // svelte-ignore state_referenced_locally
  const composerEditorId = `chat-composer-${projectId ?? 'no-project'}-${threadId ?? 'none'}`
  /** macOS shows ⌘; Windows/Linux show Ctrl — matches the global send shortcut. */
  const sendModifierLabel = navigator.platform.toUpperCase().indexOf('MAC') >= 0 ? '⌘' : 'Ctrl+'
  let mentionEntries = $state<ComposerMentionEntry[]>([])
  let mentionQuery = $state('')
  let mentionOpen = $state(false)
  let mentionIndex = $state(0)
  let mentionRequestId = 0
  let mentionSearchTimer: ReturnType<typeof setTimeout> | undefined
  let slashOpen = $state(false)
  let slashQuery = $state('')
  let slashIndex = $state(0)
  let lastCaretText: string | null = null
  let lastCaretSupportsCommands: boolean | null = null
  let richEditor: RichMarkdownEditor
  const speechScope = $derived(
    projectId
      ? ({ kind: 'project', projectId, ...(threadId ? { threadId } : {}) } as const)
      : ({ kind: 'inbox', ...(threadId ? { threadId } : {}) } as const)
  )

  function composerSpeechTarget(): SpeechEditorTarget | null {
    const editorTarget = richEditor?.speechEditorTarget(composerEditorId) ?? null
    if (!editorTarget) return null

    return {
      id: editorTarget.id,
      capture: () => editorTarget.capture(),
      apply: (snapshot, transcript) => editorTarget.apply(snapshot, transcript),
      fallbackApply: (snapshot, transcript): SpeechEditorApplyResult => {
        if (!projectId || !threadId || typeof onValueChange !== 'function') {
          return { ok: false, reason: 'destroyed' }
        }
        const base = rendererRecovery.draftFor(projectId, threadId)
        const baseMatchesSnapshot =
          snapshot.targetId === composerEditorId && snapshot.value === base

        let start: number
        let next: string
        if (baseMatchesSnapshot) {
          const selectionStart = Math.min(snapshot.selection.anchor, snapshot.selection.focus)
          const selectionEnd = Math.max(snapshot.selection.anchor, snapshot.selection.focus)
          start = selectionStart
          next = base.slice(0, selectionStart) + transcript + base.slice(selectionEnd)
        } else if (base.length === 0) {
          start = 0
          next = transcript
        } else {
          const separator = /\s$/.test(base) ? '' : ' '
          start = base.length + separator.length
          next = base + separator + transcript
        }

        onValueChange(next)
        return {
          ok: true,
          value: next,
          startOffset: start,
          endOffset: start + transcript.length
        }
      }
    }
  }

  // Dropdown open state
  let plusMenuOpen = $state(false)
  let engineeringToolbox: EngineeringToolbox | undefined = $state(undefined)
  let modelMenuOpen = $state(false)
  let inferenceMenuOpen = $state(false)
  let permissionMenuOpen = $state(false)
  /** Open state of the thinking-level dropdown inside the shared model picker. */
  let thinkingMenuOpen = $state(false)
  let startAfterPickerOpen = $state(false)
  // The composer is remounted by the parent when a restore is required, so
  // capture the persisted dependencies exactly once at construction.
  // svelte-ignore state_referenced_locally
  let startAfterThreads = $state<StartAfterSelection[]>(
    initialStartAfterThreads.map((t) => ({ ...t }))
  )
  // svelte-ignore state_referenced_locally
  let startAfterEnabled = $state(initialStartAfterThreads.length > 0)

  // Selection slot hover popover — a short grace period keeps it open while the
  // pointer travels from the chip across any gap to the popover itself.
  let selectionPopoverOpen = $state(false)
  let selectionPopoverTimer: ReturnType<typeof setTimeout> | undefined
  let startAfterPopoverOpen = $state(false)
  let startAfterPopoverTimer: ReturnType<typeof setTimeout> | undefined

  function openSelectionPopover(): void {
    clearTimeout(selectionPopoverTimer)
    selectionPopoverOpen = true
  }

  function scheduleSelectionPopoverClose(): void {
    clearTimeout(selectionPopoverTimer)
    selectionPopoverTimer = setTimeout(() => {
      selectionPopoverOpen = false
    }, 220)
  }

  function toggleSelectionPopover(): void {
    if (selectionPopoverOpen) scheduleSelectionPopoverClose()
    else openSelectionPopover()
  }

  /** Close the popover immediately (e.g. after choosing an edit/delete action). */
  function closeSelectionPopover(): void {
    clearTimeout(selectionPopoverTimer)
    selectionPopoverOpen = false
  }

  function openStartAfterPopover(): void {
    clearTimeout(startAfterPopoverTimer)
    startAfterPopoverOpen = true
  }

  function scheduleStartAfterPopoverClose(): void {
    clearTimeout(startAfterPopoverTimer)
    startAfterPopoverTimer = setTimeout(() => {
      startAfterPopoverOpen = false
    }, 220)
  }

  function closeStartAfterPopover(): void {
    clearTimeout(startAfterPopoverTimer)
    startAfterPopoverOpen = false
  }

  const permissionLabels: Record<PermissionLevel, string> = {
    auto_review: 'Auto Review',
    full_access: 'Full Access'
  }

  function selectPermission(level: PermissionLevel): void {
    permissionMenuOpen = false
    const updated = { ...resolved, permissionLevel: level }
    if (onSettingsChange) onSettingsChange(updated)
    else threadSettingsStore.commit(updated)
  }

  function closeAllMenus(): void {
    plusMenuOpen = false
    modelMenuOpen = false
    inferenceMenuOpen = false
    permissionMenuOpen = false
    thinkingMenuOpen = false
  }

  function openStartAfterPicker(): void {
    if (!projectId || readOnlyMode) return
    closeAllMenus()
    startAfterPickerOpen = true
  }

  function toggleStartAfter(enabled: boolean): void {
    if (!enabled) {
      startAfterEnabled = false
      startAfterThreads = []
      closeStartAfterPopover()
      onStartAfterThreadsChange?.([])
      return
    }
    if (!projectId || readOnlyMode) return
    startAfterEnabled = true
    openStartAfterPicker()
  }

  function selectStartAfterThread(thread: Thread): void {
    if (thread.id === threadId) return
    if (startAfterThreads.some((existing) => existing.id === thread.id)) return
    startAfterThreads = [...startAfterThreads, { id: thread.id, title: thread.title }]
    startAfterEnabled = true
    onStartAfterThreadsChange?.(startAfterThreads)
    focusComposerAtEnd()
  }

  function removeStartAfterThread(threadId: string): void {
    startAfterThreads = startAfterThreads.filter((existing) => existing.id !== threadId)
    if (startAfterThreads.length === 0) startAfterEnabled = false
    onStartAfterThreadsChange?.(startAfterThreads)
  }

  function clearStartAfterThreads(): void {
    startAfterEnabled = false
    startAfterThreads = []
    closeStartAfterPopover()
    onStartAfterThreadsChange?.([])
  }

  /** Toggle the independent (spec-less) audit. Turning it on hands the thread
   *  over to the audit coordinator in the context sidebar. */
  async function toggleIndependentAudit(enabled: boolean): Promise<void> {
    await onIndependentAuditToggle?.(enabled)
    if (enabled) plusMenuOpen = false
  }

  function showModelMenu(): void {
    modelMenuOpen = true
    plusMenuOpen = false
    inferenceMenuOpen = false
    thinkingMenuOpen = false
  }

  function showThinkingMenu(): void {
    if (!supportsThinking) return
    thinkingMenuOpen = true
    plusMenuOpen = false
    modelMenuOpen = false
    inferenceMenuOpen = false
  }

  function showInferenceMenu(): void {
    if (!supportsFast) return
    inferenceMenuOpen = true
    plusMenuOpen = false
    modelMenuOpen = false
    thinkingMenuOpen = false
  }

  // Focus restoration on close for every menu/overlay that steals focus from
  // the editor: each returns the caret to its last published position rather
  // than the end, so mid-sentence editing stays seamless.
  let modelWasOpen = false
  $effect(() => {
    if (modelWasOpen && !modelMenuOpen) {
      focusComposerAtSavedCaret()
    }
    modelWasOpen = modelMenuOpen
  })

  let thinkingWasOpen = false
  $effect(() => {
    if (thinkingWasOpen && !thinkingMenuOpen) {
      focusComposerAtSavedCaret()
    }
    thinkingWasOpen = thinkingMenuOpen
  })

  let permissionWasOpen = false
  $effect(() => {
    if (permissionWasOpen && !permissionMenuOpen) {
      focusComposerAtSavedCaret()
    }
    permissionWasOpen = permissionMenuOpen
  })

  let inferenceWasOpen = false
  $effect(() => {
    if (inferenceWasOpen && !inferenceMenuOpen) {
      focusComposerAtSavedCaret()
    }
    inferenceWasOpen = inferenceMenuOpen
  })

  function toggleInferenceMenu(): void {
    if (inferenceMenuOpen) closeAllMenus()
    else showInferenceMenu()
  }

  /**
   * Resolve against every catalog snapshot available to the renderer. The
   * composer can mount with a persisted/partial prop while the live project
   * catalog is still hydrating; merging here prevents that prop from passing
   * an empty thinking-preset override to ModelPicker.
   */
  let cachedProviders = $derived(providerCatalog.allCached())
  let currentProviders = $derived(
    projectId ? (providerCatalog.cached(projectId) ?? providers) : providers
  )
  let resolvedProviders = $derived(
    mergeProviderCatalogEntries([...cachedProviders, ...providers, ...currentProviders])
  )

  /** Catalog entry for the selected harness/provider/model, when reported. */
  let selectedProvider = $derived(
    resolvedProviders.find(
      (provider) => provider.harnessId === resolved.harnessId && provider.id === resolved.providerId
    ) ?? resolvedProviders.find((provider) => provider.id === resolved.providerId)
  )
  let selectedModel = $derived(
    selectedProvider?.models.find((model) => model.id === resolved.modelId)
  )

  /** True when the selected harness cannot accept any prompt attachments. */
  let selectedHarnessLacksAttachments = $derived(selectedProvider?.supportsAttachments === false)
  /** True when the catalog reports this model cannot see images and the app's
   *  own vision record does not say otherwise. */
  let selectedModelLacksVision = $derived(
    selectedModel?.attachment === false && !visionModels.has(selectedModel.id)
  )
  let hasImageAttachments = $derived(attachments.some(isImageAttachment))
  let attachmentBlockedNotice = $state(false)
  let textAttachmentError = $state('')

  function isImageAttachment(file: PromptAttachment): boolean {
    if (file.mime.startsWith('image/')) return true
    return /\.(png|jpe?g|gif|webp|bmp|avif|svg|ico)$/iu.test(file.filename ?? '')
  }

  /**
   * Whether sending the draft should be intercepted by the vision-model gate:
   * an image is attached, the active model cannot see it, and the user has not
   * opted into "don't ask again". The card is shown on every such send; the
   * thread or global default merely pre-fills the picker.
   */
  function shouldInterceptImageGate(): boolean {
    return (
      enableImageDescriptorGate &&
      hasImageAttachments &&
      selectedModelLacksVision &&
      !imageDescriptorAskAgain
    )
  }

  function openImageDescriptorGate(direct?: boolean): void {
    gateVisionSelection = resolved.imageDescriptor ?? imageDescriptorDefault ?? null
    gateDonotAsk = false
    gateDirect = direct
    imageDescriptorGateOpen = true
  }

  function cancelImageDescriptorGate(): void {
    imageDescriptorGateOpen = false
    focusComposerAtSavedCaret()
  }

  /** Persist the chosen vision model (thread + optional global default) and send. */
  function confirmImageDescriptorGate(): void {
    const selection = gateVisionSelection
    if (!selection) return
    if (onSettingsChange) onSettingsChange({ ...resolved, imageDescriptor: selection })
    else threadSettingsStore.commit({ ...resolved, imageDescriptor: selection })
    if (gateDonotAsk) {
      onImageDescriptorDefaultChange?.(selection)
      onImageDescriptorAskAgainChange?.(true)
    }
    imageDescriptorGateOpen = false
    performSend(gateDirect)
  }

  /**
   * Thinking presets declared by the selected model. While the catalog is cold
   * (model unknown yet) fall back to the standard presets so the thread's stored
   * `thinkingLevel` snapshot renders immediately; once the model resolves, its
   * real presets (or none, for non-reasoning models) take over.
   */
  let thinkingPresets = $derived(
    selectedModel ? (selectedModel.thinkingPresets ?? []) : STANDARD_THINKING_PRESETS
  )

  /** Thinking controls only appear when the model explicitly declares presets. */
  let supportsThinking = $derived(thinkingPresets.length > 0)

  /** Native fast harnesses stay visible even while their model catalog is cold or incomplete. */
  let fastVariant = $derived(
    supportsFastInference(resolved.harnessId, resolved.providerId, selectedModel?.fastSupported)
      ? { multiplier: fastMultiplierFor(resolved.modelId) }
      : null
  )

  let supportsFast = $derived(fastVariant !== null)

  let inferenceMode = $derived(resolved.inferenceMode ?? 'normal')
  const composerActionSource = {
    id: 'composer',
    label: APP_NAME,
    kind: 'app'
  } satisfies ActionSource
  let selectorActions = $derived<ActionDefinition[]>([
    {
      id: 'selector:models',
      title: '/models',
      description: 'Open the full model selector and search',
      category: 'model',
      source: composerActionSource,
      keywords: ['model', 'favorites', 'provider']
    },
    ...(supportsThinking
      ? [
          {
            id: 'selector:thinking' as const,
            title: '/thinking',
            description: 'Open the thinking selector and search',
            category: 'reasoning' as const,
            source: composerActionSource,
            keywords: ['reasoning', 'effort', ...thinkingPresets.map((p) => p.id)]
          }
        ]
      : [])
  ])
  let slashAvailableActions = $derived([
    ...selectorActions,
    ...actions.filter((action) => action.category !== 'model' && action.category !== 'reasoning')
  ])
  let slashActions = $derived(filterActions(slashAvailableActions, slashQuery))
  let pendingStop = $state(false)
  let pendingStopTimer: ReturnType<typeof setTimeout> | undefined
  let historyIndex = $state(-1)
  let savedValue = $state('')
  let hasText = $derived(value.trim().length > 0)

  /** True when an attached selection carries a user comment, so an otherwise
   *  empty message can still be sent (the comment is the payload). */
  let hasCommentReference = $derived(references.some((reference) => Boolean(reference.comment)))

  /** Whether there is anything to send: text, an attachment, or a commented selection. */
  let hasSendableContent = $derived(hasText || attachments.length > 0 || hasCommentReference)

  /** Whether the button should show the stop icon (agent working, nothing to send). */
  let canStop = $derived(working && !hasSendableContent)

  /** The mic stays mounted; only the send/stop control follows composer state. */
  let showSendControl = $derived(!disabled && (working || hasSendableContent))

  // Cancel pending stop when the agent stops working on its own.
  $effect(() => {
    if (working) return
    cancelStop()
  })

  /** Arms the stop confirmation on the first press; the second press calls
   *  `onStop`. Shared by the stop button and the Escape-key flow so both paths
   *  show the same visual armed state. */
  function confirmStop(): void {
    if (!onStop) return
    if (pendingStop) {
      clearTimeout(pendingStopTimer)
      pendingStop = false
      onStop()
      return
    }
    pendingStop = true
    pendingStopTimer = setTimeout(() => {
      pendingStop = false
    }, 3000)
  }

  function cancelStop(): void {
    clearTimeout(pendingStopTimer)
    pendingStop = false
  }

  /** Actions whose selection inserts `/title ` into the composer and whose
   *  typed `/title args` submit is routed through `onSlashCommand`. Harness
   *  command/skill/mcp actions qualify natively; app-owned actions opt in via
   *  the `slashCommand` flag. */
  function isSlashRoutedAction(action: ActionDefinition): boolean {
    if (action.slashCommand === true) return true
    return (
      action.source.kind === 'harness' &&
      (action.category === 'command' || action.category === 'skill' || action.category === 'mcp') &&
      action.title.startsWith('/')
    )
  }

  /** Focus the composer editor and place the caret at the end, in place. */
  export function focusComposerAtEnd(): void {
    void tick().then(() => {
      const editor = document.getElementById(composerEditorId)
      if (!(editor instanceof HTMLDivElement)) return
      editor.focus()
      placeCaretAtEnd(editor)
    })
  }

  /** Replace the composer draft with the given text and focus the caret at
   *  the end — used by external surfaces such as suggested prompts that
   *  should seed a draft instead of sending it. */
  export function setComposerText(text: string): void {
    value = text
    handleComposerValueChange(text)
    void tick().then(() => {
      focusComposerAtEnd()
    })
  }

  /** Focus the composer editor and place the caret at the start of the first
   *  line — the fallback when no caret position was ever captured. */
  export function focusComposerAtStart(): void {
    void tick().then(() => {
      const editor = document.getElementById(composerEditorId)
      if (!(editor instanceof HTMLDivElement)) return
      editor.focus()
      const range = document.createRange()
      range.setStart(editor, 0)
      range.collapse(true)
      const selection = window.getSelection()
      if (!selection) return
      selection.removeAllRanges()
      selection.addRange(range)
    })
  }

  /** Focus the composer editor and restore the caret to the position the user
   *  last had inside it — published continuously by the rich editor via its
   *  selection tracking. Falls back to the end when no position is known.
   *  This is the right default whenever an overlay that stole focus (menu,
   *  attachment preview, picker) closes: typing resumes exactly where it left
   *  off instead of the caret jumping to the end. */
  export function focusComposerAtSavedCaret(): void {
    void tick().then(() => {
      richEditor?.focusAtBookmark(richEditor.caretBookmark())
    })
  }

  function selectSlashAction(action: ActionDefinition, method: ActionSelection['method']): void {
    if (action.disabledReason) return
    const selectedQuery = slashQuery
    slashOpen = false

    const replacement = isSlashRoutedAction(action) ? `${action.title} ` : ''
    const replaced = richEditor.replaceTextBeforeCaret(
      /(^|\s)\/[^\s/]*$/u,
      (_match, prefix) => `${prefix}${replacement}`
    )
    if (!replaced) return

    if (action.id === 'selector:models') {
      showModelMenu()
      return
    }

    if (action.id === 'selector:thinking') {
      // Thinking level lives in the shared model picker's dropdown — open it directly.
      showThinkingMenu()
      return
    }

    if (isSlashRoutedAction(action)) {
      return
    }

    void onActionSelect?.({ action, query: selectedQuery, method })
  }

  function submit(direct?: boolean): void {
    if (mentionOpen && mentionEntries[mentionIndex]) {
      selectMention(mentionEntries[mentionIndex])
      return
    }
    const selectedSlashAction = slashActions[slashIndex]
    if (slashOpen && selectedSlashAction) {
      selectSlashAction(selectedSlashAction, 'keyboard')
      return
    }
    if (disabled) return
    if (working && !hasSendableContent) {
      confirmStop()
      return
    }
    cancelStop()
    const msg = normalizeComposerMessage(value, projectReferences)
    if (!msg && attachments.length === 0 && !hasCommentReference) return
    historyIndex = -1
    savedValue = ''
    const slashCommand = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(msg)
    if (slashCommand && onSlashCommand) {
      const name = slashCommand[1]
      const action = actions.find(
        (candidate) => isSlashRoutedAction(candidate) && candidate.title === `/${name}`
      )
      if (action) {
        if (action.disabledReason) return
        value = ''
        slashOpen = false
        onValueChange?.('')
        void onSlashCommand(action.id, slashCommand[2]?.trim() ?? '')
        return
      }
    }
    if (selectedHarnessLacksAttachments && attachments.length > 0) {
      attachmentBlockedNotice = true
      return
    }
    // When working and not direct, the parent (ThreadView) queues the message instead of sending it.
    // We still clear the input so the user can type their next message.
    if (shouldInterceptImageGate()) {
      openImageDescriptorGate(direct)
      return
    }
    performSend(direct)
  }

  function performSend(direct?: boolean): void {
    if (selectedHarnessLacksAttachments && attachments.length > 0) {
      attachmentBlockedNotice = true
      return
    }
    const msg = normalizeComposerMessage(value, projectReferences)
    speechController.observeSent(composerEditorId, msg)
    value = ''
    onValueChange?.('')
    const files = [...attachments]
    const taggedPaths = [...projectReferences]
    const taggedTasks = [...taskReferences]
    for (const objectUrl of Object.values(previewUrls)) {
      URL.revokeObjectURL(objectUrl)
    }
    attachments = []
    projectReferences = []
    taskReferences = []
    previewUrls = {}
    previewTexts = {}
    previewDocuments = {}
    previewDocumentLoading = {}
    onAttachmentsChange?.([])
    onProjectReferencesChange?.([])
    onTaskReferencesChange?.([])
    const selectedStartAfterThreads = startAfterEnabled ? startAfterThreads : []
    clearStartAfterThreads()
    onSend(msg, files, direct, taggedPaths, taggedTasks, selectedStartAfterThreads)
  }

  async function updateFileMention(nextValue: string): Promise<void> {
    const query = composerMentionQuery(nextValue)
    if (query === null) {
      mentionOpen = false
      return
    }
    const requestId = ++mentionRequestId
    try {
      const normalizedQuery = query.trim().toLocaleLowerCase()
      const utilityEntries: ComposerMentionEntry[] =
        !normalizedQuery || 'cio-utility'.includes(normalizedQuery)
          ? [
              {
                type: 'utility',
                entry: {
                  id: 'cio-utility',
                  name: '@cio-utility',
                  description:
                    'Set up a skill, MCP server, or plugin, or debug an app issue with a CodeInOven agent.'
                }
              }
            ]
          : []
      const taskEntries: ComposerMentionEntry[] = assignmentTasks
        .filter((task) => {
          if (!normalizedQuery) return true
          return [task.title, task.description, task.id, task.workerName]
            .filter((value): value is string => typeof value === 'string')
            .some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
        })
        .map((entry) => ({ type: 'task', entry }))
      const files = fileTagProjectId
        ? (
            await invoke(
              'projectFiles:search',
              fileTagProjectId,
              query,
              'all',
              workspaceState.activeScopeBucketIdFor(fileTagProjectId)
            )
          ).filter((entry) => cioSearchVisibility.includeCio || !isCioScratchPath(entry.path))
        : []
      const entries: ComposerMentionEntry[] = [
        ...utilityEntries,
        ...taskEntries,
        ...files.map((entry) => ({ type: 'project' as const, entry }))
      ]
      if (requestId !== mentionRequestId) return
      mentionQuery = query
      mentionEntries = entries.slice(0, 40)
      mentionIndex = 0
      mentionOpen = true
    } catch {
      if (requestId === mentionRequestId) mentionOpen = false
    }
  }

  function scheduleFileMentionSearch(textBeforeCaret: string): void {
    clearTimeout(mentionSearchTimer)
    if (composerMentionQuery(textBeforeCaret) === null) {
      mentionRequestId += 1
      mentionOpen = false
      return
    }
    mentionSearchTimer = setTimeout(() => void updateFileMention(textBeforeCaret), 120)
  }

  function handleComposerValueChange(nextValue: string): void {
    if (historyIndex >= 0) {
      historyIndex = -1
      savedValue = ''
    }
    const retainedReferences = projectReferences.filter((reference) =>
      nextValue.includes(projectReferenceToken(reference))
    )
    if (retainedReferences.length !== projectReferences.length) {
      projectReferences = retainedReferences
      onProjectReferencesChange?.(projectReferences)
    }
    const retainedTaskReferences = taskReferences.filter((reference) =>
      nextValue.includes(taskReferenceToken(reference))
    )
    if (retainedTaskReferences.length !== taskReferences.length) {
      taskReferences = retainedTaskReferences
      onTaskReferencesChange?.(taskReferences)
    }
    onValueChange?.(nextValue)
  }

  function handleCaretTextChange(textBeforeCaret: string, supportsCommands: boolean): void {
    if (textBeforeCaret === lastCaretText && supportsCommands === lastCaretSupportsCommands) {
      return
    }
    lastCaretText = textBeforeCaret
    lastCaretSupportsCommands = supportsCommands
    scheduleFileMentionSearch(supportsCommands ? textBeforeCaret : '')
    const slashMatch = supportsCommands ? /(^|\s)\/([^\s/]*)$/u.exec(textBeforeCaret) : null
    slashOpen = Boolean(slashMatch)
    slashQuery = slashMatch?.[2] ?? ''
    slashIndex = 0
    // A query that matches no actions is almost certainly a path being typed
    // (e.g. `cd /usr/local/bin`), not a command — close the menu so Enter and
    // the rest of the text behave normally.
    if (slashOpen && slashActions.length === 0) {
      slashOpen = false
    }
  }

  function selectMention(mention: ComposerMentionEntry): void {
    mentionOpen = false
    if (mention.type === 'utility') {
      const inserted = richEditor.replaceTextBeforeCaret(
        /(^|\s)@[^\s@]*$/u,
        (_match, prefix) => `${prefix}@cio-utility `
      )
      if (!inserted) {
        value = value.replace(/(^|\s)@[^\s@]*$/u, (_, prefix: string) => {
          return `${prefix}@cio-utility `
        })
        onValueChange?.(value)
      }
      return
    }
    if (mention.type === 'task') {
      selectTaskMention(mention.entry)
      return
    }
    const entry = mention.entry
    const existingReference = projectReferences.find((reference) => reference.path === entry.path)
    if (!existingReference && projectReferences.length >= 20) return
    const reference: PromptProjectReference = {
      id: crypto.randomUUID(),
      name: entry.name,
      path: entry.path,
      kind: entry.kind
    }
    if (!existingReference) {
      projectReferences = [...projectReferences, reference]
      onProjectReferencesChange?.(projectReferences)
    }
    const inserted = richEditor.replaceTextBeforeCaret(
      /(^|\s)@[^\s@]*$/u,
      (_match, prefix) => `${prefix}${projectReferenceToken(reference)} `
    )
    if (!inserted) {
      value = value.replace(/(^|\s)@[^\s@]*$/u, (_, prefix: string) => {
        return `${prefix}${projectReferenceToken(reference)} `
      })
      onValueChange?.(value)
    }
    if (inserted) return
    void tick().then(() => {
      const editor = document.getElementById(composerEditorId)
      if (!(editor instanceof HTMLDivElement)) return
      editor.focus()
      placeCaretAtEnd(editor)
    })
  }

  function selectTaskMention(task: AssignmentTask): void {
    if (!assignmentId) return
    const existingReference = taskReferences.find((reference) => reference.taskId === task.id)
    if (!existingReference && taskReferences.length >= 20) return
    const reference: PromptAssignmentTaskReference = {
      assignmentId,
      taskId: task.id,
      phaseId: task.phaseId,
      title: task.title,
      description: task.description,
      status: task.status,
      workerName: task.workerName ?? (task.owner === 'senior' ? 'Sr. Engineer' : undefined),
      threadId: task.threadId
    }
    if (!existingReference) {
      taskReferences = [...taskReferences, reference]
      onTaskReferencesChange?.(taskReferences)
    }
    const inserted = richEditor.replaceTextBeforeCaret(
      /(^|\s)@[^\s@]*$/u,
      (_match, prefix) => `${prefix}${taskReferenceToken(reference)} `
    )
    if (!inserted) {
      value = value.replace(/(^|\s)@[^\s@]*$/u, (_, prefix: string) => {
        return `${prefix}${taskReferenceToken(reference)} `
      })
      onValueChange?.(value)
    }
    if (inserted) return
    void tick().then(focusComposerAtEnd)
  }

  function toggleFileSystemMode(): void {
    const updated = { ...resolved, fileSystemMode: resolved.fileSystemMode !== true }
    if (onSettingsChange) onSettingsChange(updated)
    else threadSettingsStore.commit(updated)
  }

  function selectModel(providerId: string, modelId: string, nextHarnessId?: string): void {
    modelMenuOpen = false
    const nextHarness = nextHarnessId ?? resolved.harnessId
    onModelUsed?.(modelKey(nextHarness, providerId, modelId))
    const provider = resolvedProviders.find(
      (candidate) => candidate.harnessId === nextHarness && candidate.id === providerId
    )
    const model = provider?.models.find((candidate) => candidate.id === modelId)
    const defaultThinkingLevel = baseUrlProviderStore.defaultThinkingLevel(
      nextHarness,
      providerId,
      modelId
    )
    const thinkingLevel = resolveDefaultThinkingLevel(
      model?.thinkingPresets,
      defaultThinkingLevel,
      resolved.thinkingLevel
    )
    const fastSupported = supportsFastInference(nextHarness, providerId, model?.fastSupported)
    const updated: ThreadSettings = {
      ...resolved,
      harnessId: nextHarnessId ?? resolved.harnessId,
      providerId,
      modelId,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(fastSupported ? {} : { inferenceMode: 'normal' })
    }
    if (onSettingsChange) onSettingsChange(updated)
    else threadSettingsStore.commit(updated)
  }

  function selectThinking(preset: ThinkingPreset): void {
    const level = preset.id as ThinkingLevel
    // The picker may re-emit the level it already applied during a model
    // change — skip the redundant commit.
    if (resolved.thinkingLevel === level) return
    const updated = { ...resolved, thinkingLevel: level }
    if (onSettingsChange) onSettingsChange(updated)
    else threadSettingsStore.commit(updated)
  }

  function selectInference(mode: InferenceMode): void {
    inferenceMenuOpen = false
    const updated = {
      ...resolved,
      modelId:
        mode === 'fast'
          ? fastSelectionModelId(resolved.harnessId, resolved.modelId)
          : resolved.modelId,
      inferenceMode: mode
    }
    if (onSettingsChange) onSettingsChange(updated)
    else threadSettingsStore.commit(updated)
  }

  function runUsageCredits(): void {
    if (!usageCreditsCommandId || !onSlashCommand) return
    void onSlashCommand(usageCreditsCommandId, '')
  }

  /** Loads the preview payload for one attachment: blob URLs for binary media,
   *  converted document HTML (DOCX, DOC, ODT, PPTX), or decoded text. Missing/
   *  undecodable files silently yield no preview so the chip falls back to the
   *  file:// URL or the modal shows its unavailable state. */
  async function loadAttachmentPreview(file: PromptAttachment): Promise<void> {
    const kind = attachmentPreviewKind(file.mime, file.filename ?? '')
    if (!kind) return
    if (kind === 'document' && previewFile?.url !== file.url) return
    try {
      const filePath = fileUrlToPath(file.url)
      if (kind === 'document') {
        if (previewDocuments[file.url] !== undefined && previewUrls[file.url]) return
        if (previewDocumentLoading[file.url]) return
        previewDocumentLoading = { ...previewDocumentLoading, [file.url]: true }
        const html = await invoke('file:readDocumentPreview', filePath)
        if (!html) return
        previewDocuments = { ...previewDocuments, [file.url]: html }
        if (!previewUrls[file.url]) {
          const bytes = await window.api.readFile(filePath)
          const objectUrl = URL.createObjectURL(new Blob([bytes], { type: file.mime }))
          previewUrls = { ...previewUrls, [file.url]: objectUrl }
        }
        return
      }
      const bytes = await window.api.readFile(filePath)
      if (kind === 'markdown' || kind === 'text' || kind === 'csv') {
        if (previewTexts[file.url] !== undefined) return
        previewTexts = { ...previewTexts, [file.url]: new TextDecoder().decode(bytes) }
        return
      }
      if (previewUrls[file.url]) return
      const objectUrl = URL.createObjectURL(new Blob([bytes], { type: file.mime }))
      previewUrls = { ...previewUrls, [file.url]: objectUrl }
    } catch {
      // Preview unavailable; the chip/modal will fall back to the file:// URL.
    } finally {
      if (kind === 'document') {
        previewDocumentLoading = { ...previewDocumentLoading, [file.url]: false }
      }
    }
  }

  function openAttachmentPreview(file: PromptAttachment): void {
    previewFile = file
    void loadAttachmentPreview(file)
  }

  async function loadAttachmentPreviews(files: PromptAttachment[]): Promise<void> {
    for (const file of files) {
      await loadAttachmentPreview(file)
    }
  }

  onMount(() => {
    void loadAttachmentPreviews(attachments)
    // A voice recording started in this thread keeps running while the user
    // navigates away and back, which destroys and remounts this composer. The
    // speech controller still holds the destroyed editor target, so the
    // transcript would silently land in the draft store without appearing in
    // the visible editor. Hand the live editor target back to the controller
    // when one is mid-capture for this composer.
    const liveTarget = composerSpeechTarget()
    if (liveTarget) speechController.reattachTarget(liveTarget)
  })

  async function addFileAttachments(
    selections: ReadonlyArray<{ path: string; file?: File }>
  ): Promise<void> {
    if (readOnlyMode && !allowAttachments) return
    if (selectedHarnessLacksAttachments) {
      attachmentBlockedNotice = true
      return
    }
    const addedAttachments = selections.map(({ path, file }) => {
      const filename =
        file?.name ?? (path.split('/').pop() ?? path.split('\\').pop() ?? 'file').split('?')[0]
      const mime = file?.type || mimeFromPath(path)
      return { mime, url: pathToFileUrl(path), filename }
    })
    if (addedAttachments.length === 0) return

    attachments = [...attachments, ...addedAttachments]
    onAttachmentsChange?.([...attachments])
    await Promise.all(addedAttachments.map((attachment) => loadAttachmentPreview(attachment)))
  }

  async function addFileAttachment(filePath: string, file?: File): Promise<void> {
    await addFileAttachments([{ path: filePath, file }])
  }

  function isEditablePastedTextAttachment(file: PromptAttachment): boolean {
    if (file.mime !== 'text/plain') return false
    const path = fileUrlToPath(file.url)
    return /^pasted-[0-9a-f-]+\.txt$/u.test(path.split(/[/\\]/u).pop() ?? '')
  }

  async function addPastedTextAttachment(text: string): Promise<void> {
    if (!attachmentStorage) throw new Error('Attachment storage is unavailable for this chat.')
    const path = await invoke('attachment:saveText', attachmentStorage, text)
    const attachment: PromptAttachment = {
      mime: 'text/plain',
      url: pathToFileUrl(path),
      filename: 'Pasted text.txt'
    }
    attachments = [...attachments, attachment]
    previewTexts = { ...previewTexts, [attachment.url]: text }
    onAttachmentsChange?.([...attachments])
  }

  async function savePastedTextAttachment(
    attachment: PromptAttachment,
    text: string
  ): Promise<void> {
    if (!attachmentStorage || !isEditablePastedTextAttachment(attachment)) {
      throw new Error('This attachment is not editable here.')
    }
    await invoke('attachment:saveText', attachmentStorage, text, fileUrlToPath(attachment.url))
    previewTexts = { ...previewTexts, [attachment.url]: text }
  }

  async function savePreviewText(text: string): Promise<void> {
    const attachment = previewFile
    if (!attachment) throw new Error('The attachment preview is no longer open.')
    await savePastedTextAttachment(attachment, text)
  }

  function removeAttachment(index: number): void {
    const removed = attachments[index]
    if (removed) {
      const objectUrl = previewUrls[removed.url]
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
        const rest = { ...previewUrls }
        delete rest[removed.url]
        previewUrls = rest
      }
      const restTexts = { ...previewTexts }
      delete restTexts[removed.url]
      previewTexts = restTexts
      const restDocuments = { ...previewDocuments }
      delete restDocuments[removed.url]
      previewDocuments = restDocuments
      const restLoading = { ...previewDocumentLoading }
      delete restLoading[removed.url]
      previewDocumentLoading = restLoading
    }
    attachments = attachments.filter((_, i) => i !== index)
    onAttachmentsChange?.(attachments)
  }

  onDestroy(() => {
    clearTimeout(mentionSearchTimer)
    clearTimeout(selectionPopoverTimer)
    clearTimeout(startAfterPopoverTimer)
    for (const objectUrl of Object.values(previewUrls)) {
      URL.revokeObjectURL(objectUrl)
    }
  })

  async function pickAttachment(): Promise<void> {
    if (readOnlyMode && !allowAttachments) return
    if (selectedHarnessLacksAttachments) {
      attachmentBlockedNotice = true
      return
    }
    if (isRemotePwaRuntime()) {
      remoteFileInput?.click()
      return
    }
    const paths = await invoke('dialog:pickFiles', attachmentStorage)
    await addFileAttachments(paths.map((path) => ({ path })))
    focusComposerAtSavedCaret()
  }

  async function handleRemoteFileSelection(event: Event): Promise<void> {
    const input = event.currentTarget
    if (!(input instanceof HTMLInputElement) || !input.files) return
    for (const file of Array.from(input.files)) {
      try {
        const filePath = await window.api.registerFileSelection(file, attachmentStorage)
        if (filePath) await addFileAttachment(filePath, file)
      } catch (error) {
        textAttachmentError =
          error instanceof Error ? error.message : 'The attachment could not be added.'
      }
    }
    input.value = ''
    focusComposerAtSavedCaret()
  }

  // ─── Global file drop (full viewport) ─────────────────────────────────────
  // Uses document-level event listeners so files dragged anywhere on the page
  // are captured. A fixed-position overlay appears when files are in flight.
  function hasFiles(dt: DataTransfer | null): boolean {
    if (!dt) return false
    // `types` can be a DOMStringList (contains) or FrozenArray (includes).
    const types = Array.from(dt.types ?? [])
    return types.includes('Files')
  }

  /** True when the pointer is inside any visible project file tree region. The
   *  file tree handles the drag/drop itself, so the composer must not capture it. */
  function overFileTree(e: { clientX: number; clientY: number }): boolean {
    const trees = document.querySelectorAll<HTMLElement>('[data-region="file-tree"]')
    for (const tree of trees) {
      if (tree.offsetParent === null) continue
      const rect = tree.getBoundingClientRect()
      if (
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom
      ) {
        return true
      }
    }
    return false
  }

  async function handleDropFiles(dt: DataTransfer | null): Promise<void> {
    if (readOnlyMode && !allowAttachments) return
    if (selectedHarnessLacksAttachments) {
      attachmentBlockedNotice = true
      return
    }
    if (!dt) return
    const files = dt.files
    if (!files || files.length === 0) return
    for (const file of Array.from(files)) {
      try {
        const filePath = await window.api.registerFileSelection(file, attachmentStorage)
        if (filePath) await addFileAttachment(filePath, file)
      } catch (error) {
        // Not a local file (e.g., image dragged from a web page); skip.
        if (isRemotePwaRuntime()) {
          textAttachmentError =
            error instanceof Error ? error.message : 'The attachment could not be added.'
        }
      }
    }
  }

  // Register the document-level drag listeners once on mount and gate each
  // handler on the current mode flags. The previous $effect re-subscribed on
  // every change of readOnlyMode/allowAttachments; with the handlers gating on
  // those values at event time the behavior is identical while keeping the
  // listener lifecycle (and the isDragging mutations) out of a reactive effect.
  onMount(() => {
    function onDragOver(e: DragEvent): void {
      if (readOnlyMode && !allowAttachments) return
      if (selectedHarnessLacksAttachments) return
      if (overFileTree(e)) {
        // The file tree owns the drop in its region; hide the composer overlay.
        if (isDragging) isDragging = false
        return
      }
      if (!hasFiles(e.dataTransfer)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      isDragging = true
    }

    function onDragLeave(e: DragEvent): void {
      if (readOnlyMode && !allowAttachments) return
      if (selectedHarnessLacksAttachments) return
      if (
        e.clientX <= 0 ||
        e.clientY <= 0 ||
        e.clientX >= window.innerWidth ||
        e.clientY >= window.innerHeight
      ) {
        isDragging = false
      }
    }

    function onDrop(e: DragEvent): void {
      if (readOnlyMode && !allowAttachments) return
      if (selectedHarnessLacksAttachments) {
        if (hasFiles(e.dataTransfer)) {
          e.preventDefault()
          attachmentBlockedNotice = true
        }
        return
      }
      if (overFileTree(e)) return
      e.preventDefault()
      isDragging = false
      void handleDropFiles(e.dataTransfer)
    }

    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onDrop)

    return () => {
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', onDrop)
    }
  })

  async function handlePaste(e: ClipboardEvent): Promise<void> {
    if (readOnlyMode && !allowAttachments) return
    const pastedText = e.clipboardData?.getData('text/plain') ?? ''
    const shouldAttachText =
      pastedText.length >= LONG_PASTE_ATTACHMENT_CHARACTERS ||
      value.length + pastedText.length > MAX_PROMPT_CHARACTERS
    if (
      shouldAttachText &&
      pastedText.length > 0 &&
      attachmentStorage &&
      !selectedHarnessLacksAttachments
    ) {
      e.preventDefault()
      textAttachmentError = ''
      try {
        await addPastedTextAttachment(pastedText)
      } catch (error) {
        textAttachmentError =
          error instanceof Error ? error.message : 'The pasted text could not be attached.'
      }
      return
    }
    const items = e.clipboardData?.items
    if (!items) return
    if (selectedHarnessLacksAttachments) {
      const hasFile = Array.from(items).some(
        (item) => item.kind === 'file' || item.type.startsWith('image/')
      )
      if (hasFile) {
        e.preventDefault()
        attachmentBlockedNotice = true
      }
      return
    }
    let hasFileAttachment = false

    for (const item of Array.from(items)) {
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file) {
          try {
            const filePath = await window.api.registerFileSelection(file, attachmentStorage)
            if (filePath) {
              await addFileAttachment(filePath, file)
              hasFileAttachment = true
            }
          } catch {
            // Pasted item is not a local file; fall through to clipboard image handler.
          }
        }
      }
    }

    if (!hasFileAttachment) {
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          hasFileAttachment = true
          break
        }
      }
      if (hasFileAttachment) {
        try {
          const path = attachmentStorage
            ? await invoke('clipboard:saveImage', attachmentStorage)
            : null
          if (path) await addFileAttachment(path)
          else hasFileAttachment = false
        } catch {
          hasFileAttachment = false
        }
      }
    }

    if (hasFileAttachment) e.preventDefault()
  }

  function onWindowKeydown(e: KeyboardEvent): void {
    // While a surface above this composer owns Escape — a Settings/Scope page
    // covering the shell, an open modal or palette (spotlight) — or the event
    // was already consumed by such an overlay, stay inert. Reacting here would
    // arm the "Stop?" confirmation invisibly, making the user's next Escape on
    // the thread abort the run without them ever seeing the armed state.
    if (isEscapeClaimed(e)) return
    if (mentionOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const direction = e.key === 'ArrowDown' ? 1 : -1
        mentionIndex =
          (mentionIndex + direction + Math.max(mentionEntries.length, 1)) %
          Math.max(mentionEntries.length, 1)
        return
      }
      if (e.key === 'Tab' && mentionEntries[mentionIndex]) {
        e.preventDefault()
        selectMention(mentionEntries[mentionIndex])
        return
      }
      if (e.key === 'Enter' && mentionEntries[mentionIndex]) {
        e.preventDefault()
        selectMention(mentionEntries[mentionIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        mentionOpen = false
        return
      }
    }
    if (slashOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const direction = e.key === 'ArrowDown' ? 1 : -1
        const count = Math.max(slashActions.length, 1)
        slashIndex = (slashIndex + direction + count) % count
        return
      }
      if (e.key === 'Tab' && !e.shiftKey && slashActions[slashIndex]) {
        e.preventDefault()
        selectSlashAction(slashActions[slashIndex], 'keyboard')
        return
      }
      if (e.key === 'Enter' && slashActions[slashIndex]) {
        // The rich editor only submits when the caret sits in a plain paragraph
        // (P/DIV). When the slash is typed after text that renders as a heading,
        // list, code block, etc. the editor's own Enter handler would let the
        // browser insert a newline instead of running the command — so the slash
        // menu claims Enter here, in the bubbling phase, before the default
        // action fires. For plain paragraphs the editor already submitted and
        // closed the menu, making this branch a no-op.
        e.preventDefault()
        selectSlashAction(slashActions[slashIndex], 'keyboard')
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        slashOpen = false
        return
      }
    }
    if (selectionPopoverOpen && e.key === 'Escape') {
      e.preventDefault()
      selectionPopoverOpen = false
      return
    }
    if (startAfterPopoverOpen && e.key === 'Escape') {
      e.preventDefault()
      closeStartAfterPopover()
      return
    }
    const editorEl = document.getElementById(composerEditorId)
    const isComposerFocused = editorEl?.contains(document.activeElement)
    if (isComposerFocused && !mentionOpen && !slashOpen) {
      if (historyIndex >= 0 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        historyIndex = -1
        savedValue = ''
      }
      if (e.key === 'ArrowUp' && !e.shiftKey && (value === '' || historyIndex >= 0)) {
        const history = historyMessages
        if (history.length > 0) {
          e.preventDefault()
          if (historyIndex === -1) {
            savedValue = value
            historyIndex = history.length - 1
          } else {
            historyIndex = Math.max(0, historyIndex - 1)
          }
          value = history[historyIndex]
          onValueChange?.(value)
          return
        }
      }
      if (e.key === 'ArrowDown' && !e.shiftKey && historyIndex >= 0) {
        e.preventDefault()
        const history = historyMessages
        if (historyIndex >= history.length - 1) {
          value = savedValue
          onValueChange?.(value)
          historyIndex = -1
        } else {
          historyIndex += 1
          value = history[historyIndex]
          onValueChange?.(value)
        }
        return
      }
    }
    // Global-on-thread toggle: works regardless of what has focus (composer,
    // toolbox panel, or elsewhere on the thread) — like the voice shortcut.
    // The toolbox panel handles Cmd/Ctrl+E itself while open and prevents
    // default, so this won't immediately re-open it.
    if (
      (e.metaKey || e.ctrlKey) &&
      e.key.toLowerCase() === 'e' &&
      !e.defaultPrevented &&
      showEngineeringMode
    ) {
      e.preventDefault()
      void engineeringToolbox?.openAndFocus()
      return
    }
    // While the agent runs, the first Escape arms the stop button with a
    // visible "Stop?" state and the second confirms the abort. A running agent
    // is a global session concern, so this remains active even when the
    // composer editor itself does not have focus.
    if (e.key !== 'Escape') return
    if (working && onStop) {
      confirmStop()
      return
    }
    // Idle — Escape only dismisses a stale armed confirmation.
    if (pendingStop) cancelStop()
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<input
  bind:this={remoteFileInput}
  type="file"
  multiple
  class="sr-only"
  tabindex="-1"
  aria-hidden="true"
  onchange={(event) => void handleRemoteFileSelection(event)}
/>

{#if previewFile}
  <AttachmentPreview
    attachment={previewFile}
    src={previewUrls[previewFile.url]}
    text={previewTexts[previewFile.url]}
    documentHtml={previewDocuments[previewFile.url]}
    documentLoading={previewDocumentLoading[previewFile.url] ?? false}
    onSaveText={isEditablePastedTextAttachment(previewFile) ? savePreviewText : undefined}
    onClose={() => {
      previewFile = null
      focusComposerAtSavedCaret()
    }}
  />
{/if}

{#if isDragging}
  <!-- Rendered as a sibling of .chat-composer, not a descendant: that element sets
       container-type for its responsive toolbar, which makes it a containing block
       for position:fixed children and would confine this overlay to its bounds
       instead of the viewport. -->
  <div
    role="region"
    aria-label="Drop zone"
    class="fixed inset-0 z-100 flex items-center justify-center border-2 border-dashed border-primary bg-primary/20 backdrop-blur-sm pointer-events-auto"
    ondragover={(e: DragEvent) => {
      if (overFileTree(e)) {
        isDragging = false
        return
      }
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }}
    ondrop={(e: DragEvent) => {
      if (overFileTree(e)) return
      e.preventDefault()
      e.stopPropagation()
      isDragging = false
      handleDropFiles(e.dataTransfer)
    }}
  >
    <div class="flex flex-col items-center gap-2 text-primary">
      <Upload size={32} />
      <span class="text-base font-medium">Drop files to attach</span>
    </div>
  </div>
{/if}

<div
  class="chat-composer border bg-surface shadow-sm"
  data-onboarding="composer"
  data-voice-trigger-root
>
  {#if imageDescriptorGateOpen}
    <div
      class="mx-3 mt-2.5 rounded-xl border border-primary/30 bg-primary/5 p-4"
      role="dialog"
      aria-label="Pick a vision model to describe this image"
    >
      <div class="flex items-start gap-2.5">
        <div class="mt-0.5 shrink-0 rounded-lg bg-primary/10 p-1.5 text-primary">
          <Eye size={15} />
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold text-foreground">This model can't see images</p>
          <p class="mt-1 text-xs leading-relaxed text-muted">
            You're about to send an image to a model without vision capability. Image Descriptor is
            a tool the model can call to describe the image for it — but you need to pick the vision
            model that does the describing.
          </p>
        </div>
      </div>
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="flex h-9 items-center gap-1.5 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
          title="Cancel and keep your message and attachment"
          onclick={cancelImageDescriptorGate}
        >
          Cancel
        </button>
        <div class="min-w-0 flex-1">
          <ModelPicker
            {providers}
            {projectId}
            harnessId={gateVisionSelection?.harnessId ??
              providers[0]?.harnessId ??
              resolved.harnessId}
            providerId={gateVisionSelection?.providerId ?? ''}
            modelId={gateVisionSelection?.modelId ?? ''}
            {favoriteModels}
            {recentModels}
            {onRemoveRecent}
            visionOnly
            side="top"
            variant="field"
            label={gateVisionSelection ? undefined : 'Choose a vision model'}
            onSelect={(providerId, modelId, harnessId) => {
              gateVisionSelection = { harnessId, providerId, modelId }
            }}
            thinkingLevel={gateVisionSelection?.thinkingLevel}
            onSelectThinking={(level) => {
              if (!gateVisionSelection) return
              gateVisionSelection = { ...gateVisionSelection, thinkingLevel: level }
            }}
            {onToggleFavorite}
            {onReorderFavorite}
          />
        </div>
        <button
          type="button"
          class="flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
          title="Send the image and describe it with the selected vision model"
          disabled={!gateVisionSelection}
          onclick={() => confirmImageDescriptorGate()}
        >
          <Check size={13} /> Continue
        </button>
      </div>
      {#if !gateVisionSelection}
        <p class="mt-1.5 text-[0.6875rem] text-dimmed">
          No vision model selected — Continue is disabled until you pick one.
        </p>
      {/if}
      <div class="mt-3 flex justify-start">
        <Switch
          bind:checked={gateDonotAsk}
          label="Don't ask again"
          aria-label="Don't ask again for this vision model"
        />
      </div>
    </div>
  {/if}

  {#if selectedHarnessLacksAttachments && (attachmentBlockedNotice || attachments.length > 0)}
    <div
      class="mx-3 mt-2.5 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
      role="status"
    >
      This model cannot accept file attachments. Choose another model before sending this file.
    </div>
  {/if}

  {#if textAttachmentError}
    <div
      class="mx-3 mt-2.5 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
      role="status"
    >
      {textAttachmentError}
    </div>
  {/if}

  <!-- Project context + attachment chips -->
  {#if projectContext || attachments.length > 0 || references.length > 0 || startAfterThreads.length > 0 || (showChatModes && resolved.fileSystemMode)}
    <div class="flex flex-col gap-1.5 px-3 pt-2.5">
      <div class="flex flex-wrap items-center gap-1.5">
        {#if projectContext}
          <ProjectSwitch
            activeProjectId={projectId}
            onSwitch={onSwitchProject}
            class="flex items-center gap-2 justify-start"
          >
            {#if projectContext.iconUrl}
              <img src={projectContext.iconUrl} alt="" class="h-4 w-4 shrink-0 rounded" />
            {:else}
              <Folder size={13} class="shrink-0 text-dimmed" />
            {/if}
            <ProjectIdentity
              project={projectContext}
              class="min-w-0 max-w-48"
              nameClass="text-xs font-medium text-foreground"
              locationClass="text-[0.5625rem] text-dimmed"
              showLocation={hasProjectNameCollision(projectContext, scopeState.projectRecords)}
            />
            <span
              class="flex shrink-0 items-center gap-1 rounded-md bg-elevated px-1.5 py-0.5 text-[0.625rem] text-muted"
            >
              {#if projectContext.source === 'ssh'}
                <Globe size={9} />
              {:else}
                <Monitor size={9} />
              {/if}
              {projectContext.source}
            </span>
            {#if projectContext.branch}
              <span
                class="flex min-w-0 shrink items-center gap-1 rounded-md bg-elevated px-1.5 py-0.5 text-[0.625rem] text-muted"
                title={branchPillTitle}
              >
                <GitBranch size={9} class="shrink-0" />
                <span class="truncate">{projectContext.branch}</span>
              </span>
            {/if}
          </ProjectSwitch>
        {/if}
        {#if showChatModes && resolved.fileSystemMode}
          <div class="flex flex-wrap items-center gap-1.5" aria-label="Active chat modes">
            {#if resolved.fileSystemMode}
              <span
                class="flex shrink-0 items-center gap-1 rounded-md bg-info/10 px-1.5 py-0.5 text-[0.625rem] text-info"
              >
                <HardDrive size={9} class="shrink-0" />
                <span>File System</span>
                <button
                  type="button"
                  class="shrink-0 text-info/60 transition-colors hover:text-info"
                  title="Turn off File System"
                  aria-label="Turn off File System"
                  onclick={toggleFileSystemMode}
                >
                  <X size={9} />
                </button>
              </span>
            {/if}
          </div>
        {/if}
        {#if startAfterThreads.length > 0}
          <div
            class="relative inline-flex"
            role="group"
            aria-label="Start after dependencies"
            onmouseenter={openStartAfterPopover}
            onmouseleave={scheduleStartAfterPopoverClose}
          >
            <div
              class="flex items-center rounded-lg border border-info/30 bg-info/10 text-[0.625rem] font-medium text-info transition-colors hover:bg-info/15"
            >
              <button
                type="button"
                class="flex items-center gap-1.5 rounded-l-lg px-2 py-1"
                title={`Starts after ${startAfterThreads.length} ${startAfterThreads.length === 1 ? 'thread' : 'threads'} — hover to manage`}
                aria-label={`Starts after ${startAfterThreads.length} ${startAfterThreads.length === 1 ? 'thread' : 'threads'}`}
                aria-expanded={startAfterPopoverOpen}
                onclick={() => {
                  if (startAfterPopoverOpen) closeStartAfterPopover()
                  else openStartAfterPopover()
                }}
              >
                <Clock size={10} class="shrink-0" />
                <span
                  >Start after{startAfterThreads.length > 1
                    ? ` · ${startAfterThreads.length}`
                    : ''}</span
                >
              </button>
              <button
                type="button"
                class="flex h-full items-center rounded-r-lg pl-0.5 pr-1.5 text-info/70 transition-colors hover:text-danger"
                title="Remove all Start after threads"
                aria-label="Remove all Start after threads"
                onclick={clearStartAfterThreads}
              >
                <X size={10} />
              </button>
            </div>
            {#if startAfterPopoverOpen}
              <div
                class="absolute bottom-full left-0 z-50 mb-1.5 w-72 rounded-xl border border-border bg-surface p-2 shadow-lg"
                role="dialog"
                aria-label="Start after details"
                tabindex="0"
                onmouseenter={openStartAfterPopover}
                onmouseleave={scheduleStartAfterPopoverClose}
              >
                <div
                  class="px-2 pb-1 text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed"
                >
                  Starts after thread{startAfterThreads.length === 1 ? '' : 's'}
                </div>
                {#each startAfterThreads as selectedStartAfterThread (selectedStartAfterThread.id)}
                  <div class="flex items-center gap-1">
                    <button
                      type="button"
                      class="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-elevated"
                      title={'Open ' + selectedStartAfterThread.title}
                      aria-label={'Open ' + selectedStartAfterThread.title}
                      onclick={() => void onOpenStartAfterThread?.(selectedStartAfterThread.id)}
                    >
                      <Clock size={12} class="shrink-0 text-info" />
                      <span class="min-w-0 flex-1 truncate">
                        {selectedStartAfterThread.title}
                      </span>
                    </button>
                    <button
                      type="button"
                      class="flex h-6 shrink-0 items-center rounded-md px-1 text-dimmed transition-colors hover:bg-elevated hover:text-danger"
                      title={`Remove ${selectedStartAfterThread.title} from Start after`}
                      aria-label={`Remove ${selectedStartAfterThread.title} from Start after`}
                      onclick={() => removeStartAfterThread(selectedStartAfterThread.id)}
                    >
                      <X size={11} />
                    </button>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
      {#if references.length > 0}
        <div
          role="group"
          aria-label="Attached selections"
          class="relative inline-flex"
          onmouseenter={openSelectionPopover}
          onmouseleave={scheduleSelectionPopoverClose}
        >
          <div
            class="flex items-center rounded-lg border border-accent/30 bg-accent/10 text-[0.6875rem] font-medium text-foreground transition-colors hover:bg-accent/15"
          >
            <button
              type="button"
              class="flex items-center gap-1.5 rounded-l-lg px-2 py-1"
              title={`${references.length} attached ${references.length === 1 ? 'selection' : 'selections'} — hover to manage`}
              aria-label={`${references.length} attached ${references.length === 1 ? 'selection' : 'selections'}`}
              aria-expanded={selectionPopoverOpen}
              onclick={toggleSelectionPopover}
            >
              <MessageSquare size={11} class="shrink-0 text-accent" />
              <span>
                {references.length}
                {references.length === 1 ? 'selection' : 'selections'}
              </span>
            </button>
            {#if onRemoveAllReferences}
              <button
                type="button"
                class="flex h-full items-center rounded-r-lg pl-0.5 pr-1.5 text-dimmed transition-colors hover:text-danger"
                title="Delete all selections"
                aria-label="Delete all selections"
                onclick={onRemoveAllReferences}
              >
                <X size={11} />
              </button>
            {/if}
          </div>
          {#if selectionPopoverOpen}
            <div class="absolute bottom-full left-0 z-50 mb-1.5">
              <SelectionListPopover
                {references}
                onEdit={(id) => {
                  closeSelectionPopover()
                  onEditReference?.(id)
                }}
                onRemove={(id) => onRemoveReference?.(id)}
                onRemoveAll={onRemoveAllReferences}
              />
            </div>
          {/if}
        </div>
      {/if}
      {#if attachments.length > 0}
        <div class="flex flex-wrap gap-1.5">
          {#each attachments as file, i (file.url)}
            {@const previewKind = attachmentPreviewKind(file.mime, file.filename ?? '')}
            <div
              class="flex items-stretch overflow-hidden rounded-lg border border-border bg-elevated text-[0.6875rem] text-muted transition-colors"
            >
              {#if previewKind}
                <button
                  type="button"
                  class="flex min-w-0 items-center gap-1.5 py-1 pr-1 pl-2 text-left transition-colors hover:text-foreground"
                  title="Click to preview"
                  aria-label="Preview {file.filename ?? 'file'}"
                  onclick={() => openAttachmentPreview(file)}
                >
                  {#if previewKind === 'image'}
                    {#if previewUrls[file.url]}
                      <img
                        src={previewUrls[file.url]}
                        alt={file.filename ?? 'file'}
                        class="h-5 w-5 shrink-0 rounded object-cover"
                      />
                    {:else}
                      <ImageIcon size={11} class="shrink-0" />
                    {/if}
                  {:else if previewKind === 'video'}
                    <Video size={11} class="shrink-0" />
                  {:else if previewKind === 'audio'}
                    <AudioLines size={11} class="shrink-0" />
                  {:else}
                    <FileText size={11} class="shrink-0" />
                  {/if}
                  <span class="max-w-32 truncate">{file.filename ?? 'file'}</span>
                </button>
              {:else}
                <span class="flex min-w-0 items-center gap-1.5 py-1 pr-1 pl-2">
                  <FileText size={11} class="shrink-0" />
                  <span class="max-w-32 truncate">{file.filename ?? 'file'}</span>
                </span>
              {/if}
              <button
                type="button"
                class="flex shrink-0 items-center justify-center border-l border-border px-2.5 text-dimmed transition-colors hover:bg-danger/10 hover:text-danger"
                title="Remove attachment"
                aria-label="Remove attachment"
                onclick={() => removeAttachment(i)}
              >
                <X size={11} />
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <div class="relative">
    {#if slashOpen}
      <SlashActionMenu
        actions={slashAvailableActions}
        query={slashQuery}
        activeIndex={slashIndex}
        onSelect={(action) => selectSlashAction(action, 'pointer')}
      />
    {/if}
    {#if mentionOpen}
      <ProjectFileMentionMenu
        entries={mentionEntries}
        activeIndex={mentionIndex}
        query={mentionQuery}
        onSelect={selectMention}
        onCioFilterChange={() => {
          if (lastCaretText !== null) void updateFileMention(lastCaretText)
        }}
      />
    {/if}
    <RichMarkdownEditor
      bind:this={richEditor}
      id={composerEditorId}
      bind:value
      {placeholder}
      {autofocus}
      {disabled}
      ariaLabel="Message"
      onValueChange={handleComposerValueChange}
      onSubmit={submit}
      onPaste={handlePaste}
      inlineBadges={projectReferenceBadges}
      onCaretTextChange={handleCaretTextChange}
    />
  </div>

  <!-- Bottom bar: + menu · model · thinking ··· send -->
  <div class="composer-toolbar flex min-w-0 items-center gap-1 px-3 pb-2 pt-1">
    <!-- Plus menu — attachments and project scheduling; Engineering lives in Toolbox. -->
    {#if !readOnlyMode || allowAttachments || showEngineeringMode}
      <div class="relative">
        <button
          type="button"
          class="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
          title="Chat options"
          aria-label="Chat options"
          aria-haspopup="menu"
          aria-expanded={plusMenuOpen}
          onclick={() => {
            plusMenuOpen = !plusMenuOpen
            modelMenuOpen = false
            thinkingMenuOpen = false
          }}
        >
          <Plus size={15} class="transition-transform {plusMenuOpen ? 'rotate-45' : ''}" />
        </button>

        {#if plusMenuOpen}
          <button
            class="fixed inset-0 z-30 cursor-default"
            aria-label="Close menu"
            onclick={() => (plusMenuOpen = false)}
          ></button>
          <div
            class="absolute bottom-9 left-0 z-40 w-60 rounded-xl border bg-surface p-1 shadow-lg"
            role="menu"
          >
            {#if showChatModes || showEngineeringMode || independentAuditAvailable}
              {#if showChatModes}
                <!-- File System toggle (chat view) -->
                <Switch
                  checked={resolved.fileSystemMode === true}
                  onchange={toggleFileSystemMode}
                  title={resolved.fileSystemMode
                    ? 'Turn off File System — chat becomes web-only'
                    : 'Turn on File System — grant this thread file operations'}
                  activeClass="bg-info"
                  class="w-full justify-between rounded-lg px-2.5 py-2 transition-colors hover:bg-elevated"
                >
                  <span
                    class="flex min-w-0 items-center gap-2 {resolved.fileSystemMode
                      ? 'text-foreground'
                      : 'text-muted'}"
                  >
                    <HardDrive
                      size={13}
                      class={resolved.fileSystemMode ? 'text-info' : 'text-dimmed'}
                    />
                    File System
                  </span>
                </Switch>
              {/if}

              {#if independentAuditAvailable && projectId && !readOnlyMode}
                <!-- Independent audit (spec-less) -->
                <Switch
                  checked={independentAuditEnabled}
                  onchange={(enabled) => void toggleIndependentAudit(enabled)}
                  title="Independent audit that uses the context of the thread to bring up an auditor to audit the current work of the agent"
                  aria-label={independentAuditEnabled
                    ? 'Turn off Independent audit'
                    : 'Turn on Independent audit'}
                  activeClass="bg-info"
                  class="w-full justify-between rounded-lg px-2.5 py-2 transition-colors hover:bg-elevated"
                >
                  <span
                    class="flex min-w-0 items-center gap-2 {independentAuditEnabled
                      ? 'text-foreground'
                      : 'text-muted'}"
                  >
                    <ShieldCheck
                      size={13}
                      class={independentAuditEnabled ? 'text-info' : 'text-dimmed'}
                    />
                    Independent Audit
                  </span>
                </Switch>
              {/if}

              {#if showEngineeringMode && projectId && !readOnlyMode}
                <!-- Start-after dependency -->
                <Switch
                  checked={startAfterEnabled}
                  onchange={toggleStartAfter}
                  title={startAfterThreads.length > 0
                    ? `Start after ${startAfterThreads.length} ${startAfterThreads.length === 1 ? 'thread' : 'threads'}`
                    : 'Start this thread after other active threads finish'}
                  aria-label="Start after other threads"
                  activeClass="bg-info"
                  class="w-full justify-between rounded-lg px-2.5 py-2 transition-colors hover:bg-elevated"
                >
                  <span
                    class="flex min-w-0 items-center gap-2 {startAfterEnabled
                      ? 'text-foreground'
                      : 'text-muted'}"
                  >
                    <Clock size={13} class={startAfterEnabled ? 'text-info' : 'text-dimmed'} />
                    <span class="min-w-0 truncate">
                      {startAfterEnabled && startAfterThreads.length > 0
                        ? `Start after · ${startAfterThreads.length} ${startAfterThreads.length === 1 ? 'thread' : 'threads'}`
                        : 'Start after'}
                    </span>
                  </span>
                </Switch>
                {#if startAfterEnabled}
                  {#each startAfterThreads as startAfterThread (startAfterThread.id)}
                    <div class="flex items-center gap-1 px-1">
                      <span
                        class="min-w-0 flex-1 truncate px-1.5 py-0.5 text-[0.6875rem] text-info"
                      >
                        {startAfterThread.title}
                      </span>
                      <button
                        type="button"
                        class="flex h-6 shrink-0 items-center rounded-md px-1 text-dimmed transition-colors hover:bg-elevated hover:text-danger"
                        title={`Remove ${startAfterThread.title} from Start after`}
                        aria-label={`Remove ${startAfterThread.title} from Start after`}
                        onclick={() => removeStartAfterThread(startAfterThread.id)}
                      >
                        <X size={11} />
                      </button>
                    </div>
                  {/each}
                  <button
                    type="button"
                    class="flex w-full items-center rounded-lg px-2.5 py-1 text-left text-[0.6875rem] text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                    role="menuitem"
                    title="Add another thread to Start after"
                    onclick={openStartAfterPicker}
                  >
                    Add thread
                  </button>
                {/if}
              {/if}

              <div class="mx-2 my-1 border-t"></div>
            {/if}

            {#if !readOnlyMode || allowAttachments}
              <!-- Attach file -->
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-foreground transition-colors hover:bg-elevated disabled:cursor-not-allowed disabled:opacity-50"
                role="menuitem"
                title={selectedHarnessLacksAttachments
                  ? 'Attachments are unavailable for this model'
                  : 'Attach files to this message'}
                disabled={selectedHarnessLacksAttachments}
                onclick={() => {
                  plusMenuOpen = false
                  void pickAttachment()
                }}
              >
                <Paperclip size={13} class="text-dimmed" />
                Attach Files
              </button>
            {/if}
          </div>
        {/if}
      </div>
    {/if}

    {#if showEngineeringMode && onEngineeringLifecycleSelect && !engineeringToolboxHidden}
      <EngineeringToolbox
        bind:this={engineeringToolbox}
        lifecycleState={engineeringLifecycle}
        active={engineeringActive === true}
        disabled={readOnlyMode}
        onselect={onEngineeringLifecycleSelect}
        onclose={() => {
          if (richEditor?.caretBookmark()) focusComposerAtSavedCaret()
          else focusComposerAtStart()
        }}
      />
    {/if}

    <!-- Permission level selector -->
    {#if readOnlyMode}
      <span
        class="flex items-center gap-1 rounded-lg bg-raised px-2 py-1.5 text-[0.6875rem] text-muted"
        title="Temporary chats can inspect context but cannot modify files or run commands"
      >
        <Shield size={12} />
        <span class="composer-control-label">Read only</span>
      </span>
    {:else if !hidePermissionSelector || resolved.fileSystemMode === true}
      <div class="relative">
        <button
          type="button"
          class="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[0.6875rem] transition-colors hover:bg-elevated {resolved.permissionLevel ===
          'full_access'
            ? 'font-bold text-warning'
            : 'text-muted hover:text-foreground'}"
          aria-label={`Permission level: ${permissionLabels[resolved.permissionLevel]}`}
          title={working
            ? 'Permission level for the next turn — the current run is unchanged'
            : 'Permission level — controls how tool-call permissions are handled'}
          onclick={() => {
            permissionMenuOpen = !permissionMenuOpen
            plusMenuOpen = false
            modelMenuOpen = false
            thinkingMenuOpen = false
          }}
        >
          {#if resolved.permissionLevel === 'full_access'}
            <ShieldAlert size={12} strokeWidth={2.75} />
          {:else}
            <Shield size={12} />
          {/if}
          <span class="composer-control-label">{permissionLabels[resolved.permissionLevel]}</span>
        </button>

        {#if permissionMenuOpen}
          <button
            class="fixed inset-0 z-30 cursor-default"
            aria-label="Close menu"
            onclick={closeAllMenus}
          ></button>
          <div
            class="absolute bottom-9 left-0 z-40 w-36 rounded-xl border bg-surface p-1 shadow-lg"
          >
            {#if working}
              <p class="px-2 pb-1 pt-1 text-[0.5625rem] text-dimmed">Applies to the next turn</p>
            {/if}
            {#each Object.entries(permissionLabels) as [level, label] (level)}
              <button
                class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-elevated {resolved.permissionLevel ===
                level
                  ? level === 'full_access'
                    ? 'font-bold text-warning'
                    : 'font-medium text-foreground'
                  : 'text-muted'}"
                title={level === 'full_access'
                  ? 'Full Access — yolo mode, every operation auto-approved'
                  : 'Auto Review — auto-run any permission that is not explicitly denied'}
                onclick={() => selectPermission(level as PermissionLevel)}
              >
                {#if level === 'full_access'}
                  <ShieldAlert size={12} strokeWidth={2.75} class="text-warning" />
                {:else}
                  <ShieldCheck size={12} class="text-info" />
                {/if}
                {label}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <!-- Shared model selector — model + thinking level in one control -->
    <ModelPicker
      {providers}
      {projectId}
      {harnessId}
      providerId={resolved.providerId}
      modelId={resolved.modelId}
      {favoriteModels}
      {recentModels}
      {onRemoveRecent}
      bind:open={modelMenuOpen}
      bind:thinkingMenuOpen
      onSelect={selectModel}
      {onToggleFavorite}
      {onReorderFavorite}
      fast={inferenceMode === 'fast'}
      thinkingLevel={resolved.thinkingLevel}
      {thinkingPresets}
      onSelectThinking={(level) => selectThinking({ id: level, label: level })}
    />

    <!-- Fast inference — native harness tier or catalog-provided fast variant -->
    {#if fastVariant}
      <div class="relative">
        <button
          type="button"
          class="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground {inferenceMode ===
          'fast'
            ? 'text-accent'
            : ''}"
          aria-label={`Inference mode: ${inferenceMode === 'fast' ? 'Fast' : 'Normal'}`}
          title="Inference mode — fast prioritizes speed over cost"
          onclick={toggleInferenceMenu}
        >
          <Zap
            size={13}
            class={inferenceMode === 'fast' ? 'text-accent' : ''}
            fill={inferenceMode === 'fast' ? 'currentColor' : 'none'}
          />
        </button>

        {#if inferenceMenuOpen}
          <button
            class="fixed inset-0 z-30 cursor-default"
            aria-label="Close menu"
            onclick={closeAllMenus}
          ></button>
          <div
            class="absolute bottom-9 left-0 z-40 w-52 overflow-hidden rounded-xl border bg-surface shadow-lg"
          >
            <div class="p-1">
              <button
                class="flex w-full items-center rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-elevated {inferenceMode ===
                'normal'
                  ? 'text-primary'
                  : 'text-foreground'}"
                title="Normal inference — full-cost standard tier"
                onclick={() => selectInference('normal')}
              >
                Normal
              </button>
              <button
                class="flex w-full items-center rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-elevated {inferenceMode ===
                'fast'
                  ? 'text-primary'
                  : 'text-foreground'}"
                title="Fast inference — prioritizes speed over cost"
                onclick={() => selectInference('fast')}
              >
                <span class="flex flex-col">
                  <span>Fast</span>
                  <span class="text-[0.625rem] text-muted">~{fastVariant.multiplier}× usage</span>
                </span>
              </button>
            </div>
          </div>
        {/if}
      </div>
    {/if}

    <!-- API usage credits — native harness command to bill this session's
         turns against pay-as-you-go API credits instead of a subscription. -->
    {#if usageCreditsCommandId}
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
        aria-label="Switch to API usage credits"
        title="Switch this session to pay-as-you-go API usage credits"
        onclick={runUsageCredits}
      >
        <Flame size={13} />
      </button>
    {/if}

    <span class="flex-1"></span>

    {#if !hideUsageIndicator}
      <ContextUsageIndicator
        usage={contextUsage}
        {efficiencyKpis}
        {harnessUsage}
        {canCompact}
        {compacting}
        {onCompact}
        {onActivateBankedReset}
        onReveal={onRevealUsage}
        onHide={onHideUsage}
        refreshing={usageRefreshing}
      />
    {/if}

    <!-- Keep the mic mounted in one stable slot so recording state never resets
         when the composer gains text and the send control appears. -->
    <VoiceInputButton
      targetId={composerEditorId}
      getTarget={composerSpeechTarget}
      scope={speechScope}
      {disabled}
    />

    {#if showSendControl}
      <!-- Send / Queue / Stop button.
           - Agent idle:       ArrowUp (send) — primary, disabled when empty
           - Agent working, user typing:  Clock (queue) — primary, always clickable
           - Agent working, no text:      Square (stop) — danger tint
           - Stop confirmation pending:   "Stop?" danger label -->
      <button
        type="button"
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors {pendingStop
          ? 'bg-danger text-on-danger hover:bg-danger-hover'
          : canStop
            ? 'bg-danger/10 text-danger hover:bg-danger/20'
            : 'bg-primary text-on-primary hover:bg-primary-hover'}"
        aria-label={pendingStop
          ? 'Confirm stop'
          : canStop
            ? 'Stop agent'
            : working
              ? 'Queue message'
              : 'Send message'}
        title={pendingStop
          ? 'Click again to stop'
          : canStop
            ? 'Stop the running agent'
            : working
              ? `Queue — ${sendModifierLabel}Enter · Steer — ${sendModifierLabel}⇧Enter`
              : `Send — ${sendModifierLabel}Enter`}
        disabled={disabled || (!working && !hasSendableContent)}
        onclick={() => submit()}
      >
        {#if pendingStop}
          <span class="pending-stop-label text-[0.5625rem] font-semibold">Stop?</span>
          <span class="pending-stop-icon">
            <Square size={14} />
          </span>
        {:else if canStop}
          <Square size={14} />
        {:else if working}
          <Clock size={15} />
        {:else}
          <ArrowUp size={16} />
        {/if}
      </button>
    {/if}
  </div>
</div>

<StartAfterThreadPicker
  open={startAfterPickerOpen}
  {projectId}
  currentThreadId={threadId}
  selectedIds={startAfterThreads.map((t) => t.id)}
  onSelect={selectStartAfterThread}
  onClose={() => {
    startAfterPickerOpen = false
    if (startAfterThreads.length === 0) startAfterEnabled = false
    focusComposerAtSavedCaret()
  }}
/>

<style>
  .chat-composer {
    container-type: inline-size;
  }

  .pending-stop-icon {
    display: none;
  }

  @container (max-width: 520px) {
    .composer-control-label {
      display: none;
    }

    .composer-toolbar {
      padding-inline: 0.5rem;
    }

    .pending-stop-label {
      display: none;
    }

    .pending-stop-icon {
      display: block;
    }
  }
</style>
