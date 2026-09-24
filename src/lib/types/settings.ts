import type { AgentDefaultsConfig, AuxiliaryAgentConfig, RankingJudgeConfig } from './agent'
import type { GitPullPreference, PrMergeMethod } from './git'

export interface WorkflowStage {
  id: string
  name: string
  description: string
  requiredArtifacts: string[]
  gateConditions: string[]
  promptTemplate: string
}

export type WorkflowRuleTrigger = 'stage_change' | 'thread_start' | 'error' | 'completion'

export type WorkflowRuleAction = 'notify' | 'inject_prompt' | 'create_task' | 'block'

export interface WorkflowRule {
  trigger: WorkflowRuleTrigger
  action: WorkflowRuleAction
  config: Record<string, unknown>
}

export interface WorkflowConfig {
  name: string
  stages: WorkflowStage[]
  rules: WorkflowRule[]
}

export interface RemoteConnection {
  id: string
  name: string
  host: string
  port: number
  auth: { type: 'key' | 'password'; keyPath?: string }
  remotePath: string
}

/** Editors / terminals CodeInOven can open a project folder with. */
export type EditorId =
  | 'system'
  | 'terminal'
  | 'iterm2'
  | 'ghostty'
  | 'cmux'
  | 'warp'
  | 'kitty'
  | 'alacritty'
  | 'vscode'
  | 'cursor'
  | 'zed'
  | 'webstorm'
  | 'idea'

/** A detected editor available on this machine. */
export interface EditorInfo {
  id: EditorId
  name: string
  /** Whether the editor was found installed on this machine. */
  available: boolean
  /** Native application icon as a data-URL (PNG), extracted from the .app bundle. */
  iconDataUrl?: string
}

export type ThemePreference = 'light' | 'dark' | 'system'

export type SlashCommandMode = 'app' | 'passthrough'

export type MemoryCategory = 'behavioral' | 'project-rule' | 'identity' | 'preference' | 'models'

export type MemoryPriority = 'critical' | 'high' | 'medium' | 'low'

/**
 * An audience a memory can be loaded for: the three surfaces that receive
 * persistent memory. An entry applies to every audience when its scope set is
 * empty.
 */
export type MemoryAudience = 'projects' | 'chat' | 'assistant'

/**
 * One scope a memory carries: an audience, or a single place inside an
 * audience (`project`/`thread` for projects, `routine`/`task` for assistants).
 *
 * A scope set is either audience-level (any subset of `MemoryAudience`, empty
 * meaning every audience) or exactly one place. It is never both.
 */
export type MemoryScope = MemoryAudience | 'project' | 'thread' | 'routine' | 'task'

export type MemorySource = 'manual' | 'auto-detected'

export interface MemoryEntry {
  id: string
  label: string
  content: string
  enabled: boolean
  createdAt: number
  updatedAt: number
  category: MemoryCategory
  priority: MemoryPriority
  /** Audiences/places this memory applies to; empty means every audience. */
  scopes: MemoryScope[]
  source: MemorySource
  frequency: number
  lastReinforced: number
  projectId?: string
  threadId?: string
  /** Set by routine-scoped memory: the routine whose tasks receive it. */
  routineId?: string
  /** Harness-scoped model keys for model-specific memories. */
  modelKeys?: string[]
}

export interface MemoryConfig {
  /** Whether persistent memory is sent to project agents (global + projects + project + thread). */
  enabled: boolean
  /** Whether persistent memory is sent to chat agents (global + chat + thread). */
  chatEnabled: boolean
  entries: MemoryEntry[]
}

export interface MemoryProposal {
  id: string
  label: string
  content: string
  category: MemoryCategory
  priority: MemoryPriority
  /** Audiences/places this proposal would apply to; empty means every audience. */
  scopes: MemoryScope[]
  projectId?: string
  threadId?: string
  /** Set by a routine-scoped proposal: the routine whose tasks receive it. */
  routineId?: string
  /** Harness-scoped model keys for model-specific proposals. */
  modelKeys?: string[]
  createdAt: number
  expiresAt: number
  status: 'pending' | 'approved' | 'rejected'
}

/** A completed turn whose memory extraction failed and is queued for retry. */
export interface DeferredMemoryExtraction {
  id: string
  projectId?: string
  threadId?: string
  /** Capped user material captured at gate time. */
  userMessage: string
  /** Capped assistant material captured at gate time. */
  assistantResponse: string
  /** Capped user message from the preceding turn, when the thread had one. */
  previousUserMessage?: string
  /** Why the first extraction attempt failed (for diagnostics). */
  reason: string
  createdAt: number
  attempts: number
  lastError?: string
  lastAttemptAt?: number
}

/** Which bucket of memory an export/import targets. */
export type MemoryExportKind = 'projects' | 'chats' | 'assistant' | 'both' | 'project'

/** The on-disk JSON shape written by a memory export and read by an import. */
export interface MemoryExportFile {
  format: 'codeinoven-memory'
  version: 1
  exportedAt: number
  kind: MemoryExportKind
  /** Present only when `kind === 'project'` (the sidebar project export). */
  projectId?: string
  entries: MemoryEntry[]
}

/** Preview of an imported memory file, returned before anything is applied. */
export interface MemoryImportPreview {
  format: string
  version: number
  kind: MemoryExportKind
  projectId?: string
  entryCount: number
  entries: MemoryEntry[]
}

/**
 * Which in-app (toast) alerts play a sound while the app is focused.
 *
 * While the app is in the background the same notifications deliver an OS card
 * and the louder off-app alert, which is not configurable. When the app is in
 * front the user only sees the toast, so this quieter alert announces the exact
 * same events. The two groups are independent: a user may keep just one.
 */
