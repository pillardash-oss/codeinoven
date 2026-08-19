import type {
  AgentEvent,
  AgentMessage,
  AgentQuestionRequest,
  AgentRateLimitWindow,
  AgentUsageCredits,
  PromptAttachment,
  ThreadSettings,
  ProviderCatalog,
  HarnessCommand,
  PermissionReply,
  ResolvedUtility,
  UtilityKind
} from '../../lib/types'

/** Callback invoked whenever the harness emits a streaming event. */
export type AgentEventCallback = (event: AgentEvent) => void

/** Features a harness can reliably provide to CodeInOven. */
export interface HarnessCapabilities {
  /** Truthful process topology used for app-wide host and RAM policy. */
  runtimeTopology: {
    kind: 'shared_server' | 'shared_daemon' | 'embedded' | 'turn_process'
    scope: 'application' | 'session'
    /** Upstream may still create one worker process for each executing session. */
    sessionWorkers?: boolean
  }
  streaming: boolean
  /** Can append user input to the provider's currently active turn. */
  steering: boolean
  nativeResume: boolean
  messageHistory: 'native' | 'mirrored'
  interactivePermissions: boolean
  attachments: boolean
  commands: boolean
  providerCatalog: boolean
  /** Emits structured waiting/error lifecycle events instead of silent stalls. */
  sessionStatus: boolean
  /** Reports model context limits and per-turn token/cost telemetry. */
  contextUsage: boolean
  /** Supports an explicit user-requested context compaction. */
  compaction: boolean
  /** Emits provider-normalized child-agent lifecycle activity. */
  subagents: boolean
  /** Can force a model response through a validated JSON-schema output tool. */
  structuredOutput?: boolean
  /** Utility capabilities already supplied natively by this harness. */
  nativeUtilities?: UtilityKind[]
  /**
   * The harness schedules and performs its own provider retry after a reset
   * (it emits a `waiting` session status with `retryAt` and resumes the turn
   * itself). The app records every harness's reset wait in the retry scheduler
   * so it survives an app restart; harnesses that resume their own turns simply
   * clear that record when they resume (`session.status` `working`).
   */
  scheduledRetry?: boolean
}

/** Provider-neutral JSON-schema output request for deterministic agent results. */
export interface StructuredOutputRequest {
  schema: Record<string, unknown>
  retryCount?: number
}

/** Raw effective definition reported by a harness for one provider/model. */
export interface HarnessToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Provider-neutral input supplied when a harness prepares utility injection. */
export interface UtilityRuntimePreparationRequest {
  projectPath: string
  /** Selected provider for this turn, when the harness exposes provider selection. */
  providerId?: string
  resolvedUtilities: ResolvedUtility[]
}

/** One ephemeral configuration file requested by a harness adapter. */
export interface UtilityRuntimeConfigFile {
  /** Stable caller-facing key used to retrieve the materialized absolute path. */
  id: string
  /** Relative path beneath the isolated runtime configuration directory. */
  relativePath: string
  content: string
}

/**
 * Harness-specific additions to a provider-neutral utility activation plan.
 * Values remain inert until UtilityRuntimeService materializes the overlay.
 */
export interface UtilityRuntimeOverlay {
  /**
   * The harness cannot safely expose the per-turn gateway for this launch.
   * Skill instructions remain available, but gateway-backed utilities are not advertised.
   */
  gatewayAvailable?: boolean
  env?: Record<string, string>
  args?: string[]
  configFiles?: UtilityRuntimeConfigFile[]
  allowedTools?: string[]
}

/** Materialized launch overlay owned by CodeInOven for one runtime activation. */
export interface PreparedUtilityRuntime {
  id: string
  directory: string
  manifestPath: string
  env: Record<string, string>
  args: string[]
  configPaths: Record<string, string>
  allowedTools: string[]
  /** Safe to call repeatedly, including after partial external teardown. */
  cleanup(): Promise<void>
}

/** Authentication operations a harness exposes without implied account switching. */
export interface HarnessAuthCapabilities {
  status: boolean
  loginHandoff: boolean
  logout: boolean
  accountActivation: boolean
  multipleAccounts: boolean
  /**
   * The harness presents its own interactive provider picker inside the login
   * terminal (e.g. `opencode auth login`), so the UI launches the bare login
   * command and lets the user choose the provider there instead of guessing
   * from an incomplete in-app catalog.
   */
  pickerLogin: boolean
}

export interface HarnessAuthAccount {
  id: string
  label: string
  method?: string
  active?: boolean
}

