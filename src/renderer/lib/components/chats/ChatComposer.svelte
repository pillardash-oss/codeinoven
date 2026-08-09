<script lang="ts">
  import { tick, onDestroy, onMount } from 'svelte'
  import {
    ArrowUp,
    Clock,
    Plus,
    Paperclip,
    Square,
    Wrench,
    Brain,
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
    Repeat2,
    Network,
    HardDrive,
    Zap,
    ShieldAlert,
    Eye,
    Check
  } from '@lucide/svelte'
  import { threadSettings as threadSettingsStore } from '$lib/stores/thread-settings.svelte'
  import { baseUrlProviderStore } from '$lib/stores/base-url-providers.svelte'
  import {
    fastMultiplierFor,
    fastSelectionModelId,
    supportsFastInference
  } from '$shared/fast-inference'
  import { STANDARD_THINKING_PRESETS, resolveDefaultThinkingLevel } from '$shared/thinking-presets'
  import { invoke } from '$lib/ipc.svelte'
  import ProjectSwitch from '$lib/components/shared/ProjectSwitch.svelte'
  import ProjectIdentity from '$lib/components/shared/ProjectIdentity.svelte'
  import { hasProjectNameCollision, projectIdentityTitle } from '$lib/project-location'
  import { projectRemotes } from '$lib/stores/project-remotes.svelte'
  import {
    getInlineFileTypeIconDataUri,
    getInlineFolderTypeIconDataUri
  } from '../files/file-type-icons'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { attachmentPreviewKind, fileUrlToPath, mimeFromPath, pathToFileUrl } from '$lib/mime'
  import { placeCaretAtEnd } from '../shared/rich-markdown'
  import AttachmentPreview from './AttachmentPreview.svelte'
  import SelectionListPopover from './SelectionListPopover.svelte'
  import Switch from '../ui/Switch.svelte'
  import ContextUsageIndicator from './ContextUsageIndicator.svelte'
  import ProjectFileMentionMenu from './ProjectFileMentionMenu.svelte'
  import type { ComposerMentionEntry } from './composer-mentions'
  import SlashActionMenu from '../actions/SlashActionMenu.svelte'
  import RichMarkdownEditor from '../shared/RichMarkdownEditor.svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import { filterActions } from '$lib/actions'
  import { APP_NAME } from '$shared/brand'
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
    AgentModelSelection
  } from '$shared/types'

  interface Props {
    /** Called with the trimmed message and attachments when the user sends. */
    onSend: (
      message: string,
      attachments: PromptAttachment[],
      direct?: boolean,
      projectReferences?: PromptProjectReference[],
      taskReferences?: PromptAssignmentTaskReference[]
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
    onSlashCommand?: (name: string, args: string) => void | Promise<void>
    /** Available providers + models from the harness. */
    providers?: ProviderCatalog[]
    /** Id of the agent harness serving the models (shown on each model row). */
    harnessId?: string
    /** Project context row shown before the first message of the thread. */
    projectContext?: ComposerProject
    /** Active project ID for the project switcher dropdown. */
    projectId?: string | null
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
    /** Assistant-response excerpts referenced by the next message. */
    references?: readonly PromptReference[]
    onRemoveReference?: (id: string) => void
    /** Removes every attached selection. */
    onRemoveAllReferences?: () => void
    /** Jump to a reference's highlight and open its comment editor. */
    onEditReference?: (id: string) => void
    /** False on the Chats tab — plain chats never surface the engineer toggle. */
    showEngineeringMode?: boolean
    /** True on the Chats tab — surfaces the chat-only Engineering and File System toggles. */
    showChatModes?: boolean
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
    onToggleFavorite?: (providerId: string, modelId: string) => void
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
    /** Per-harness quota telemetry when a thread used more than one harness. */
    harnessUsage?: AgentHarnessUsage[]
    /** Flushes the rendered usage snapshot to the latest value (e.g. on hover). */
    onRevealUsage?: () => void
    /** Whether this harness can explicitly compact conversation context. */
    canCompact?: boolean
    compacting?: boolean
    onCompact?: () => void
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
    providers = [],
    harnessId = 'opencode',
    projectContext,
    projectId = null,
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
    references = [],
    onRemoveReference,
    onRemoveAllReferences,
    onEditReference,
    showEngineeringMode = true,
    showChatModes = false,
    hidePermissionSelector = false,
    readOnlyMode = false,
    allowAttachments = false,
    favoriteModels = [],
    onToggleFavorite,
    onReorderFavorite,
    recentModels = [],
    onModelUsed,
    contextUsage,
    harnessUsage = [],
    onRevealUsage,
    canCompact = false,
    compacting = false,
    onCompact,
    historyMessages = [],
    imageDescriptorDefault,
    imageDescriptorAskAgain = false,
    onImageDescriptorDefaultChange,
    onImageDescriptorAskAgainChange,
    enableImageDescriptorGate = true
  }: Props = $props()

  /** Resolved settings — uses the prop if provided, else the global last-used.
   *  Chats always run with auto permission review, so when the permission
   *  selector is hidden the level is pinned to `auto_review`. */
  let resolved = $derived<ThreadSettings>(
    hidePermissionSelector
      ? { ...(settings ?? threadSettingsStore.lastUsed), permissionLevel: 'auto_review' as const }
      : (settings ?? threadSettingsStore.lastUsed)
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
  /** Object URLs for image/pdf previews, keyed by attachment file:// URL. */
  let previewUrls = $state<Record<string, string>>({})
  /** Decoded text content for markdown/plain-text previews, keyed by url. */
  let previewTexts = $state<Record<string, string>>({})
  /** Image-descriptor gate state: intercepts sending an image to a text-only model. */
  let imageDescriptorGateOpen = $state(false)
  let gateVisionSelection = $state<AgentModelSelection | null>(null)
  let gateDonotAsk = $state(false)
  let gateDirect = $state<boolean | undefined>(undefined)
  const composerEditorId = `chat-composer-${crypto.randomUUID()}`
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

  // Dropdown open state
  let plusMenuOpen = $state(false)
  let modelMenuOpen = $state(false)
  let thinkingMenuOpen = $state(false)
  let inferenceMenuOpen = $state(false)
  let permissionMenuOpen = $state(false)

  // Selection slot hover popover — a short grace period keeps it open while the
  // pointer travels from the chip across any gap to the popover itself.
  let selectionPopoverOpen = $state(false)
  let selectionPopoverTimer: ReturnType<typeof setTimeout> | undefined

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
    thinkingMenuOpen = false
    inferenceMenuOpen = false
    permissionMenuOpen = false
  }

  function showModelMenu(): void {
    modelMenuOpen = true
    plusMenuOpen = false
    thinkingMenuOpen = false
    inferenceMenuOpen = false
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

  let modelWasOpen = $state(false)
  $effect(() => {
    if (modelWasOpen && !modelMenuOpen) {
      focusComposerAtEnd()
    }
    modelWasOpen = modelMenuOpen
  })

  let thinkingWasOpen = $state(false)
  $effect(() => {
    if (thinkingWasOpen && !thinkingMenuOpen && !modelMenuOpen) {
      focusComposerAtEnd()
    }
    thinkingWasOpen = thinkingMenuOpen
  })

  $effect(() => {
    if (thinkingMenuOpen) {
      void tick().then(() => {
        const firstItem = document.querySelector('[data-thinking-index="0"]')
        if (firstItem instanceof HTMLElement) {
          firstItem.focus()
        }
      })
    }
  })

  function toggleThinkingMenu(): void {
    if (thinkingMenuOpen) closeAllMenus()
    else showThinkingMenu()
  }

  function toggleInferenceMenu(): void {
    if (inferenceMenuOpen) closeAllMenus()
    else showInferenceMenu()
  }

  /** Catalog entry for the selected harness/provider/model, when reported. */
  let selectedProvider = $derived(
    providers.find(
      (provider) => provider.harnessId === resolved.harnessId && provider.id === resolved.providerId
    )
  )
  let selectedModel = $derived(
    selectedProvider?.models.find((model) => model.id === resolved.modelId)
  )

  /** True when the catalog reports this model cannot see images. */
  let selectedModelLacksVision = $derived(selectedModel?.attachment === false)
  let hasImageAttachments = $derived(attachments.some(isImageAttachment))

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

  /** Whether the button should show the stop icon (agent working, no text typed). */
  let canStop = $derived(working && !hasText)

  // Cancel pending stop when the agent stops working on its own.
  $effect(() => {
    if (working) return
    cancelStop()
  })

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

  function isHarnessSlashAction(action: ActionDefinition): boolean {
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

  function selectSlashAction(action: ActionDefinition, method: ActionSelection['method']): void {
    if (action.disabledReason) return
    const selectedQuery = slashQuery
    slashOpen = false

    const replacement = isHarnessSlashAction(action) ? `${action.title} ` : ''
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
      showThinkingMenu()
      return
    }

    if (isHarnessSlashAction(action)) {
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
    if (working && !hasText) {
      confirmStop()
      return
    }
    cancelStop()
    const msg = value.trim()
    if (!msg) return
    historyIndex = -1
    savedValue = ''
    const slashCommand = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(msg)
    if (slashCommand && onSlashCommand) {
      const name = slashCommand[1]
      const action = actions.find(
        (candidate) => isHarnessSlashAction(candidate) && candidate.title === `/${name}`
      )
      if (action) {
        if (action.disabledReason) return
        value = ''
        slashOpen = false
        onValueChange?.('')
        void onSlashCommand(name, slashCommand[2]?.trim() ?? '')
        return
      }
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
    const msg = value.trim()
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
    onAttachmentsChange?.([])
    onProjectReferencesChange?.([])
    onTaskReferencesChange?.([])
    onSend(msg, files, direct, taggedPaths, taggedTasks)
  }

  async function updateFileMention(nextValue: string): Promise<void> {
    const match = /(^|\s)@([^\s@]*)$/u.exec(nextValue)
    if ((!fileTagProjectId && assignmentTasks.length === 0) || !match) {
      mentionOpen = false
      return
    }
    const query = match[2] ?? ''
    const requestId = ++mentionRequestId
    try {
      const normalizedQuery = query.trim().toLocaleLowerCase()
      const taskEntries: ComposerMentionEntry[] = assignmentTasks
        .filter((task) => {
          if (!normalizedQuery) return true
          return [task.title, task.description, task.id, task.workerName]
            .filter((value): value is string => typeof value === 'string')
            .some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
        })
        .map((entry) => ({ type: 'task', entry }))
      const files = fileTagProjectId
        ? await invoke('projectFiles:search', fileTagProjectId, query, 'all')
        : []
      const entries: ComposerMentionEntry[] = [
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
    const match = /(^|\s)@([^\s@]*)$/u.exec(textBeforeCaret)
    if ((!fileTagProjectId && assignmentTasks.length === 0) || !match) {
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
  }

  function selectMention(mention: ComposerMentionEntry): void {
    mentionOpen = false
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

  function toggleEngineeringMode(): void {
    const engineeringMode = !resolved.engineeringMode
    const updated = {
      ...resolved,
      engineeringMode,
      assignmentMode: engineeringMode ? resolved.assignmentMode : false,
      loopMode: engineeringMode ? resolved.loopMode : false
    }
    if (onSettingsChange) onSettingsChange(updated)
    else threadSettingsStore.commit(updated)
  }

  function toggleAssignmentMode(): void {
    const assignmentMode = resolved.assignmentMode !== true
    const updated = {
      ...resolved,
      engineeringMode: assignmentMode ? true : resolved.engineeringMode,
      assignmentMode,
      loopMode: resolved.loopMode
    }
    if (onSettingsChange) onSettingsChange(updated)
    else threadSettingsStore.commit(updated)
  }

  function toggleLoopMode(): void {
    const loopMode = resolved.loopMode !== true
    const updated = {
      ...resolved,
      engineeringMode: loopMode ? true : resolved.engineeringMode,
      assignmentMode: resolved.assignmentMode,
      loopMode
    }
    if (onSettingsChange) onSettingsChange(updated)
    else threadSettingsStore.commit(updated)
  }

  function toggleFileSystemMode(): void {
    const updated = { ...resolved, fileSystemMode: resolved.fileSystemMode !== true }
    if (onSettingsChange) onSettingsChange(updated)
    else threadSettingsStore.commit(updated)
  }

  function selectModel(providerId: string, modelId: string, nextHarnessId?: string): void {
    modelMenuOpen = false
    onModelUsed?.(`${providerId}:${modelId}`)
    const nextHarness = nextHarnessId ?? resolved.harnessId
    const provider = providers.find(
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
    thinkingMenuOpen = false
    const updated = { ...resolved, thinkingLevel: preset.id as ThinkingLevel }
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

  /** Loads the preview payload for one attachment: blob URLs for images/pdfs,
   *  decoded text for markdown/plain-text. Missing/undecodable files silently
   *  yield no preview so the chip falls back to the file:// URL or the modal
   *  shows its unavailable state. */
  async function loadAttachmentPreview(file: PromptAttachment): Promise<void> {
    const kind = attachmentPreviewKind(file.mime, file.filename ?? '')
    if (!kind) return
    try {
      const bytes = await window.api.readFile(fileUrlToPath(file.url))
      if (kind === 'markdown' || kind === 'text') {
        if (previewTexts[file.url] !== undefined) return
        previewTexts = { ...previewTexts, [file.url]: new TextDecoder().decode(bytes) }
        return
      }
      if (previewUrls[file.url]) return
      const objectUrl = URL.createObjectURL(new Blob([bytes], { type: file.mime }))
      previewUrls = { ...previewUrls, [file.url]: objectUrl }
    } catch {
      // Preview unavailable; the chip/modal will fall back to the file:// URL.
    }
  }

  async function loadAttachmentPreviews(files: PromptAttachment[]): Promise<void> {
    for (const file of files) {
      await loadAttachmentPreview(file)
    }
  }

  onMount(() => {
    void loadAttachmentPreviews(attachments)
  })

  async function addFileAttachment(filePath: string, file?: File): Promise<void> {
    if (readOnlyMode && !allowAttachments) return
    const filename =
      file?.name ??
      (filePath.split('/').pop() ?? filePath.split('\\').pop() ?? 'file').split('?')[0]
    const mime = file?.type || mimeFromPath(filePath)
    const url = pathToFileUrl(filePath)
    const attachment = { mime, url, filename }
    attachments = [...attachments, attachment]
    onAttachmentsChange?.(attachments)
    void loadAttachmentPreview(attachment)
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
    }
    attachments = attachments.filter((_, i) => i !== index)
    onAttachmentsChange?.(attachments)
  }

  onDestroy(() => {
    clearTimeout(mentionSearchTimer)
    clearTimeout(selectionPopoverTimer)
    for (const objectUrl of Object.values(previewUrls)) {
      URL.revokeObjectURL(objectUrl)
    }
  })

  async function pickAttachment(): Promise<void> {
    if (readOnlyMode && !allowAttachments) return
    const path = await invoke('dialog:pickFile')
    if (!path) return
    await addFileAttachment(path)
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

  function handleDropFiles(dt: DataTransfer | null): void {
    if (readOnlyMode && !allowAttachments) return
    if (!dt) return
    const files = dt.files
    if (!files || files.length === 0) return
    for (const file of Array.from(files)) {
      try {
        const filePath = window.api.getPathForFile(file)
        if (filePath) addFileAttachment(filePath, file)
      } catch {
        // Not a local file (e.g., image dragged from a web page); skip.
      }
    }
  }

  $effect(() => {
    if (readOnlyMode && !allowAttachments) return
    function onDragOver(e: DragEvent): void {
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
      if (overFileTree(e)) return
      e.preventDefault()
      isDragging = false
      handleDropFiles(e.dataTransfer)
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
    const items = e.clipboardData?.items
    if (!items) return
    let hasFileAttachment = false

    for (const item of Array.from(items)) {
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file) {
          try {
            const filePath = window.api.getPathForFile(file)
            if (filePath) {
              addFileAttachment(filePath, file)
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
          const path = await invoke('clipboard:saveImage')
          if (path) await addFileAttachment(path)
          else hasFileAttachment = false
        } catch {
          hasFileAttachment = false
        }
      }
    }

    if (hasFileAttachment) e.preventDefault()
  }

  // Double-Escape abort — two presses within the window stop the running turn.
  // Single escape or any outside click cancels a pending stop confirmation.
  const ESCAPE_ABORT_WINDOW_MS = 800
  let lastEscapeAt = 0

  function onWindowKeydown(e: KeyboardEvent): void {
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
    const editorEl = document.getElementById(composerEditorId)
    const isComposerFocused = editorEl?.contains(document.activeElement)
    if (isComposerFocused && !mentionOpen && !slashOpen) {
      if (historyIndex >= 0 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        historyIndex = -1
        savedValue = ''
      }
      if (e.key === 'ArrowUp' && (value === '' || historyIndex >= 0)) {
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
      if (e.key === 'ArrowDown' && historyIndex >= 0) {
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
    if (e.key === 'Tab' && e.shiftKey && isComposerFocused && showEngineeringMode) {
      e.preventDefault()
      toggleEngineeringMode()
      return
    }
    if (e.key !== 'Escape') return
    // Cancel pending stop on single escape
    if (pendingStop) {
      cancelStop()
      return
    }
    if (!working || !onStop) return
    const now = Date.now()
    if (now - lastEscapeAt <= ESCAPE_ABORT_WINDOW_MS) {
      lastEscapeAt = 0
      onStop()
    } else {
      lastEscapeAt = now
    }
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if previewFile}
  <AttachmentPreview
    attachment={previewFile}
    src={previewUrls[previewFile.url]}
    text={previewTexts[previewFile.url]}
    onClose={() => (previewFile = null)}
  />
{/if}

<div class="chat-composer border bg-surface shadow-sm">
  {#if isDragging}
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
            visionOnly
            side="top"
            variant="field"
            label={gateVisionSelection ? undefined : 'Choose a vision model'}
            onSelect={(providerId, modelId, harnessId) => {
              gateVisionSelection = { harnessId, providerId, modelId }
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
        <p class="mt-1.5 text-[11px] text-dimmed">
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

  <!-- Project context + attachment chips -->
  {#if projectContext || attachments.length > 0 || references.length > 0 || (showEngineeringMode && (resolved.engineeringMode || resolved.assignmentMode || resolved.loopMode)) || (showChatModes && resolved.fileSystemMode)}
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
              locationClass="text-[9px] text-dimmed"
              showLocation={hasProjectNameCollision(projectContext, scopeState.projectRecords)}
            />
            <span
              class="flex shrink-0 items-center gap-1 rounded-md bg-elevated px-1.5 py-0.5 text-[10px] text-muted"
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
                class="flex min-w-0 shrink items-center gap-1 rounded-md bg-elevated px-1.5 py-0.5 text-[10px] text-muted"
                title={branchPillTitle}
              >
                <GitBranch size={9} class="shrink-0" />
                <span class="truncate">{projectContext.branch}</span>
              </span>
            {/if}
          </ProjectSwitch>
        {/if}
        {#if showEngineeringMode && (resolved.engineeringMode || resolved.loopMode)}
          <div class="flex flex-wrap items-center gap-1.5" aria-label="Active chat modes">
            {#if resolved.engineeringMode}
              <span
                class="flex shrink-0 items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
              >
                <Wrench size={9} class="shrink-0" />
                <span>Engineering</span>
                <button
                  type="button"
                  class="shrink-0 text-primary/60 transition-colors hover:text-primary"
                  title="Turn off Engineering"
                  aria-label="Turn off Engineering"
                  onclick={toggleEngineeringMode}
                >
                  <X size={9} />
                </button>
              </span>
            {/if}
            {#if resolved.assignmentMode}
              <span
                class="flex shrink-0 items-center gap-1 rounded-md bg-info/10 px-1.5 py-0.5 text-[10px] text-info"
              >
                <Network size={9} class="shrink-0" />
                <span>Assignment</span>
                <button
                  type="button"
                  class="shrink-0 text-info/60 transition-colors hover:text-info"
                  title="Turn off Assignment"
                  aria-label="Turn off Assignment"
                  onclick={toggleAssignmentMode}
                >
                  <X size={9} />
                </button>
              </span>
            {/if}
            {#if resolved.loopMode}
              <span
                class="flex shrink-0 items-center gap-1 rounded-md bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent"
              >
                <Repeat2 size={9} class="shrink-0" />
                <span>Achievement</span>
                <button
                  type="button"
                  class="shrink-0 text-accent/60 transition-colors hover:text-accent"
                  title="Turn off Achievement"
                  aria-label="Turn off Achievement"
                  onclick={toggleLoopMode}
                >
                  <X size={9} />
                </button>
              </span>
            {/if}
          </div>
        {/if}
        {#if showChatModes && resolved.fileSystemMode}
          <div class="flex flex-wrap items-center gap-1.5" aria-label="Active chat modes">
            {#if resolved.fileSystemMode}
              <span
                class="flex shrink-0 items-center gap-1 rounded-md bg-info/10 px-1.5 py-0.5 text-[10px] text-info"
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
            class="flex items-center rounded-lg border border-accent/30 bg-accent/10 text-[11px] font-medium text-foreground transition-colors hover:bg-accent/15"
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
              class="flex items-stretch overflow-hidden rounded-lg border border-border bg-elevated text-[11px] text-muted transition-colors"
            >
              {#if previewKind}
                <button
                  type="button"
                  class="flex min-w-0 items-center gap-1.5 py-1 pr-1 pl-2 text-left transition-colors hover:text-foreground"
                  title="Click to preview"
                  aria-label="Preview {file.filename ?? 'file'}"
                  onclick={() => (previewFile = file)}
                >
                  {#if previewKind === 'image'}
                    <img
                      src={previewUrls[file.url] ?? file.url}
                      alt={file.filename ?? 'file'}
                      class="h-5 w-5 shrink-0 rounded object-cover"
                    />
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
      submitOnEnter
      onValueChange={handleComposerValueChange}
      onSubmit={submit}
      onPaste={handlePaste}
      inlineBadges={projectReferenceBadges}
      onCaretTextChange={handleCaretTextChange}
    />
  </div>

  <!-- Bottom bar: + menu · model · thinking ··· send -->
  <div class="composer-toolbar flex min-w-0 items-center gap-1 px-3 pb-2 pt-1">
    <!-- Plus menu — Engineering, Achievement, attachments, future per-chat options -->
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
            class="absolute bottom-9 left-0 z-40 w-52 rounded-xl border bg-surface p-1 shadow-lg"
            role="menu"
          >
            {#if showChatModes || showEngineeringMode}
              {#if showChatModes}
                <!-- File System toggle (chat view) -->
                <Switch
                  checked={resolved.fileSystemMode === true}
                  onchange={toggleFileSystemMode}
                  role="menuitemcheckbox"
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
              {:else}
                <!-- Engineering toggle -->
                <Switch
                  checked={resolved.engineeringMode}
                  onchange={toggleEngineeringMode}
                  role="menuitemcheckbox"
                  title={resolved.engineeringMode ? 'Turn off Engineering' : 'Turn on Engineering'}
                  class="w-full justify-between rounded-lg px-2.5 py-2 transition-colors hover:bg-elevated"
                >
                  <span
                    class="flex min-w-0 items-center gap-2 {resolved.engineeringMode
                      ? 'text-foreground'
                      : 'text-muted'}"
                  >
                    <Wrench
                      size={13}
                      class={resolved.engineeringMode ? 'text-primary' : 'text-dimmed'}
                    />
                    Engineering
                  </span>
                </Switch>

                <!-- Assignment toggle -->
                <Switch
                  checked={resolved.assignmentMode === true}
                  onchange={toggleAssignmentMode}
                  role="menuitemcheckbox"
                  title={resolved.assignmentMode ? 'Turn off Assignment' : 'Turn on Assignment'}
                  activeClass="bg-info"
                  class="w-full justify-between rounded-lg px-2.5 py-2 transition-colors hover:bg-elevated"
                >
                  <span
                    class="flex min-w-0 items-center gap-2 {resolved.assignmentMode
                      ? 'text-foreground'
                      : 'text-muted'}"
                  >
                    <Network
                      size={13}
                      class={resolved.assignmentMode ? 'text-info' : 'text-dimmed'}
                    />
                    Assignment
                  </span>
                </Switch>

                <!-- Achievement toggle -->
                <Switch
                  checked={resolved.loopMode === true}
                  onchange={toggleLoopMode}
                  role="menuitemcheckbox"
                  title={resolved.loopMode ? 'Turn off Achievement' : 'Turn on Achievement'}
                  activeClass="bg-accent"
                  class="w-full justify-between rounded-lg px-2.5 py-2 transition-colors hover:bg-elevated"
                >
                  <span
                    class="flex min-w-0 items-center gap-2 {resolved.loopMode
                      ? 'text-foreground'
                      : 'text-muted'}"
                  >
                    <Repeat2 size={13} class={resolved.loopMode ? 'text-accent' : 'text-dimmed'} />
                    Achievement
                  </span>
                </Switch>
              {/if}

              <div class="mx-2 my-1 border-t"></div>
            {/if}

            {#if !readOnlyMode || allowAttachments}
              <!-- Attach file -->
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-foreground transition-colors hover:bg-elevated"
                role="menuitem"
                title="Attach a file to this message"
                onclick={() => {
                  plusMenuOpen = false
                  void pickAttachment()
                }}
              >
                <Paperclip size={13} class="text-dimmed" />
                Attach File
              </button>
            {/if}
          </div>
        {/if}
      </div>
    {/if}

    <!-- Permission level selector -->
    {#if readOnlyMode}
      <span
        class="flex items-center gap-1 rounded-lg bg-raised px-2 py-1.5 text-[11px] text-muted"
        title="Temporary chats can inspect context but cannot modify files or run commands"
      >
        <Shield size={12} />
        <span class="composer-control-label">Read only</span>
      </span>
    {:else if !hidePermissionSelector}
      <div class="relative">
        <button
          type="button"
          class="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] transition-colors hover:bg-elevated {resolved.permissionLevel ===
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
              <p class="px-2 pb-1 pt-1 text-[9px] text-dimmed">Applies to the next turn</p>
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

    <!-- Shared model selector -->
    <ModelPicker
      {providers}
      {projectId}
      {harnessId}
      providerId={resolved.providerId}
      modelId={resolved.modelId}
      {favoriteModels}
      {recentModels}
      bind:open={modelMenuOpen}
      onSelect={selectModel}
      {onToggleFavorite}
      {onReorderFavorite}
      fast={inferenceMode === 'fast'}
    />

    <!-- Thinking level — only for models that support reasoning -->
    {#if supportsThinking}
      <div class="relative">
        <button
          type="button"
          class="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] text-muted transition-colors hover:bg-elevated hover:text-foreground"
          aria-label={`Thinking strategy: ${thinkingPresets.find((preset) => preset.id === resolved.thinkingLevel)?.label ?? resolved.thinkingLevel}`}
          title="Thinking strategy"
          onclick={toggleThinkingMenu}
        >
          <Brain size={12} />
          <span class="composer-control-label capitalize"
            >{thinkingPresets.find((p) => p.id === resolved.thinkingLevel)?.label ??
              resolved.thinkingLevel}</span
          >
        </button>

        {#if thinkingMenuOpen}
          <button
            class="fixed inset-0 z-30 cursor-default"
            aria-label="Close menu"
            onclick={closeAllMenus}
          ></button>
          <div
            class="absolute bottom-9 left-0 z-40 w-44 overflow-hidden rounded-xl border bg-surface shadow-lg"
          >
            <div class="p-1">
              {#each thinkingPresets as preset, i (preset.id)}
                <button
                  data-thinking-index={i}
                  class="flex w-full items-center rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-elevated {resolved.thinkingLevel ===
                  preset.id
                    ? 'text-primary'
                    : 'text-foreground'}"
                  title={preset.description ?? `Set thinking to ${preset.label}`}
                  onclick={() => selectThinking(preset)}
                  onkeydown={(event: KeyboardEvent) => {
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      event.preventDefault()
                      const buttons = document.querySelectorAll('[data-thinking-index]')
                      const currentIndex = Array.from(buttons).indexOf(
                        event.currentTarget as HTMLElement
                      )
                      const nextIndex =
                        event.key === 'ArrowDown'
                          ? Math.min(currentIndex + 1, buttons.length - 1)
                          : Math.max(currentIndex - 1, 0)
                      const next = buttons[nextIndex] as HTMLElement
                      if (next) next.focus()
                      return
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      closeAllMenus()
                      return
                    }
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      selectThinking(preset)
                      return
                    }
                  }}
                >
                  <span class="flex flex-col">
                    <span class="capitalize">{preset.label}</span>
                    {#if preset.description}
                      <span class="text-[10px] text-muted">{preset.description}</span>
                    {/if}
                  </span>
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    {/if}

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
                  <span class="text-[10px] text-muted">~{fastVariant.multiplier}× usage</span>
                </span>
              </button>
            </div>
          </div>
        {/if}
      </div>
    {/if}

    <span class="flex-1"></span>

    <ContextUsageIndicator
      usage={contextUsage}
      {harnessUsage}
      {canCompact}
      {compacting}
      {onCompact}
      onReveal={onRevealUsage}
    />

    <!-- Send / Queue / Stop button.
         - Agent idle:       ArrowUp (send) — primary, disabled when empty
         - Agent working, user typing:  Clock (queue) — primary, always clickable
         - Agent working, no text:      Square (stop) — danger tint
         - Stop confirmation pending:   "Stop?" danger label -->
    <button
      type="button"
      class="flex h-8 w-8 items-center justify-center rounded-lg transition-colors {pendingStop
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
        ? 'Click again to stop — Esc to cancel'
        : canStop
          ? 'Stop the running agent'
          : working
            ? 'Queue — message sends when the agent finishes'
            : 'Send'}
      disabled={disabled || (!working && !hasText)}
      onclick={() => submit()}
    >
      {#if pendingStop}
        <span class="pending-stop-label text-[9px] font-semibold">Stop?</span>
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
  </div>
</div>

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
