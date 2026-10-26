import type { AgentDefaultsConfig, AuxiliaryAgentConfig, RankingJudgeConfig } from './agent'
import type { CioCleanupCategoryId } from './cio-cleanup'
import type { AgentModelSelection, InferenceMode, PermissionLevel, ThinkingLevel } from './common'
import type { GitPullPreference, PrMergeMethod } from './git'
import type { MediaProviderId } from '../media-generation'
import type { BrowserSearchEngine } from '../browser-search-engines'

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

/**
 * How far the text and rule tokens are pushed away from their surfaces.
 *
 * `normal` is the shipped palette. The two stronger levels redraw the same
 * tokens at roughly twice and three times their original contrast, so the
 * interface stays readable on a washed-out or badly calibrated display without
 * changing a single layout measure. Every level is a palette, never a filter:
 * the hue of each token is kept, so `danger` still reads red and `accent` still
 * reads gold.
 */
export type ContrastLevel = 'normal' | 'more' | 'intense'

/** Every contrast level, in increasing order. */
export const CONTRAST_LEVELS: readonly ContrastLevel[] = ['normal', 'more', 'intense']

export const DEFAULT_CONTRAST_LEVEL: ContrastLevel = 'normal'

/** Whether an untrusted value is a contrast level this build understands. */
export function isContrastLevel(value: unknown): value is ContrastLevel {
  return typeof value === 'string' && (CONTRAST_LEVELS as readonly string[]).includes(value)
}

export type SlashCommandMode = 'app' | 'passthrough'

export type MemoryCategory = 'behavioral' | 'project-rule' | 'identity' | 'preference' | 'models'

export type MemoryPriority = 'critical' | 'high' | 'medium' | 'low'

/**
 * An audience a memory can be loaded for: the surfaces that receive
 * persistent memory. An entry applies to every audience when its scope set is
 * empty.
 */
export type MemoryAudience = 'projects' | 'chat' | 'assistant' | 'browser'

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
  assistantId?: string
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
  assistantId?: string
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

/**
 * What a design assignment produces, which is what decides how a session
 * reaches it.
 *
 * `text` work is answered by the assigned model itself. A media output names the
 * model the user wants for that media, because not every model generates a
 * picture or a clip, and the ones that do are usually picked for exactly that.
 */
export type DesignAssignmentOutput = 'text' | 'image' | 'video' | 'audio'

/**
 * One named piece of design work and the model the user assigned to it.
 *
 * The model is the user's choice and is never chosen by the app or by an agent
 * working in a design session: an assignment with no model is inert rather than
 * routed somewhere plausible.
 */
export interface DesignAssignment {
  /** Stable handle an agent names in a tool call, e.g. `image-generation`. */
  id: string
  /** Human name shown in settings, e.g. `Image generation`. */
  label: string
  /**
   * What the work produces. A stored assignment written before this field
   * existed has none, which reads as `text`.
   */
  produces?: DesignAssignmentOutput
  /** Standing guidance handed to the assigned model with every call. */
  instructions?: string
  /**
   * The harness model that does this work. Required for a text craft, and absent
   * for a media craft, which names a generated-media model instead.
   */
  selection?: AgentModelSelection
  /**
   * The generation model that produces this craft's asset, in the configured
   * provider's own spelling (`black-forest-labs/flux-1.1-pro`). Required for a
   * media craft, and absent for a text craft.
   */
  mediaModel?: string
}

/** Design work the user routed to a model of their own choosing. */
export interface DesignConfig {
  /** User-authored assignments. Empty means nothing is delegated anywhere. */
  assignments: DesignAssignment[]
}

/**
 * A named preset for how a conversation runs: which harness and model, how hard
 * it thinks, how fast it answers, and how much it is allowed to touch.
 *
 * A profile is what the user re-picks instead of re-tuning five separate
 * controls, so it captures the whole shape of a run rather than the model alone.
 *
 * Stores the selected account handle and optional context-window override.
 */
