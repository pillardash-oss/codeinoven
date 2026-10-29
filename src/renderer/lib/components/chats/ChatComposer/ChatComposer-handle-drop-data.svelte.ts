import { threadSettings as threadSettingsStore } from '$lib/stores/thread-settings.svelte'
import { STANDARD_THINKING_PRESETS } from '$shared/thinking-presets'
import { posixBasename } from '$shared/paths'
import { showToastWarning } from '$lib/stores/app-errors.svelte'
import { ipcErrorMessage } from '$lib/ipc-errors'
import { invoke } from '$lib/ipc.svelte'
import { hasModelRuntimeSettings } from '$shared/model-runtime-settings'
import { applyModelProfile } from '$shared/model-profiles'
import { modelKey } from '$lib/model-keys'
import { visionModels } from '$lib/stores/vision-models.svelte'
import { fileUrlToPath, mimeFromPath, pathToFileUrl, attachmentPreviewKind } from '$lib/mime'
import type { PreviewPagerState } from '../../ui/PreviewPager.svelte'
import { droppedThread, readComposerDrop } from '../chat-composer-drop-source'
import { type ComposerPasteContext } from '../chat-composer-paste'
import { createComposerSlashActions } from '../chat-composer-slash.svelte'
import {
  withFileSystemMode,
  withModelSelection,
  withPermissionLevel,
  withThinkingLevel
} from '../chat-composer-settings'
import { createComposerAttachmentPreview } from '../chat-composer-preview.svelte'
import {
  isEditablePastedTextAttachment,
  type StartAfterSelection
} from '../chat-composer-attachments'
import ModelPicker from '../../shared/ModelPicker.svelte'
import { threadNeedsAiAccount } from '$lib/ai-account'
import { mergeProviderCatalogEntries, providerCatalog } from '$lib/stores/provider-catalog.svelte'
import { modelRuntime } from '$lib/stores/model-runtime.svelte'
import { ovens } from '$lib/stores/ovens.svelte'
import { type ComposerUsage } from '../ComposerShoe.svelte'
import { uniqueThreadContextReferences, type ThreadContextReference } from '$lib/thread-context'
import { workspaceState } from '$lib/stores/workspace.svelte'
import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
import { type ExpertSummary } from '$shared/experts'
import { mediaProviderLabel } from '$shared/media-generation'
import { appConfigState } from '$lib/stores/app-config.svelte'
import type {
  ThreadSettings,
  ThinkingLevel,
  ThinkingPreset,
  PermissionLevel,
  PromptAttachment,
  AgentModelSelection,
  ModelProfile,
  Thread
} from '$shared/types'
import type { ChatComposer } from './ChatComposer-board.svelte'
/** One concern of the ChatComposer board. */
export class ChatComposerHandleDropData {
  #root: ChatComposer | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): ChatComposer {
    if (!this.#root)
      throw new Error('ChatComposerHandleDropData read its board before it was bound')
    return this.#root
  }
  constructor(root: ChatComposer) {
    this.#root = root
  }
  /** Base composer settings   the prop when provided, else the global last-used. */
  baseSettings = $derived(this.root.props.settings ?? threadSettingsStore.lastUsed)

  /** Resolved settings   chats run with auto permission review until File System
   *  is enabled, so the level stays pinned to `auto_review` while File System is
   *  off and unlocks (selector visible, up to Full Access) once it is turned on. */
  resolved = $derived<ThreadSettings>(
    this.root.props.hidePermissionSelector && this.baseSettings.fileSystemMode !== true
      ? { ...this.baseSettings, permissionLevel: 'auto_review' as const }
      : this.baseSettings
  )

  /** The remote Oven this composer targets, or null on this computer. */
  targetOvenId = $derived(this.resolved.ovenId ?? null)

  /**
   * Harnesses the target Oven does not have installed.
   *
   * Main keeps a persisted copy of every Oven's harness inventory, refreshed on
   * each probe, so a harness the user installed on the Oven themselves is in
   * this set only after it is actually absent. Null while unknown or local, and
   * the picker then behaves exactly as it does for a local thread.
   */
  unavailableHarnessIds = $derived.by((): ReadonlySet<string> | null => {
    const ovenId = this.targetOvenId
    if (!ovenId || ovenId === 'local') return null
    return ovens.unavailableHarnesses(ovenId)
  })