export interface HarnessAuthStatus {
  state: 'authenticated' | 'unauthenticated' | 'unknown' | 'error'
  accounts: HarnessAuthAccount[]
  detail?: string
}

export interface HarnessLoginOptions {
  mode?: 'default' | 'subscription' | 'console' | 'device'
  accountHint?: string
  sso?: boolean
  /** Provider to authenticate against, for harnesses that support per-provider login. */
  providerId?: string
}

/**
 * A command the UI may hand to a user-controlled terminal. Merely creating a
 * handoff never starts the command or mutates harness credentials.
 */
export interface HarnessLoginHandoff {
  kind: 'terminal'
  command: string
  args: string[]
  title: string
  mutatesGlobalCredentials: true
}

/** Options for sending a prompt to the harness. */
export interface SendPromptOptions {
  sessionId: string
  settings: ThreadSettings
  text: string
  attachments: PromptAttachment[]
  /** Enforce a non-mutating harness sandbox for temporary inspection chats. */
  readOnly?: boolean
  /** Injected system prompt when Engineering is enabled. */
  systemPrompt?: string
  /** Exact harness tool IDs allowed for this turn; omitted to use harness defaults. */
  allowedTools?: string[]
  /** Force the response through the harness's validated structured-output tool. */
  structuredOutput?: StructuredOutputRequest
  /**
   * ID assigned to the user message. Mirrored drivers should
   * use this ID so the driver's transcript merges cleanly with the on-disk
   * mirror. Drivers that do not own message history can ignore it.
   */
  userMessageId?: string
}

/** Input for one disposable, provider-owned thread-title completion. */
export interface GenerateTitleOptions {
  settings: ThreadSettings
  message: string
  /** Parent turn whose authenticated transport permits a safe auxiliary title process. */
  parentSessionId?: string
}

/** Provider-neutral input appended to an already active harness turn. */
export interface SteerPromptOptions {
  sessionId: string
  text: string
  attachments: PromptAttachment[]
  userMessageId?: string
}

/**
 * HarnessDriver — the contract every AI harness must fulfill to participate
 * in CodeInOven's chat engine. Each driver encapsulates the harness's headless
 * communication strategy (HTTP+SSE, subprocess JSONL, WebSocket, etc.) and
 * translates raw harness output into the unified AgentEvent stream.
 *
 * Drivers are transport-only: they know nothing about threads, projects, or
 * permission policy. Coordination lives in the ChatEngine.
 */
export interface HarnessDriver {
  readonly id: string
  readonly name: string
  /** Capabilities exposed by this harness adapter. */
  readonly capabilities: HarnessCapabilities
  readonly authCapabilities?: HarnessAuthCapabilities

  /** Attach task-level process tracking after driver construction. */
  setProcessObserver?(observer: AgentProcessObserver): void

  /** Ensure the driver's backend is ready (e.g. spawn server). Called lazily. */
  ensureReady(projectPath: string): Promise<void>

  /** Create a new conversation session bound to a project directory. */
  createSession(projectPath: string, title: string): Promise<string>

  /** Permanently discard a provider session when the transport supports it. */
  deleteSession?(projectPath: string, sessionId: string): Promise<void>

  /**
   * Generate a title in an isolated disposable session. Implementations choose
   * their cheapest available model, then fall back to the active thread model.
   */
  generateTitle(projectPath: string, options: GenerateTitleOptions): Promise<string | null>

  /**
   * Best-effort release of a project's in-memory harness resources without
   * deleting any sessions. Called by the idle reaper after a project has been
   * fully idle for a grace period. The harness session(s) persist on disk and
   * rehydrate on next use.
   */
  releaseProjectResources?(projectPath: string): Promise<void> | void

  /** Send a prompt; responses stream back via the event callback. Non-blocking. */
  sendPrompt(projectPath: string, opts: SendPromptOptions): Promise<void>

  /** Append user input to the active turn using the harness's native steering protocol. */
  steerPrompt?(projectPath: string, opts: SteerPromptOptions): Promise<void>

  /** Load the full message history for a session. */
  loadMessages(projectPath: string, sessionId: string): Promise<AgentMessage[]>

  /**
   * Load only the active turn beginning at a stable user-message id. Drivers
   * with an in-memory session should implement this so turn finalization never
   * rescans a conversation whose cost grows with thread age.
   */
  loadMessagesSince?(
    projectPath: string,
    sessionId: string,
    messageId: string
  ): Promise<AgentMessage[]>