export interface ModelProfile {
  /** Stable handle the profile row is keyed by. */
  id: string
  /** Human name the user typed, e.g. `Deep review`. */
  name: string
  /** Harness that runs the conversation, e.g. `opencode`. */
  harnessId: string
  /** Provider under that harness, e.g. `anthropic`. */
  providerId: string
  /** Model under that provider. */
  modelId: string
  /** Reasoning effort, resolved against the model's presets when applied. */
  thinkingLevel: ThinkingLevel
  /** Speed tier: `normal` (standard), `fast`, or `ultrafast`. */
  inferenceMode: InferenceMode
  /** How tool-call permissions are handled while the profile is active. */
  permissionLevel: PermissionLevel
  /** Account handle, never the credential itself. */
  accountId?: string
  /** Context-window override in tokens; null restores the harness default. */
  contextWindow?: number | null
}

/**
 * The backend that turns a prompt into an image, a clip or a track.
 *
 * One provider at a time, because one aggregator token already reaches many
 * models: the user's real choice is the model they assign to each craft, which
 * lives on the design assignment rather than here. The token itself is kept in
 * the secure vault and never in this config.
 */
export interface MediaGenerationConfig {
  /** The backend the app calls, or null while the user has not chosen one. */
  providerId: MediaProviderId | null
}

/** Bounds for `AppConfig.browserHibernationMinutes`. */
export const MIN_BROWSER_HIBERNATION_MINUTES = 5
export const MAX_BROWSER_HIBERNATION_MINUTES = 120
export const DEFAULT_BROWSER_HIBERNATION_MINUTES = 30

/**
 * Bounds for `AppConfig.browserHistoryLimit`, how many pages the browser's
 * history keeps. Older visits evict for newer ones once the cap is reached, so
 * the setting trades a longer memory against the size of the stored file.
 */
export const MIN_BROWSER_HISTORY_LIMIT = 50
export const MAX_BROWSER_HISTORY_LIMIT = 10_000
export const DEFAULT_BROWSER_HISTORY_LIMIT = 1_000

/**
 * How the app behaves once its last window closes.
 *
 * - `off` is the original behaviour: closing the last window quits the process.
 * - `scheduled` keeps the backend alive while work is running or due inside the
 *   wake lead, so a routine can fire on time from the menu bar.
 * - `always` never quits on close.
 */
export type BackgroundMode = 'off' | 'scheduled' | 'always'

/** Bounds for `AppConfig.backgroundWakeLeadMs`. */
export const MIN_BACKGROUND_WAKE_LEAD_MS = 0
export const MAX_BACKGROUND_WAKE_LEAD_MS = 30 * 60 * 1000
export const DEFAULT_BACKGROUND_WAKE_LEAD_MS = 2 * 60 * 1000

/** Bounds for `AppConfig.maxBackgroundWakeHoldMs`, the hard awake-time cap. */
export const MIN_MAX_BACKGROUND_WAKE_HOLD_MS = 60 * 1000
export const MAX_MAX_BACKGROUND_WAKE_HOLD_MS = 60 * 60 * 1000
export const DEFAULT_MAX_BACKGROUND_WAKE_HOLD_MS = 10 * 60 * 1000

/**
 * This process's role against the shared config root's single backend.
 *
 * There is exactly one backend per config root (one database, one scheduler),
 * and exactly one running process owns the scheduled work for it. A secondary
 * instance keeps a fully usable window but schedules nothing and shows the
 * "running in another instance" notice.
 */
export interface InstanceRole {
  /** `owner` runs scheduled work; `secondary` is a window into the owner. */
  role: 'owner' | 'secondary'
  /** Process id of the elected owner, or 0 when it could not be resolved. */
  ownerPid: number
}