export interface InAppNotificationSoundSettings {
  /** Agent finished, chat finished, or a specification is ready to review. */
  success: boolean
  /** An agent needs attention or a run failed. */
  issue: boolean
}

/** Both in-app alert groups on: the quieter alert is an attention cue, not a chime. */
export const DEFAULT_IN_APP_NOTIFICATION_SOUND: InAppNotificationSoundSettings = {
  success: true,
  issue: true
}

export interface AppConfig {
  theme: ThemePreference
  /** Font family id used across the app UI. */
  fontFamily: string
  /** Base font size in px for the app UI; scales all rem-based text. */
  appFontSize: number
  /** Base font weight for app text (Light 300 / Regular 400 / Medium 500). */
  fontWeight: number
  /** UI zoom level (Electron zoomFactor). 1 = 100%. */
  zoomLevel: number
  /** True after the user finishes or dismisses the first-run setup guide. */
  onboardingCompleted: boolean
  threadLimit: number
  /** Time before a pending agent question automatically selects its recommendation. */
  questionTimeoutMs: number
  /** Maximum questions one structured agent question card can carry (cio_ask_user). */
  agentQuestionCap: number
  keybindings: Record<string, string>
  /** How slash commands are handled: in-app actions or forwarded to the harness. */
  slashCommandMode: SlashCommandMode
  /** Preferred editor used by “Open in Editor”. `system` falls back to the OS default. */
  preferredEditor: EditorId
  /** Last directory chosen in the folder-picker dialog, so it opens there next time. */
  lastFolderDialogPath?: string
  /** Last directory chosen in the file-attachment dialog, so it opens there next time. */
  lastAttachmentDialogPath?: string
  /** Explicit, user-authored preferences; never mined silently from conversations. */
  memory: MemoryConfig
  /** User-selected defaults for Engineering agent roles. Roles remain unset after installation. */
  agentDefaults: AgentDefaultsConfig
  /** Model each harness uses for auxiliary work, keyed by the harness a thread runs on. */
  auxiliaryAgents: AuxiliaryAgentConfig
  /** Model that judges ranking conversations, and whether it is pinned at all. */
  rankingJudge: RankingJudgeConfig
  /** Editable default behavior prompt for project Engineering implementation turns. */
  agentBehaviorPrompt: string
  /** Automatically download available updates in the background. */
  autoDownloadUpdates: boolean
  /** Automatically quit and install after an update is downloaded. */
  autoInstallUpdates: boolean
  /** Update channel to receive over-the-air updates from. `stable` is the default; `nightly` opts into prerelease builds. */
  updateChannel: 'stable' | 'nightly'
  /** Prevent sleep while a harness is actively working; review-ready spec threads stay idle. */
  keepAwakeWhileWorking: boolean
  /** When true, sending an image to a text-only model auto-uses the configured
   *  image descriptor model instead of showing the vision-model picker card. */
  imageDescriptorAskAgain: boolean
  /** Automatically resume threads whose turn ended in a usage/rate-limit reset
   *  once the reported reset time passes. Only applies to harnesses that do not
   *  schedule their own provider retries (OpenCode manages its own). */
  autoRetryAfterReset: boolean
  /** Resume regular and Sr. Engineer threads that were interrupted by an app
   *  closure or unknown issue when the app restarts. */
  resumeWorkOnRestart: boolean
  /** Default PR merge method used by the Git panel, pre-selected when merging. */
  defaultMergeMethod: PrMergeMethod
  /** Pull strategy used by the Git panel. `ask` opens the strategy chooser. */
  defaultPullStrategy: GitPullPreference
  /** Hunks whose changed lines exceed this are collapsed with a notice so huge
   *  diffs do not hurt diff-view performance. */
  maxDiffLines: number
  /** Conflicted files larger than this open in the plain file editor instead of
   *  the merge editor. Bounded to 0.25-2 MiB by `MIN/MAX_MAX_CONFLICT_FILE_BYTES`. */
  maxConflictFileBytes: number
  /** Route loopback development links into the app-scoped test browser. */
  openLocalhostInCioBrowser: boolean
  /** Quieter in-app alert played with the toast while the app is focused. */
  inAppNotificationSound: InAppNotificationSoundSettings
  /** Local speech capture, cleanup, model, cue, history, and playback preferences. */
  sound: import('../speech/types').SpeechSettings
}

/** A single layer of the assembled prompt/behavior display. */
export interface BehaviorLayer {
  title: string
  content: string
  editable: boolean
  defaultOpen: boolean
}

/** Renderer-editable settings. Internal config fields cannot be patched over IPC. */
export type AppConfigPatch = Partial<
  Pick<
    AppConfig,
    | 'theme'
    | 'fontFamily'
    | 'appFontSize'
    | 'fontWeight'
    | 'zoomLevel'
    | 'onboardingCompleted'
    | 'threadLimit'
    | 'questionTimeoutMs'
    | 'agentQuestionCap'
    | 'slashCommandMode'
    | 'preferredEditor'
    | 'memory'
    | 'agentDefaults'
    | 'auxiliaryAgents'
    | 'rankingJudge'
    | 'agentBehaviorPrompt'
    | 'autoDownloadUpdates'
    | 'autoInstallUpdates'
    | 'updateChannel'
    | 'keepAwakeWhileWorking'
    | 'imageDescriptorAskAgain'
    | 'autoRetryAfterReset'
    | 'resumeWorkOnRestart'
    | 'defaultMergeMethod'
    | 'defaultPullStrategy'
    | 'maxDiffLines'
    | 'maxConflictFileBytes'
    | 'openLocalhostInCioBrowser'
    | 'inAppNotificationSound'
    | 'sound'
  >
>