  /** Abort the running turn in a session. */
  abort(projectPath: string, sessionId: string): Promise<void>

  /**
   * Forcefully stop the harness process backing a session (SIGTERM). Called when
   * the user explicitly confirms a forced close so a still-streaming local
   * project stops immediately instead of lingering after the app exits. Drivers
   * that own a per-session process (e.g. the OpenCode SSE server) implement
   * this to kill the process outright; the default `abort` already sends
   * SIGTERM for one-process-per-turn CLI drivers.
   */
  terminate?(projectPath: string, sessionId: string): Promise<void> | void

  /** List available providers and their models. */
  listProviders(projectPath: string): Promise<ProviderCatalog[]>

  /** List slash commands the harness exposes. */
  listCommands(projectPath: string): Promise<HarnessCommand[]>

  /** List exact model-visible tools when the harness exposes introspection. */
  listTools?(
    projectPath: string,
    providerId: string,
    modelId: string
  ): Promise<HarnessToolDefinition[]>

  /** Translate a provider-neutral utility plan into harness launch additions. */
  prepareUtilityRuntime?(request: UtilityRuntimePreparationRequest): Promise<UtilityRuntimeOverlay>

  /** Activate or clear a materialized utility overlay for one session turn. */
  applyPreparedUtilityRuntime?(
    projectPath: string,
    runtime: PreparedUtilityRuntime | null,
    sessionId: string
  ): Promise<void>

  /**
   * Start any session-specific transport needed by the prepared runtime before
   * prompt composition finishes. Implementations must keep this idempotent.
   */
  preparePromptTransport?(
    projectPath: string,
    sessionId: string,
    settings: ThreadSettings
  ): Promise<void>

  /** Read the harness's current authentication state without changing it. */
  getAuthStatus?(projectPath: string): Promise<HarnessAuthStatus>

  /**
   * Fetch the account's current quota telemetry on demand (rate-limit windows,
   * prepaid credits). Used by the battery popover so old threads — whose turns
   * predate quota capture — can still show live quota. Returns null when the
   * harness cannot report quota without a turn.
   */
  readAccountUsage?(projectPath: string): Promise<{
    rateLimits: AgentRateLimitWindow[]
    credits?: AgentUsageCredits
    contextWindow?: number
    contextUsed?: number
  } | null>

  /** Build, but do not execute, an interactive login handoff. */
  beginLogin?(projectPath: string, options?: HarnessLoginOptions): Promise<HarnessLoginHandoff>

  /** Remove a harness credential only when explicitly supported by the driver. */
  logout?(projectPath: string, accountId?: string): Promise<void>

  /** Select a previously stored account only when the harness supports isolation. */
  activateAccount?(projectPath: string, accountId: string): Promise<void>

  /** Execute a slash command within a session. */
  runCommand(projectPath: string, sessionId: string, command: string, args: string): Promise<void>

  /** Compact the conversation context when supported by the harness. */
  compactSession?(projectPath: string, sessionId: string, settings: ThreadSettings): Promise<void>

  /**
   * Reply to a pending permission request. When `message` is provided alongside a
   * `reject` reply it is delivered to the harness as corrective feedback so the
   * model can continue the current turn instead of the turn being killed.
   */
  replyPermission(
    projectPath: string,
    requestId: string,
    reply: PermissionReply,
    message?: string,
    sessionId?: string
  ): Promise<void>

  /** Reply to a pending question request with user answers. */
  replyToQuestion(
    projectPath: string,
    sessionId: string,
    requestId: string,
    answers: string[][]
  ): Promise<void>

  /** Reject a pending question request without answering it. */
  rejectQuestion(projectPath: string, sessionId: string, requestId: string): Promise<void>

  /** List provider-held pending questions for restart/reconnect recovery. */
  listPendingQuestions(projectPath: string): Promise<AgentQuestionRequest[]>

  /** Register the callback that receives streaming AgentEvents. */
  onEvent(callback: AgentEventCallback): void

  /** Tear down all pooled resources (called on app quit). */
  dispose(): void
}

/** Main-process observer used by drivers to attribute process trees to sessions. */
export interface AgentProcessObserver {
  /**
   * Register a harness root process. `sessionId` may be omitted for app-wide
   * roots (e.g. the shared opencode server) that are not tied to one thread.
   */
  watchProcess(
    sessionId: string | undefined,
    pid: number | undefined,
    command: string,
    cwd: string
  ): void
}
