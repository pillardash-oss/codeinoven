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

/**
 * A provider kept an interactive question after the turn process that owned it
 * exited. The chat engine can recover by resuming the persisted session with
 * the user's decision instead of trying to write to a closed input stream.
 */
export class InactiveQuestionTurnError extends Error {
  constructor(
    readonly sessionId: string,
    readonly requestId: string,
    harnessName: string
  ) {
    super(`The ${harnessName} turn ended while question ${requestId} was awaiting a response`)
    this.name = 'InactiveQuestionTurnError'
  }
}

/**
 * The chat engine still tracks a question as pending, but the driver's own
 * bookkeeping already dropped it (the harness answered/cancelled it through
 * another path, or the driver instance was reset). Retrying the same reject
 * or reply against the driver can never succeed, so the chat engine should
 * treat this as an already-resolved question instead of leaving the user
 * stuck retrying a dismissal that will always fail the same way.
 */
export class QuestionRequestGoneError extends Error {
  constructor(
    readonly sessionId: string,
    readonly requestId: string,
    harnessName: string
  ) {
    super(`The ${harnessName} question ${requestId} is no longer pending on the driver`)
    this.name = 'QuestionRequestGoneError'
  }
}

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
  /**
   * CodeInOven can persist an API key for a provider into the harness's own
   * credential store (e.g. Pi's auth.json), so catalog providers can be
   * connected headlessly without the harness's interactive flow.
   */
  apiKeyEntry: boolean
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
  /**
   * Lean app-managed opencode agent name (e.g. `cio-chat`) for trimmed
   * lightweight modes. Non-opencode drivers ignore it; the opencode driver
   * emits it in the prompt body so the harness prunes denied tool/skill
   * schemas server-side. Omitted for engineering/implement modes, which keep
   * the full built-in opencode experience.
   */
  agent?: string
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

/** Captured grading payload judged 1–5 by a disposable cheap-model completion. */
export interface GradeTurnOptions {
  settings: ThreadSettings
  /** The initiating visible user message of the scored turn. */
  userMessage: string
  /** The agent's final output text for the scored turn. */
  assistantOutput: string
  /** Follow-up the user sent while the grade was pending, when one exists. */
  followUp?: string | null
  /** Parent turn whose authenticated transport permits a safe auxiliary grading process. */
  parentSessionId?: string
}

/**
 * One self-contained auxiliary completion run against the harness's cheapest
 * available model, shared by every disposable cheap-model scenario (title
 * generation, turn grading, speech lessons, memory proposals, …).
 */
export interface CheapModelRequest {
  settings: ThreadSettings
  /** Short scenario label used as the disposable session title. */
  purpose: string
  /** Complete, self-contained prompt. No conversation history is attached. */
  prompt: string
  /** Parent turn whose authenticated transport permits a safe auxiliary process. */
  parentSessionId?: string
  /** Time budget per candidate attempt. Defaults to the harness standard. */
  timeoutMs?: number
}

/** Outcome of one cheap-model candidate attempt. */
export interface CheapModelAttempt {
  providerId: string
  modelId: string
  ok: boolean
  failure: string | null
}

export interface CheapModelResult {
  /** Validated response text, or null when every candidate attempt failed. */
  text: string | null
  attempts: CheapModelAttempt[]
}

/** Input for one disposable heartbeat "ping" completion, pinned to the exact selected model. */
export interface SendHeartbeatPingOptions {
  settings: ThreadSettings
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
   * Judge a completed turn 1–5 in an isolated disposable session using the
   * same cheapest-candidate strategy as title generation.
   */
  gradeTurn(projectPath: string, options: GradeTurnOptions): Promise<number | null>

  /**
   * Run one self-contained completion in a disposable session, cheapest
   * candidate first, falling back to the active thread model. Handles per-
   * attempt timeouts and reports per-candidate outcomes. The single entry
   * point every cheap-model scenario must go through.
   */
  provideCheapModel(projectPath: string, request: CheapModelRequest): Promise<CheapModelResult>

