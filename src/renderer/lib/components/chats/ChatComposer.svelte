<script lang="ts">
  import { tick, onDestroy, onMount } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { fade } from 'svelte/transition'
  import { ArrowUp, Clock, Flame, Maximize2, Minimize2, Square } from '@lucide/svelte'
  import { motionDuration } from '$lib/motion'
  import { registerComposerFocusTarget } from '$lib/focus/composer-focus-registry'
  import { threadSettings as threadSettingsStore } from '$lib/stores/thread-settings.svelte'
  import { fastMultiplierFor, supportsFastInference } from '$shared/fast-inference'
  import { DEFAULT_HARNESS } from '$shared/harness-default'
  import { STANDARD_THINKING_PRESETS } from '$shared/thinking-presets'
  import { posixBasename } from '$shared/paths'
  import { showToastWarning } from '$lib/stores/app-errors.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { modelKey } from '$lib/model-keys'
  import { getInlineFileTypeIconSvg, getInlineFolderTypeIconSvg } from '../files/file-type-icons'
  import { visionModels } from '$lib/stores/vision-models.svelte'
  import { fileUrlToPath, mimeFromPath, pathToFileUrl } from '$lib/mime'
  import { placeCaretAtEnd } from '../shared/rich-markdown'
  import AttachmentPreview from './AttachmentPreview.svelte'
  import StartAfterThreadPicker from './StartAfterThreadPicker.svelte'
  import ContextUsageIndicator from './ContextUsageIndicator.svelte'
  import ProjectFileMentionMenu from './ProjectFileMentionMenu.svelte'
  import ChatComposerAttachmentStrip from './ChatComposerAttachmentStrip.svelte'
  import ChatComposerDropZone from './ChatComposerDropZone.svelte'
  import ChatComposerImageGate from './ChatComposerImageGate.svelte'
  import ChatComposerInferencePicker from './ChatComposerInferencePicker.svelte'
  import ChatComposerPermissionPicker from './ChatComposerPermissionPicker.svelte'
  import ChatComposerPlusMenu from './ChatComposerPlusMenu.svelte'
  import { installComposerDropListeners, type ComposerDropRegion } from './chat-composer-drop'
  import { handleComposerKeydown, type ComposerKeydownContext } from './chat-composer-keydown'
  import { handleComposerPaste, type ComposerPasteContext } from './chat-composer-paste'
  import { createComposerSlashActions, isSlashRoutedAction } from './chat-composer-slash.svelte'
  import { createComposerMentionSearch } from './chat-composer-mentions.svelte'
  import { createComposerExpansion } from './chat-composer-expand.svelte'
  import { trackMenuCloseFocus } from './chat-composer-menu-focus.svelte'
  import {
    withFileSystemMode,
    withInferenceMode,
    withModelSelection,
    withPermissionLevel,
    withThinkingLevel
  } from './chat-composer-settings'
  import { createComposerAttachmentPreview } from './chat-composer-preview.svelte'
  import {
    abbreviatedTaskTitle,
    isEditablePastedTextAttachment,
    isImageAttachment,
    partitionNewAttachments,
    projectReferenceToken,
    restoredDraft,
    taskReferenceToken,
    uniqueAttachments,
    type StartAfterSelection
  } from './chat-composer-attachments'
  import {
    normalizeComposerMessage,
    COMPOSER_BUILT_IN_TAGS,
    type ComposerMentionEntry
  } from './composer-mentions'
  import SlashActionMenu from '../actions/SlashActionMenu.svelte'
  import RichMarkdownEditor from '../shared/RichMarkdownEditor.svelte'
  import VoiceInputButton from '../speech/VoiceInputButton.svelte'
  import EngineeringToolbox from './EngineeringToolbox.svelte'
  import { speechController } from '../../speech/speech-controller.svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import { threadNeedsAiAccount } from '$lib/ai-account'
  import { mergeProviderCatalogEntries, providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { filterActions, permissionLevelForAction } from '$lib/actions'
  import { APP_NAME } from '$shared/brand'
  import { getVendorIconSvg } from '$lib/vendor-icons/registry'
  import ComposerShoe, { type ComposerScopeShoe } from './ComposerShoe.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import type { SpeechEditorApplyResult, SpeechEditorTarget } from '../../speech/editor-target'
  import type { ActionDefinition, ActionSelection } from '$lib/actions'
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
    AgentContextUsage,
    AgentHarnessUsage,
    PromptReference,
    AssignmentTask,
    AgentModelSelection,
    AttachmentStorageScope,
    UsageEfficiencyKpis,
    Thread,
    EngineeringLifecycleSelectionInput,
    EngineeringLifecycleState,
    HarnessAccount
  } from '$shared/types'

  const codeInOvenIconSvg = getVendorIconSvg(APP_NAME)

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
    /** True while the agent is running   turns the send button into a stop button. */
    working?: boolean
    /** Called when the user asks to abort the running turn (stop button / double Escape). */
    onStop?: () => void
    placeholder?: string
    autofocus?: boolean
    /** Current thread settings (drives toolbar state). Falls back to last-used. */
    settings?: ThreadSettings
    /** Called when any toolbar setting changes. */
    onSettingsChange?: (settings: ThreadSettings) => void
    /** Reports the selected account so the owning thread can attribute the
     *  pending/live turn without issuing a second account-registry read. */
    onAccountSelected?: (account: HarnessAccount) => void
    /** Thread-scoped actions available through the composer slash menu. */
    actions?: readonly ActionDefinition[]
    /** Executes a non-command action selected from the slash menu. */
    onActionSelect?: (selection: ActionSelection) => void | Promise<void>
    /** Executes an active-harness slash command with explicit arguments. */
    onSlashCommand?: (commandId: string, args: string) => void | Promise<void>
    /** Id of the harness's native "switch to API usage credits" command, when
     *  it exposes one. Present only when the harness driver reports it   this
     *  is what shows the flame icon shortcut in the toolbar. */
    usageCreditsCommandId?: string
    /** Available providers + models from the harness. */
    providers?: ProviderCatalog[]
    /** Id of the agent harness serving the models (shown on each model row). */
    harnessId?: string
    /** Project context row shown before the first message of the thread. */
    /** Active project ID for the project switcher dropdown. */
    projectId?: string | null
    /** Active thread ID used to prevent selecting the current thread as a dependency. */
    threadId?: string
    /** Project or app scratch destination for pasted/ephemeral attachment files. */
    attachmentStorage?: AttachmentStorageScope
    /** Called when the user selects a different project from the switcher. */
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
    /** False on the Chats tab   plain chats never surface the engineer toggle. */
    showEngineeringMode?: boolean
    engineeringLifecycle?: EngineeringLifecycleState | null
    /** Overrides the settings-derived Engineering activity for the toolbox
     *  icon so staged (send-deferred) selections light or dim it live. */
    engineeringActive?: boolean
    onEngineeringLifecycleSelect?: (
      input: EngineeringLifecycleSelectionInput
    ) => void | Promise<void>
    /** True on the Chats tab   surfaces the chat-only Engineering and File System toggles. */
    showChatModes?: boolean
    /** Independent (spec-less) audit: the thread has work and the audit was never initialized. */
    independentAuditAvailable?: boolean
    /** Independent (spec-less) audit is currently enabled for this thread. */
    independentAuditEnabled?: boolean
    /** Called when the user toggles the independent audit switch. */
    onIndependentAuditToggle?: (enabled: boolean) => void | Promise<void>
    /** Engineering toolbox is hidden (Independent Audit staged or enabled
     *  the two controls are mutually exclusive before a send commits either). */
    engineeringToolboxHidden?: boolean
    /** Hides the permission level selector and forces auto review   chats are
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
    /** Called when the user selects a model   for tracking recently used. */
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
    /** Fired when the user first engages arrow-up recall, before reading the
     *  list, so a lazily loaded full history (e.g. the persisted user-message
     *  history behind the history side panel) can fill in for later presses. */
    onHistoryNavigateStart?: () => void
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
    /** Renders the scope shoe   the project scope + project type row at the
     *  footer of the composer. Only set in project mode. */
    scopeShoe?: ComposerScopeShoe
    /** Called instead of sending when the thread has no AI account or no model
     *  selected, so the host can show its setup card and keep the draft. */
    onNeedsAiAccount?: () => void
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
    onAccountSelected,
    actions = [],
    onActionSelect,
    onSlashCommand,
    usageCreditsCommandId,
    providers = [],
    harnessId = DEFAULT_HARNESS,
    projectId = null,
    threadId = '',
    attachmentStorage,
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
    onHistoryNavigateStart,
    imageDescriptorDefault,
    imageDescriptorAskAgain = false,
    onImageDescriptorDefaultChange,
    onImageDescriptorAskAgainChange,
    enableImageDescriptorGate = true,
    scopeShoe,
    onNeedsAiAccount
  }: Props = $props()

  /** Base composer settings   the prop when provided, else the global last-used. */
  const baseSettings = $derived(settings ?? threadSettingsStore.lastUsed)
  /** Resolved settings   chats run with auto permission review until File System
   *  is enabled, so the level stays pinned to `auto_review` while File System is
   *  off and unlocks (selector visible, up to Full Access) once it is turned on. */
  let resolved = $derived<ThreadSettings>(
    hidePermissionSelector && baseSettings.fileSystemMode !== true
      ? { ...baseSettings, permissionLevel: 'auto_review' as const }
      : baseSettings
  )

  // svelte-ignore state_referenced_locally
  let value = $state(restoredDraft(initialValue, initialProjectReferences, initialTaskReferences))
  // The composer is remounted by the parent when a restore is required, so we
  // intentionally capture only the initial attachments passed at creation time.
  // Drafts restored from a session that ran before the duplicate guard can hold
  // the same file twice, which the keyed attachment chips cannot render, so the
  // restored list is collapsed here before it ever reaches the markup.
  // svelte-ignore state_referenced_locally
  let attachments = $state<PromptAttachment[]>(uniqueAttachments(initialAttachments))
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
              ? await getInlineFolderTypeIconSvg(reference.name)
              : await getInlineFileTypeIconSvg(reference.path)
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
    ...COMPOSER_BUILT_IN_TAGS.filter((tag) => value.includes(tag.token)).map((tag) => ({
      iconSvg: codeInOvenIconSvg,
      label: tag.chipLabel,
      title: `${APP_NAME} ${tag.chipLabel}`,
      value: tag.token
    })),
    ...projectReferences.map((reference) => ({
      iconSvg: projectReferenceIcons[projectReferenceToken(reference)],
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
  let isDragging = $state(false)
  /** Root element of the composer, used to find the conversation region it sits in. */
  let composerRoot = $state<HTMLElement | null>(null)
  /** 0x0 out-of-flow element sitting beside the drop overlay. Its viewport
   *  position is the origin the overlay's `position: fixed` resolves against. */
  let dropAnchorProbe = $state<HTMLElement | null>(null)
  const captureComposerRoot: Attachment<HTMLElement> = (element) => {
    composerRoot = element
    // Publish this composer to the app-wide focus registry so the double-tap
    // primary-modifier gesture can return the caret here from anywhere in the
    // app. The composer owns how it takes focus, and refuses it while it is
    // disabled.
    const unregister = registerComposerFocusTarget({
      root: element,
      focus: () => {
        if (disabled) return false
        focusComposerAtSavedCaret()
        return true
      }
    })
    return () => {
      unregister()
      if (composerRoot === element) composerRoot = null
    }
  }
  /** Reports the DropZone's mounted measurement anchor back to this composer so
   *  the overlay resolves its fixed-position origin against it. */
  function handleDropAnchorChange(element: HTMLElement | null): void {
    dropAnchorProbe = element
  }
  /** Maximize control   triples the editor's height and widens the composer to
   *  150% of its column for long-form writing. */
  const expansion = createComposerExpansion({ getComposer: () => composerRoot })

  /** Resize the composer, then hand focus straight back to the caret so the user
   *  keeps typing in the surface they just enlarged. */
  function toggleComposerExpansion(): void {
    expansion.toggle()
    focusComposerAtSavedCaret()
  }
  /** Viewport geometry of the conversation region while files are in flight, so
   *  the overlay covers exactly that region (never the sidebars). */
  let dropRegion = $state<ComposerDropRegion | null>(null)

  /** Hide the drop overlay when the DropZone reports a drop. */
  function clearDropState(): void {
    isDragging = false
    dropRegion = null
  }
  const preview = createComposerAttachmentPreview()
  /** Image-descriptor gate state: intercepts sending an image to a text-only model. */
  let imageDescriptorGateOpen = $state(false)
  let gateVisionSelection = $state<AgentModelSelection | null>(null)
  let gateDonotAsk = $state(false)
  let gateDirect = $state<boolean | undefined>(undefined)
  // svelte-ignore state_referenced_locally
  const composerEditorId = `chat-composer-${projectId ?? 'no-project'}-${threadId ?? 'none'}`
  /** macOS shows ⌘; Windows/Linux show Ctrl   matches the global send shortcut. */
  const sendModifierLabel = navigator.platform.toUpperCase().indexOf('MAC') >= 0 ? '⌘' : 'Ctrl+'
  const mentions = createComposerMentionSearch({
    getAssignmentTasks: () => assignmentTasks,
    getFileTagProjectId: () => fileTagProjectId
  })
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
      // Armed voice dictation dispatches through the composer itself (see
      // `SpeechEditorAutoSend`), so a voice send obeys the same queue/steer
      // rules as the send button.
      autoSend: {
        isLive: () => richEditor?.speechEditorTarget(composerEditorId)?.capture() != null,
        submit: (direct) => submit(direct)
      },
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
  /** Open state of the account dropdown inside the shared model picker. */
  let accountMenuOpen = $state(false)
  /** Whether the shared model picker renders the account picker (more than one
   *  account for the selected provider)   gates the `/account` slash action. */
  let accountPickerVisible = $state(false)
  /** The scope shoe instance, so the `/scope` slash action can open its picker. */
  let scopeShoeComponent: ComposerShoe | undefined = $state(undefined)
  /** The scope picker is live on the shoe (project mode, new thread)   gates
   *  the `/scope` slash action the same way the shoe's badge chevron does. */
  let scopePickerAvailable = $derived(scopeShoe !== undefined && scopeShoe.isNewThread === true)
  let startAfterPickerOpen = $state(false)
  // The composer is remounted by the parent when a restore is required, so
  // capture the persisted dependencies exactly once at construction.
  // svelte-ignore state_referenced_locally
  let startAfterThreads = $state<StartAfterSelection[]>(
    initialStartAfterThreads.map((t) => ({ ...t }))
  )
  // svelte-ignore state_referenced_locally
  let startAfterEnabled = $state(initialStartAfterThreads.length > 0)

  // Selection slot hover popover   a short grace period keeps it open while the
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

  /** Commit a toolbar settings change through the host callback, or fall back to
   *  the global last-used store when this composer owns no thread. */
  function applySettings(updated: ThreadSettings): void {
    if (onSettingsChange) onSettingsChange(updated)
    else threadSettingsStore.commit(updated)
  }

  function selectPermission(level: PermissionLevel): void {
    permissionMenuOpen = false
    applySettings(withPermissionLevel(resolved, level))
  }

  function closeAllMenus(): void {
    plusMenuOpen = false
    modelMenuOpen = false
    inferenceMenuOpen = false
    permissionMenuOpen = false
    thinkingMenuOpen = false
    accountMenuOpen = false
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
    accountMenuOpen = false
  }

  function showThinkingMenu(): void {
    if (!supportsThinking) return
    thinkingMenuOpen = true
    plusMenuOpen = false
    modelMenuOpen = false
    inferenceMenuOpen = false
    accountMenuOpen = false
  }

  function showAccountMenu(): void {
    if (!accountPickerVisible) return
    accountMenuOpen = true
    plusMenuOpen = false
    modelMenuOpen = false
    inferenceMenuOpen = false
    thinkingMenuOpen = false
  }

  function showScopeMenu(): void {
    closeAllMenus()
    scopeShoeComponent?.openScopeMenu()
  }

  function showInferenceMenu(): void {
    if (!supportsFast) return
    inferenceMenuOpen = true
    plusMenuOpen = false
    modelMenuOpen = false
    thinkingMenuOpen = false
    accountMenuOpen = false
  }

  // Focus restoration on close for every menu/overlay that steals focus from
  // the editor: each returns the caret to its last published position rather
  // than the end, so mid-sentence editing stays seamless.
  trackMenuCloseFocus(() => modelMenuOpen, focusComposerAtSavedCaret)
  trackMenuCloseFocus(() => thinkingMenuOpen, focusComposerAtSavedCaret)
  trackMenuCloseFocus(() => accountMenuOpen, focusComposerAtSavedCaret)
  trackMenuCloseFocus(() => permissionMenuOpen, focusComposerAtSavedCaret)
  trackMenuCloseFocus(() => inferenceMenuOpen, focusComposerAtSavedCaret)

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

  /**
   * True when this composer has nothing to run a turn with. Sending such a turn
   * only reaches the driver to fail with an unavailable model, so hosts that
   * pass `onNeedsAiAccount` get to show their setup card instead. Hosts that
   * omit the callback keep the old behaviour.
   */
  let needsAiAccount = $derived(threadNeedsAiAccount(resolved))

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
  const slash = createComposerSlashActions({
    getShowChatModes: () => showChatModes,
    getFileSystemMode: () => resolved.fileSystemMode,
    getSupportsThinking: () => supportsThinking,
    getAccountPickerVisible: () => accountPickerVisible,
    getScopePickerVisible: () => scopePickerAvailable,
    getThinkingPresets: () => thinkingPresets,
    getActions: () => actions
  })
  let slashActions = $derived(filterActions(slash.available, slashQuery))
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

  /** The maximize control is only useful once there is something to expand for,
   *  and it stays while maximized so clearing the text cannot strand the composer
   *  in its expanded size with no way back. */
  let showExpandControl = $derived(hasText || expansion.maximized)

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
   *  the end   used by external surfaces such as suggested prompts that
   *  should seed a draft instead of sending it. */
  export function setComposerText(text: string): void {
    value = text
    handleComposerValueChange(text)
    void tick().then(() => {
      focusComposerAtEnd()
    })
  }

  /** Focus the composer editor and place the caret at the start of the first
   *  line   the fallback when no caret position was ever captured. */
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
   *  last had inside it   published continuously by the rich editor via its
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
      // Thinking level lives in the shared model picker's dropdown   open it directly.
      showThinkingMenu()
      return
    }

    if (action.id === 'selector:account') {
      // The account picker lives in the shared model picker's dropdown   open it directly.
      showAccountMenu()
      return
    }

    if (action.id === 'selector:scope') {
      // The scope picker lives in the shoe under the composer   open it directly.
      showScopeMenu()
      return
    }

    if (action.id === 'mode:file-system') {
      // Same commit path as the plus-menu switch, chat mode only. Selecting the
      // action has already consumed the typed `/query` text.
      toggleFileSystemMode()
      return
    }

    // Chat mode: the slash menu offers the permission levels once File System is
    // on, and the picker chip takes the exact same commit path.
    const permissionLevel = permissionLevelForAction(action)
    if (permissionLevel) {
      selectPermission(permissionLevel)
      return
    }

    if (isSlashRoutedAction(action)) {
      return
    }

    void onActionSelect?.({ action, query: selectedQuery, method })
  }

  function submit(direct?: boolean): void {
    if (mentions.open && mentions.entries[mentions.index]) {
      selectMention(mentions.entries[mentions.index])
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
    // Nothing to send with: let the host show its setup card instead of
    // handing the driver a turn it can only reject. The draft stays intact.
    if (needsAiAccount && onNeedsAiAccount) {
      onNeedsAiAccount()
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
    preview.reset()
    attachments = []
    projectReferences = []
    taskReferences = []
    onAttachmentsChange?.([])
    onProjectReferencesChange?.([])
    onTaskReferencesChange?.([])
    const selectedStartAfterThreads = startAfterEnabled ? startAfterThreads : []
    clearStartAfterThreads()
    onSend(msg, files, direct, taggedPaths, taggedTasks, selectedStartAfterThreads)
    // The draft just left the composer, so the long-form writing surface has
    // nothing left to hold: settle back to the compact composer.
    expansion.collapse()
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
    mentions.schedule(supportsCommands ? textBeforeCaret : '')
    const slashMatch = supportsCommands ? /(^|\s)\/([^\s/]*)$/u.exec(textBeforeCaret) : null
    slashOpen = Boolean(slashMatch)
    slashQuery = slashMatch?.[2] ?? ''
    slashIndex = 0
    // A query that matches no actions is almost certainly a path being typed
    // (e.g. `cd /usr/local/bin`), not a command   close the menu so Enter and
    // the rest of the text behave normally.
    if (slashOpen && slashActions.length === 0) {
      slashOpen = false
    }
  }

  function selectMention(mention: ComposerMentionEntry): void {
    mentions.open = false
    if (mention.type === 'utility') {
      const token = `${mention.entry.token} `
      const inserted = richEditor.replaceTextBeforeCaret(
        /(^|\s)@[^\s@]*$/u,
        (_match, prefix) => `${prefix}${token}`
      )
      if (!inserted) {
        value = value.replace(/(^|\s)@[^\s@]*$/u, (_, prefix: string) => {
          return `${prefix}${token}`
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
    applySettings(withFileSystemMode(resolved))
  }

  function selectModel(
    providerId: string,
    modelId: string,
    nextHarnessId?: string,
    accountId?: string
  ): void {
    modelMenuOpen = false
    const nextHarness = nextHarnessId ?? resolved.harnessId
    onModelUsed?.(modelKey(nextHarness, providerId, modelId))
    applySettings(
      withModelSelection(resolved, resolvedProviders, {
        providerId,
        modelId,
        harnessId: nextHarnessId,
        accountId
      })
    )
  }

  function selectThinking(preset: ThinkingPreset): void {
    const level = preset.id as ThinkingLevel
    // The picker may re-emit the level it already applied during a model
    // change   skip the redundant commit.
    if (resolved.thinkingLevel === level) return
    applySettings(withThinkingLevel(resolved, level))
  }

  function selectInference(mode: InferenceMode): void {
    inferenceMenuOpen = false
    applySettings(withInferenceMode(resolved, mode))
  }

  function runUsageCredits(): void {
    if (!usageCreditsCommandId || !onSlashCommand) return
    void onSlashCommand(usageCreditsCommandId, '')
  }

  onMount(() => {
    void preview.loadAll(attachments)
    // A voice recording started in this thread keeps running while the user
    // navigates away and back, which destroys and remounts this composer. The
    // speech controller still holds the destroyed editor target, so the
    // transcript would silently land in the draft store without appearing in
    // the visible editor. Hand the live editor target back to the controller
    // when one is mid-capture for this composer.
    const liveTarget = composerSpeechTarget()
    if (liveTarget) speechController.reattachTarget(liveTarget)
  })

  /** Explain a drop or paste that only repeated files already attached, instead
   *  of letting it look like the composer silently ignored the gesture. */
  function noticeDuplicateAttachments(duplicates: readonly PromptAttachment[]): void {
    const first = duplicates[0]
    if (!first) return
    const name = (first.filename ?? posixBasename(fileUrlToPath(first.url))) || 'That file'
    showToastWarning(
      duplicates.length === 1
        ? `${name} is already attached.`
        : `${duplicates.length} of those files are already attached.`
    )
  }

  async function addFileAttachments(
    selections: ReadonlyArray<{ path: string; file?: File }>
  ): Promise<void> {
    if (readOnlyMode && !allowAttachments) return
    if (selectedHarnessLacksAttachments) {
      attachmentBlockedNotice = true
      return
    }
    const candidates = selections.map(({ path, file }) => {
      const filename = file?.name ?? (posixBasename(path.split('?')[0]) || 'file')
      const mime = file?.type || mimeFromPath(path)
      return { mime, url: pathToFileUrl(path), filename }
    })
    if (candidates.length === 0) return

    // Dropping the same file twice must leave one chip: a repeated `file://` URL
    // is a duplicate key in the keyed attachment list and throws at render time.
    const { added, duplicates } = partitionNewAttachments(attachments, candidates)
    if (duplicates.length > 0) noticeDuplicateAttachments(duplicates)
    if (added.length === 0) return

    attachments = [...attachments, ...added]
    onAttachmentsChange?.([...attachments])
    await Promise.all(added.map((attachment) => preview.load(attachment)))
  }

  async function addFileAttachment(filePath: string, file?: File): Promise<void> {
    await addFileAttachments([{ path: filePath, file }])
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
    preview.setText(attachment.url, text)
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
    preview.setText(attachment.url, text)
  }

  async function savePreviewText(text: string): Promise<void> {
    const attachment = preview.file
    if (!attachment) throw new Error('The attachment preview is no longer open.')
    await savePastedTextAttachment(attachment, text)
  }

  function removeAttachment(index: number): void {
    const removed = attachments[index]
    if (removed) preview.clear(removed.url)
    attachments = attachments.filter((_, i) => i !== index)
    onAttachmentsChange?.(attachments)
  }

  onDestroy(() => {
    mentions.dispose()
    clearTimeout(selectionPopoverTimer)
    clearTimeout(startAfterPopoverTimer)
    preview.revokeAll()
  })

  async function pickAttachment(): Promise<void> {
    if (readOnlyMode && !allowAttachments) return
    if (selectedHarnessLacksAttachments) {
      attachmentBlockedNotice = true
      return
    }
    const paths = await invoke('dialog:pickFiles', attachmentStorage)
    await addFileAttachments(paths.map((path) => ({ path })))
    focusComposerAtSavedCaret()
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
      } catch {
        // Not a local file (e.g., an image dragged from a web page); skip it.
      }
    }
  }

  // Register the document-level drag listeners once on mount and gate each
  // handler on the current mode flags. The previous $effect re-subscribed on
  // every change of readOnlyMode/allowAttachments; with the handlers gating on
  // those values at event time the behavior is identical while keeping the
  // listener lifecycle (and the isDragging mutations) out of a reactive effect.
  onMount(() =>
    installComposerDropListeners({
      getReadOnlyMode: () => readOnlyMode,
      getAllowAttachments: () => allowAttachments,
      getSelectedHarnessLacksAttachments: () => selectedHarnessLacksAttachments,
      getComposerRoot: () => composerRoot,
      getDropAnchorProbe: () => dropAnchorProbe,
      setDragging: (dragging) => (isDragging = dragging),
      setDropRegion: (region) => (dropRegion = region),
      setAttachmentBlockedNotice: (blocked) => (attachmentBlockedNotice = blocked),
      handleDropFiles
    })
  )

  const pasteContext: ComposerPasteContext = {
    getReadOnlyMode: () => readOnlyMode,
    getAllowAttachments: () => allowAttachments,
    getValue: () => value,
    getAttachmentStorage: () => attachmentStorage,
    getSelectedHarnessLacksAttachments: () => selectedHarnessLacksAttachments,
    addPastedTextAttachment,
    addFileAttachment,
    setTextAttachmentError: (message) => (textAttachmentError = message),
    setAttachmentBlockedNotice: (blocked) => (attachmentBlockedNotice = blocked)
  }

  function handlePaste(e: ClipboardEvent): void {
    void handleComposerPaste(e, pasteContext)
  }

  const keydownContext: ComposerKeydownContext = {
    isMentionOpen: () => mentions.open,
    getMentionEntries: () => mentions.entries,
    getMentionIndex: () => mentions.index,
    setMentionIndex: (index) => (mentions.index = index),
    closeMentions: () => (mentions.open = false),
    selectMention,
    isSlashOpen: () => slashOpen,
    closeSlash: () => (slashOpen = false),
    getSlashActions: () => slashActions,
    getSlashIndex: () => slashIndex,
    setSlashIndex: (index) => (slashIndex = index),
    selectSlashAction,
    isSelectionPopoverOpen: () => selectionPopoverOpen,
    closeSelectionPopover: () => (selectionPopoverOpen = false),
    isStartAfterPopoverOpen: () => startAfterPopoverOpen,
    closeStartAfterPopover,
    getComposerElement: () => document.getElementById(composerEditorId),
    getHistoryIndex: () => historyIndex,
    setHistoryIndex: (index) => (historyIndex = index),
    getSavedValue: () => savedValue,
    setSavedValue: (next) => (savedValue = next),
    getValue: () => value,
    setValue: (next) => (value = next),
    getHistoryMessages: () => historyMessages,
    onHistoryNavigateStart: () => onHistoryNavigateStart?.(),
    onValueChange: (next) => onValueChange?.(next),
    getShowEngineeringMode: () => showEngineeringMode,
    openEngineeringToolbox: () => void engineeringToolbox?.openAndFocus(),
    getWorking: () => working,
    hasStop: () => Boolean(onStop),
    confirmStop,
    isPendingStop: () => pendingStop,
    cancelStop
  }

  function onWindowKeydown(e: KeyboardEvent): void {
    handleComposerKeydown(e, keydownContext)
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if preview.file}
  {@const previewAttachment = preview.file}
  <AttachmentPreview
    attachment={previewAttachment}
    src={preview.urls[previewAttachment.url]}
    text={preview.texts[previewAttachment.url]}
    documentHtml={preview.documents[previewAttachment.url]}
    documentLoading={preview.documentLoading[previewAttachment.url] ?? false}
    onSaveText={isEditablePastedTextAttachment(previewAttachment) ? savePreviewText : undefined}
    onClose={() => {
      preview.close()
      focusComposerAtSavedCaret()
    }}
  />
{/if}

<ChatComposerDropZone
  region={isDragging ? dropRegion : null}
  onAnchorChange={handleDropAnchorChange}
  onDropFiles={handleDropFiles}
  onClearDropState={clearDropState}
/>

<div
  class="chat-composer relative z-10 border bg-surface shadow-sm {expansion.maximized
    ? 'composer-maximized'
    : ''}"
  data-onboarding="composer"
  data-voice-trigger-root
  {@attach captureComposerRoot}
>
  {#if imageDescriptorGateOpen}
    <ChatComposerImageGate
      {providers}
      {projectId}
      harnessId={resolved.harnessId}
      bind:visionSelection={gateVisionSelection}
      bind:donotAsk={gateDonotAsk}
      {favoriteModels}
      {recentModels}
      {onRemoveRecent}
      {onToggleFavorite}
      {onReorderFavorite}
      onCancel={cancelImageDescriptorGate}
      onConfirm={confirmImageDescriptorGate}
    />
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

  <ChatComposerAttachmentStrip
    {attachments}
    {references}
    {startAfterThreads}
    {showChatModes}
    fileSystemMode={resolved.fileSystemMode}
    previewUrls={preview.urls}
    onPreviewAttachment={preview.open}
    onRemoveAttachment={removeAttachment}
    onToggleFileSystemMode={toggleFileSystemMode}
    {startAfterPopoverOpen}
    onOpenStartAfterPopover={openStartAfterPopover}
    onScheduleStartAfterPopoverClose={scheduleStartAfterPopoverClose}
    onCloseStartAfterPopover={closeStartAfterPopover}
    onClearStartAfterThreads={clearStartAfterThreads}
    {onOpenStartAfterThread}
    onRemoveStartAfterThread={removeStartAfterThread}
    {selectionPopoverOpen}
    onOpenSelectionPopover={openSelectionPopover}
    onScheduleSelectionPopoverClose={scheduleSelectionPopoverClose}
    onToggleSelectionPopover={toggleSelectionPopover}
    onCloseSelectionPopover={closeSelectionPopover}
    {onEditReference}
    {onRemoveReference}
    {onRemoveAllReferences}
  />

  <div class="relative">
    {#if slashOpen}
      <SlashActionMenu
        actions={slash.available}
        query={slashQuery}
        activeIndex={slashIndex}
        onSelect={(action) => selectSlashAction(action, 'pointer')}
      />
    {/if}
    {#if mentions.open}
      <ProjectFileMentionMenu
        entries={mentions.entries}
        activeIndex={mentions.index}
        query={mentions.query}
        onSelect={selectMention}
        onFilterChange={() => {
          if (lastCaretText !== null) void mentions.update(lastCaretText)
        }}
      />
    {/if}
    <!-- Maximize   floats at the top right of the typing surface so the control
         is out of the writing line; the editor reserves its corner with `pr-10`.
         It fades in with the first character typed (see `showExpandControl`). -->
    {#if showExpandControl}
      <button
        type="button"
        class="absolute top-2 right-3 z-20 flex h-6 w-6 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        transition:fade={{ duration: motionDuration(140) }}
        aria-label={expansion.maximized ? 'Collapse the composer' : 'Expand the composer'}
        aria-pressed={expansion.maximized}
        title={expansion.maximized
          ? 'Collapse the composer to its normal size'
          : 'Expand the composer for a taller, wider typing area'}
        onclick={toggleComposerExpansion}
      >
        {#if expansion.maximized}
          <Minimize2 size={13} />
        {:else}
          <Maximize2 size={13} />
        {/if}
      </button>
    {/if}

    <RichMarkdownEditor
      bind:this={richEditor}
      id={composerEditorId}
      class="composer-editor w-full overflow-y-auto pt-3 pb-1 pl-3.5 text-sm leading-5 text-foreground outline-none {showExpandControl
        ? 'pr-10'
        : 'pr-3.5'}"
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
    <ChatComposerPlusMenu
      open={plusMenuOpen}
      onToggle={() => {
        plusMenuOpen = !plusMenuOpen
        modelMenuOpen = false
        thinkingMenuOpen = false
      }}
      onClose={() => (plusMenuOpen = false)}
      {showChatModes}
      fileSystemMode={resolved.fileSystemMode}
      onToggleFileSystemMode={toggleFileSystemMode}
      {independentAuditAvailable}
      {independentAuditEnabled}
      {projectId}
      {readOnlyMode}
      onToggleIndependentAudit={(enabled) => void toggleIndependentAudit(enabled)}
      {showEngineeringMode}
      {startAfterEnabled}
      {startAfterThreads}
      onToggleStartAfter={toggleStartAfter}
      onRemoveStartAfterThread={removeStartAfterThread}
      onOpenStartAfterPicker={openStartAfterPicker}
      {allowAttachments}
      {selectedHarnessLacksAttachments}
      onPickAttachment={() => {
        plusMenuOpen = false
        void pickAttachment()
      }}
    />

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

    <ChatComposerPermissionPicker
      {readOnlyMode}
      {hidePermissionSelector}
      fileSystemMode={resolved.fileSystemMode}
      permissionLevel={resolved.permissionLevel}
      {working}
      menuOpen={permissionMenuOpen}
      onToggle={() => {
        permissionMenuOpen = !permissionMenuOpen
        plusMenuOpen = false
        modelMenuOpen = false
        thinkingMenuOpen = false
      }}
      onClose={closeAllMenus}
      onSelect={selectPermission}
    />

    <!-- Shared model selector   model + thinking level in one control -->
    <ModelPicker
      {providers}
      {projectId}
      {harnessId}
      providerId={resolved.providerId}
      modelId={resolved.modelId}
      accountId={resolved.accountId}
      {favoriteModels}
      {recentModels}
      {onRemoveRecent}
      bind:open={modelMenuOpen}
      bind:thinkingMenuOpen
      bind:accountMenuOpen
      onAccountPickerVisibleChange={(visible) => {
        accountPickerVisible = visible
      }}
      onSelect={selectModel}
      onSelectAccount={onAccountSelected}
      {onToggleFavorite}
      {onReorderFavorite}
      fast={inferenceMode === 'fast'}
      thinkingLevel={resolved.thinkingLevel}
      {thinkingPresets}
      onSelectThinking={(level) => selectThinking({ id: level, label: level })}
    />

    {#if fastVariant}
      <ChatComposerInferencePicker
        {inferenceMode}
        fastMultiplier={fastVariant.multiplier}
        menuOpen={inferenceMenuOpen}
        onToggle={toggleInferenceMenu}
        onClose={closeAllMenus}
        onSelect={selectInference}
      />
    {/if}

    <!-- API usage credits   native harness command to bill this session's
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
           - Agent idle:       ArrowUp (send)   primary, disabled when empty
           - Agent working, user typing:  Clock (queue)   primary, always clickable
           - Agent working, no text:      Square (stop)   danger tint
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
              ? `Queue   ${sendModifierLabel}Enter · Steer   ${sendModifierLabel}⇧Enter`
              : `Send   ${sendModifierLabel}Enter`}
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

<!-- Scope shoe   floats underneath the composer as its own inset bar,
     centered at 80% of the composer width; project mode only. It slides up
     behind the composer (z below it) so the shoe's top edge is tucked under
     the composer's bottom border   only the lower half shows, like a shoe.
     No z-index on the wrapper: the composer (z-10) paints over the card, but
     the shoe's dropdown (z-40 inside) still opens above the composer. -->
{#if scopeShoe}
  <div class="composer-shoe relative -mt-4 flex w-full justify-center px-6 pt-3 pb-2">
    <div
      class="composer-shoe-card flex w-[80%] min-w-0 items-center justify-center border bg-surface px-2 pt-2.5 pb-1 shadow-md @container"
    >
      <ComposerShoe
        bind:this={scopeShoeComponent}
        projectId={scopeShoe.projectId}
        threadId={scopeShoe.threadId}
        bucket={scopeShoe.bucket}
        source={scopeShoe.source}
        host={scopeShoe.host}
        project={scopeShoe.project}
        onSwitchProject={scopeShoe.onSwitchProject}
        isNewThread={scopeShoe.isNewThread}
        isWorking={scopeShoe.isWorking}
        onOpenScopeView={scopeShoe.onOpenScopeView}
        onScopeMenuClosed={focusComposerAtSavedCaret}
        report={scopeShoe.report}
      />
    </div>
  </div>
{/if}

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
    /* `width: 100%` is what lets the maximize transition run: an `auto` width
       cannot interpolate to the measured pixel width, so the box would snap
       wider while its margins were still animating. */
    width: 100%;
    transition:
      width 240ms ease,
      margin-inline 240ms ease;
  }

  /* Maximize   the editor is the composer's typing surface, so the control is
     what grows: the collapsed height cap becomes the expanded floor (the box is
     immediately large) and the cap triples. The 60vh clamp keeps a visible
     conversation on short windows. */
  :global(.composer-editor) {
    min-height: 2.5rem;
    max-height: 10rem;
    /* The right padding only grows once the maximize control is on screen, and
       it grows with the same beat as that control's fade. */
    transition:
      min-height 240ms ease,
      max-height 240ms ease,
      padding-right 140ms ease;
  }

  :global(.chat-composer.composer-maximized .composer-editor) {
    min-height: 10rem;
    max-height: min(30rem, 60vh);
  }

  /* Maximize also widens the composer to 150% of its column.
     `--composer-expanded-width` is measured against the hosting conversation
     pane (see chat-composer-expand.svelte.ts) and falls back to the column width
     until that measurement lands; the negative inline margins centre a box that
     is now wider than its own parent. */
  :global(.chat-composer.composer-maximized) {
    width: var(--composer-expanded-width, 100%);
    margin-inline: calc((100% - var(--composer-expanded-width, 100%)) / 2);
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.chat-composer),
    :global(.composer-editor) {
      transition: none;
    }
  }

  .pending-stop-icon {
    display: none;
  }

  /* Control labels ellipsize as the composer tightens   they never wrap to a
     second line. At the narrow tier they drop out entirely so only the icon is
     left behind. The `.composer-control-label` rule for the permission picker
     lives in that component. */
  @container (max-width: 520px) {
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

  /* Shoe stays at 80% width; expands up to 95% as the conversation screen
     shrinks (e.g. a very wide right sidebar), so its content keeps fitting. */
  @container (max-width: 640px) {
    .composer-shoe-card {
      width: 95%;
    }
  }
</style>