  unavailableHarnessReason = $derived.by((): string | null => {
    const ovenId = this.targetOvenId
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
  ovenModelUnavailable = $derived(this.unavailableHarnessIds?.has(this.resolved.harnessId) === true)

  /** Why the send is held, shown above the composer while it is. */
  ovenModelNotice = $derived(
    this.ovenModelUnavailable
      ? `${this.unavailableHarnessReason ?? 'That model is not installed on this Oven'}. Choose a model that is available there to send this turn.`
      : ''
  )

  preview = createComposerAttachmentPreview()

  /** Attachments the fullscreen preview can render, in strip order. The pager
   *  walks this list, so an attachment with no preview is skipped instead of
   *  opening as an empty frame. */
  previewableAttachments = $derived(
    this.root.submit.attachments.filter(
      (file) => attachmentPreviewKind(file.mime, file.filename ?? '') !== null
    )
  )

  /** Sibling navigation for the open fullscreen preview, absent when the
   *  composer holds fewer than two previewable attachments. */
  previewPager = $derived.by<PreviewPagerState | undefined>(() => {
    const open = this.preview.file
    if (!open) return undefined
    const list = this.previewableAttachments
    const index = list.findIndex((file) => file.url === open.url)
    if (index === -1 || list.length < 2) return undefined
    return {
      index,
      count: list.length,
      onPrevious: () => {
        const target = list[index - 1]
        if (target) this.preview.open(target)
      },
      onNext: () => {
        const target = list[index + 1]
        if (target) this.preview.open(target)
      }
    }
  })

  /** Image-descriptor gate state: intercepts sending an image to a text-only model. */
  imageDescriptorGateOpen = $state(false)

  gateVisionSelection = $state<AgentModelSelection | null>(null)

  gateDonotAsk = $state(false)

  gateDirect = $state<boolean | undefined>(undefined)

  // Dropdown open state
  plusMenuOpen = $state(false)

  modelMenuOpen = $state(false)

  inferenceMenuOpen = $state(false)

  permissionMenuOpen = $state(false)

  /** Open state of the thinking-level dropdown inside the shared model picker. */
  thinkingMenuOpen = $state(false)

  /** Open state of the account dropdown inside the shared model picker. */
  accountMenuOpen = $state(false)

  /** Whether the shared model picker renders the account picker (more than one
   *  account for the selected provider)   gates the `/account` slash action. */
  accountPickerVisible = $state(false)

  /**
   * The context reading the shoe carries. It is the composer's own data, so it
   * stays out of the shoe contract the host builds. It is always present: the
   * battery is how the user checks what a model choice will cost before sending
   * the first message of a thread, and hovering it is what fetches live quota.
   */
  /** The shared model picker, so the `/profile` action can open its profiles panel. */
  modelPicker: ModelPicker | undefined = $state(undefined)

  startAfterPickerOpen = $state(false)

  // The composer is remounted by the parent when a restore is required, so
  // capture the persisted dependencies exactly once at construction.
  // svelte-ignore state_referenced_locally
  startAfterThreads = $state<StartAfterSelection[]>(
    this.root.props.initialStartAfterThreads.map((t) => ({ ...t }))
  )

  // svelte-ignore state_referenced_locally
  startAfterEnabled = $state(this.root.props.initialStartAfterThreads.length > 0)

  // Attached conversations travel with the draft, so they are captured the same
  // way the restored draft and its dependencies are.
  // svelte-ignore state_referenced_locally
  threadReferences = $state<ThreadContextReference[]>(
    uniqueThreadContextReferences(this.root.props.initialThreadReferences)
  )

  /** Commit a toolbar settings change through the host callback, or fall back to
   *  the global last-used store when this composer owns no thread. */
  applySettings(updated: ThreadSettings): void {
    if (this.root.props.onSettingsChange) this.root.props.onSettingsChange(updated)
    else threadSettingsStore.commit(updated)
  }

  selectPermission(level: PermissionLevel): void {
    this.permissionMenuOpen = false
    this.applySettings(withPermissionLevel(this.resolved, level))
  }

  closeAllMenus(): void {
    this.plusMenuOpen = false
    this.modelMenuOpen = false
    this.inferenceMenuOpen = false
    this.permissionMenuOpen = false
    this.thinkingMenuOpen = false
    this.accountMenuOpen = false
  }

  openStartAfterPicker(): void {
    if (!this.root.props.projectId || this.root.props.readOnlyMode) return
    this.closeAllMenus()
    this.startAfterPickerOpen = true
  }

  toggleStartAfter(enabled: boolean): void {
    if (!enabled) {
      this.startAfterEnabled = false
      this.startAfterThreads = []
      this.root.captureComposerRoot.closeStartAfterPopover()
      this.root.props.onStartAfterThreadsChange?.([])
      return
    }
    if (!this.root.props.projectId || this.root.props.readOnlyMode) return
    this.startAfterEnabled = true
    this.openStartAfterPicker()
  }

  selectStartAfterThread(thread: Thread): void {
    if (thread.id === this.root.props.threadId) return
    if (this.startAfterThreads.some((existing) => existing.id === thread.id)) return
    this.startAfterThreads = [...this.startAfterThreads, { id: thread.id, title: thread.title }]
    this.startAfterEnabled = true
    this.root.props.onStartAfterThreadsChange?.(this.startAfterThreads)
    this.root.captureComposerRoot.focusComposerAtEnd()
  }

  removeStartAfterThread(threadId: string): void {
    this.startAfterThreads = this.startAfterThreads.filter((existing) => existing.id !== threadId)
    if (this.startAfterThreads.length === 0) this.startAfterEnabled = false
    this.root.props.onStartAfterThreadsChange?.(this.startAfterThreads)
  }

  /**
   * Attach a conversation as context for the next message.
   *
   * A thread is attached by identity only: the badge names it, and the turn tells
   * the agent it may look it up. Attaching the thread this composer speaks for is
   * refused, because the agent already holds that conversation.
   */
  attachThreadContext(reference: ThreadContextReference): void {
    if (reference.threadId === this.root.props.threadId) return
    const next = uniqueThreadContextReferences([...this.threadReferences, reference])
    if (next.length === this.threadReferences.length) return
    this.threadReferences = next
    this.root.props.onThreadReferencesChange?.(this.threadReferences)
  }

  removeThreadContext(attachedThreadId: string): void {
    this.threadReferences = this.threadReferences.filter(
      (reference) => reference.threadId !== attachedThreadId
    )
    this.root.props.onThreadReferencesChange?.(this.threadReferences)
  }

  clearThreadContexts(): void {
    if (this.threadReferences.length === 0) return
    this.threadReferences = []
    this.root.props.onThreadReferencesChange?.([])
  }

  /** Toggle the independent (spec-less) audit. Turning it on hands the thread
   *  over to the audit coordinator in the context sidebar. */
  async toggleIndependentAudit(enabled: boolean): Promise<void> {
    await this.root.props.onIndependentAuditToggle?.(enabled)
    if (enabled) this.plusMenuOpen = false
  }

  showModelMenu(): void {
    this.modelMenuOpen = true
    this.plusMenuOpen = false
    this.inferenceMenuOpen = false
    this.thinkingMenuOpen = false
    this.accountMenuOpen = false
  }

  showModelSettingsMenu(): void {
    if (!this.modelSettingsVisible) return
    this.closeAllMenus()
    this.inferenceMenuOpen = true
  }

  /**
   * Open the model picker on its profiles panel, for the `/profile` action.
   *
   * The picker owns that surface, so the ask is one call: it opens its popover and
   * hands the panel to the arrow keys once the panel has mounted.
   */
  showProfilesMenu(): void {
    if (this.root.props.readOnlyMode) return
    this.closeAllMenus()
    this.modelPicker?.openProfiles()
  }

  showThinkingMenu(): void {
    if (!this.supportsThinking) return
    this.thinkingMenuOpen = true
    this.plusMenuOpen = false
    this.modelMenuOpen = false
    this.inferenceMenuOpen = false
    this.accountMenuOpen = false
  }

  showAccountMenu(): void {
    if (!this.accountPickerVisible) return
    this.accountMenuOpen = true
    this.plusMenuOpen = false
    this.modelMenuOpen = false
    this.inferenceMenuOpen = false
    this.thinkingMenuOpen = false
  }

  /**
   * Resolve against every catalog snapshot available to the renderer. The
   * composer can mount with a persisted/partial prop while the live project
   * catalog is still hydrating; merging here prevents that prop from passing
   * an empty thinking-preset override to ModelPicker.
   */
  cachedProviders = $derived(providerCatalog.allCached())

  resolvedProviders = $derived(
    mergeProviderCatalogEntries([
      ...this.cachedProviders,
      ...this.root.props.providers,
      ...this.root.captureComposerRoot.currentProviders
    ])
  )

  /** Catalog entry for the selected harness/provider/model, when reported. */
  selectedProvider = $derived(
    this.resolvedProviders.find(
      (provider) =>
        provider.harnessId === this.resolved.harnessId && provider.id === this.resolved.providerId
    ) ?? this.resolvedProviders.find((provider) => provider.id === this.resolved.providerId)
  )

  /**
   * The selected model's own properties, resolved through the shared store for
   * this composer's account.
   *
   * A model's context windows are stated by its harness, and Codex states them
   * per account, so the merged catalog only ever holds one account's answer.
   * The battery, the context dropdown, and the send path all read this reading,
   * which also reads the account's own answer as soon as the model lands.
   */
  modelRuntimeSelection = $derived({
    projectId: this.root.props.projectId,
    harnessId: this.resolved.harnessId,
    providerId: this.resolved.providerId,
    modelId: this.resolved.modelId,
    accountId: this.resolved.accountId
  })

  runtimeModel = $derived(
    modelRuntime.resolve(
      this.modelRuntimeSelection,
      this.resolvedProviders,
      this.resolved.contextWindow
    )
  )

  selectedModel = $derived(this.runtimeModel.model)

  usageReading = $derived<ComposerUsage>({
    usage: this.root.props.contextUsage,
    previewContextWindow: this.runtimeModel.contextWindow,
    generationRate: this.root.props.generationRate,
    generationDetails: this.root.props.generationDetails,
    efficiencyKpis: this.root.props.efficiencyKpis,
    harnessUsage: this.root.props.harnessUsage,
    canCompact: this.root.props.canCompact,
    compacting: this.root.props.compacting,
    onCompact: this.root.props.onCompact,
    onActivateBankedReset: this.root.props.onActivateBankedReset,
    onReveal: this.root.props.onRevealUsage,
    onHide: this.root.props.onHideUsage,
    refreshing: this.root.props.usageRefreshing
  })

  /**
   * True when this composer has nothing to run a turn with. Sending such a turn
   * only reaches the driver to fail with an unavailable model, so hosts that
   * pass `onNeedsAiAccount` get to show their setup card instead. Hosts that
   * omit the callback keep the old behaviour.
   */
  needsAiAccount = $derived(threadNeedsAiAccount(this.resolved))

  /** True when the selected harness cannot accept any prompt attachments. */
  selectedHarnessLacksAttachments = $derived(this.selectedProvider?.supportsAttachments === false)

  /** True when the catalog reports this model cannot see images and the app's
   *  own vision record does not say otherwise. */
  selectedModelLacksVision = $derived(
    this.selectedModel?.attachment === false && !visionModels.has(this.selectedModel.id)
  )

  attachmentBlockedNotice = $state(false)

  /**
   * Whether sending the draft should be intercepted by the vision-model gate:
   * an image is attached, the active model cannot see it, and the user has not
   * opted into "don't ask again". The card is shown on every such send; the
   * thread or global default merely pre-fills the picker.
   */
  shouldInterceptImageGate(): boolean {
    return (
      this.root.props.enableImageDescriptorGate &&
      this.root.captureComposerRoot.hasImageAttachments &&
      this.selectedModelLacksVision &&
      !this.root.props.imageDescriptorAskAgain
    )
  }

  openImageDescriptorGate(direct?: boolean): void {
    this.gateVisionSelection =
      this.resolved.imageDescriptor ?? this.root.props.imageDescriptorDefault ?? null
    this.gateDonotAsk = false
    this.gateDirect = direct
    this.imageDescriptorGateOpen = true
  }

  /** Persist the chosen vision model (thread + optional global default) and send. */
  confirmImageDescriptorGate(): void {
    const selection = this.gateVisionSelection
    if (!selection) return
    if (this.root.props.onSettingsChange)
      this.root.props.onSettingsChange({ ...this.resolved, imageDescriptor: selection })
    else threadSettingsStore.commit({ ...this.resolved, imageDescriptor: selection })
    if (this.gateDonotAsk) {
      this.root.props.onImageDescriptorDefaultChange?.(selection)
      this.root.props.onImageDescriptorAskAgainChange?.(true)
    }
    this.imageDescriptorGateOpen = false
    this.root.submit.performSend(this.gateDirect)
  }

  /**
   * The provider and model an expert runs on, named from the composer's own
   * catalog so a row reads as one of the models the user can see, not as an id.
   */
  expertModelLabel(expert: ExpertSummary): string {
    // A media craft names a generation model rather than a harness model, and
    // there is no catalog to resolve that against, so the provider's own name is
    // the whole label.
    if (expert.mediaModel) {
      const providerId = appConfigState.mediaGeneration?.providerId
      return `${providerId ? mediaProviderLabel(providerId) : 'Generation'} ${expert.mediaModel}`
    }
    const selection = expert.selection
    if (!selection) return expert.label
    const provider = this.resolvedProviders.find(
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
  thinkingPresets = $derived(
    this.selectedModel ? (this.selectedModel.thinkingPresets ?? []) : STANDARD_THINKING_PRESETS
  )

  /** Thinking controls only appear when the model explicitly declares presets. */
  supportsThinking = $derived(this.thinkingPresets.length > 0)

  modelSettingsVisible = $derived(
    hasModelRuntimeSettings(
      this.runtimeModel.model,
      this.resolved.harnessId,
      this.resolved.providerId
    )
  )

  slash = createComposerSlashActions({
    getModelSettingsVisible: () => this.modelSettingsVisible,
    getProfilesPickerVisible: () => !this.root.props.readOnlyMode,
    getShowChatModes: () => this.root.props.showChatModes,
    getFileSystemMode: () => this.resolved.fileSystemMode,
    getSupportsThinking: () => this.supportsThinking,
    getAccountPickerVisible: () => this.accountPickerVisible,
    getScopePickerVisible: () => this.root.captureComposerRoot.scopePickerAvailable,
    getOvenPickerVisible: () => !!this.root.props.shoe?.onOpenOven,
    getReadingsVisible: () => !!this.root.props.shoe,
    getThinkingPresets: () => this.thinkingPresets,
    getActions: () => this.root.props.actions
  })

  compactBeforeSend = $derived(
    !this.root.props.working &&
      this.root.props.contextUsage?.contextUsed !== undefined &&
      this.usageReading.previewContextWindow !== undefined &&
      this.root.props.contextUsage.contextUsed >=
        Math.round(this.usageReading.previewContextWindow * 0.8)
  )

  toggleFileSystemMode(): void {
    this.applySettings(withFileSystemMode(this.resolved))
  }

  selectModel(
    providerId: string,
    modelId: string,
    nextHarnessId?: string,
    accountId?: string
  ): void {
    this.modelMenuOpen = false
    const nextHarness = nextHarnessId ?? this.resolved.harnessId
    this.root.props.onModelUsed?.(modelKey(nextHarness, providerId, modelId))
    this.applySettings(
      withModelSelection(this.resolved, this.resolvedProviders, {
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
  applyProfile(profile: ModelProfile): void {
    this.closeAllMenus()
    this.root.props.onModelUsed?.(modelKey(profile.harnessId, profile.providerId, profile.modelId))
    const applied = applyModelProfile(this.resolved, profile, this.resolvedProviders)
    this.applySettings(
      this.root.props.hidePermissionSelector && this.resolved.fileSystemMode !== true
        ? { ...applied, permissionLevel: 'auto_review' }
        : applied
    )
  }

  selectThinking(preset: ThinkingPreset): void {
    const level = preset.id as ThinkingLevel
    // The picker may re-emit the level it already applied during a model
    // change   skip the redundant commit.
    if (this.resolved.thinkingLevel === level) return
    this.applySettings(withThinkingLevel(this.resolved, level))
  }

  async addFileAttachments(
    selections: ReadonlyArray<{ path: string; file?: File }>
  ): Promise<void> {
    if (this.root.props.readOnlyMode && !this.root.props.allowAttachments) return
    if (this.selectedHarnessLacksAttachments) {
      this.attachmentBlockedNotice = true
      return
    }
    const candidates = selections.map(({ path, file }) => {
      const filename = file?.name ?? (posixBasename(path.split('?')[0]) || 'file')
      const mime = file?.type || mimeFromPath(path)
      return { mime, url: pathToFileUrl(path), filename }
    })
    if (candidates.length === 0) return

    const added = this.root.submit.adoptAttachments(candidates)
    await Promise.all(added.map((attachment) => this.preview.load(attachment)))
  }

  async addFileAttachment(filePath: string, file?: File): Promise<void> {
    await this.addFileAttachments([{ path: filePath, file }])
  }

  async addPastedTextAttachment(text: string): Promise<void> {
    if (!this.root.props.attachmentStorage)
      throw new Error('Attachment storage is unavailable for this chat.')
    const path = await invoke('attachment:saveText', this.root.props.attachmentStorage, text)
    const attachment: PromptAttachment = {
      mime: 'text/plain',
      url: pathToFileUrl(path),
      filename: 'Pasted text.txt'
    }
    const [added] = this.root.submit.adoptAttachments([attachment])
    if (!added) return
    this.preview.setText(added.url, text)
  }

  async savePastedTextAttachment(attachment: PromptAttachment, text: string): Promise<void> {
    if (!this.root.props.attachmentStorage || !isEditablePastedTextAttachment(attachment)) {
      throw new Error('This attachment is not editable here.')
    }
    await invoke(
      'attachment:saveText',
      this.root.props.attachmentStorage,
      text,
      fileUrlToPath(attachment.url)
    )
    this.preview.setText(attachment.url, text)
  }

  async savePreviewText(text: string): Promise<void> {
    const attachment = this.preview.file
    if (!attachment) throw new Error('The attachment preview is no longer open.')
    await this.savePastedTextAttachment(attachment, text)
  }

  async pickAttachment(): Promise<void> {
    if (this.root.props.readOnlyMode && !this.root.props.allowAttachments) return
    if (this.selectedHarnessLacksAttachments) {
      this.attachmentBlockedNotice = true
      return
    }
    const paths = await invoke('dialog:pickFiles', this.root.props.attachmentStorage)
    await this.addFileAttachments(paths.map((path) => ({ path })))
    this.root.submit.focusComposerAtSavedCaret()
  }

  /**
   * Attach whatever a conversation drop carried.
   *
   * A drop out of a web page hands over a link and no file (Chromium keeps the
   * files to itself across documents), so a drop that brought no files is read as
   * the media links it named and those are fetched into attachment storage.
   */
  async handleDropData(dt: DataTransfer | null): Promise<void> {
    if (this.root.props.readOnlyMode && !this.root.props.allowAttachments) return
    if (!dt) return
    // A thread row carried in is context, not a file: it attaches by identity,
    // never touches attachment storage, and a model that takes no files can still
    // be given one.
    const carriedThread = droppedThread(dt)
    if (carriedThread) {
      this.attachThreadContext({
        projectId: carriedThread.projectId,
        threadId: carriedThread.threadId,
        title: carriedThread.title
      })
      this.root.submit.focusComposerAtSavedCaret()
      return
    }
    if (this.selectedHarnessLacksAttachments) {
      this.attachmentBlockedNotice = true
      return
    }
    const { files, urls } = readComposerDrop(dt)
    if (files.length > 0) {
      for (const file of files) {
        try {
          const filePath = await window.api.registerFileSelection(
            file,
            this.root.props.attachmentStorage
          )
          if (filePath) await this.addFileAttachment(filePath, file)
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
    await this.attachRemoteMedia(urls)
  }

  /** Fetch the links one drop named and attach each file that comes back. */
  async attachRemoteMedia(urls: readonly string[]): Promise<void> {
    if (!this.root.props.attachmentStorage) {
      showToastWarning('This chat has nowhere to store an attachment.')
      return
    }
    for (const url of urls) {
      try {
        const filePath = await invoke(
          'attachment:retainRemote',
          this.root.props.attachmentStorage,
          url
        )
        await this.addFileAttachment(filePath)
      } catch (error) {
        showToastWarning(ipcErrorMessage(error, 'That link could not be attached.'))
      }
    }
  }

  pasteContext: ComposerPasteContext = {
    getReadOnlyMode: () => this.root.props.readOnlyMode,
    getAllowAttachments: () => this.root.props.allowAttachments,
    getValue: () => this.root.submit.value,
    getAttachmentStorage: () => this.root.props.attachmentStorage,
    getSelectedHarnessLacksAttachments: () => this.selectedHarnessLacksAttachments,
    getOwnFileCopy: () => {
      const copied = projectFilesWorkspace.clipboard
      if (!copied) return null
      // Tags only target a file when the copy came from the same project and the
      // same scope bucket they are relative to; anything else has to travel as
      // the files themselves.
      const sameProject =
        copied.projectId === this.root.props.projectId &&
        (!this.root.props.projectId ||
          copied.scopeBucketId === workspaceState.activeScopeBucketIdFor(this.root.props.projectId))
      return { paths: copied.paths, sameProject }
    },
    addPastedTextAttachment: this.addPastedTextAttachment,
    addFileAttachment: this.addFileAttachment,
    setTextAttachmentError: (message) =>
      (this.root.captureComposerRoot.textAttachmentError = message),
    setAttachmentBlockedNotice: (blocked) => (this.attachmentBlockedNotice = blocked)
  }
}