  /**
   * Send a single disposable "ping" completion pinned to the exact model in
   * `options.settings` (no cheap-candidate substitution) so a configured
   * Heartbeat keeps that specific provider's usage window warm. Resolves
   * true when any reply was received.
   */
  sendHeartbeatPing(projectPath: string, options: SendHeartbeatPingOptions): Promise<boolean>

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

  /**
   * Ask the harness whether a session currently has a live agent loop. Used by
   * restart recovery: the engine's in-memory session-status map is empty after
   * a restart, but the harness process may have survived and still be running
   * the pre-restart turn — resuming such a session spawns a second concurrent
   * run that interleaves outputs and derails both turns. Drivers without a
   * status probe simply omit this; callers treat `false`/throwaway errors as
   * "not busy" to keep the legacy behavior.
   */
  isSessionBusy?(projectPath: string, sessionId: string): Promise<boolean>

  /** Load the full message history for a session. */
  loadMessages(projectPath: string, sessionId: string): Promise<AgentMessage[]>

  /**
   * Carry a replaced session's native conversation binding over to its
   * replacement, so a harness that persists its own transcript (native resume)
   * keeps resuming the real history instead of silently degrading every later
   * turn to the engine's history recap. Best-effort; implementations must not
   * throw when the old session is unknown or its transcript is gone.
   */
  inheritNativeSession?(
    projectPath: string,
    fromSessionId: string,
    toSessionId: string
  ): Promise<boolean>

  /** Stamp the owning thread onto a session record so the driver can later
   * relocate the thread's sessions across harness switches. Best-effort. */
  tagSessionThread?(projectPath: string, sessionId: string, threadId: string): Promise<void>

  /**
   * Restore this session's native conversation binding from the driver's most
   * recent resumable session record for the given thread. Used when a thread
   * returns to a harness after a switch: the thread's session slot moved to
   * the other harness, but this harness still holds the real transcript.
   * Returns true when a binding was restored. Best-effort; implementations
   * must not throw.
   */
  restoreNativeBinding?(projectPath: string, sessionId: string, threadId: string): Promise<boolean>

  /**
   * Seed a freshly created session with the thread's edited history as a
   * native transcript, so the next turn resumes the real conversation instead
   * of replaying the mirror as a history recap. Returns true when the session
   * now natively holds history. No-ops on drivers without native transcripts.
   * Best-effort; must not throw.
   */
  prefillNativeSession?(
    projectPath: string,
    sessionId: string,
    messages: readonly AgentMessage[]
  ): Promise<boolean>

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

  /**
   * Restart transport state after the user re-authenticates a provider. This
   * is optional because most harnesses do not keep authenticated resident
   * processes that need to be rebuilt.
   */
  restartAfterAuthentication?(projectPath: string): Promise<void> | void

  /** List available providers and their models. */
  listProviders(projectPath: string): Promise<ProviderCatalog[]>

  /**
   * Cheap, spawn-free staleness fingerprint of the driver's provider-catalog
   * inputs (connected providers, auth state, configured model lists). The chat
   * engine compares it against the fingerprint recorded with the last cached
   * catalog and forces re-discovery when it drifts. Return `null` when the
   * driver cannot determine one reliably (the cache then keeps its normal TTL).
   */
  providerCatalogFingerprint?(): Promise<string | null>

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
   * Publish a turn-scoped endpoint for harness bridges that cannot receive a
   * per-turn launch overlay (shared or extension-backed harnesses). The payload
   * is written session-keyed by the driver; `null` clears any active endpoint
   * so turn-scoped tokens cannot be replayed after cleanup.
   */
  publishUtilityGatewayEndpoint?(
    projectPath: string,
    sessionId: string,
    endpoint: { url: string; token: string } | null
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
  runCommand(
    projectPath: string,
    sessionId: string,
    command: HarnessCommand,
    args: string,
    settings: ThreadSettings
  ): Promise<void>

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
