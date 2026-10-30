import type { ComposerRelocationRequest } from '../composer-relocation'
import { type StartAfterSelection } from '../chat-composer-attachments'
import { type ComposerAssistantTag } from '../composer-mentions'
import { type ComposerShoeData } from '../ComposerShoe.svelte'
import { type ThreadContextReference } from '$lib/thread-context'
import type { ActionDefinition, ActionSelection } from '$lib/actions'
import type {
  ThreadSettings,
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
  EngineeringLifecycleSelectionInput,
  EngineeringLifecycleState,
  HarnessAccount
} from '$shared/types'

export interface Props {
  /** Called with the trimmed message and attachments when the user sends.
   *  `direct` is true when the message must be force-delivered as a steer
   *  into a live turn (Cmd/Ctrl+Shift+Enter); busy parents queue otherwise. */
  onSend: (
    message: string,
    attachments: PromptAttachment[],
    direct?: boolean,
    projectReferences?: PromptProjectReference[],
    taskReferences?: PromptAssignmentTaskReference[],
    startAfterThreads?: StartAfterSelection[],
    threadReferences?: ThreadContextReference[]
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
  /** Restart-safe conversations attached to this composer as context. */
  initialThreadReferences?: ThreadContextReference[]
  /** Persists or clears the conversations attached to this composer. */
  onThreadReferencesChange?: (references: ThreadContextReference[]) => void
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
  onEngineeringLifecycleSelect?: (input: EngineeringLifecycleSelectionInput) => void | Promise<void>
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
  onReorderFavorite?: (draggedKey: string, targetKey: string, position: 'before' | 'after') => void
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
/**
 * The surface props as the units read them.
 *
 * A prop the component destructures with a default (`active = true`) is never
 * `undefined` inside the surface, so those keys are required here and lose
 * `undefined`; every other prop keeps the optionality the surface declared.
 */
export type ChatComposerSurfaceProps = {
  [
    K in
      | 'disabled'
      | 'working'
      | 'stackedAbove'
      | 'placeholder'
      | 'autofocus'
      | 'actions'
      | 'providers'
      | 'harnessId'
      | 'projectId'
      | 'threadId'
      | 'assignmentTasks'
      | 'assistantTags'
      | 'initialValue'
      | 'initialAttachments'
      | 'initialProjectReferences'
      | 'initialTaskReferences'
      | 'initialStartAfterThreads'
      | 'initialThreadReferences'
      | 'references'
      | 'showEngineeringMode'
      | 'engineeringLifecycle'
      | 'showChatModes'
      | 'independentAuditAvailable'
      | 'independentAuditEnabled'
      | 'engineeringToolboxHidden'
      | 'hidePermissionSelector'
      | 'readOnlyMode'
      | 'allowAttachments'
      | 'favoriteModels'
      | 'recentModels'
      | 'harnessUsage'
      | 'usageRefreshing'
      | 'canCompact'
      | 'compacting'
      | 'historyMessages'
      | 'imageDescriptorAskAgain'
      | 'enableImageDescriptorGate'
  ]-?: Exclude<Props[K], undefined>
} & Omit<
  Props,
  | 'disabled'
  | 'working'
  | 'stackedAbove'
  | 'placeholder'
  | 'autofocus'
  | 'actions'
  | 'providers'
  | 'harnessId'
  | 'projectId'
  | 'threadId'
  | 'assignmentTasks'
  | 'assistantTags'
  | 'initialValue'
  | 'initialAttachments'
  | 'initialProjectReferences'
  | 'initialTaskReferences'
  | 'initialStartAfterThreads'
  | 'initialThreadReferences'
  | 'references'
  | 'showEngineeringMode'
  | 'engineeringLifecycle'
  | 'showChatModes'
  | 'independentAuditAvailable'
  | 'independentAuditEnabled'
  | 'engineeringToolboxHidden'
  | 'hidePermissionSelector'
  | 'readOnlyMode'
  | 'allowAttachments'
  | 'favoriteModels'
  | 'recentModels'
  | 'harnessUsage'
  | 'usageRefreshing'
  | 'canCompact'
  | 'compacting'
  | 'historyMessages'
  | 'imageDescriptorAskAgain'
  | 'enableImageDescriptorGate'
>