export interface AppConfig {
  /** Sensitive-file protection applies exclusively to the app-bundled Pi runtime. */
  bundledPiSensitiveFilePatterns?: string[]
  /** Disables the entire bundled-Pi sensitive-file check when explicitly false. */
  bundledPiSensitiveFileProtectionEnabled?: boolean
  theme: ThemePreference
  /** Font family id used across the app UI. */
  fontFamily: string
  /** Base font size in px for the app UI; scales all rem-based text. */
  appFontSize: number
  /** Base font weight for app text (Light 300 / Regular 400 / Medium 500). */
  fontWeight: number
  /** How hard the palette pushes text and rules away from its surfaces. */
  contrastLevel: ContrastLevel
  /** UI zoom level (Electron zoomFactor). 1 = 100%. */
  zoomLevel: number
  /** True after the user finishes or dismisses the first-run setup guide. */
  onboardingCompleted: boolean
  /** Explicit consent for anonymous installation usage statistics. */
  shareAnonymousUsage?: boolean
  threadLimit: number
  /**
   * The Ctrl+Tab thread switcher also lists each open terminal tab, so the tabs
   * of a panel that keeps its own strip are reachable without a click. On by
   * default; the tabs it adds are the ones open for the active project.
   */
  switcherTerminalTabs: boolean
  /** The Ctrl+Tab thread switcher also lists each open project file tab. */
  switcherFileTabs: boolean
  /** The Ctrl+Tab thread switcher also lists each tab of the thread browser. */
  switcherThreadBrowserTabs: boolean
  /** Time before a pending agent question automatically selects its recommendation. */
  questionTimeoutMs: number
  /** Maximum questions one structured agent question card can carry (cio_ask_user). */
  agentQuestionCap: number
  /** Standard stdio LSP configurations shared by project trees. Enabling IDE Mode remains local to each tree. */
  ideLanguageServers?: import('../ide-language-servers').IdeLanguageServer[]
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
  /** Model the user assigned to each named design assignment (images, copy, video). */
  design: DesignConfig
  /** Named presets the user can apply from the model picker to shape a whole run. */
  modelProfiles: ModelProfile[]
  /** Backend that generates images, clips and sound for a design or a composition. */
  mediaGeneration: MediaGenerationConfig
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
  /**
   * Route every other (non-loopback) link into the workspace browser of the
   * project/thread it was activated in, instead of the system browser. Off by
   * default. Localhost keeps its own preference because it always belongs to the
   * surface it was clicked in, while this is the general default that a future
   * project-less global browser will extend.
   */
  openAllLinksInCioBrowser: boolean
  /**
   * Minutes a global-browser tab may sit idle before it hibernates. Bounded to
   * `MIN/MAX_BROWSER_HIBERNATION_MINUTES`.
   */
  browserHibernationMinutes: number
  /**
   * How many pages the browser's browsing history keeps. Bounded to
   * `MIN/MAX_BROWSER_HISTORY_LIMIT`; older visits evict for newer ones.
   */
  browserHistoryLimit: number
  /**
   * Let a page keep a shortcut the app also binds. On by default: a page that
   * handles a chord itself (its own find, its own save) wins it, and a chord the
   * page does not handle bubbles up to the app, which runs its own action. Off
   * makes the app win every chord whether the page is focused or not.
   */
  browserAllowSiteKeymapOverride: boolean
  /**
   * How the app behaves once its last window closes. On by default (`scheduled`)
   * so Assistant routines can fire while the window is closed.
   */
  backgroundMode: BackgroundMode
  /**
   * Launch CodeInOven at login so a schedule can fire after a restart. Off
   * until the user asks for it: the app offers it once, after the first
   * routine's how-to is saved, and never assumes the answer.
   */
  launchAtLogin: boolean
  /**
   * True once the one-time start-at-login offer has been answered. The offer is
   * raised only when a routine gets its first how-to, and this flag is saved
   * with the answer, so no later routine setup asks again.
   */
  launchAtLoginPrompted: boolean
  /** Run assistant slots missed to sleep or a closed app when the app returns. */
  autoRunMissedAssistantRuns: boolean
  /** How long before a due run the app holds the machine awake. Bounded to
   *  `MIN/MAX_BACKGROUND_WAKE_LEAD_MS`. */
  backgroundWakeLeadMs: number
  /** Hard cap on uninterrupted awake time held for background scheduling.
   *  Bounded to `MIN/MAX_MAX_BACKGROUND_WAKE_HOLD_MS`. */
  maxBackgroundWakeHoldMs: number
  /**
   * Search engine id used when typed address text is not a URL. Names a built-in
   * engine or one of `browserCustomSearchEngines`; an unknown id falls back to
   * the shipped default.
   */
  browserSearchEngine: string
  /** User-added search engines, offered after the built-ins. */
  browserCustomSearchEngines: BrowserSearchEngine[]
  /**
   * Let prototype previews load fonts, styles, and scripts from the approved
   * CDNs. Off confines every prototype to assets inlined in its own folder.
   */
  allowPrototypeExternalCdn: boolean
  /** Extra CDN origins the user approved, merged after the app's own list. */
  prototypeCdnAllowlist: string[]
  /** Quieter in-app alert played with the toast while the app is focused. */
  inAppNotificationSound: InAppNotificationSoundSettings
  /** Local speech capture, cleanup, model, cue, history, and playback preferences. */
  sound: import('../speech/types').SpeechSettings
  /**
   * Age in days after which CIO Cleanup deletes content of a workspace's `.cio`
   * scratch folder. Bounded to `MIN/MAX_CIO_CLEANUP_RETENTION_DAYS`.
   */
  cioCleanupRetentionDays: number
  /**
   * `.cio` folders the sweep never enters, by category. A fresh install keeps
   * designs, videos, and installed utilities, leaving the four scratch folders
   * sweepable; the settings page toggles the list.
   */
  cioCleanupExcludedCategories: CioCleanupCategoryId[]
}

