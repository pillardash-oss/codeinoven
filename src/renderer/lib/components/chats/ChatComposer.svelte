<script lang="ts">
  import { isMacPlatform } from '$lib/shortcut-display'
  import CioArrowUp from '@pdslng/cio-icon/CioArrowUp.svelte'
  import CioClock from '@pdslng/cio-icon/CioClock.svelte'
  import CioCompactSend from '@pdslng/cio-icon/CioCompactSend.svelte'
  import CioFlame from '@pdslng/cio-icon/CioFlame.svelte'
  import CioMaximize from '@pdslng/cio-icon/CioMaximize.svelte'
  import CioMinimize from '@pdslng/cio-icon/CioMinimize.svelte'
  import CioStop from '@pdslng/cio-icon/CioStop.svelte'
  import { ICON_SIZE } from '$lib/components/icons/cio/scale'
  import { trackEscapeMenu } from '$lib/overlay-close.svelte'
  import { flushSync, tick, onDestroy, onMount } from 'svelte'
  import { toast } from 'svelte-sonner'
  import type { Attachment } from 'svelte/attachments'
  import { scale } from 'svelte/transition'

  import { motionDuration } from '$lib/motion'
  import { registerComposerFocusTarget } from '$lib/focus/composer-focus-registry'
  import { threadSettings as threadSettingsStore } from '$lib/stores/thread-settings.svelte'
  import { DEFAULT_HARNESS } from '$shared/harness-default'
  import { STANDARD_THINKING_PRESETS } from '$shared/thinking-presets'
  import { posixBasename } from '$shared/paths'
  import { showToastWarning } from '$lib/stores/app-errors.svelte'
  import { ipcErrorMessage } from '$lib/ipc-errors'
  import { invoke } from '$lib/ipc.svelte'
  import { hasModelRuntimeSettings } from '$shared/model-runtime-settings'
  import { applyModelProfile } from '$shared/model-profiles'
  import { modelKey } from '$lib/model-keys'
  import { getInlineFileTypeIconSvg, getInlineFolderTypeIconSvg } from '../files/file-type-icons'
  import { visionModels } from '$lib/stores/vision-models.svelte'
  import { fileUrlToPath, mimeFromPath, pathToFileUrl, attachmentPreviewKind } from '$lib/mime'
  import { placeCaretAtEnd } from '../shared/rich-markdown'
  import AttachmentPreview from './AttachmentPreview.svelte'
  import type { PreviewPagerState } from '../ui/PreviewPager.svelte'
  import StartAfterThreadPicker from './StartAfterThreadPicker.svelte'
  import ProjectFileMentionMenu from './ProjectFileMentionMenu.svelte'
  import ChatComposerAttachmentStrip from './ChatComposerAttachmentStrip.svelte'
  import ChatComposerDropZone from './ChatComposerDropZone.svelte'
  import ChatComposerImageGate from './ChatComposerImageGate.svelte'
  import ExpertCard from './ExpertCard.svelte'
  import ChatComposerPermissionPicker from './ChatComposerPermissionPicker.svelte'
  import ChatComposerPlusMenu from './ChatComposerPlusMenu.svelte'
  import type { ComposerRelocationRequest } from './composer-relocation'
  import { installComposerDropListeners, type ComposerDropRegion } from './chat-composer-drop'
  import { readComposerDrop } from './chat-composer-drop-source'
  import { handleComposerKeydown, type ComposerKeydownContext } from './chat-composer-keydown'
  import { handleComposerPaste, type ComposerPasteContext } from './chat-composer-paste'
  import {
    createComposerSlashActions,
    isSlashRoutedAction,
    composerReadingSurface,
    type ComposerReadingSurface
  } from './chat-composer-slash.svelte'
  import { createComposerMentionSearch } from './chat-composer-mentions.svelte'
  import { createComposerExpansion } from './chat-composer-expand.svelte'
  import { trackMenuCloseFocus } from './chat-composer-menu-focus.svelte'
  import {
    withFileSystemMode,
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
    composerAssistantTagToken,
    composerMentionStart,
    type ComposerAssistantTag,
    type ComposerMentionEntry
  } from './composer-mentions'
  import SlashActionMenu from '../actions/SlashActionMenu.svelte'
  import RichMarkdownEditor from '../shared/RichMarkdownEditor.svelte'
  import CardNotice from '../shared/CardNotice.svelte'
  import VoiceInputButton from '../speech/VoiceInputButton.svelte'
  import EngineeringToolbox from './EngineeringToolbox.svelte'
  import { speechController } from '../../speech/speech-controller.svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import { threadNeedsAiAccount } from '$lib/ai-account'
  import { mergeProviderCatalogEntries, providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { ovens } from '$lib/stores/ovens.svelte'
  import { filterActions, permissionLevelForAction } from '$lib/actions'
  import { APP_NAME } from '$shared/brand'
  import { getVendorIconSvg } from '$lib/vendor-icons/registry'
  import ComposerShoe, { type ComposerShoeData, type ComposerUsage } from './ComposerShoe.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { sessionTagKind } from '$shared/session-tags'
  import { expertSessionFor, shouldOfferExpertCard, type ExpertSummary } from '$shared/experts'
  import { mediaProviderLabel } from '$shared/media-generation'
  import { appConfigState } from '$lib/stores/app-config.svelte'
  import type { ExpertDecisionInput, ThreadExpertState } from '$shared/ipc-contract'
  import type { SpeechEditorApplyResult, SpeechEditorTarget } from '../../speech/editor-target'
  import type { ActionDefinition, ActionSelection } from '$lib/actions'
  import type { RichInlineBadge } from '../shared/rich-markdown'
  import type {
    ThreadSettings,
    ThinkingLevel,
    ThinkingPreset,
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
    ModelProfile,
    UsageEfficiencyKpis,
    Thread,
    EngineeringLifecycleSelectionInput,
    EngineeringLifecycleState,
    HarnessAccount
  } from '$shared/types'
  import { MAX_PROMPT_ATTACHMENTS } from '$shared/types'

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
    /**
     * Assistants and assistant threads this composer may tag. Assistant View
     * supplies them; every other composer leaves the list empty, so the @ menu
     * only offers them where the Assistant tab is open.
     */
    assistantTags?: readonly ComposerAssistantTag[]
    /**
     * Opens the assistant thread a tag names. A tag in the draft is a link to
     * that thread, so clicking its badge opens it.
     */
    onOpenAssistantTag?: (tag: ComposerAssistantTag) => void
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
    /**
     * Carry a composer attachment, doc comment or inspector comment to another
     * chat of the same project. Absent on a surface that has no project to move
     * into: chats, assistant tasks, browser conversations and read-only views.
     */
    onRelocateItem?: ComposerRelocationRequest
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
    generationRate?: number | null
    generationDetails?: import('$lib/generation-details').GenerationDetails
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
    /** Renders the composer shoe   the one bar the composer owns, under the
     *  message box: scope, identity, Oven, branch and the key tips. Every
     *  composer sets it, so no surface is left without its properties. */
    shoe?: ComposerShoeData
    /** Called instead of sending when the thread has no AI account or no model
     *  selected, so the host can show its setup card and keep the draft. */
    onNeedsAiAccount?: () => void
    /** True when a stack (the task list, a queued message) sits on the
     *  composer's top edge: the composer's top rule then breaks into the dashed
     *  line that carries the join, and the stack drops its own bottom rule. */
    stackedAbove?: boolean
  }

  let {
    onSend,
    disabled = false,
    working = false,
    stackedAbove = false,
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
    assistantTags = [],
    onOpenAssistantTag,
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
    onRelocateItem,
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
    generationRate,
    generationDetails,
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
    shoe,
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

  /** The remote Oven this composer targets, or null on this computer. */
  let targetOvenId = $derived(resolved.ovenId ?? null)

  /**
   * Harnesses the target Oven does not have installed.
   *
   * Main keeps a persisted copy of every Oven's harness inventory, refreshed on
   * each probe, so a harness the user installed on the Oven themselves is in
   * this set only after it is actually absent. Null while unknown or local, and
   * the picker then behaves exactly as it does for a local thread.
   */
  let unavailableHarnessIds = $derived.by((): ReadonlySet<string> | null => {
    const ovenId = targetOvenId
    if (!ovenId || ovenId === 'local') return null
    return ovens.unavailableHarnesses(ovenId)
  })

  let unavailableHarnessReason = $derived.by((): string | null => {
    const ovenId = targetOvenId
    if (!ovenId || ovenId === 'local') return null
    const identity = ovens.identity(ovenId)
    return identity ? `Not installed on ${identity.name}` : 'Not installed on this Oven'
  })

  /**
   * True when the selected model's harness is not installed on the target Oven.
   *
   * The picker omits those harnesses, so the selection has to be treated as
   * empty: the composer shows no model and holds the turn until the user picks
   * one that exists on the Oven. Sending anyway is what dispatched a run the
   * Oven could not start.
   */
  let ovenModelUnavailable = $derived(unavailableHarnessIds?.has(resolved.harnessId) === true)

  /** Why the send is held, shown above the composer while it is. */
  let ovenModelNotice = $derived(
    ovenModelUnavailable
      ? `${unavailableHarnessReason ?? 'That model is not installed on this Oven'}. Choose a model that is available there to send this turn.`
      : ''
  )

  $effect(() => {
    const ovenId = targetOvenId
    if (!ovenId || ovenId === 'local') return
    void ovens.ensure()
    void ovens.ensureInventory(ovenId)
  })

  // svelte-ignore state_referenced_locally
  let value = $state(restoredDraft(initialValue, initialProjectReferences, initialTaskReferences))
  // The composer is remounted by the parent when a restore is required, so we
  // intentionally capture only the initial attachments passed at creation time.
  // Drafts restored from a session that ran before the duplicate guard can hold
  // the same file twice, which the keyed attachment chips cannot render, so the
  // restored list is collapsed here before it ever reaches the markup.
  // svelte-ignore state_referenced_locally
  let attachments = $state<PromptAttachment[]>(
    // A restored draft or a hand-off can carry more than a message takes, so the
    // composer is bounded on the way in too.
    uniqueAttachments(initialAttachments).slice(0, MAX_PROMPT_ATTACHMENTS)
  )
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
      title: `${tag.token} · ${tag.description}`,
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
    })),
    // A tagged assistant or thread reads as its mark plus its name, never as the
    // id the token carries: the id is what the agent needs, not what the writer
    // should have to look at.
    ...assistantTags
      .filter((tag) => value.includes(composerAssistantTagToken(tag)))
      .map((tag) => ({
        iconSvg: tag.iconHtml,
        accentColor: tag.color,
        label: abbreviatedTaskTitle(tag.name),
        title: `Open ${tag.detail}: ${tag.name}`,
        value: composerAssistantTagToken(tag)
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

  /** Attachments the fullscreen preview can render, in strip order. The pager
   *  walks this list, so an attachment with no preview is skipped instead of
   *  opening as an empty frame. */
  const previewableAttachments = $derived(
    attachments.filter((file) => attachmentPreviewKind(file.mime, file.filename ?? '') !== null)
  )

  /** Sibling navigation for the open fullscreen preview, absent when the
   *  composer holds fewer than two previewable attachments. */
  const previewPager = $derived.by<PreviewPagerState | undefined>(() => {
    const open = preview.file
    if (!open) return undefined
    const list = previewableAttachments
    const index = list.findIndex((file) => file.url === open.url)
    if (index === -1 || list.length < 2) return undefined
    return {
      index,
      count: list.length,
      onPrevious: () => {
        const target = list[index - 1]
        if (target) preview.open(target)
      },
      onNext: () => {
        const target = list[index + 1]
        if (target) preview.open(target)
      }
    }
  })
  /** Image-descriptor gate state: intercepts sending an image to a text-only model. */
  let imageDescriptorGateOpen = $state(false)
  let gateVisionSelection = $state<AgentModelSelection | null>(null)
  let gateDonotAsk = $state(false)
  let gateDirect = $state<boolean | undefined>(undefined)
  /**
   * Expert gate state: a design or video session the user has not answered for
   * is held once, before the message goes, so the card can ask.
   */
  let expertGateOpen = $state(false)
  let expertGateState = $state<ThreadExpertState | null>(null)
  let expertGateSession = $state<'design' | 'video'>('design')
  let expertGateDirect = $state<boolean | undefined>(undefined)
  let expertWarming = $state(false)
  // svelte-ignore state_referenced_locally
  const composerEditorId = `chat-composer-${projectId ?? 'no-project'}-${threadId ?? 'none'}`
  /** macOS shows ⌘; Windows/Linux show Ctrl   matches the global send shortcut. */
  const sendModifierLabel = isMacPlatform() ? '⌘' : 'Ctrl+'
  const mentions = createComposerMentionSearch({
    getAssignmentTasks: () => assignmentTasks,
    getFileTagProjectId: () => fileTagProjectId,
    getAssistantTags: () => assistantTags
  })
  /**
   * The `@` the user dismissed with Escape. While the caret stays inside that
   * one token the menu stays shut, so a dismissed suggestion list cannot pop
   * back on the next keystroke; another `@`, or leaving the token, clears it and
   * suggestions resume.
   */
  let dismissedMentionStart: number | null = null
  let slashOpen = $state(false)
  let slashQuery = $state('')
  let slashIndex = $state(0)
  /** Guards the async resolve against a second send landing inside its window. */
  let resolvingSend = false
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
  // Opening the picker re-probes the Oven's harnesses, so a harness installed on
  // the Oven since the last check shows up without leaving the thread.
  $effect(() => {
    if (!modelMenuOpen) return
    const ovenId = targetOvenId
    if (!ovenId || ovenId === 'local') return
    void ovens.ensureInventory(ovenId, true)
  })
  let inferenceMenuOpen = $state(false)
  let permissionMenuOpen = $state(false)
  /** Open state of the thinking-level dropdown inside the shared model picker. */
  let thinkingMenuOpen = $state(false)
  /** Open state of the account dropdown inside the shared model picker. */
  let accountMenuOpen = $state(false)
  /** Whether the shared model picker renders the account picker (more than one
   *  account for the selected provider)   gates the `/account` slash action. */
  let accountPickerVisible = $state(false)
  /** The shoe instance, so the `/scope` slash action can open its picker. */
  let shoeComponent: ComposerShoe | undefined = $state(undefined)
  /**
   * The context reading the shoe carries. It is the composer's own data, so it
   * stays out of the shoe contract the host builds. It is always present: the
   * battery is how the user checks what a model choice will cost before sending
   * the first message of a thread, and hovering it is what fetches live quota.
   */
  /** The shared model picker, so the `/profile` action can open its profiles panel. */
  let modelPicker: ModelPicker | undefined = $state(undefined)
  /** The scope picker is live on the shoe (project mode, new thread)   gates
   *  the `/scope` slash action the same way the shoe's badge chevron does. */
  let scopePickerAvailable = $derived(shoe?.scope?.isNewThread === true)
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
  /**
   * Whether a reference row's relocation menu is up.
   *
   * The menu is portaled outside the popover, so the pointer crosses out of the
   * popover to reach it. Plain book-keeping: it is only read while deciding
   * whether a hover-out may close the list, never rendered.
   */
  let referenceMenuOpen = false
  let startAfterPopoverOpen = $state(false)
  let startAfterPopoverTimer: ReturnType<typeof setTimeout> | undefined

  function openSelectionPopover(): void {
    clearTimeout(selectionPopoverTimer)
    selectionPopoverOpen = true
  }

  function scheduleSelectionPopoverClose(): void {
    clearTimeout(selectionPopoverTimer)
    // A menu opened from a row outranks the pointer leaving: the list it was
    // opened from must still be there when the user comes back to it.
    if (referenceMenuOpen) return
    selectionPopoverTimer = setTimeout(() => {
      selectionPopoverOpen = false
    }, 220)
  }

  function handleReferenceMenuOpenChange(open: boolean): void {
    referenceMenuOpen = open
    if (!open) scheduleSelectionPopoverClose()
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

  function showModelSettingsMenu(): void {
    if (!modelSettingsVisible) return
    closeAllMenus()
    inferenceMenuOpen = true
  }

  /**
   * Open the model picker on its profiles panel, for the `/profile` action.
   *
   * The picker owns that surface, so the ask is one call: it opens its popover and
   * hands the panel to the arrow keys once the panel has mounted.
   */
  function showProfilesMenu(): void {
    if (readOnlyMode) return
    closeAllMenus()
    modelPicker?.openProfiles()
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
    shoeComponent?.openScopeMenu()
  }

  /** Opens one of the shoe's readings: the context battery (`/status`) or the
   *  generation rate (`/tps`). Neither takes arguments, so both run the moment
   *  they are picked from the menu or typed and submitted, exactly like `/scope`. */
  function showReading(surface: ComposerReadingSurface): void {
    // A thread that has measured nothing yet has no rate to open, and a panel
    // that said only "measuring" would read as a command that did nothing.
    if (surface === 'rate' && !working && generationRate == null) {
      toast.info('No generation speed measured yet', {
        description: 'Send a message and the tokens-per-second reading is measured as it streams.'
      })
      return
    }
    shoeComponent?.openReading(surface)
  }

  trackEscapeMenu(
    () => plusMenuOpen,
    () => {
      plusMenuOpen = false
    }
  )
  trackEscapeMenu(
    () => modelMenuOpen,
    () => {
      modelMenuOpen = false
    }
  )
  trackEscapeMenu(
    () => inferenceMenuOpen,
    () => {
      inferenceMenuOpen = false
    }
  )
  trackEscapeMenu(
    () => permissionMenuOpen,
    () => {
      permissionMenuOpen = false
    }
  )
  trackEscapeMenu(
    () => thinkingMenuOpen,
    () => {
      thinkingMenuOpen = false
    }
  )
  trackEscapeMenu(
    () => accountMenuOpen,
    () => {
      accountMenuOpen = false
    }
  )
  trackEscapeMenu(
    () => startAfterPickerOpen,
    () => {
      startAfterPickerOpen = false
    }
  )
  trackEscapeMenu(() => selectionPopoverOpen, closeSelectionPopover)
  trackEscapeMenu(() => startAfterPopoverOpen, closeStartAfterPopover)

  // Focus restoration on close for every menu/overlay that steals focus from
  // the editor: each returns the caret to its last published position rather
  // than the end, so mid-sentence editing stays seamless.
  trackMenuCloseFocus(() => modelMenuOpen, focusComposerAtSavedCaret)
  trackMenuCloseFocus(() => thinkingMenuOpen, focusComposerAtSavedCaret)
  trackMenuCloseFocus(() => accountMenuOpen, focusComposerAtSavedCaret)
  trackMenuCloseFocus(() => permissionMenuOpen, focusComposerAtSavedCaret)
  trackMenuCloseFocus(() => inferenceMenuOpen, focusComposerAtSavedCaret)

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
  let usageReading = $derived<ComposerUsage>({
    usage: contextUsage,
    previewContextWindow:
      resolved.contextWindow !== undefined &&
      selectedModel?.contextWindows?.includes(resolved.contextWindow)
        ? resolved.contextWindow
        : selectedModel?.contextWindow,
    generationRate,
    generationDetails,
    efficiencyKpis,
    harnessUsage,
    canCompact,
    compacting,
    onCompact,
    onActivateBankedReset,
    onReveal: onRevealUsage,
    onHide: onHideUsage,
    refreshing: usageRefreshing
  })

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
   * Read the thread's experts and its recorded answer.
   *
   * Null on any failure: the card is an offer, and a read that fails must let the
   * message go rather than hold it. The read happens on a user send, not in a
   * render loop, so it costs one indexed lookup and one small config read.
   */
  async function readExpertState(): Promise<ThreadExpertState | null> {
    if (!projectId || !threadId) return null
    try {
      return await invoke('experts:state', projectId, threadId)
    } catch {
      return null
    }
  }

  /**
   * Hold this send for the expert card, or let it go.
   *
   * The card has one question, scoped to a session: may this design or video
   * session hand its craft work to the models the user staffed. It is asked on
   * the send that opens a session and on later sends until the thread answers,
   * and it comes back only when the expert list itself changed. Everything else
   * sends straight through.
   */
  async function offerExpertCardOrSend(msg: string, direct?: boolean): Promise<void> {
    const state = await readExpertState()
    const session = expertSessionFor(sessionTagKind(msg), state?.session ?? null)
    if (
      !state ||
      !shouldOfferExpertCard({
        session,
        expertCount: state.experts.length,
        decision: state.decision,
        signature: state.signature
      })
    ) {
      performSend(direct)
      return
    }
    expertGateState = state
    expertGateSession = session === 'video' ? 'video' : 'design'
    expertGateDirect = direct
    expertGateOpen = true
    void warmSession()
  }

  /**
   * Start the harness while the card is on screen.
   *
   * The send is held for as long as the user reads the card, so the spawn they
   * would otherwise wait for happens behind it. Fire and forget: a warm-up that
   * fails changes nothing about the send that follows.
   */
  async function warmSession(): Promise<void> {
    if (!projectId || !threadId) return
    expertWarming = true
    try {
      await invoke('agent:warmSession', projectId, threadId)
    } catch {
      // A warm-up is an optimization; its failure must not surface.
    } finally {
      expertWarming = false
    }
  }

  /** Record the card's answer, then send the message it was holding. */
  async function decideExperts(choice: 'all' | 'off', silent: boolean): Promise<void> {
    const direct = expertGateDirect
    expertGateOpen = false
    const input: ExpertDecisionInput = { choice, silent }
    if (projectId && threadId) {
      try {
        expertGateState = await invoke('experts:decide', projectId, threadId, input)
      } catch {
        // The decision is remembered for the next send; it must not block this one.
      }
    }
    focusComposerAtSavedCaret()
    performSend(direct)
  }

  /**
   * The provider and model an expert runs on, named from the composer's own
   * catalog so a row reads as one of the models the user can see, not as an id.
   */
  function expertModelLabel(expert: ExpertSummary): string {
    // A media craft names a generation model rather than a harness model, and
    // there is no catalog to resolve that against, so the provider's own name is
    // the whole label.
    if (expert.mediaModel) {
      const providerId = appConfigState.mediaGeneration?.providerId
      return `${providerId ? mediaProviderLabel(providerId) : 'Generation'} ${expert.mediaModel}`
    }
    const selection = expert.selection
    if (!selection) return expert.label
    const provider = resolvedProviders.find(
      (candidate) =>
        candidate.harnessId === selection.harnessId && candidate.id === selection.providerId
    )
    const model = provider?.models.find((candidate) => candidate.id === selection.modelId)
    return `${provider?.name ?? selection.providerId} ${model?.name ?? selection.modelId}`
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

  let modelSettingsVisible = $derived(
    hasModelRuntimeSettings(
      resolvedProviders
        .find(
          (provider) =>
            provider.harnessId === resolved.harnessId && provider.id === resolved.providerId
        )
        ?.models.find((model) => model.id === resolved.modelId),
      resolved.harnessId,
      resolved.providerId
    )
  )

  const slash = createComposerSlashActions({
    getModelSettingsVisible: () => modelSettingsVisible,
    getProfilesPickerVisible: () => !readOnlyMode,
    getShowChatModes: () => showChatModes,
    getFileSystemMode: () => resolved.fileSystemMode,
    getSupportsThinking: () => supportsThinking,
    getAccountPickerVisible: () => accountPickerVisible,
    getScopePickerVisible: () => scopePickerAvailable,
    getOvenPickerVisible: () => !!shoe?.onOpenOven,
    getReadingsVisible: () => !!shoe,
    getThinkingPresets: () => thinkingPresets,
    getActions: () => actions
  })
  let slashActions = $derived(filterActions(slash.available, slashQuery))
  let pendingStop = $state(false)
  let pendingStopTimer: ReturnType<typeof setTimeout> | undefined
  let historyIndex = $state(-1)
  let savedValue = $state('')
  let hasText = $derived(value.trim().length > 0)

  /** True when an attached reference is a payload in its own right, so an
   *  otherwise empty message can still be sent: a commented selection is the
   *  comment, and a mark drawn on a picture is the mark. */
  let hasCommentReference = $derived(
    references.some((reference) => Boolean(reference.comment) || reference.kind === 'image')
  )

  /** Whether there is anything to send: text, an attachment, or a payload reference. */
  let hasSendableContent = $derived(hasText || attachments.length > 0 || hasCommentReference)

  /** Whether the button should show the stop icon (agent working, nothing to send). */
  let canStop = $derived(working && !hasSendableContent)

  /** The mic stays mounted; only the send/stop control follows composer state. */
  let showSendControl = $derived(!disabled && (working || hasSendableContent))

  /** Which glyph the send control carries. The three stay mounted in one box and
   *  crossfade, so sending reads as the arrow morphing into the stop square
   *  rather than as one icon being swapped for another. */
  let sendControlGlyph = $derived<'stop' | 'queue' | 'send'>(
    canStop ? 'stop' : working ? 'queue' : 'send'
  )
  let compactBeforeSend = $derived(
    !working &&
      contextUsage?.contextUsed !== undefined &&
      usageReading.previewContextWindow !== undefined &&
      contextUsage.contextUsed >= Math.round(usageReading.previewContextWindow * 0.8)
  )

  let hasThirdEditorLine = $state(false)

  /** Observe rendered height so wrapped lines and explicit newlines both count. */
  function observeEditorLines(surface: HTMLDivElement): () => void {
    const editor = surface.querySelector<HTMLElement>('[role="textbox"]')
    if (!editor) return () => {}
    const observer = new ResizeObserver(() => {
      const style = getComputedStyle(editor)
      const contentHeight =
        editor.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
      hasThirdEditorLine = contentHeight > parseFloat(style.lineHeight) * 2 + 1
    })
    observer.observe(editor)
    return () => observer.disconnect()
  }

  /** Keep collapse available even after the expanded editor is cleared. */
  let showExpandControl = $derived(hasThirdEditorLine || expansion.maximized)

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

    const reading = composerReadingSurface(action.id)
    if (reading) {
      showReading(reading)
      return
    }

    if (action.id === 'selector:models') {
      showModelMenu()
      return
    }

    if (action.id === 'selector:model-setting') {
      showModelSettingsMenu()
      return
    }

    if (action.id === 'selector:profiles') {
      showProfilesMenu()
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

    if (action.id === 'selector:oven') {
      shoe?.onOpenOven?.()
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

  async function submit(direct?: boolean): Promise<void> {
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
    // A tag typed but never picked still targets what it names. Resolve it
    // before anything reads the draft, so the expert gate sees a session tag
    // and the dispatched turn carries the tagged reference.
    if (resolvingSend) return
    resolvingSend = true
    try {
      await resolveTypedTargetsIntoDraft()
    } finally {
      resolvingSend = false
    }
    const msg = normalizeComposerMessage(value, projectReferences)
    if (!msg && attachments.length === 0 && !hasCommentReference) return
    historyIndex = -1
    savedValue = ''
    const slashCommand = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(msg)
    if (slashCommand) {
      const name = slashCommand[1]
      // The composer's own readings take no arguments, so a typed one runs here
      // instead of leaving as a prompt the agent has to read.
      const readingAction = slash.available.find(
        (candidate) =>
          candidate.title === `/${name}` && composerReadingSurface(candidate.id) !== undefined
      )
      const reading = readingAction ? composerReadingSurface(readingAction.id) : undefined
      if (reading) {
        value = ''
        slashOpen = false
        onValueChange?.('')
        showReading(reading)
        return
      }
      const action = onSlashCommand
        ? actions.find(
            (candidate) => isSlashRoutedAction(candidate) && candidate.title === `/${name}`
          )
        : undefined
      if (action) {
        if (action.disabledReason) return
        value = ''
        slashOpen = false
        onValueChange?.('')
        void onSlashCommand?.(action.id, slashCommand[2]?.trim() ?? '')
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
    // A design or video session holds its send once, so the expert card can ask.
    // Reading the answer is one call on the user's own action, and the common
    // case (a thread that already answered, or a plain message) sends through.
    if (projectId && threadId) {
      void offerExpertCardOrSend(msg, direct)
      return
    }
    performSend(direct)
  }

  function performSend(direct?: boolean): void {
    // The chosen model's harness is not on the Oven, so this turn cannot run.
    // Hold the draft instead of dispatching a run the Oven would fail.
    if (ovenModelUnavailable) return
    if (selectedHarnessLacksAttachments && attachments.length > 0) {
      attachmentBlockedNotice = true
      return
    }
    const msg = normalizeComposerMessage(value, projectReferences)
    speechController.observeSent(composerEditorId, msg)
    value = ''
    onValueChange?.('')
    // The words the user just sent live in the editor's own DOM, and the editor
    // empties that DOM from its value sync, which Svelte otherwise runs a
    // microtask later. Flush it here, at the instant the draft is handed away, so
    // nothing the browser already has in flight   an input event from a
    // composition or a repeat, a re-render that reads the editor back   can
    // serialize the old words out of the DOM and refill the composer with the
    // message the agent is already answering.
    flushSync()
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
    const mentionStart = supportsCommands ? composerMentionStart(textBeforeCaret) : null
    if (mentionStart === null || mentionStart !== dismissedMentionStart) {
      dismissedMentionStart = null
    }
    if (dismissedMentionStart === null) {
      mentions.schedule(supportsCommands ? textBeforeCaret : '')
    } else {
      mentions.open = false
    }
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

  /**
   * Rewrite the `@` tags a send was typed with but never picked from the
   * dropdown. The mention search owns the matching; the composer only applies
   * the resolved text and the references it returns, so a send targets the same
   * file or built-in tag a dropdown pick would have produced.
   */
  async function resolveTypedTargetsIntoDraft(): Promise<void> {
    const draft = value
    const resolved = await mentions.resolveTypedTargets(draft, projectReferences)
    // A keystroke that landed during the lookup owns a newer draft than the one
    // resolved against; never overwrite what the user has since typed.
    if (value !== draft) return
    if (resolved.text !== value) {
      value = resolved.text
      onValueChange?.(value)
    }
    if (resolved.references.length > 0) {
      projectReferences = [...projectReferences, ...resolved.references]
      onProjectReferencesChange?.(projectReferences)
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
    if (mention.type === 'assistant') {
      const token = `${composerAssistantTagToken(mention.entry)} `
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

  /**
   * Run a saved profile, closing the picker it was picked from.
   *
   * The composer is the one caller that hands the picker an applier, because it
   * holds settings a profile writes that the picker cannot see: a chat only unlocks
   * Full Access once File System is on, so a profile carrying `full_access` must not
   * be able to grant it any other way.
   */
  function applyProfile(profile: ModelProfile): void {
    closeAllMenus()
    onModelUsed?.(modelKey(profile.harnessId, profile.providerId, profile.modelId))
    const applied = applyModelProfile(resolved, profile, resolvedProviders)
    applySettings(
      hidePermissionSelector && resolved.fileSystemMode !== true
        ? { ...applied, permissionLevel: 'auto_review' }
        : applied
    )
  }

  function selectThinking(preset: ThinkingPreset): void {
    const level = preset.id as ThinkingLevel
    // The picker may re-emit the level it already applied during a model
    // change   skip the redundant commit.
    if (resolved.thinkingLevel === level) return
    applySettings(withThinkingLevel(resolved, level))
  }

  function runUsageCredits(): void {
    if (!usageCreditsCommandId || !onSlashCommand) return
    void onSlashCommand(usageCreditsCommandId, '')
  }

  onMount(() => {
    void preview.loadAll(attachments)
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

  /** Say what did not fit, so a drop past the file ceiling is never a silence. */
  function noticeOverflowAttachments(overflow: readonly PromptAttachment[]): void {
    if (overflow.length === 0) return
    showToastWarning(
      overflow.length === 1
        ? `${overflow[0]?.filename ?? 'That file'} was not attached: a message carries at most ${MAX_PROMPT_ATTACHMENTS} files.`
        : `${overflow.length} of those files were not attached: a message carries at most ${MAX_PROMPT_ATTACHMENTS} files.`
    )
  }

  /** Attach files that arrived through a path the composer has already built
   *  them on, applying the same duplicate guard and file ceiling as a drop. */
  function adoptAttachments(candidates: readonly PromptAttachment[]): PromptAttachment[] {
    if (candidates.length === 0) return []
    // Dropping the same file twice must leave one chip: a repeated `file://` URL
    // is a duplicate key in the keyed attachment list and throws at render time.
    const { added, duplicates, overflow } = partitionNewAttachments(attachments, candidates)
    if (duplicates.length > 0) noticeDuplicateAttachments(duplicates)
    noticeOverflowAttachments(overflow)
    if (added.length === 0) return []
    attachments = [...attachments, ...added]
    onAttachmentsChange?.([...attachments])
    return added
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

    const added = adoptAttachments(candidates)
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
    const [added] = adoptAttachments([attachment])
    if (!added) return
    preview.setText(added.url, text)
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

  /**
   * Attach whatever a conversation drop carried.
   *
   * A drop out of a web page hands over a link and no file (Chromium keeps the
   * files to itself across documents), so a drop that brought no files is read as
   * the media links it named and those are fetched into attachment storage.
   */
  async function handleDropData(dt: DataTransfer | null): Promise<void> {
    if (readOnlyMode && !allowAttachments) return
    if (selectedHarnessLacksAttachments) {
      attachmentBlockedNotice = true
      return
    }
    if (!dt) return
    const { files, urls } = readComposerDrop(dt)
    if (files.length > 0) {
      for (const file of files) {
        try {
          const filePath = await window.api.registerFileSelection(file, attachmentStorage)
          if (filePath) await addFileAttachment(filePath, file)
        } catch {
          // Not a local file (e.g., an image dragged from a web page); its link
          // reading is handled above.
        }
      }
      return
    }
    if (urls.length === 0) {
      // The drag looked attachable but named nothing this chat can take (an
      // inline `data:` image, say). Say so instead of swallowing the gesture.
      showToastWarning('Nothing in that drag can be attached.')
      return
    }
    await attachRemoteMedia(urls)
  }

  /** Fetch the links one drop named and attach each file that comes back. */
  async function attachRemoteMedia(urls: readonly string[]): Promise<void> {
    if (!attachmentStorage) {
      showToastWarning('This chat has nowhere to store an attachment.')
      return
    }
    for (const url of urls) {
      try {
        const filePath = await invoke('attachment:retainRemote', attachmentStorage, url)
        await addFileAttachment(filePath)
      } catch (error) {
        showToastWarning(ipcErrorMessage(error, 'That link could not be attached.'))
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
      handleDropData
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
    closeMentions: () => {
      // Escape dismisses the suggestions for the token being typed, so the
      // menu does not spring back while the user finishes that tag by hand.
      dismissedMentionStart = lastCaretText === null ? null : composerMentionStart(lastCaretText)
      mentions.open = false
    },
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
    pager={previewPager}
    onClose={() => {
      preview.close()
      focusComposerAtSavedCaret()
    }}
  />
{/if}

<ChatComposerDropZone
  region={isDragging ? dropRegion : null}
  onAnchorChange={handleDropAnchorChange}
  onDropData={handleDropData}
  onClearDropState={clearDropState}
/>

<div
  class="chat-composer relative z-10 border bg-surface {stackedAbove
    ? 'border-t border-dashed border-border-strong'
    : ''} {expansion.maximized ? 'composer-maximized' : ''}"
  data-onboarding="composer"
  data-guide="composer"
  data-voice-trigger-root
  {@attach captureComposerRoot}
>
  <!-- The composer has no bar above its writing surface: the editor is the top
       edge, so a card the composer grows under it reads as the message box
       extended rather than as something with a strip beneath it. What the
       composer is pointed at lives in the shoe below (see `.composer-shoe`). -->
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

  {#if expertGateOpen && expertGateState}
    <ExpertCard
      expertState={expertGateState}
      session={expertGateSession}
      modelLabel={expertModelLabel}
      warming={expertWarming}
      onUse={() => void decideExperts('all', false)}
      onDisable={() => void decideExperts('off', false)}
      onNeverAsk={() => void decideExperts('off', true)}
      onOpenSettings={() => workspaceState.navigateToSettings?.('design')}
    />
  {/if}

  {#if ovenModelNotice}
    <CardNotice placement="composer" tone="warn">
      {ovenModelNotice}
    </CardNotice>
  {/if}

  {#if selectedHarnessLacksAttachments && (attachmentBlockedNotice || attachments.length > 0)}
    <CardNotice placement="composer" tone="danger">
      This model cannot accept file attachments. Choose another model before sending this file.
    </CardNotice>
  {/if}

  {#if textAttachmentError}
    <CardNotice placement="composer" tone="danger">
      {textAttachmentError}
    </CardNotice>
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
    {onRelocateItem}
    onReferenceMenuOpenChange={handleReferenceMenuOpenChange}
  />

  <div class="relative" style="--editor-gutter: 2.25rem" {@attach observeEditorLines}>
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
    <!-- Maximize   sits in the gutter beneath the console prompt, so it never
         eats into the writing surface and the editor's lines can run all the way
         to the composer's right edge. It appears on the third rendered line and
         stays available while expanded. -->
    {#if showExpandControl}
      <button
        type="button"
        class="absolute top-9 left-2 z-20 flex h-6 w-6 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        transition:scale={{ duration: motionDuration(150), start: 0.85 }}
        aria-label={expansion.maximized ? 'Collapse the composer' : 'Expand the composer'}
        aria-pressed={expansion.maximized}
        title={expansion.maximized
          ? 'Collapse the composer to its normal size'
          : 'Expand the composer for a taller, wider typing area'}
        onclick={toggleComposerExpansion}
      >
        <span class="control-glyphs" aria-hidden="true">
          <span class="control-glyph" class:is-active={expansion.maximized}>
            <CioMinimize size={ICON_SIZE.control} />
          </span>
          <span class="control-glyph" class:is-active={!expansion.maximized}>
            <CioMaximize size={ICON_SIZE.control} />
          </span>
        </span>
      </button>
    {/if}

    <!-- The console prompt: the marker the writing line hangs off, in the gold
         this workstation keeps for the few places that earn it. It inks up and
         steps forward while the field has focus, and it is never selectable. -->
    <span class="composer-prompt" aria-hidden="true">&gt;</span>
    <RichMarkdownEditor
      bind:this={richEditor}
      id={composerEditorId}
      class="composer-editor w-full overflow-y-auto pt-3 pr-4 pb-1 pl-9 text-sm leading-5 text-foreground outline-none"
      bind:value
      {placeholder}
      {autofocus}
      {disabled}
      ariaLabel="Message"
      onValueChange={handleComposerValueChange}
      onSubmit={submit}
      onPaste={handlePaste}
      inlineBadges={projectReferenceBadges}
      onInlineBadgeActivate={(value) => {
        // Only an assistant tag opens something on click; a file or task badge
        // stays the inert reference it has always been, and the click falls
        // through to the caret.
        const tag = assistantTags.find((entry) => composerAssistantTagToken(entry) === value)
        if (!tag) return false
        onOpenAssistantTag?.(tag)
        return true
      }}
      onCaretTextChange={handleCaretTextChange}
    />
  </div>

  <!-- Bottom bar: + menu · model · thinking ··· send -->
  <div
    class="composer-toolbar flex min-w-0 items-center gap-1 border-t border-dashed border-border-strong px-3 pb-2 pt-1.5"
  >
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

    <div
      class={`flex min-w-0 shrink items-center ${
        readOnlyMode || !hidePermissionSelector || resolved.fileSystemMode === true ? 'gap-3' : ''
      }`}
    >
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

      <!-- Shared model selector   model + thinking level in one control, and the
           saved profiles every other picker offers too. -->
      <ModelPicker
        bind:this={modelPicker}
        {providers}
        {projectId}
        {harnessId}
        {unavailableHarnessIds}
        {unavailableHarnessReason}
        providerId={ovenModelUnavailable ? '' : resolved.providerId}
        modelId={ovenModelUnavailable ? '' : resolved.modelId}
        label={ovenModelUnavailable ? 'Choose a model for this Oven' : undefined}
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
        runtimeSettings={resolved}
        bind:runtimeMenuOpen={inferenceMenuOpen}
        onSelectRuntime={(runtime) => applySettings({ ...resolved, ...runtime })}
        thinkingLevel={resolved.thinkingLevel}
        {thinkingPresets}
        onSelectThinking={(level) => selectThinking({ id: level, label: level })}
        permissionLevel={resolved.permissionLevel}
        onApplyProfile={applyProfile}
        showProfiles={!readOnlyMode}
      />
    </div>

    <!-- API usage credits   native harness command to bill this session's
         turns against pay-as-you-go API credits instead of a subscription. -->
    {#if usageCreditsCommandId}
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground"
        aria-label="Switch to API usage credits"
        title="Switch this session to pay-as-you-go API usage credits"
        onclick={runUsageCredits}
      >
        <CioFlame size={ICON_SIZE.control} />
      </button>
    {/if}

    <span class="flex-1"></span>

    <!-- Keep the mic mounted in one stable slot so recording state never resets
         when the composer gains text and the send control appears. -->
    <VoiceInputButton
      targetId={composerEditorId}
      getTarget={composerSpeechTarget}
      scope={speechScope}
      {disabled}
    />

    <!-- Send / Queue / Stop button. It never unmounts: it widens out of the row
         and fades when the composer has nothing to send or stop, and widens back
         when it does, so the mic beside it slides instead of the row snapping.
         Its glyphs share one box, so a send morphs into the stop square.
           - Agent idle:       ArrowUp (send)   primary, disabled when empty
           - Agent working, user typing:  AlarmClock (queue)   primary, always clickable
           - Agent working, no text:      Square (stop)   quiet at rest, danger tint on hover
           - Stop confirmation pending:   "Stop?" danger label -->
    <button
      type="button"
      class="composer-send-control relative flex h-8 shrink-0 items-center justify-center {pendingStop
        ? 'bg-danger text-on-danger hover:bg-danger-hover'
        : canStop
          ? 'text-muted hover:bg-danger/10 hover:text-danger'
          : 'bg-accent text-on-accent hover:bg-accent-hover'}"
      class:is-present={showSendControl}
      class:is-armed={pendingStop}
      inert={!showSendControl || undefined}
      aria-label={pendingStop
        ? 'Confirm stop'
        : canStop
          ? 'Stop agent'
          : working
            ? 'Queue message'
            : compactBeforeSend
              ? 'Compact context and send message'
              : 'Send message'}
      title={pendingStop
        ? 'Click again to stop'
        : canStop
          ? 'Stop the running agent'
          : working
            ? `Queue   ${sendModifierLabel}Enter · Steer   ${isMacPlatform() ? '⌘⇧' : 'Ctrl+Shift+'}Enter`
            : compactBeforeSend
              ? `Compact context, then send   ${sendModifierLabel}Enter`
              : `Send   ${sendModifierLabel}Enter`}
      disabled={disabled ||
        (canStop ? false : ovenModelUnavailable) ||
        (!working && !hasSendableContent)}
      onclick={() => submit()}
    >
      <span class="control-glyphs" aria-hidden="true">
        <span class="control-glyph" class:is-active={sendControlGlyph === 'stop'}>
          <CioStop size={ICON_SIZE.control} />
        </span>
        <span class="control-glyph" class:is-active={sendControlGlyph === 'queue'}>
          <CioClock size={ICON_SIZE.control} />
        </span>
        <span class="control-glyph" class:is-active={sendControlGlyph === 'send'}>
          {#if compactBeforeSend}
            <CioCompactSend size={ICON_SIZE.control} />
          {:else}
            <CioArrowUp size={ICON_SIZE.control} />
          {/if}
        </span>
      </span>
      <span class="pending-stop-label text-[0.5625rem] font-semibold" class:is-active={pendingStop}>
        Stop?
      </span>
    </button>
  </div>
</div>

<!-- The composer shoe: the one bar the composer owns, floating just underneath
     it, sized to the row it holds and centered under the composer. It slides up
     behind the composer (z below it) so its top edge is tucked under the
     composer's bottom border   only the lower half shows, like a shoe. It is
     rendered by every composer, in every mode: the properties of whatever is
     being written into are never a project-mode extra.
     No z-index on the wrapper: the composer (z-10) paints over the card, but
     the shoe's dropdown (z-40 inside) still opens above the composer.
     The wrapper is the shoe's own inline-size query container: the composer
     cannot query a sibling, and the card must stay free of containment so it
     can size itself to its content. -->
{#if shoe}
  <div class="composer-shoe relative -mt-4 flex w-full justify-center px-4 pt-3 pb-2 @container">
    <!-- The card frame is the console shoe: one surface, tucked behind the
         composer so only its lower band shows. Its top padding is what holds the
         segments clear of the composer's lower edge. -->
    <div
      class="composer-shoe-card flex min-w-0 items-center justify-center border border-border bg-surface px-0.5 pt-1.5 pb-1"
    >
      <ComposerShoe
        bind:this={shoeComponent}
        {shoe}
        usage={usageReading}
        onScopeMenuClosed={focusComposerAtSavedCaret}
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
      margin-inline 240ms ease,
      border-color 220ms ease,
      box-shadow 420ms ease;
  }

  /* At rest the composer is a bordered field; focus inks the border and lifts it
     a hair, so the surface being written on is what the eye lands on. */
  .chat-composer:focus-within {
    border-color: var(--color-border-strong);
    box-shadow: 0 0.5rem 1.5rem -0.75rem rgb(0 0 0 / 0.18);
  }

  /* The prompt marker sits in the editor's gutter, on the writing line, and
     steps forward as focus arrives. It is decorative: the marker is
     aria-hidden and the gutter is why the placeholder is inset too. */
  .composer-prompt {
    position: absolute;
    top: 0.75rem;
    left: 0.875rem;
    font-weight: 700;
    line-height: 1.25rem;
    color: var(--color-accent-hover);
    opacity: 0.55;
    pointer-events: none;
    transition:
      opacity 220ms ease,
      transform 220ms ease;
  }

  .chat-composer:focus-within .composer-prompt {
    opacity: 1;
    transform: translateX(0.125rem);
  }

  /* The shoe card carries the console shadow: a soft, short drop that separates
     the bar from the canvas without turning it into a floating panel. */
  .composer-shoe-card {
    box-shadow: 0 0.5rem 1.25rem -0.875rem rgb(0 0 0 / 0.4);
  }

  /* Maximize   the editor is the composer's typing surface, so the control is
     what grows: the collapsed height cap becomes the expanded floor (the box is
     immediately large) and the cap triples. The 60vh clamp keeps a visible
     conversation on short windows. */
  :global(.composer-editor) {
    min-height: 2.5rem;
    max-height: 10rem;
    transition:
      min-height 240ms ease,
      max-height 240ms ease;
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
    :global(.composer-editor),
    .composer-send-control,
    .control-glyphs,
    .control-glyph,
    .pending-stop-label {
      transition: none;
    }
  }

  /* Send / Queue / Stop   one control that never unmounts. It widens out of the
     row and fades when the composer has nothing to send or stop, and widens back
     in when it does, so the mic beside it slides instead of the row snapping.
     While collapsed the negative start margin cancels the toolbar's `gap-1`, so
     the row's right edge is what moves and nothing shifts once the motion ends.
     Colour rides the same transition, so the gold send and the quiet stop tint
     into each other. */
  .composer-send-control {
    width: 0;
    /* A flex item's automatic minimum size would otherwise floor the used width
       at the control's own content, so the collapsed box has to say it may
       reach zero. */
    min-width: 0;
    margin-inline-start: -0.25rem;
    overflow: hidden;
    opacity: 0;
    pointer-events: none;
    transition:
      width 200ms cubic-bezier(0.215, 0.61, 0.355, 1),
      margin-inline-start 200ms cubic-bezier(0.215, 0.61, 0.355, 1),
      opacity 150ms ease,
      background-color 160ms ease,
      color 160ms ease;
  }

  .composer-send-control.is-present {
    width: 2rem;
    margin-inline-start: 0;
    opacity: 1;
    pointer-events: auto;
  }

  /* A control's glyphs share one box, all of them mounted: the active one
     crossfades and settles into place, so a state change reads as one mark
     becoming another rather than as a swap. Opacity and transform only, so the
     change never touches layout. */
  .control-glyphs {
    position: relative;
    display: grid;
    place-items: center;
    width: 1.0625rem;
    height: 1.0625rem;
    transition: opacity 150ms ease;
  }

  .control-glyph {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    opacity: 0;
    transform: scale(0.55) rotate(-32deg);
    transition:
      opacity 130ms ease,
      transform 210ms cubic-bezier(0.215, 0.61, 0.355, 1);
  }

  .control-glyph.is-active {
    opacity: 1;
    transform: none;
  }

  /* While the word is on screen the square behind it stays off; the narrow tier
     has no room for the word, so the square carries the armed state there (see
     the container query below). */
  .composer-send-control.is-armed .control-glyphs {
    opacity: 0;
  }

  .pending-stop-label {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    opacity: 0;
    pointer-events: none;
    transition: opacity 130ms ease;
  }

  .pending-stop-label.is-active {
    opacity: 1;
  }

  /* Control labels ellipsize as the composer tightens   they never wrap to a
     second line. At the narrow tier they drop out entirely so only the icon is
     left behind. The `.composer-control-label` rule for the permission picker
     lives in that component. */
  @container (max-width: 520px) {
    .composer-toolbar {
      padding-inline: 0.5rem;
    }

    .composer-send-control.is-armed .control-glyphs {
      opacity: 1;
    }

    .pending-stop-label.is-active {
      opacity: 0;
    }
  }

  /* The shoe sizes to the row it holds: never wider than the room the composer
     leaves it, and as wide as that row needs, so the shoe reads as one bar
     centered under the message box in every mode   a project thread with a scope
     and a branch, a chat with nothing but its own name and the keys.
     `.composer-shoe` is the query container (see its `@container` class), so
     these rules and the shoe's own truncation stages measure the composer, minus
     that wrapper's own inline padding. */
  .composer-shoe-card {
    width: max-content;
    max-width: 100%;
  }

  /* Tight composer: the shoe trims its own inline padding before the row has to
     ellipsize, so the row keeps the room it needs. */
  @container (max-width: 630px) {
    .composer-shoe-card {
      padding-inline: 0.375rem;
    }
  }
</style>