/** Bounds for `AppConfig.cioCleanupRetentionDays`. */
export const MIN_CIO_CLEANUP_RETENTION_DAYS = 1
export const MAX_CIO_CLEANUP_RETENTION_DAYS = 365
export const DEFAULT_CIO_CLEANUP_RETENTION_DAYS = 30

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
    | 'bundledPiSensitiveFilePatterns'
    | 'bundledPiSensitiveFileProtectionEnabled'
    | 'fontFamily'
    | 'appFontSize'
    | 'fontWeight'
    | 'contrastLevel'
    | 'zoomLevel'
    | 'onboardingCompleted'
    | 'shareAnonymousUsage'
    | 'threadLimit'
    | 'switcherTerminalTabs'
    | 'switcherFileTabs'
    | 'switcherThreadBrowserTabs'
    | 'questionTimeoutMs'
    | 'agentQuestionCap'
    | 'slashCommandMode'
    | 'ideLanguageServers'
    | 'preferredEditor'
    | 'memory'
    | 'agentDefaults'
    | 'auxiliaryAgents'
    | 'design'
    | 'modelProfiles'
    | 'mediaGeneration'
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
    | 'openAllLinksInCioBrowser'
    | 'browserHibernationMinutes'
    | 'browserHistoryLimit'
    | 'browserAllowSiteKeymapOverride'
    | 'backgroundMode'
    | 'launchAtLogin'
    | 'launchAtLoginPrompted'
    | 'autoRunMissedAssistantRuns'
    | 'backgroundWakeLeadMs'
    | 'maxBackgroundWakeHoldMs'
    | 'browserSearchEngine'
    | 'browserCustomSearchEngines'
    | 'allowPrototypeExternalCdn'
    | 'prototypeCdnAllowlist'
    | 'inAppNotificationSound'
    | 'sound'
    | 'cioCleanupRetentionDays'
    | 'cioCleanupExcludedCategories'
  >
>
