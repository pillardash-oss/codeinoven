import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { tmpdir } from 'os'
import { join } from 'path'
import type {
  AgentMessage,
  AgentPart,
  AgentRateLimitWindow,
  AgentUsageCredits,
  AgentToolStatus,
  ProviderCatalog,
  ProviderModel,
  SessionAgentEvent
} from '../../lib/types'
import { PI_THINKING_PRESETS } from '../../lib/pi-thinking-presets'
import { normalizeAgentQuestions, parseRecord } from '../../lib/agent-interactions'
import { CIO_SUBAGENT_STREAM_STATUS_KEY } from '../../lib/core-tools'
import { RETRIEVE_MCP_HOST_TOOL_NAME } from '../../lib/gateway-tools'
import { buildProcessEnvironment } from './cli-environment'
import { piNativeProviderIds } from '../agents/native-provider-config-service'
import { PiAuthConfigService, piAuthFileIo } from '../providers/pi-auth-config'
import type { BaseUrlProviderService } from '../providers/base-url-provider-service'
import type { BaseUrlProvider } from '../../lib/types'
import type { SecretVault } from '../storage/secret-vault'
import type { StorageEngine } from '../storage/storage-engine'
import { Logger } from '../system/logger'
import type {
  GenerateTitleOptions,
  HarnessCapabilities,
  SendPromptOptions,
  SteerPromptOptions,
  UtilityRuntimeOverlay,
  UtilityRuntimePreparationRequest
} from './driver.interface'
import { PermissionRequestGoneError, QuestionRequestGoneError } from './driver.interface'
import type { HarnessCommand, PermissionReply, ThreadSettings } from '../../lib/types'
import { classifyProviderIssue, presentProviderError } from '../../lib/provider-issue'
import {
  PersistentCliDriver,
  type CliLineParseContext,
  type CliLineParseResult,
  type CliTurnCommand,
  type PersistentCliSession,
  type TitleModelCandidate
} from './persistent-cli-driver'
import { piMcpExtension } from './pi-mcp-extension'
import { piCustomProvidersExtension } from './pi-providers-extension'
import { apiKeyEnvVarFor } from '../providers/base-url-provider-service'
import { piCioCoreToolsExtension } from './pi-cio-core-tools-extension'
import { PI_COMPACTION_EXTENSION_KEY } from './pi-compaction-extension'
import {
  PI_STATUS_COMPACTING,
  PI_STATUS_EXTENSION_KEY,
  PI_STATUS_IDLE,
  PI_STATUS_WORKING
} from './pi-status-extension'
import { PI_USAGE_EXTENSION_KEY } from './pi-usage-extension'
import { fetchPiProviderUsage } from './pi-provider-usage'
import { PiRpcClient } from './pi-rpc-client'
import {
  prepareHarnessInvocation,
  resolveHarnessRuntime,
  runHarnessCommand
} from './harness-runtime'

import {
  emptyStopRequest,
  messageTimestamp,
  numberValue,
  record,
  stringValue,
  utilityKey,
  withTimeout
} from './pi/pi-values'
import {
  isUsagelessAssistantStatsError,
  mapPiRateLimitHeaders,
  piUsageProviderId,
  refreshSessionUsageFromStats
} from './pi/pi-usage'
import { isOversizedRequestError } from './pi/pi-errors'
import { TERMINAL_SUBAGENT_STATUSES, subagentTimeRange } from './pi/pi-subagent'
import { latestPiTurnIndex, mapPiRecord } from './pi/pi-stream-fold'
import type { PiStreamContext, PiTurnState } from './pi/pi-stream-types'
import {
  findNativePiSessionFile,
  loadNativeSubagentMessages,
  nativePiSessionDir,
  parseNativePiSession,
  prefillTranscriptEntries,
  reconcileNativeCompactions
} from './pi/pi-native-session'
import { composePiAttachments } from './pi/pi-prompt-assembly'
import { permissionMarkerPayload, questionMarkerPayload } from './pi/pi-ui-markers'

export { isContinuableFinishReasonError, isOversizedRequestError } from './pi/pi-errors'
export { mapPiRateLimitHeaders } from './pi/pi-usage'
export { mapPiRecord } from './pi/pi-stream-fold'
export type { PiStreamContext } from './pi/pi-stream-types'

const THINKING_PRESETS = PI_THINKING_PRESETS
const PI_CHEAP_MODEL_DISCOVERY_TIMEOUT_MS = 10_000
/**
 * Child sessions whose live transcript is retained in memory. Each entry is a
 * few dozen kilobytes for a long worker, and every entry is worth keeping for
 * as long as an open sub-agent tab might read it, so the map is bounded to the
 * recent few rather than the whole app session.
 */
const PI_CHILD_STREAM_MAX = 16

/**
 * How long an idle thread may keep its pi process resident. Every live harness
 * process owns its own heap (tens to hundreds of megabytes) for as long as it
 * exists, and a thread that is not running a turn does not need one: the next
 * turn spawns a fresh process and resumes the persisted native transcript
 * (see `resumeNativePiSession`), the same path an app restart and a crash use.
 * Nothing is evicted while a turn, a worker, or a pending card still owns the
 * session.
 */
const PI_SESSION_IDLE_DISPOSE_MS = 5 * 60_000

/** Cadence of the idle sweep. One timer serves every session of the driver. */
const PI_SESSION_IDLE_SWEEP_MS = 60_000

/**
 * How long a child transcript stays watched after the app last asked for it.
 * An open sub-agent view polls its child every few seconds, so a visible
 * transcript keeps its own entry fresh; a view the user closed lapses on its
 * own and the worker's token stream stops being forwarded.
 */
const PI_SUBAGENT_WATCH_WINDOW_MS = 45_000

/**
 * How long a stopped session may keep streaming before the driver kills its pi
 * process. A stop must be authoritative: pi's abort RPC is the graceful path,
 * but a run that ignores it (or a wedged process) would otherwise keep working
 *   with its nested worker sessions   after the user pressed stop.
 */
const PI_ABORT_ENFORCE_MS = 3_000
const PI_ABORT_ENFORCE_INTERVAL_MS = 500
/** Bound on the post-abort `get_state` probe so a busy process cannot stall the
 *  stop behind the RPC client's full request timeout. */
const PI_ABORT_PROBE_TIMEOUT_MS = 1_500

/** Pi thinking levels accepted by `set_thinking_level`. */
const PI_THINKING_LEVELS: Record<string, string> = {
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'xhigh',
  ultra: 'xhigh'
}

function piThinkingLevel(value: string): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' {
  const resolved = PI_THINKING_LEVELS[value]
  if (
    resolved === 'minimal' ||
    resolved === 'low' ||
    resolved === 'medium' ||
    resolved === 'high' ||
    resolved === 'xhigh'
  ) {
    return resolved
  }
  return 'medium'
}

/** Fallback catalog used when the pi runtime reports no models. */
const PI_FALLBACK_CATALOG: ProviderCatalog[] = [
  {
    id: 'pi',
    name: 'Pi',
    harnessId: 'pi',
    models: [
      {
        id: 'default',
        providerId: 'pi',
        name: 'Default',
        reasoning: true,
        thinkingPresets: THINKING_PRESETS,
        attachment: true,
        toolcall: true
      }
    ]
  }
]

/**
 * Live transcript of one delegated child pi session, fed by the core-tools
 * extension's streamed `setStatus` records. The child session runs in-process
 * inside the harness, so nothing else can observe it while it works; keeping
 * the folded transcript here lets a tab open mid-run render the trace so far
 * instantly (no disk probe) and lets the engine persist the final transcript
 * without waiting for pi to flush the child's session file.
 */
interface PiChildStreamState {
  context: PiStreamContext
  turnState: PiTurnState
  /** Root session that spawned this child. Kept here so a stop (or a process
   *  death) can close every child transcript of the stopped parent without a
   *  second index. */
  parentSessionId: string
  /** True once a working status was emitted for this child. */
  announcedWorking: boolean
  /** True once the child reported its terminal settle record. */
  settled: boolean
}

interface PiUiRequest {
  sessionId: string
  method: string
  client: PiRpcClient
  request: Record<string, unknown>
}

interface PiSilentContinueState {
  attempts: number
  owed: boolean
  lastError: string
  /** The failure was an oversized request body   compact before continuing. */
  compactFirst?: boolean
}

/** Silent continues per turn before the failure is surfaced as a real error. */
const SILENT_CONTINUE_MAX_ATTEMPTS = 10

/** Compact-and-continue recoveries per turn for oversized request bodies. */
const OVERSIZED_COMPACT_MAX_ATTEMPTS = 3

/** pi rejects `set_model` for models outside its availability snapshot; the
 *  only recovery is a fresh process with a regenerated providers extension. */
function isPiModelNotFoundError(error: unknown): boolean {
  return error instanceof Error && /^Model not found: /u.test(error.message)
}

/** Materialized provider-only extension overlay used for model discovery. */
interface ProviderOverlay {
  args: string[]
  env: Record<string, string>
  cleanup(): Promise<void>
}

/**
 * Driver for Pi's headless agent. Unlike the former in-process SDK path, this
 * shells out to the `pi` CLI the user installs on PATH (like Claude Code), so
 * the heavy Pi runtime is never bundled. It drives `pi --mode rpc` over stdio
 * and keeps one persistent Pi process per active CodeInOven session.
 */
export class PiDriver extends PersistentCliDriver {
  /** Tickets prevent duplicate compactions and continuation after user cancellation. */
  private readonly pageCompactions = new Map<string, { resume: boolean }>()
  private readonly compactionReadySessions = new Set<string>()
  readonly id = 'pi'
  readonly name = 'Pi'
  readonly capabilities: HarnessCapabilities = {
    runtimeTopology: { kind: 'shared_daemon', scope: 'application', sessionWorkers: true },
    streaming: true,
    steering: true,
    nativeResume: true,
    messageHistory: 'mirrored',
    interactivePermissions: true,
    attachments: true,
    commands: true,
    providerCatalog: true,
    sessionStatus: true,
    contextUsage: true,
    compaction: true,
    subagents: true,
    scheduledRetry: true,
    nativeUtilities: []
  }

  private turnStates = new Map<string, PiTurnState>()
  private rpcClients = new Map<string, PiRpcClient>()
  /**
   * Last activity per live RPC session (any RPC record, prompt, steer, or
   * abort). Feeds the idle sweep that disposes resident harness processes, so
   * a thread that finished its work stops holding a process and its heap.
   */
  private readonly sessionActivityAt = new Map<string, number>()
  private idleSweepTimer: ReturnType<typeof setInterval> | null = null
  /** Per-session watch file the extension reads to learn which child
   *  transcripts the app is displaying (see `watchSubagentSession`). */
  private readonly cioWatchFlagPaths = new Map<string, string>()
  /** Child session ids the app asked for, with the moment the request goes
   *  stale. A transcript view polls its child while it is open, so a live view
   *  keeps its entry fresh and a closed one lapses within the watch window. */
  private readonly cioWatchedChildren = new Map<string, Map<string, number>>()
  /** Last watch list published per session, so unchanged state is not rewritten. */
  private readonly cioPublishedWatch = new Map<string, string>()
  /**
   * Live transcripts of delegated child pi sessions, keyed by child session id
   * and bounded (insertion order = recency) so a long app session cannot grow
   * without limit. Fed by the core-tools extension's streamed records; read
   * back so a sub-agent tab paints its trace immediately and the engine can
   * persist the final transcript without probing pi's session file.
   */
  private childStreams = new Map<string, PiChildStreamState>()
  /**
   * Sessions whose native `get_session_stats` RPC is known to crash. Pi's
   * `AgentSession.getSessionStats` reads `usage.input` unguarded on assistant
   * history entries that carry no `usage` (pi 0.85.1 and earlier), so legacy
   * or interrupted transcripts make the RPC fail with "Cannot read properties
   * of undefined (reading 'input')" on every call. After the first failure the
   * driver stops calling it for that session and falls back to accounting
   * mirrored from per-message usage events.
   */
  private sessionStatsBroken = new Set<string>()
  /**
   * Model/thinking-level last applied to each session's live pi RPC process.
   * Pi's own interactive mode only sends `set_model`/`set_thinking_level`
   * when the user actually changes them (see interactive-mode.js), never
   * before every prompt   re-sending them unconditionally on every turn adds
   * two blocking RPC round-trips with no progress signal, which is what left
   * follow-up turns stuck on the bare spinner. Cleared whenever the RPC
   * client is disposed so a freshly spawned process still gets an explicit
   * set_model on its first turn.
   */
  private appliedPiSettings = new Map<
    string,
    { provider: string; modelId: string; thinkingLevel: string }
  >()
  /** Session-keyed turn handoff files carrying { url, token } for the gateway extension, storage-relative. */
  private gatewayHandoffPaths = new Map<string, string>()
  /**
   * Session-keyed endpoints published before the gateway extension was materialized.
   * On the first turn of a fresh session, publishUtilityGatewayEndpoint runs before
   * sendPrompt spawns Pi and materializes the handoff file, so the endpoint must be
   * held here and flushed by materializeCioCoreToolsExtension   otherwise every first
   * cio_util_* call fails with `new URL(route, '')` → "Invalid URL".
   */
  private pendingGatewayEndpoints = new Map<string, { url: string; token: string }>()
  private sessionProjects = new Map<string, string>()
  private activeTurns = new Set<string>()
  /**
   * Sessions whose live RPC process was started by loading the previously
   * persisted native pi transcript (`switch_session`). The chat engine's
   * resume decision reads `loadMessages` before this process exists; this set
   * records the outcome for observability and cleanup.
   */
  private readonly resumedNativeSessions = new Set<string>()
  private pendingUiRequests = new Map<string, PiUiRequest>()
  /**
   * Bounded silent-continue bookkeeping per session. When a turn settles with a
   * finish-reason flake (`Provider finish_reason: other` and friends), the
   * driver silently re-prompts the model instead of surfacing the error. The
   * mirror is claimed only while a continuation is actually owed, so every
   * other path keeps its plain `message.completed`/finalization behavior.
   */
  private silentContinues = new Map<string, PiSilentContinueState>()
  private nativeMcpConfigSupport: Promise<boolean> | null = null
  /** Latest provider rate-limit windows reported by the usage extension,
   *  per session, with the pi provider id the response came from. */
  private latestRateLimits = new Map<
    string,
    { providerId?: string; windows: AgentRateLimitWindow[] }
  >()
  /** Latest windows per pi provider id, persisted to storage so hovers after
   *  an app restart (no live RPC session, no in-memory cache) still show bars
   *    and so the same provider used across multiple projects shares them. */
  private persistedRateLimits: Map<string, AgentRateLimitWindow[]> | null = null
  private persistedRateLimitsWrite: Promise<void> | null = null
  private static readonly USAGE_WINDOWS_PATH = 'runtime/pi-usage/windows.json'
  private static readonly USAGE_WINDOWS_MAX_PROVIDERS = 50
  /**
   * Session-keyed handoff file carrying the CodeInOven-composed system prompt
   * (work ethic, persistent preferences, working scope, skills), storage-relative.
   * The extension's `before_agent_start` hook reads this fresh on every agent
   * loop start and appends it to Pi's own system prompt as a real system-role
   * field. This exists so that content is sent once per request via the
   * system prompt, not re-concatenated into every user turn's text   doing
   * the latter made every fresh turn replay the same multi-kilobyte block
   * inside "user" content, which models can (and did) mistake for injected
   * or duplicated content.
   */
  private cioSystemPromptPaths = new Map<string, string>()
  /** Storage-relative allowed-tools handoff file per session, rewritten per turn
   *  so the extension's tool gate reflects the current File-System setting. */
  private cioAllowedToolsPaths = new Map<string, string>()
  /** Storage-relative arm/disarm flag files for oversized-request recovery. */
  private cioOversizedFlagPaths = new Map<string, string>()
  /** Storage-relative stop-flag files the user's Stop writes for the core-tools
   *  extension. `abort()` publishes a token here before it aborts the root run,
   *  because the extension is the only code that can stop the nested worker
   *  sessions pi keeps inside its own process. */
  private cioStopFlagPaths = new Map<string, string>()
  /** Monotonic per-process counter making every stop token unique. */
  private stopRequestSeq = 0
  /** Session-keyed absolute paths to the materialized single "cio-core-tools"
   *  extension module (status + usage + gateway + core tools composed), passed
   *  to `--extension`. */
  private cioCoreToolsExtensionPaths = new Map<string, string>()
  /** Resolved key env for the session's custom-providers extension, merged
   *  into the RPC process environment on every (re)boot. */
  private cioProvidersExtensionEnvs = new Map<string, Record<string, string>>()
  /** WSL-aware read view of Pi's own credential store (`~/.pi/agent/auth.json`). */
  private readonly authConfig = new PiAuthConfigService(undefined, piAuthFileIo)

  constructor(
    storage: StorageEngine,
    private readonly baseUrlProviders?: BaseUrlProviderService,
    private readonly secretVault?: SecretVault,
    private readonly accountEnvironment: NodeJS.ProcessEnv = {}
  ) {
    super(storage)
  }

  async generateTitle(projectPath: string, options: GenerateTitleOptions): Promise<string | null> {
    return this.generateTitleWithCandidates(
      projectPath,
      options,
      options.candidates ?? (await this.cheapCandidateModels(projectPath))
    )
  }

  protected async ensureCliReady(projectPath: string): Promise<void> {
    try {
      await runHarnessCommand('pi', ['--version'], {
        cwd: projectPath,
        env: buildProcessEnvironment({ ...process.env, ...this.accountEnvironment }),
        timeoutMs: 5_000
      })
    } catch {
      throw new Error(
        'Pi is not installed. Install the Pi CLI globally, then retry. (npm i -g @earendil-works/pi-coding-agent)'
      )
    }
  }

  async listProviders(projectPath: string): Promise<ProviderCatalog[]> {
    const connected = await this.connectedProviderIds()
    if (connected !== null && connected.size === 0) return []
    if (!(await resolveHarnessRuntime('pi', projectPath))) {
      return this.filterConnectedCatalogs(structuredClone(PI_FALLBACK_CATALOG), connected)
    }
    try {
      const overlay = await this.buildProviderOverlay(projectPath)
      const models = await this.discoverModels(projectPath, overlay)
      await overlay.cleanup()
      if (models.length === 0) {
        return this.filterConnectedCatalogs(structuredClone(PI_FALLBACK_CATALOG), connected)
      }
      const byProvider = new Map<string, ProviderModel[]>()
      for (const model of models) {
        const providerId = stringValue(model['provider'])
        const modelId = stringValue(model['id'])
        if (!providerId || !modelId) continue
        const reasoning = model['reasoning'] === true
        const list = byProvider.get(providerId) ?? []
        list.push({
          id: modelId,
          providerId,
          name: stringValue(model['name']) ?? modelId,
          reasoning,
          ...(reasoning ? { thinkingPresets: THINKING_PRESETS } : {}),
          attachment: Array.isArray(model['input']) ? model['input'].includes('image') : true,
          toolcall: true,
          ...(numberValue(model['contextWindow'])
            ? { contextWindow: numberValue(model['contextWindow']) }
            : {})
        })
        byProvider.set(providerId, list)
      }
      const catalogs = [...byProvider.entries()].map(([id, models]) => ({
        id,
        name: id,
        harnessId: 'pi',
        models
      }))
      return this.filterConnectedCatalogs(
        catalogs.length > 0 ? catalogs : structuredClone(PI_FALLBACK_CATALOG),
        connected
      )
    } catch (error) {
      Logger.dev('Pi provider discovery failed, using fallback catalog', error)
      return this.filterConnectedCatalogs(structuredClone(PI_FALLBACK_CATALOG), connected)
    }
  }

  /** Every connected Pi model whose display name or id identifies it as free. */
  protected override async cheapCandidateModels(
    projectPath: string
  ): Promise<TitleModelCandidate[]> {
    let timeout: ReturnType<typeof setTimeout> | null = null
    const catalogs = await Promise.race([
      this.listProviders(projectPath).catch(() => []),
      new Promise<ProviderCatalog[]>((resolve) => {
        timeout = setTimeout(() => resolve([]), PI_CHEAP_MODEL_DISCOVERY_TIMEOUT_MS)
      })
    ]).finally(() => {
      if (timeout) clearTimeout(timeout)
    })
    const candidates = new Map<string, TitleModelCandidate>()
    for (const catalog of catalogs) {
      for (const model of catalog.models) {
        if (!/free/iu.test(model.id) && !/free/iu.test(model.name)) continue
        candidates.set(`${model.providerId}/${model.id}`, {
          providerId: model.providerId,
          modelId: model.id
        })
      }
    }
    return [...candidates.values()]
  }

  /**
   * The providers the user is actually connected to, keyed by the same provider
   * ids pi's catalog reports: credentials in `~/.pi/agent/auth.json` (written by
   * pi's TUI or CodeInOven's connect flow), providers configured in
   * `~/.pi/agent/models.json` (keyed catalog providers and keyless local
   * servers alike), and CodeInOven-managed base-URL providers injected through
   * the discovery overlay. Returns `null` when the connected set cannot be
   * determined reliably   callers then keep the catalog unfiltered rather than
   * wrongly hiding every provider behind a transient read failure.
   */
  private async connectedProviderIds(): Promise<Set<string> | null> {
    const overlay = this.baseUrlProviders
      ? await this.baseUrlProviders.listEnabled(this.id).catch(() => null)
      : []
    const nativeIds = await piNativeProviderIds().catch(() => null)
    if (overlay === null || nativeIds === null) return null
    const connected = new Set<string>([...(await this.authConfig.credentialIds()), ...nativeIds])
    for (const provider of overlay) connected.add(provider.id)
    return connected
  }

  private filterConnectedCatalogs(
    catalogs: ProviderCatalog[],
    connected: Set<string> | null
  ): ProviderCatalog[] {
    if (connected === null) return catalogs
    return catalogs.filter((catalog) => connected.has(catalog.id))
  }

  /** Cheap staleness signature of the connected-provider set; see the interface contract. */
  async providerCatalogFingerprint(): Promise<string | null> {
    const connected = await this.connectedProviderIds()
    if (connected === null) return null
    const overlay = this.baseUrlProviders
      ? await this.baseUrlProviders.listEnabled(this.id).catch(() => [])
      : []
    const overlayModels = overlay
      .map((provider) => `${provider.id}=${provider.models.map((model) => model.id).join(',')}`)
      .sort()
      .join('|')
    return JSON.stringify([[...connected].sort(), overlayModels])
  }

  private async discoverModels(
    projectPath: string,
    overlay: ProviderOverlay
  ): Promise<Array<Record<string, unknown>>> {
    let models: unknown
    const invocation = await prepareHarnessInvocation('pi', ['--mode', 'rpc', ...overlay.args], {
      cwd: projectPath,
      env: {
        ...buildProcessEnvironment({ ...process.env, ...this.accountEnvironment }),
        ...overlay.env
      }
    })
    const client = new PiRpcClient({
      invocation
    })
    try {
      await client.newSession()
      models = await client.getAvailableModels()
    } finally {
      client.dispose()
    }
    const payload = record(models)
    const list = Array.isArray(payload?.['models']) ? (payload['models'] as unknown[]) : []
    return list.filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === 'object' && entry !== null && !Array.isArray(entry)
    )
  }

  /** Whether the user's pi runtime exposes the `--mcp-config` adapter flag. */
  private supportsNativeMcpConfig(): Promise<boolean> {
    this.nativeMcpConfigSupport ??= this.probeNativeMcpConfig()
    return this.nativeMcpConfigSupport
  }

  private async probeNativeMcpConfig(): Promise<boolean> {
    let help: string
    try {
      help = (
        await runHarnessCommand('pi', ['--help'], {
          env: buildProcessEnvironment({ ...process.env, ...this.accountEnvironment }),
          timeoutMs: 10_000
        })
      ).stdout
    } catch {
      return false
    }
    // The flag is registered by the pi-mcp-adapter extension; absent the
    // adapter, pi rejects `--mcp-config` as an unknown flag.
    return /\bmcp-config\b/u.test(help) || /--mcp-config/u.test(help)
  }

  override async listCommands(projectPath?: string): Promise<HarnessCommand[]> {
    // Commands are project-scoped in pi; probe them in a disposable session so
    // the running turn is untouched. Fall back to the last seen project when the
    // caller omits the path (the base class declares a no-arg signature).
    const cwd = projectPath ?? [...this.sessionProjects.values()][0] ?? process.cwd()
    if (!(await resolveHarnessRuntime('pi', cwd))) return []
    const invocation = await prepareHarnessInvocation('pi', ['--mode', 'rpc'], {
      cwd,
      env: buildProcessEnvironment({ ...process.env, ...this.accountEnvironment })
    })
    const client = new PiRpcClient({
      invocation
    })
    try {
      await client.newSession()
      const payload = record(await client.getCommands())
      const commands = Array.isArray(payload?.['commands']) ? payload['commands'] : []
      const result: HarnessCommand[] = []
      for (const raw of commands) {
        const command = record(raw)
        const name = stringValue(command?.['name'])
        if (!name) continue
        const source = stringValue(command?.['source'])
        const description = stringValue(command?.['description'])
        result.push({
          name,
          ...(description ? { description } : {}),
          ...(source === 'skill' ? { source: 'skill' as const } : {})
        })
      }
      return result
    } catch (error) {
      Logger.dev('Pi command discovery failed:', error)
      return []
    } finally {
      client.dispose()
    }
  }

  override async runCommand(
    projectPath: string,
    sessionId: string,
    command: HarnessCommand,
    args: string,
    _settings: ThreadSettings
  ): Promise<void> {
    void _settings
    const session = await this.requireSession(projectPath, sessionId)
    if (this.activeTurns.has(session.id)) {
      throw new Error(`A turn is already active for session ${session.id}`)
    }
    const client = await this.ensureRpcClient(projectPath, session.id)
    const commandText = (args.trim() ? `${command.name} ${args}` : command.name).trim()
    this.silentContinues.delete(session.id)
    this.activeTurns.add(session.id)
    try {
      await client.prompt(commandText)
    } catch (error) {
      this.activeTurns.delete(session.id)
      const message = error instanceof Error ? error.message : 'Pi command failed to start'
      this.emit({ type: 'session.error', sessionId: session.id, error: message })
      throw error
    }
  }

  async compactSession(
    projectPath: string,
    sessionId: string,
    _settings: ThreadSettings
  ): Promise<void> {
    void _settings
    const session = await this.requireSession(projectPath, sessionId)
    // An idle thread has no live RPC process (app restart, idle dispose, crash
    // cleanup all evict clients). Boot one on demand   ensureRpcClient resumes
    // the persisted native transcript so compaction sees the full history.
    const client = await this.ensureRpcClient(projectPath, sessionId)
    // pi's `compact` RPC aborts any active run and then compacts, so it works
    // both mid-turn and on an idle session. Awaiting here keeps the handoff
    // deterministic from the caller's view; compaction_start/compaction_end
    // events stream out as it summarizes.
    const currentTurnState = this.turnStates.get(sessionId)
    this.turnStates.set(sessionId, {
      assistantMessageId: currentTurnState?.assistantMessageId ?? null,
      turnIndex: Math.max(
        currentTurnState?.turnIndex ?? 0,
        latestPiTurnIndex(session.messages, sessionId)
      ),
      compacting: true
    })
    this.activeTurns.add(sessionId)
    // pi's `compact` RPC aborts any active run before compacting. When a turn
    // was live (or a steer/follow-up was queued into the compaction window),
    // the work must resume after the checkpoint instead of silently dying:
    // pi drains queued steer/follow-up messages only inside an agent run, and
    // compaction leaves the session idle, so without a continuation the
    // queued messages strand forever and the user's steered input is lost.
    let before: Record<string, unknown> | null
    try {
      before = record(await client.getState())
    } catch {
      before = null
    }
    let continuationStarted = false
    try {
      const result = await client.compact()
      await this.handleRpcEvent({ type: 'compaction_end', result }, sessionId, projectPath)
      const after = record(await client.getState())
      // pi resumed the aborted run itself (overflow recovery)   let its own
      // `agent_settled` finalize the turn; do not compete with it.
      if (after?.['isStreaming'] === true) return
      const pending = numberValue(after?.['pendingMessageCount']) ?? 0
      const interrupted = before?.['isStreaming'] === true
      if (pending > 0 || interrupted) {
        // Clear the compacting flag before the continuation so the
        // continuation run's `agent_settled` finalizes the turn normally.
        const settled = this.turnStates.get(sessionId)
        if (settled) this.turnStates.set(sessionId, { ...settled, compacting: false })
        continuationStarted = true
        await client.prompt(
          'Continue from the Last working trace in the checkpoint. Complete the current step, then the next unfinished step.'
        )
        return
      }
    } finally {
      // A started continuation keeps the turn registered (its own settled
      // finalizes it); every other path finalizes right here so the thread
      // never lingers "working" until the watchdog reconciles.
      const state = this.turnStates.get(sessionId)
      if (state) this.turnStates.set(sessionId, { ...state, compacting: false })
      if (!continuationStarted && this.activeTurns.has(sessionId)) {
        this.activeTurns.delete(sessionId)
        await this.refreshSessionUsage(session).finally(() => void this.finishTurn(session))
      }
    }
  }

  override async sendPrompt(projectPath: string, options: SendPromptOptions): Promise<void> {
    const session = await this.requireSession(projectPath, options.sessionId)
    const client = await this.ensureRpcClient(projectPath, session.id)
    // A real user turn is not a continuation of a stop: clear the stop request
    // the extension applies to worker sessions, and re-arm pi's automatic retry
    // that the stop disarmed.
    await this.clearStopRequest(session.id)
    void client.setAutoRetry(true).catch((error: unknown) => {
      Logger.dev('Pi auto-retry re-arm failed:', error)
    })
    // A live turn owns this session (silent continue, auto-retry, an idle race
    // between the harness and the chat-engine status). Throwing here surfaced a
    // second user-facing error on top of a turn that is still producing output
    //   the user clicks retry and is told the session already has an active
    // turn. Instead, re-anchor provenance with the incoming settings and
    // deliver the prompt through pi's steer channel so the live working trace
    // simply continues.
    if (this.activeTurns.has(session.id)) {
      const activeModel = this.resolveModel(options.settings.providerId, options.settings.modelId)
      if (activeModel) {
        try {
          await this.applyPiSettingsIfChanged(
            session.id,
            client,
            activeModel,
            options.settings.thinkingLevel
          )
        } catch {
          // The active turn keeps its current model/thinking level; steering
          // must not fail just because a mid-turn model switch was rejected.
        }
      }
      this.setTurnProvenance(
        session.id,
        options.settings.providerId,
        options.settings.modelId,
        options.settings.thinkingLevel
      )
      this.appendUserMessage(session, options)
      this.silentContinues.delete(session.id)
      await this.steerIntoActiveTurn(session.id, options.text, options.attachments)
      return
    }
    const model = this.resolveModel(options.settings.providerId, options.settings.modelId)
    if (!model) {
      throw new Error(
        `Pi model is unavailable: ${options.settings.providerId}/${options.settings.modelId}`
      )
    }
    let turnClient = client
    try {
      await this.applyPiSettingsIfChanged(
        session.id,
        turnClient,
        model,
        options.settings.thinkingLevel
      )
    } catch (error) {
      if (!isPiModelNotFoundError(error)) throw error
      // The running process predates a provider/model edit: regenerate the
      // custom-providers extension and retry once on a fresh process (which
      // reloads extensions at boot). Any second failure surfaces unchanged.
      this.disposeRpcClient(session.id)
      turnClient = await this.ensureRpcClient(projectPath, session.id)
      await this.applyPiSettingsIfChanged(
        session.id,
        turnClient,
        model,
        options.settings.thinkingLevel
      )
    }

    this.setTurnProvenance(
      session.id,
      options.settings.providerId,
      options.settings.modelId,
      options.settings.thinkingLevel
    )
    this.appendUserMessage(session, options)
    this.silentContinues.delete(session.id)
    this.activeTurns.add(session.id)

    const { inlineSvg, images, references } = await composePiAttachments(options.attachments)
    if (options.systemPrompt) {
      await this.publishCioSystemPrompt(session.id, options.systemPrompt)
    }
    // Publish every turn: an empty list clears a previous restriction, so a
    // mid-session File-System toggle takes effect without a session restart.
    await this.publishCioAllowedTools(session.id, options.allowedTools)
    const prompt = [inlineSvg, ...references, options.text].filter(Boolean).join('\n\n')

    try {
      await turnClient.prompt(prompt, images)
    } catch (error) {
      this.activeTurns.delete(session.id)
      const message = error instanceof Error ? error.message : 'Pi turn failed to start'
      this.emit({ type: 'session.error', sessionId: session.id, error: message })
      await this.finishTurn(session)
      throw error
    }
  }

  private resolveModel(
    providerId: string,
    modelId: string
  ): { provider: string; modelId: string } | null {
    if (!providerId || !modelId) return null
    return { provider: providerId, modelId }
  }

  /**
   * Only send `set_model`/`set_thinking_level` when the session's live pi
   * process doesn't already have them applied. Each is a full RPC round-trip
   * with no progress event, so paying for both on every turn   as opposed to
   * only when the user actually changes a setting, which is what pi's own
   * interactive mode does   left follow-up turns stuck on a bare spinner for
   * however long those round-trips took.
   */
  private async applyPiSettingsIfChanged(
    sessionId: string,
    client: PiRpcClient,
    model: { provider: string; modelId: string },
    thinkingLevel: string
  ): Promise<void> {
    const level = piThinkingLevel(thinkingLevel)
    const applied = this.appliedPiSettings.get(sessionId)
    if (
      applied &&
      applied.provider === model.provider &&
      applied.modelId === model.modelId &&
      applied.thinkingLevel === level
    ) {
      return
    }
    // Both settings are independent; on a fresh process neither is applied, so
    // issue them as concurrent RPC commands instead of two sequential blocking
    // round-trips on the prompt's critical path. The RPC client correlates
    // responses by id, so interleaved commands are safe.
    const wantsModel =
      !applied || applied.provider !== model.provider || applied.modelId !== model.modelId
    const wantsLevel = !applied || applied.thinkingLevel !== level
    if (wantsModel && wantsLevel) {
      await Promise.all([
        client.setModel(model.provider, model.modelId),
        client.setThinkingLevel(level)
      ])
    } else if (wantsModel) {
      await client.setModel(model.provider, model.modelId)
    } else if (wantsLevel) {
      await client.setThinkingLevel(level)
    }
    this.appliedPiSettings.set(sessionId, {
      provider: model.provider,
      modelId: model.modelId,
      thinkingLevel: level
    })
  }

  async steerPrompt(projectPath: string, options: SteerPromptOptions): Promise<void> {
    const session = await this.requireSession(projectPath, options.sessionId)
    const client = this.rpcClients.get(options.sessionId)
    // A registered live turn takes the steer channel. When it is not
    // registered, the session may still be busy inside pi's own lifecycle
    // (auto-compaction, retry windows) that CodeInOven reports as "working"
    //   pi's docs treat compaction/retry as part of the running trace, so
    // never reject user input there. `follow_up` is accepted in exactly those
    // states: pi queues it and runs it as the continuation of the same
    // session, whether the trace is compacting, retrying, or momentarily
    // between agent runs. Manual compaction drains the queue afterwards
    // (see `compactSession`).
    if (client && this.activeTurns.has(options.sessionId)) {
      await this.steerIntoActiveTurn(options.sessionId, options.text, options.attachments)
      return
    }
    if (client && (await this.isSessionBusy(projectPath, options.sessionId))) {
      const { inlineSvg, images, references } = await composePiAttachments(options.attachments)
      const message = [inlineSvg, ...references, options.text].filter(Boolean).join('\n\n')
      this.appendUserMessage(session, options)
      this.silentContinues.delete(options.sessionId)
      // Delivering a real user message supersedes a stop the user requested
      // earlier: workers it spawns belong to this message, not to the stopped
      // turn.
      await this.clearStopRequest(options.sessionId)
      await client.followUp(message, images)
      return
    }
    // Neither a registered turn nor a busy pi lifecycle: the harness is idle
    // or its process was evicted mid-turn. A steered message must never be
    // rejected   resume the work by starting a fresh run with it. pi keeps
    // the session's model in its durable state, so no settings round-trip is
    // needed; the run's own `agent_settled` finalizes the turn normally.
    const activeClient = client ?? (await this.ensureRpcClient(projectPath, options.sessionId))
    this.appendUserMessage(session, options)
    this.silentContinues.delete(options.sessionId)
    // A steered message that has to start its own run is a new turn, not a
    // continuation of a stop: clear the stop request and re-arm the automatic
    // retry the stop disarmed.
    await this.clearStopRequest(options.sessionId)
    void activeClient.setAutoRetry(true).catch((error: unknown) => {
      Logger.dev('Pi auto-retry re-arm failed:', error)
    })
    this.activeTurns.add(options.sessionId)
    const { inlineSvg, images, references } = await composePiAttachments(options.attachments)
    const message = [inlineSvg, ...references, options.text].filter(Boolean).join('\n\n')
    try {
      await activeClient.prompt(message, images)
    } catch (error) {
      this.activeTurns.delete(options.sessionId)
      const failure = error instanceof Error ? error.message : 'Pi turn failed to start'
      this.emit({ type: 'session.error', sessionId: options.sessionId, error: failure })
      await this.finishTurn(session)
      throw error
    }
  }

  /** Compose attachments + text and deliver them into the session's live turn
   *  through pi's steer channel. The caller must have verified an active turn. */
  private async steerIntoActiveTurn(
    sessionId: string,
    text: string,
    attachments: SendPromptOptions['attachments']
  ): Promise<void> {
    const checkpoint = this.pageCompactions.get(sessionId)
    if (checkpoint) checkpoint.resume = true
    const client = this.rpcClients.get(sessionId)
    if (!client) {
      throw new Error(`No active Pi turn is available to steer for session ${sessionId}`)
    }
    const { inlineSvg, images, references } = await composePiAttachments(attachments)
    const message = [inlineSvg, ...references, text].filter(Boolean).join('\n\n')
    await client.steer(message, images)
  }

  /**
   * Stop the session: end its run, stop every nested worker session, and leave
   * nothing behind that could resume the work the user just cancelled.
   *
   * A stop has four parts, because pi's own abort RPC only reaches the root run:
   *  1. drop an owed silent continue, which would otherwise re-prompt
   *     'Continue.' as soon as the aborted run settles;
   *  2. publish a stop request into the session's stop-flag file, which the
   *     app-owned core-tools extension applies to the worker sessions it owns
   *     and which disarms its own wake-up paths;
   *  3. disarm pi's automatic retry of the aborted run;
   *  4. after the graceful abort, verify the run actually ended (bounded) and
   *     kill the process if it did not.
   */
  override async abort(projectPath: string, sessionId: string): Promise<void> {
    if (this.pageCompactions.has(sessionId)) {
      const turn = this.turnStates.get(sessionId)
      if (turn) this.turnStates.set(sessionId, { ...turn, compacting: false })
    }
    this.pageCompactions.delete(sessionId)
    // An owed silent continue belongs to the turn the user is stopping: pi
    // settles the aborted run with `agent_settled`, and the continuation would
    // then start a fresh run seconds after the stop.
    this.silentContinues.delete(sessionId)
    // Published before the abort so the extension already sees it when the
    // run's own settle hook fires.
    await this.publishStopRequest(sessionId)
    const session = await this.requireSession(projectPath, sessionId).catch(() => null)
    const client = this.rpcClients.get(sessionId)
    if (!session || !client) {
      // No live process to abort: nothing can still be running under it.
      this.settleChildStreams(sessionId, 'aborted')
      return
    }
    void client.setAutoRetry(false).catch((error: unknown) => {
      Logger.dev('Pi auto-retry disarm after stop failed:', error)
    })
    try {
      await client.abort()
    } catch {
      // The abort RPC failed   the pi process is wedged or already gone, so a
      // graceful abort can never land. Kill the process so the run actually
      // stops instead of silently continuing; the exit event finalizes the
      // session state and a fresh run spawns a new process on demand.
      client.dispose()
    } finally {
      this.activeTurns.delete(sessionId)
    }
    // The workers report their own settle a poll window later at worst;
    // settling them here is what makes the cards and child statuses stop with
    // the stop instead of spinning until the last transcript lands.
    this.settleChildStreams(sessionId, 'aborted')
    void this.enforceStoppedSession(projectPath, sessionId)
  }

  /**
   * Stop one nested worker session without touching the root run. Pi keeps its
   * sub-agent sessions inside its own process, so the child can never be
   * addressed by `abort`; the extension owns them and acts on this request.
   */
  async abortSubagent(
    projectPath: string,
    parentSessionId: string,
    childSessionId: string
  ): Promise<void> {
    // The request is keyed by the parent session, so a missing parent means
    // there is no live harness holding this worker at all.
    const parent = await this.requireSession(projectPath, parentSessionId).catch(() => null)
    if (!parent) return
    await this.publishStopRequest(parentSessionId, [childSessionId])
    this.settleChildStreams(parentSessionId, 'aborted', childSessionId)
  }

  /** Publish the user's stop into the session's stop-flag file. */
  private async publishStopRequest(sessionId: string, childSessionIds?: string[]): Promise<void> {
    const path = this.cioStopFlagPaths.get(sessionId)
    if (!path) return
    this.stopRequestSeq += 1
    try {
      await this.storage.writeRaw(
        path,
        JSON.stringify({
          token: `${Date.now()}-${this.stopRequestSeq}`,
          requestedAt: Date.now(),
          childSessionIds: childSessionIds ?? []
        })
      )
    } catch (error) {
      Logger.dev('Pi stop-request publication failed:', error)
    }
  }

  /**
   * Disarm the stop request. A new user turn is not a continuation of a stop,
   * so the extension must never apply an old token to its workers.
   */
  private async clearStopRequest(sessionId: string): Promise<void> {
    const path = this.cioStopFlagPaths.get(sessionId)
    if (!path) return
    try {
      await this.storage.writeRaw(path, JSON.stringify(emptyStopRequest()))
    } catch (error) {
      Logger.dev('Pi stop-request reset failed:', error)
    }
  }

  /**
   * Bounded backstop for a user stop. The graceful abort plus the extension's
   * stop sweep end the run and its workers in the normal case; when pi still
   * reports a live run after the grace window it ignored the abort, so the
   * process is terminated   which takes every nested worker session with it.
   */
  private async enforceStoppedSession(projectPath: string, sessionId: string): Promise<void> {
    const deadline = Date.now() + PI_ABORT_ENFORCE_MS
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, PI_ABORT_ENFORCE_INTERVAL_MS))
      const client = this.rpcClients.get(sessionId)
      if (!client || this.sessionProjects.get(sessionId) !== projectPath) return
      let state: Record<string, unknown> | null
      try {
        state = record(await withTimeout(client.getState(), PI_ABORT_PROBE_TIMEOUT_MS))
      } catch {
        // A session that cannot answer a state probe after its own abort is
        // wedged: a graceful stop can never land on it.
        this.killStoppedSession(sessionId)
        return
      }
      // A probe that timed out (null) cannot confirm the run ended, so it keeps
      // waiting and terminates at the end of the grace window instead.
      if (state && state['isStreaming'] !== true && state['isCompacting'] !== true) return
    }
    this.killStoppedSession(sessionId)
  }

  /** Terminate a stopped session's pi process. The exit event finalizes the
   *  turn and the next run resumes the persisted native transcript. */
  private killStoppedSession(sessionId: string): void {
    if (!this.rpcClients.has(sessionId)) return
    Logger.info('Pi ignored the abort request   terminating the session process', { sessionId })
    this.settleChildStreams(sessionId, 'aborted')
    this.disposeRpcClient(sessionId)
  }

  override async deleteSession(projectPath: string, sessionId: string): Promise<void> {
    this.disposeRpcClient(sessionId)
    this.activeTurns.delete(sessionId)
    this.turnStates.delete(sessionId)
    this.silentContinues.delete(sessionId)
    await this.removeGatewayHandoff(sessionId)
    await super.deleteSession(projectPath, sessionId)
  }

  override releaseProjectResources(projectPath: string): void {
    for (const [sessionId, clientProject] of this.sessionProjects) {
      if (clientProject !== projectPath) continue
      if (this.activeTurns.has(sessionId)) continue
      this.disposeRpcClient(sessionId)
    }
    super.releaseProjectResources(projectPath)
  }

  /**
   * Quota telemetry for the battery popover: the latest provider rate-limit
   * windows (keyed by pi provider id, shared across projects) plus prepaid
   * credits for known gateways, and live context stats when a session for
   * the project is running. Provider-scoped data answers even without a live
   * session, mirroring the cached-bars contract of the other drivers.
   */
  async readAccountUsage(
    projectPath: string,
    providerId?: string
  ): Promise<{
    rateLimits: AgentRateLimitWindow[]
    credits?: AgentUsageCredits
    contextWindow?: number
    contextUsed?: number
  } | null> {
    const sessionId = [...this.sessionProjects.entries()].find(
      ([, clientProject]) => clientProject === projectPath
    )?.[0]
    const client = sessionId ? this.rpcClients.get(sessionId) : undefined
    const persisted = await this.loadPersistedRateLimits()
    const sessionCache = sessionId !== undefined ? this.latestRateLimits.get(sessionId) : undefined
    // Account/provider-keyed windows win; the live session's latest capture answers
    // only when it matches the requested provider (or no provider was given).
    const providerWindows = providerId
      ? (persisted.get(this.rateLimitStorageKey(providerId)) ??
        (sessionCache && (sessionCache.providerId === providerId || !sessionCache.providerId)
          ? sessionCache.windows
          : undefined))
      : (sessionCache?.windows ?? [...persisted.values()].at(-1))
    const providerUsage = providerId
      ? await fetchPiProviderUsage(providerId, this.accountEnvironment)
      : null
    const windows = providerWindows?.length ? providerWindows : (providerUsage?.rateLimits ?? [])
    const credits = providerUsage?.credits
    if (!client || (sessionId !== undefined && this.sessionStatsBroken.has(sessionId))) {
      return windows.length > 0 || credits ? { rateLimits: windows, credits } : null
    }
    try {
      const stats = record(await client.getSessionStats())
      const contextUsage = record(stats?.['contextUsage'])
      const contextWindow = numberValue(contextUsage?.['contextWindow'])
      const contextUsed = numberValue(contextUsage?.['tokens'])
      if (
        contextWindow === undefined &&
        contextUsed === undefined &&
        windows.length === 0 &&
        !credits
      )
        return null
      return {
        ...(windows.length > 0 ? { rateLimits: windows } : { rateLimits: [] }),
        ...(credits ? { credits } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(contextUsed !== undefined ? { contextUsed } : {})
      }
    } catch (error) {
      if (sessionId !== undefined && isUsagelessAssistantStatsError(error)) {
        this.sessionStatsBroken.add(sessionId)
      }
      Logger.dev('Pi account usage read failed:', error)
      return windows.length > 0 || credits ? { rateLimits: windows, credits } : null
    }
  }

  /**
   * Publish the turn-scoped gateway endpoint for the app-owned utility gateway
   * extension. Pi sessions are persistent RPC processes whose extensions load
   * at spawn, so the per-turn URL+token reach the extension through a
   * session-keyed handoff file the driver rewrites per turn; clearing it on
   * turn end makes stale tokens unusable. Publishing must succeed before the
   * model starts; there is no model-facing shell fallback.
   */
  async publishUtilityGatewayEndpoint(
    _projectPath: string,
    sessionId: string,
    endpoint: { url: string; token: string } | null
  ): Promise<void> {
    void _projectPath
    const handoffPath = this.gatewayHandoffPaths.get(sessionId)
    if (!handoffPath) {
      if (endpoint !== null) {
        // First turn of a fresh session: the extension materializes only inside
        // ensureRpcClient (during sendPrompt), which runs after this publish.
        // Defer the endpoint instead of dropping it so the spawned session starts
        // with a working gateway rather than the empty { url: '', token: '' } seed.
        this.pendingGatewayEndpoints.set(sessionId, endpoint)
        Logger.dev('Pi utility gateway endpoint deferred: extension not yet materialized')
      } else {
        this.pendingGatewayEndpoints.delete(sessionId)
      }
      return
    }
    try {
      if (endpoint === null) await this.storage.removeRaw(handoffPath)
      else {
        await this.storage.writeRaw(handoffPath, JSON.stringify(endpoint))
      }
    } catch (error) {
      throw new Error('Pi utility gateway handoff update failed', { cause: error })
    }
  }

  async prepareUtilityRuntime(
    request: UtilityRuntimePreparationRequest
  ): Promise<UtilityRuntimeOverlay> {
    const mcpServers: Record<
      string,
      { command?: string; args?: string[]; env?: Record<string, string>; url?: string }
    > = {}
    const keys = new Set<string>()
    for (const { utility, binding } of request.resolvedUtilities) {
      if (utility.kind !== 'mcp') continue
      const baseKey = utilityKey(binding.transportName ?? utility.name)
      let key = baseKey
      for (let suffix = 2; keys.has(key); suffix += 1) key = `${baseKey}-${suffix}`
      keys.add(key)

      const config = utility.config
      if (config.transport === 'http' || config.transport === 'sse') {
        if (!config.url) {
          throw new TypeError(`Pi MCP utility "${utility.name}" requires a URL`)
        }
        mcpServers[key] = { url: config.url }
        continue
      }
      if (!config.command) {
        throw new TypeError(`Pi MCP utility "${utility.name}" requires a stdio command`)
      }
      mcpServers[key] = {
        command: config.command,
        args: [...(config.args ?? [])],
        env: { ...(config.environment ?? {}) }
      }
    }

    const args: string[] = []
    const configFiles: NonNullable<UtilityRuntimeOverlay['configFiles']> = []
    const env: Record<string, string> = {}

    if (Object.keys(mcpServers).length > 0) {
      const native = await this.supportsNativeMcpConfig()
      if (native) {
        // pi-mcp-adapter (an extension the user may install) registers the
        // `--mcp-config` flag and reads a standard `{ mcpServers }` file. Using
        // it avoids maintaining a bespoke in-extension MCP client.
        args.push('--mcp-config', '{{config:pi-mcp}}')
        configFiles.push({
          id: 'pi-mcp',
          relativePath: 'pi/mcp-config.json',
          content: JSON.stringify({ mcpServers }, null, 2)
        })
      } else {
        // The app-owned bridge extension can only host stdio servers, so remote
        // http/sse utilities require the pi-mcp-adapter native path.
        const remoteNames = Object.entries(mcpServers).filter(
          ([, server]) => typeof server['url'] === 'string'
        )
        if (remoteNames.length > 0) {
          throw new TypeError(
            `Pi MCP utility "${remoteNames[0]?.[0]}" requires the pi-mcp-adapter extension. Install it with: pi install npm:pi-mcp-adapter`
          )
        }
        const stdioServers = mcpServers as Record<
          string,
          { command: string; args: string[]; env: Record<string, string> }
        >
        args.push('--extension', '{{config:pi-mcp-extension}}')
        configFiles.push({
          id: 'pi-mcp-extension',
          relativePath: 'pi/codeinoven-mcp-extension.ts',
          content: piMcpExtension(stdioServers)
        })
      }
    }

    if (configFiles.length === 0) return {}
    return { args, configFiles, env }
  }

  protected async buildTurnCommand(): Promise<CliTurnCommand> {
    throw new Error('PiDriver drives pi over RPC; buildTurnCommand is not used')
  }

  protected parseJsonLine(value: unknown, context: CliLineParseContext): CliLineParseResult | null {
    const state = this.turnStates.get(context.sessionId) ?? {
      assistantMessageId: null,
      turnIndex: 0
    }
    this.turnStates.set(context.sessionId, state)
    return mapPiRecord(value, context, state)
  }

  dispose(): void {
    for (const client of this.rpcClients.values()) client.dispose()
    this.rpcClients.clear()
    this.activeTurns.clear()
    this.turnStates.clear()
    this.childStreams.clear()
    this.silentContinues.clear()
    this.cioStopFlagPaths.clear()
    this.pendingUiRequests.clear()
    for (const sessionId of this.gatewayHandoffPaths.keys()) {
      void this.removeGatewayHandoff(sessionId)
    }
    this.gatewayHandoffPaths.clear()
    this.pendingGatewayEndpoints.clear()
    this.cioCoreToolsExtensionPaths.clear()
    this.cioSystemPromptPaths.clear()
    super.dispose()
  }

  /**
   * Live probe of the pi session's streaming state (`get_state` →
   * `isStreaming`), used by restart recovery to avoid resuming a turn the
   * surviving pi process is still executing   the same role OpenCode's
   * session-status probe plays for its shared server.
   */
  /** Whether the driver still tracks a live turn for this session. The engine's
   *  watchdog uses this to detect a turn the session settled without the
   *  driver noticing (pi's auto-compaction / retry gap). */
  hasActiveTurn(sessionId: string): boolean {
    return this.activeTurns.has(sessionId)
  }

  async isSessionBusy(projectPath: string, sessionId: string): Promise<boolean> {
    const client = this.rpcClients.get(sessionId)
    if (!client || this.sessionProjects.get(sessionId) !== projectPath) return false
    try {
      const state = record(await client.getState())
      return state?.['isStreaming'] === true || state?.['isCompacting'] === true
    } catch (error) {
      Logger.dev('Pi session busy probe failed:', error)
      return false
    }
  }

  private async ensureRpcClient(projectPath: string, sessionId: string): Promise<PiRpcClient> {
    const existing = this.rpcClients.get(sessionId)
    if (existing) return existing
    const session = await this.requireSession(projectPath, sessionId)
    const currentTurnState = this.turnStates.get(sessionId)
    this.turnStates.set(sessionId, {
      assistantMessageId: currentTurnState?.assistantMessageId ?? null,
      turnIndex: Math.max(
        currentTurnState?.turnIndex ?? 0,
        latestPiTurnIndex(session.messages, sessionId)
      )
    })
    const runtime = this.utilityRuntime(sessionId)
    const args = runtime
      ? runtime.args.map((arg) => this.resolveRuntimePlaceholders(arg, runtime))
      : []
    const runtimeEnv = runtime
      ? Object.fromEntries(
          Object.entries(runtime.env).map(([key, value]) => [
            key,
            this.resolveRuntimePlaceholders(value, runtime)
          ])
        )
      : {}
    if (!(await resolveHarnessRuntime('pi', projectPath))) {
      throw new Error(
        'Pi is not installed. Install the Pi CLI globally, then retry. (npm i -g @earendil-works/pi-coding-agent)'
      )
    }
    // The single app-owned "cio-core-tools" extension composes status, usage,
    // utility gateway, and core tools into ONE module loaded through ONE
    // `--extension` flag, so pi's process boot pays a single extension load
    // instead of four. The checkpoint policy is required for every session.
    const cioCoreToolsExtensionPath = await this.materializeCioCoreToolsExtension(sessionId)
    if (!cioCoreToolsExtensionPath) {
      throw new Error(
        'Cannot start Pi without the CodeInOven compaction extension. Retry after resolving the extension materialization error.'
      )
    }
    const extensionArgs = ['--extension', cioCoreToolsExtensionPath]
    // Custom providers (app-store entries plus, inside managed containers, the
    // harness-global models.json providers) must be registered in THIS process
    // too, or `set_model` rejects models the model picker offered.
    const providersExtensionPath = await this.materializeCioProvidersExtension(sessionId)
    if (providersExtensionPath) {
      extensionArgs.push('--extension', providersExtensionPath)
    }
    const invocation = await prepareHarnessInvocation(
      'pi',
      ['--mode', 'rpc', ...extensionArgs, ...args],
      {
        cwd: projectPath,
        env: {
          ...buildProcessEnvironment({ ...process.env, ...this.accountEnvironment }),
          ...(this.cioProvidersExtensionEnvs.get(sessionId) ?? {}),
          ...runtimeEnv
        }
      }
    )
    const client = new PiRpcClient({
      invocation,
      onEvent: (record) => {
        void this.handleRpcEvent(record, sessionId, projectPath)
      },
      onUiRequest: (record) => {
        this.handleUiRequest(record, sessionId)
      },
      onExtensionStatus: (record) => {
        this.handleExtensionStatus(record, sessionId)
      },
      onExit: (code) => {
        this.handleRpcExit(code, sessionId)
      }
    })
    this.rpcClients.set(sessionId, client)
    this.sessionProjects.set(sessionId, projectPath)
    this.touchSessionActivity(sessionId)
    this.ensureIdleSweep()
    // Register the long-lived RPC harness root with the app's process tracker
    // so it appears in the task manager and is covered by orphan reaping.
    this.observeHarnessProcess(sessionId, client.process, invocation.command, projectPath)
    try {
      this.compactionReadySessions.delete(sessionId)
      await client.newSession()
      if (!this.compactionReadySessions.has(sessionId)) {
        throw new Error(
          'The CodeInOven compaction extension did not load. Pi was stopped to prevent fallback to its default compaction.'
        )
      }
      // Resume the persisted native transcript BEFORE syncing the native
      // session id: `switch_session` makes the resumed session current, so the
      // sync below then records the same id the thread was already bound to.
      // A transient failure here must never block the turn.
      await this.resumeNativePiSession(projectPath, sessionId, client)
      await Promise.allSettled([
        client.setAutoRetry(true),
        client.setAutoCompaction(true),
        this.syncNativeSessionId(projectPath, sessionId)
      ])
    } catch (error) {
      client.dispose()
      this.rpcClients.delete(sessionId)
      this.sessionProjects.delete(sessionId)
      this.cioProvidersExtensionEnvs.delete(sessionId)
      throw new Error(
        `Failed to start a Pi session: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      )
    }
    return client
  }

  /**
   * Continue a previously persisted native pi session in the freshly spawned
   * RPC process by loading pi's own transcript file. Without this, every
   * driver-side process replacement (app restart, idle dispose, crash) made
   * the next turn a cold session   the engine's history recap was the only
   * context carrier, and models that see their prior work restated without
   * tool evidence treat it as fabricated and refuse to continue.
   *
   * Best-effort: any failure leaves the fresh session in place and the
   * engine's recap replay covers the gap.
   */
  private async resumeNativePiSession(
    projectPath: string,
    sessionId: string,
    client: PiRpcClient
  ): Promise<void> {
    try {
      const session = await this.requireSession(projectPath, sessionId)
      const nativeId = session.nativeSessionId
      if (!nativeId) return
      if (!existsSync(nativePiSessionDir(projectPath))) return
      const file = await findNativePiSessionFile(projectPath, nativeId)
      if (!file) return
      await client.switchSession(file)
      this.resumedNativeSessions.add(sessionId)
      Logger.info('Resumed native Pi session transcript', { sessionId, nativeSessionId: nativeId })
    } catch (error) {
      Logger.dev('Native Pi session resume unavailable; continuing fresh:', error)
    }
  }

  /** Mirror the native pi session id so driver records stay addressable. */
  /**
   * Load messages for an app-managed session, or   for sub-agent worker
   * threads   the native pi session transcript persisted on disk by the
   * in-process sub-agent session.
   *
   * The native transcript is authoritative whenever it exists and the live RPC
   * process is not already holding the conversation in memory: the engine's
   * resume decision treats a non-empty `loadMessages` result as "this harness
   * session natively holds the conversation" and skips the history-recap
   * replay. Returning the mirror there would make a fresh (unresumable) pi
   * session look resumable and silently drop all context.
   */
  override async loadMessages(projectPath: string, sessionId: string): Promise<AgentMessage[]> {
    return this.loadMessagesInternal(projectPath, sessionId, true)
  }

  /** Flush-aware transcript load for delegated child sessions: a settled
   *  child must not block the caller on a directory watch for a transcript
   *  file that can never appear (reopening a finished sub-agent otherwise
   *  waits seconds on every open). */
  loadSubagentMessages(
    projectPath: string,
    sessionId: string,
    options?: { waitForFlush?: boolean }
  ): Promise<AgentMessage[]> {
    // The extension streams a child session's transcript while it works, so
    // the trace so far is already in memory: return it instead of waiting for
    // pi to flush the child's session file (which it defers until the child's
    // first assistant message completes). Reopening a settled child keeps
    // working the same way until the entry is evicted, after which the session
    // file and the engine's mirror take over as before.
    const live = this.childStreams.get(sessionId)
    if (live && live.context.session.messages.length > 0) {
      // Whoever asked for this child's transcript is looking at it, so the
      // extension may forward its token deltas again.
      this.watchSubagentSession(sessionId)
      return Promise.resolve(structuredClone(live.context.session.messages))
    }
    return this.loadMessagesInternal(projectPath, sessionId, options?.waitForFlush ?? true)
  }

  private async loadMessagesInternal(
    projectPath: string,
    sessionId: string,
    waitForFlush: boolean
  ): Promise<AgentMessage[]> {
    if (!this.rpcClients.has(sessionId)) {
      const record = await this.readSessionRecord(projectPath, sessionId)
      if (record) {
        const native = await this.loadResumableNativeMessages(projectPath, sessionId, record)
        if (native) return native
        if (record.nativeSessionId) {
          // The session was bound to a native pi session whose transcript is
          // gone   the next turn starts a fresh session, so report no native
          // history and let the engine replay the durable mirror instead.
          return []
        }
      }
    }
    try {
      return await super.loadMessages(projectPath, sessionId)
    } catch (error) {
      const native = await loadNativeSubagentMessages(projectPath, sessionId, waitForFlush)
      if (native) return native
      // Throwing stays correct whenever a record genuinely exists   including
      // a hash-mismatched one (moved project), where the engine must retire
      // the dead session and create a replacement. Only a truly absent record
      // takes the child-session fallback: pi child sessions (cio_spawn_agent)
      // are never persisted as CLI session records, so "CLI session is
      // unavailable" is their normal state, not a failure   and pi never
      // flushes their transcripts to disk either (the nested SessionManager
      // inherits the parent cwd). Throwing there only spams the renderer with
      // repeated load errors while the sub-agent card's own activity already
      // carries the transcript preview; an empty result tells the engine to
      // keep using that preview.
      if (await this.readSessionRecordIgnoringPath(sessionId)) throw error
      return []
    }
  }

  /** The persisted session record, or null when the session is unknown. */
  private async readSessionRecord(
    projectPath: string,
    sessionId: string
  ): Promise<PersistentCliSession | null> {
    try {
      return await this.requireSession(projectPath, sessionId)
    } catch {
      return null
    }
  }

  /** Like `readSessionRecord`, but matches even a hash-mismatched record. */
  private async readSessionRecordIgnoringPath(
    sessionId: string
  ): Promise<PersistentCliSession | null> {
    return (
      (await this.storage
        .read<PersistentCliSession>(this.sessionPath(sessionId))
        .catch(() => null)) ?? null
    )
  }

  /**
   * Restore this session's native pi transcript binding from the most recent
   * resumable session record for the thread. Called when a thread returns to
   * pi after a harness switch: the thread's session slot now belongs to the
   * other harness, but pi still holds the real transcript on disk   without
   * this the returning turn cold-starts on the engine's history recap, which
   * weaker models read as injected fiction and freeze on.
   */
  async restoreNativeBinding(
    projectPath: string,
    sessionId: string,
    threadId: string
  ): Promise<boolean> {
    try {
      const replacement = await this.requireSession(projectPath, sessionId)
      if (replacement.nativeSessionId) return true
      const previous = await this.findLatestThreadSession(projectPath, threadId)
      if (!previous || previous.id === sessionId) return false
      const nativeId = previous.nativeSessionId
      if (!nativeId) return false
      if (!existsSync(nativePiSessionDir(projectPath))) return false
      if (!(await findNativePiSessionFile(projectPath, nativeId))) return false
      replacement.nativeSessionId = nativeId
      Logger.info('Restored native Pi transcript binding after harness switch', {
        sessionId,
        threadId,
        fromSessionId: previous.id,
        nativeSessionId: nativeId
      })
      return true
    } catch (error) {
      Logger.dev('Native Pi binding restore skipped:', error)
      return false
    }
  }

  /**
   * Seed a fresh session with the thread's edited history as a native pi
   * transcript. Used after the user edits a session (delete/truncate/collapse):
   * instead of replaying the remaining mirror as a history recap   which weak
   * models read as injected fiction and stall on   the next RPC spawn resumes
   * this synthetic transcript natively, exactly as if the conversation had
   * happened in pi itself.
   */
  async prefillNativeSession(
    projectPath: string,
    sessionId: string,
    messages: readonly AgentMessage[]
  ): Promise<boolean> {
    try {
      const session = await this.requireSession(projectPath, sessionId)
      if (session.nativeSessionId) return true
      const entries = prefillTranscriptEntries(projectPath, messages)
      if (entries.length === 0) return false
      const dir = nativePiSessionDir(projectPath)
      await mkdir(dir, { recursive: true })
      const nativeId = randomUUID()
      const file = join(dir, `${new Date().toISOString().replace(/[:.]/gu, '-')}_${nativeId}.jsonl`)
      await writeFile(file, `${entries.join('\n')}\n`, 'utf8')
      session.nativeSessionId = nativeId
      await this.persistSession(session)
      Logger.info('Seeded a native Pi transcript from the edited mirror', {
        sessionId,
        nativeSessionId: nativeId,
        entries: entries.length
      })
      return true
    } catch (error) {
      Logger.dev('Native Pi transcript prefill skipped:', error)
      return false
    }
  }

  /**
   * Carry a replaced session's native pi transcript binding over to the
   * replacement record. When the engine mints a replacement app session (the
   * stored session became unreachable), the fresh record starts without a
   * nativeSessionId   without this transfer the thread's real native
   * transcript is orphaned and every later turn degrades to the engine's
   * history recap, which models can misread as fabricated context.
   */
  async inheritNativeSession(
    projectPath: string,
    fromSessionId: string,
    toSessionId: string
  ): Promise<boolean> {
    try {
      const previous = await this.readSessionRecord(projectPath, fromSessionId)
      const nativeId = previous?.nativeSessionId
      if (!nativeId) return false
      if (!existsSync(nativePiSessionDir(projectPath))) return false
      if (!(await findNativePiSessionFile(projectPath, nativeId))) return false
      const replacement = await this.requireSession(projectPath, toSessionId)
      if (replacement.nativeSessionId) return true
      replacement.nativeSessionId = nativeId
      Logger.info('Inherited native Pi session transcript onto a replacement session', {
        fromSessionId,
        toSessionId,
        nativeSessionId: nativeId
      })
      return true
    } catch (error) {
      Logger.dev('Native Pi session inheritance skipped:', error)
      return false
    }
  }

  /**
   * Parse pi's own transcript for a cold (no live RPC process) session whose
   * native session file still exists on disk. Returns null when the session is
   * not natively resumable so the caller falls back to the mirror.
   */
  private async loadResumableNativeMessages(
    projectPath: string,
    sessionId: string,
    sessionRecord: PersistentCliSession
  ): Promise<AgentMessage[] | null> {
    const nativeId = sessionRecord.nativeSessionId
    if (!nativeId) return null
    if (!existsSync(nativePiSessionDir(projectPath))) return null
    const file = await findNativePiSessionFile(projectPath, nativeId)
    if (!file) return null
    try {
      const messages = await parseNativePiSession(file, sessionId)
      return messages.length > 0 ? messages : null
    } catch (error) {
      Logger.dev('Pi native transcript parse failed during resume check:', error)
      return null
    }
  }

  private async syncNativeSessionId(projectPath: string, sessionId: string): Promise<void> {
    const client = this.rpcClients.get(sessionId)
    if (!client) return
    const state = record(await client.getState())
    const nativeId = stringValue(state?.['sessionId'])
    if (!nativeId) return
    const session = await this.requireSession(projectPath, sessionId)
    session.nativeSessionId = nativeId
  }

  private handleRpcEvent(
    record: Record<string, unknown>,
    sessionId: string,
    projectPath: string
  ): Promise<void> {
    this.touchSessionActivity(sessionId)
    return this.requireSession(projectPath, sessionId)
      .then(async (session) => {
        // Resolve the retained context at compaction time, never while forking.
        const compaction = parseRecord(record['result'])
        const keptId = compaction?.['firstKeptEntryId']
        const details = parseRecord(compaction?.['details'])
        const trace = parseRecord(details?.['lastWorkingTrace'])
        const retainedAt =
          details?.['kind'] === 'cio-page-checkpoint' && trace?.['firstKeptEntryId'] === keptId
            ? numberValue(trace?.['firstKeptCreatedAt'])
            : undefined
        if (retainedAt !== undefined) record['firstKeptCreatedAt'] = retainedAt
        if (
          (record['type'] === 'auto_compaction_end' || record['type'] === 'compaction_end') &&
          typeof keptId === 'string' &&
          retainedAt === undefined &&
          session.nativeSessionId
        ) {
          try {
            const file = await findNativePiSessionFile(projectPath, session.nativeSessionId)
            if (file) {
              const input = createReadStream(file)
              const lines = createInterface({ input, crlfDelay: Infinity })
              try {
                for await (const line of lines) {
                  const entry = parseRecord(line)
                  if (entry?.['id'] === keptId) {
                    const message = parseRecord(entry['message'])
                    if (message) record['firstKeptCreatedAt'] = messageTimestamp(message)
                    break
                  }
                  await new Promise<void>((resolve) => setImmediate(resolve))
                }
              } finally {
                lines.close()
                input.destroy()
              }
            }
          } catch (error) {
            Logger.dev('Pi compaction retained boundary unavailable:', error)
          }
        }
        const result = this.parseJsonLine(record, { session, sessionId, projectPath })
        if (!result) return
        if (result.nativeSessionId) session.nativeSessionId = result.nativeSessionId
        if (result.messages) this.mergeMessages(session, result.messages)
        for (const event of this.normalizeInteractionEvents(session.id, result.events ?? [])) {
          // A successful assistant completion proves the provider recovered, so
          // the flake budget resets: a long agentic turn that survives many
          // scattered hiccups must not be capped by their cumulative count.
          if (
            event.type === 'message.completed' &&
            !event.error &&
            !event.silentContinue &&
            !event.compaction
          ) {
            const state = this.silentContinues.get(session.id)
            if (state && state.attempts > 0) {
              state.attempts = 0
              this.silentContinues.set(session.id, state)
            }
            // The provider accepted a request again   stand the oversized
            // recovery context stripping down so future turns send full media.
            void this.publishOversizedRecovery(session.id, false)
          }
          // A continuable finish-reason flake is claimed by the driver: strip
          // the marker and never let the errored completion reach the engine,
          // or the chat would show a failure the silent continue is about to
          // recover from. The empty assistant message is dropped from the
          // mirror so the user never sees a blank failed turn.
          if (event.type === 'message.completed' && event.silentContinue) {
            const compactFirst = isOversizedRequestError(event.silentContinue.error)
            const state = this.silentContinues.get(session.id) ?? {
              attempts: 0,
              owed: false,
              lastError: ''
            }
            state.lastError = event.silentContinue.error
            const { silentContinue, ...clean } = event
            void silentContinue
            const maxAttempts = compactFirst
              ? OVERSIZED_COMPACT_MAX_ATTEMPTS
              : SILENT_CONTINUE_MAX_ATTEMPTS
            if (state.attempts < maxAttempts) {
              state.owed = true
              state.attempts += 1
              state.compactFirst = compactFirst
              this.silentContinues.set(session.id, state)
              // Mark the flaked message complete (without the error) so the
              // mirror stays consistent; content-bearing messages are kept.
              this.applyEventToSession(session, clean)
              this.dropMirroredEmptyAssistant(session)
              continue
            }
            // Cap reached: surface the original error through the normal path.
            state.owed = false
            this.silentContinues.set(session.id, state)
            const failure: SessionAgentEvent = { ...clean, error: state.lastError }
            this.applyEventToSession(session, failure)
            this.emit(failure)
            continue
          }
          this.applyEventToSession(session, event)
          this.emit({ ...event, sessionId: session.id })
        }
        session.updatedAt = Date.now()
        // pi auto-retries transient failures, emitting `agent_end` for every
        // attempt, before `auto_retry_end` and finally `agent_settled`. Only
        // `agent_settled` is a stable signal that no retry or queued
        // continuation remains, so never finalize a turn on `agent_end`.
        if (record['type'] === 'agent_settled') {
          // A settled signal during an RPC-initiated compaction is the
          // compaction run itself finishing, not the end of the logical turn:
          // pi still owes the user a retry of the aborted prompt. Register the
          // compaction turn so its streaming and finalization are tracked like
          // any other turn, and never finalize here   the compaction's own
          // `agent_settled` finalizes the whole turn.
          if (this.turnStates.get(session.id)?.compacting) return
          if (this.beginSilentContinue(session)) return
          this.activeTurns.delete(session.id)
          void this.refreshSessionUsage(session).finally(() => {
            void this.finishTurn(session)
          })
        }
      })
      .catch((error) => {
        Logger.dev('Pi event handler dropped', error)
      })
  }

  /**
   * Drop the trailing assistant message the mirror captured for a flaked turn
   * when it produced no user-visible content, so the silent continue does not
   * leave a blank stub behind.
   */
  private dropMirroredEmptyAssistant(session: PersistentCliSession): void {
    const last = [...session.messages].reverse().find((message) => message.role === 'assistant')
    if (!last || last.error) return
    const hasContent = last.parts.some((part) => {
      if (part.type === 'text' || part.type === 'reasoning') return part.text.trim().length > 0
      return part.type === 'tool'
    })
    if (hasContent) return
    const index = session.messages.indexOf(last)
    if (index !== -1) session.messages.splice(index, 1)
  }

  /**
   * Claim a owed silent continue when the turn settles. Returns true when a
   * continuation was started (the turn stays active); false when there is
   * nothing owed and the turn should finalize normally.
   */
  private beginSilentContinue(session: PersistentCliSession): boolean {
    const state = this.silentContinues.get(session.id)
    if (!state?.owed) return false
    state.owed = false
    this.dropMirroredEmptyAssistant(session)
    const client = this.rpcClients.get(session.id)
    if (!client) {
      this.failSilentContinue(session, state.lastError)
      return true
    }
    if (state.compactFirst) {
      void this.compactAndContinue(session, client, state)
      return true
    }
    void this.promptContinuation(
      session,
      this.sessionProjects.get(session.id),
      'Continue.',
      state.lastError
    )
    return true
  }

  /** Re-prompt a settled turn on the continuation channel. A rejection here is
   *  a transport/state failure (pi rejects `prompt` only at transport level;
   *  provider errors stream as events afterwards), so recover instead of
   *  killing the turn: retry the live client once after a short settle, then
   *  boot a fresh RPC process (which resumes the persisted native transcript)
   *  and try again. Only a double failure finalizes the turn with the error. */
  private async promptContinuation(
    session: PersistentCliSession,
    projectPath: string | undefined,
    text: string,
    fallbackError: string
  ): Promise<void> {
    const live = this.rpcClients.get(session.id)
    if (live) {
      try {
        await live.prompt(text)
        return
      } catch (error) {
        Logger.error('Pi continuation prompt rejected by the live client', {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error)
        })
      }
      // The compaction lane can still be settling when the continuation is
      // issued; a short delay clears the transient busy state.
      await new Promise((resolve) => setTimeout(resolve, 300))
      try {
        await live.prompt(text)
        return
      } catch {
        // Fall through to the fresh-process recovery.
      }
    }
    if (projectPath) {
      try {
        this.disposeRpcClient(session.id)
        const fresh = await this.ensureRpcClient(projectPath, session.id)
        await fresh.prompt(text)
        return
      } catch (error) {
        Logger.error('Pi continuation retry on a fresh RPC process failed', {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    this.failSilentContinue(session, fallbackError)
  }

  /**
   * Recover an oversized-request-body failure: compact the transcript so the
   * replayed history collapses into a summary and the next request fits the
   * provider's byte limit, then re-prompt. The turn stays active throughout  
   * the compaction run's own `agent_settled` is swallowed by the `compacting`
   * turn-state flag, and the continuation run finalizes the turn normally.
   */
  private async compactAndContinue(
    session: PersistentCliSession,
    client: PiRpcClient,
    state: PiSilentContinueState
  ): Promise<void> {
    const projectPath = this.sessionProjects.get(session.id)
    if (!projectPath) {
      this.failSilentContinue(session, state.lastError)
      return
    }
    const turnState = this.turnStates.get(session.id)
    this.turnStates.set(session.id, {
      assistantMessageId: turnState?.assistantMessageId ?? null,
      turnIndex: Math.max(
        turnState?.turnIndex ?? 0,
        latestPiTurnIndex(session.messages, session.id)
      ),
      compacting: true
    })
    try {
      const result = await client.compact()
      await this.handleRpcEvent({ type: 'compaction_end', result }, session.id, projectPath)
    } catch (error) {
      this.turnStates.set(session.id, {
        ...(this.turnStates.get(session.id) ?? { assistantMessageId: null, turnIndex: 0 }),
        compacting: false
      })
      this.failSilentContinue(session, error instanceof Error ? error.message : state.lastError)
      return
    }
    // Clear the compacting flag before starting the continuation so the
    // compaction run's `agent_settled` (if any) finalizes cleanly and the
    // continuation run owns the turn from there.
    const settled = this.turnStates.get(session.id)
    if (settled) this.turnStates.set(session.id, { ...settled, compacting: false })
    // `prompt`   not `followUp`   is the only correct continuation here. pi's
    // `compact` RPC aborts the run and settles to idle before summarizing, and
    // queued follow-ups are drained exclusively at the end of an active run,
    // so a follow-up queued into an idle session is never delivered (the turn
    // silently stalls   pi's own TUI re-prompts after compaction for the same
    // reason). A fresh prompt starts the new run when idle.
    // Arm the oversized-recovery extension before the continuation: the
    // compaction kept the recent transcript tail intact, and that tail is
    // exactly where multi-hundred-KB base64 image tool results live
    // compaction alone cannot bring the request body under the provider's
    // byte limit. While armed, the extension's `context` hook strips image
    // parts and oversized text from the REQUEST copy only; the transcript
    // keeps the originals. Disarmed again on the first successful completion.
    await this.publishOversizedRecovery(session.id, true)
    try {
      await client.prompt('Continue.')
    } catch (error) {
      // Keep the recovery armed: the fresh-process retry below still needs the
      // extension to strip image parts and oversized text from the request.
      await this.promptContinuation(
        session,
        projectPath,
        'Continue.',
        error instanceof Error ? error.message : state.lastError
      )
    }
  }

  /** Rewrite the session's oversized-recovery arm/disarm flag file. A missing
   *  materialized path (extension failed to load) means the next provider
   *  request goes out unmodified   never blocks the turn. */
  private async publishOversizedRecovery(sessionId: string, armed: boolean): Promise<void> {
    const path = this.cioOversizedFlagPaths.get(sessionId)
    if (!path) return
    try {
      await this.storage.writeRaw(path, JSON.stringify({ armed }))
    } catch (error) {
      Logger.dev('Pi core-tools oversized-recovery flag update failed:', error)
    }
  }

  /** Remove a session's gateway handoff file and forget its path. */
  private async removeGatewayHandoff(sessionId: string): Promise<void> {
    const handoffPath = this.gatewayHandoffPaths.get(sessionId)
    if (!handoffPath) {
      this.pendingGatewayEndpoints.delete(sessionId)
      return
    }
    this.gatewayHandoffPaths.delete(sessionId)
    this.pendingGatewayEndpoints.delete(sessionId)
    try {
      await this.storage.removeRaw(handoffPath)
    } catch (error) {
      Logger.dev('Pi utility gateway handoff removal failed:', error)
    }
  }

  /** Surface a silent continue that could not be started as a real error. */
  private failSilentContinue(session: PersistentCliSession, error: string): void {
    // Logged at error level: a silent-continue failure kills a real turn, and
    // the raw reason (pi process death, transport rejection) was previously
    // invisible everywhere but the user-facing card, making diagnosis impossible.
    Logger.error('Pi silent continue failed; finalizing the turn', {
      sessionId: session.id,
      error
    })
    this.silentContinues.delete(session.id)
    this.activeTurns.delete(session.id)
    this.emit({
      type: 'session.error',
      sessionId: session.id,
      error: error || 'Pi turn failed'
    })
    void this.finishTurn(session)
  }

  private handleRpcExit(code: number | null, sessionId: string): void {
    void code
    // Drop the dead client so the next turn spawns a fresh RPC process and
    // resumes the persisted native transcript instead of failing on a dead
    // pipe (or worse, silently continuing a context-less session).
    this.disposeRpcClient(sessionId)
    // Nested worker sessions lived inside this process: their transcripts settle
    // as failed, or a killed session would leave their cards spinning forever.
    this.settleChildStreams(sessionId, 'error')
    if (this.activeTurns.has(sessionId)) {
      this.activeTurns.delete(sessionId)
      // The pi process died mid-turn; persist whatever was mirrored and
      // surface the idle state so the thread does not stay "working".
      const projectPath = this.sessionProjects.get(sessionId)
      if (projectPath) {
        this.requireSession(projectPath, sessionId)
          .then((session) => void this.finishTurn(session))
          .catch((error) => Logger.dev('Pi exit finalization failed:', error))
      }
    }
  }

  /** Preserve the logical turn while the 85% checkpoint aborts, compacts, and resumes Pi. */
  private async compactPageCheckpoint(sessionId: string, resume: boolean): Promise<void> {
    const client = this.rpcClients.get(sessionId)
    const projectPath = this.sessionProjects.get(sessionId)
    const turn = this.turnStates.get(sessionId)
    if (
      !client ||
      !projectPath ||
      !turn ||
      turn.compacting ||
      this.pageCompactions.has(sessionId)
    ) {
      return
    }
    const ticket = { resume }
    this.pageCompactions.set(sessionId, ticket)
    this.turnStates.set(sessionId, { ...turn, compacting: true })
    this.activeTurns.add(sessionId)
    const current = () => this.pageCompactions.get(sessionId) === ticket
    try {
      // Native overflow recovery may already own the session. Let it finish
      // through the same page hook instead of interrupting its checkpoint.
      const state = record(await client.getState())
      if (!current() || state?.['isCompacting'] === true) return
      const result = await client.compact()
      if (!current()) return
      await this.handleRpcEvent(
        { type: 'compaction_end', result, reason: 'threshold' },
        sessionId,
        projectPath
      )
      if (!current()) return
      const after = record(await client.getState())
      if (!current()) return
      const latest = this.turnStates.get(sessionId)
      if (latest) this.turnStates.set(sessionId, { ...latest, compacting: false })
      if (after?.['isStreaming'] === true) return
      if (ticket.resume || (numberValue(after?.['pendingMessageCount']) ?? 0) > 0) {
        await client.prompt(
          'Continue from the Last working trace in the checkpoint. Complete the current step, then the next unfinished step.'
        )
      } else {
        const session = await this.requireSession(projectPath, sessionId)
        this.activeTurns.delete(sessionId)
        await this.refreshSessionUsage(session)
        await this.finishTurn(session)
      }
    } catch (error) {
      if (!current()) return
      const session = await this.requireSession(projectPath, sessionId)
      if (!current()) return
      // The compaction succeeded; only the resume failed. Recover through the
      // resilient continuation instead of discarding a healthy checkpointed
      // turn   a fresh RPC process resumes the persisted native transcript.
      const latest = this.turnStates.get(sessionId)
      if (latest) this.turnStates.set(sessionId, { ...latest, compacting: false })
      await this.promptContinuation(
        session,
        projectPath,
        'Continue from the Last working trace in the checkpoint. Complete the current step, then the next unfinished step.',
        error instanceof Error ? error.message : String(error)
      )
    } finally {
      if (current()) {
        this.pageCompactions.delete(sessionId)
        const latest = this.turnStates.get(sessionId)
        if (latest) this.turnStates.set(sessionId, { ...latest, compacting: false })
      }
    }
  }

  /** Route app-owned extension status records and compaction requests. */
  private handleExtensionStatus(record: Record<string, unknown>, sessionId: string): void {
    if (stringValue(record['statusKey']) === PI_COMPACTION_EXTENSION_KEY) {
      const request = parseRecord(record['statusText'])
      if (request?.['type'] === 'ready') this.compactionReadySessions.add(sessionId)
      if (request?.['type'] === 'threshold') {
        void this.compactPageCheckpoint(sessionId, request['resume'] === true)
      }
      return
    }
    if (stringValue(record['statusKey']) === PI_USAGE_EXTENSION_KEY) {
      void this.handleUsageStatus(record, sessionId)
      return
    }
    if (stringValue(record['statusKey']) === CIO_SUBAGENT_STREAM_STATUS_KEY) {
      this.handleSubagentStreamStatus(record, sessionId)
      return
    }
    if (stringValue(record['statusKey']) !== PI_STATUS_EXTENSION_KEY) return
    const text = stringValue(record['statusText'])
    if (!text) return
    if (!this.activeTurns.has(sessionId)) return
    const state =
      text === PI_STATUS_WORKING || text === PI_STATUS_COMPACTING
        ? ({ state: 'working' } as const)
        : text === PI_STATUS_IDLE
          ? ({ state: 'idle' } as const)
          : null
    if (!state) return
    // `agent_settled` remains the sole finalization trigger (usage stats +
    // session persistence); the idle status here only clears the busy flag.
    this.emit({ type: 'session.status', sessionId, status: state })
  }

  /**
   * Close the parent thread's sub-agent card for one settled child session.
   *
   * A background spawn's tool call returns before its worker does, and the
   * `cio-subagent-done` notification only reaches the driver once the model
   * loop drains it (the drain can wait a whole turn). The child's own stream
   * already reports the settle, so stamping the parent card here is what keeps
   * the card, the dropdown and the tab on the same terminal state at the same
   * moment. The card's earlier payload still wins for output, files and model:
   * only the lifecycle fields are authoritative here.
   */
  private closeSubagentCard(
    parentSessionId: string,
    childSessionId: string,
    error: string | undefined,
    status: AgentToolStatus = error ? 'error' : 'completed',
    force = false
  ): void {
    // A parent that is mid-turn buffers the done notification until its loop
    // reaches the next step, which is exactly the lag this closes. An idle
    // parent runs the notification turn immediately, so its own patch lands
    // just as fast and this extra update would only flip the thread's live
    // activity back on with no turn behind it. A stop is the exception: the
    // parent's turn is already gone when its workers settle, so a stopped
    // worker's card is stamped regardless   otherwise it spins forever.
    if (!force && !this.activeTurns.has(parentSessionId)) return
    const session = this.sessionCache.get(parentSessionId)
    if (!session) return
    for (const message of session.messages) {
      const part = message.parts.findLast(
        (candidate): candidate is Extract<AgentPart, { type: 'subagent' }> =>
          candidate.type === 'subagent' && candidate.activity.childSessionId === childSessionId
      )
      // A card that already reports a terminal state carries the richer
      // payload (final output, duration); never overwrite it with a lifecycle
      // stamp alone.
      if (!part || TERMINAL_SUBAGENT_STATUSES.has(part.activity.status)) {
        continue
      }
      const event: SessionAgentEvent = {
        type: 'message.part.updated',
        sessionId: parentSessionId,
        part: {
          ...part,
          activity: {
            ...part.activity,
            status,
            ...(error ? { error } : {}),
            time: subagentTimeRange(part.activity, status)
          }
        }
      }
      this.applyEventToSession(session, event)
      this.emit(event)
    }
  }

  /**
   * Close every still-open child transcript of one parent session. Called when
   * the user stops the session (its workers are being aborted) and when the
   * harness process dies (its nested sessions die with it), so no sub-agent
   * card, tab or trace row can keep spinning for work that is already gone.
   */
  private settleChildStreams(
    parentSessionId: string,
    status: 'aborted' | 'error',
    onlyChildSessionId?: string
  ): void {
    const error =
      status === 'error' ? 'The session ended while this sub-agent was still running.' : undefined
    for (const [childSessionId, state] of this.childStreams) {
      if (state.parentSessionId !== parentSessionId || state.settled) continue
      if (onlyChildSessionId && childSessionId !== onlyChildSessionId) continue
      state.settled = true
      this.closeSubagentCard(parentSessionId, childSessionId, error, status, true)
      if (status === 'aborted') {
        this.emit({ type: 'session.status', sessionId: childSessionId, status: { state: 'idle' } })
        continue
      }
      const detail = error ?? 'The sub-agent run ended unexpectedly.'
      const kind = classifyProviderIssue(detail)
      this.emit({
        type: 'session.status',
        sessionId: childSessionId,
        status: {
          state: 'error',
          issue: {
            kind,
            message: presentProviderError(detail).message,
            rawError: detail,
            harnessId: this.id,
            retryable: kind !== 'billing'
          }
        }
      })
    }
  }

  /**
   * Fold one batch of streamed child-session records into that child's live
   * transcript and re-emit them as child-scoped events. Records carry pi's own
   * shapes, so they go through `mapPiRecord`   the exact mapper a root thread
   * uses   which is what makes a sub-agent stream and render like a normal
   * thread: the engine broadcasts whatever session id the driver reports, and
   * the sub-agent view already filters on the child session id.
   */
  private handleSubagentStreamStatus(
    record: Record<string, unknown>,
    parentSessionId: string
  ): void {
    const payload = parseRecord(record['statusText'])
    if (!payload) return
    const childSessionId = stringValue(payload['childSessionId'])
    if (!childSessionId) return
    const state = this.childStreamState(childSessionId, parentSessionId)
    const records = Array.isArray(payload['records']) ? payload['records'] : []
    if (records.length > 0 && !state.announcedWorking && !state.settled) {
      state.announcedWorking = true
      this.emit({ type: 'session.status', sessionId: childSessionId, status: { state: 'working' } })
    }
    for (const value of records) {
      const result = mapPiRecord(value, state.context, state.turnState)
      if (!result) continue
      for (const message of result.messages ?? []) {
        const messages = state.context.session.messages
        const index = messages.findIndex((candidate) => candidate.id === message.id)
        if (index === -1) messages.push(message)
        else messages[index] = message
      }
      for (const event of result.events ?? []) {
        this.applyChildStreamEvent(state, event)
        this.emit({ ...event, sessionId: childSessionId })
      }
    }
    if (payload['settled'] !== true) return
    state.settled = true
    const error = stringValue(payload['error'])
    // A worker the user stopped is neither a completion nor a failure: it gets
    // its own terminal status so no surface can report finished work, and its
    // card is stamped even though the stopped parent turn is already gone.
    const aborted = stringValue(payload['status']) === 'aborted'
    const status: AgentToolStatus = aborted ? 'aborted' : error ? 'error' : 'completed'
    // The child's own settle record closes the parent thread's card, so the
    // working-trace dropdown and the sub-agent tab flip together instead of
    // the card waiting for the model loop to drain its done notification.
    this.closeSubagentCard(parentSessionId, childSessionId, error, status, aborted)
    if (!error || aborted) {
      this.emit({ type: 'session.status', sessionId: childSessionId, status: { state: 'idle' } })
      return
    }
    // The child's failure belongs to the child's transcript: report it on the
    // child session so the sub-agent view shows the reason and offers a retry,
    // never on the parent thread.
    const kind = classifyProviderIssue(error)
    this.emit({
      type: 'session.status',
      sessionId: childSessionId,
      status: {
        state: 'error',
        issue: {
          kind,
          message: presentProviderError(error).message,
          rawError: error,
          harnessId: this.id,
          retryable: kind !== 'billing'
        }
      }
    })
  }

  /**
   * Fold one child event into that child's transcript. A root session's
   * transcript is rebuilt from the harness (the driver only stamps it), but a
   * child session's transcript exists nowhere else until pi flushes its file
   *   so a streamed part whose message has not been materialized yet creates
   * that message here. Without this the live snapshot would be empty and the
   * final tool inputs could not be correlated with their results.
   */
  private applyChildStreamEvent(state: PiChildStreamState, event: SessionAgentEvent): void {
    const messages = state.context.session.messages
    if (event.type === 'message.part.updated' && event.part.type !== 'subagent') {
      if (!messages.some((message) => message.id === event.part.messageID)) {
        messages.push({
          id: event.part.messageID,
          role: 'assistant',
          parts: [],
          createdAt: Date.now(),
          harnessId: this.id
        })
      }
    }
    this.applyEventToMessages(messages, event)
  }

  /** The live transcript state of one child session, capped and LRU-ordered. */
  private childStreamState(childSessionId: string, parentSessionId: string): PiChildStreamState {
    const existing = this.childStreams.get(childSessionId)
    if (existing) {
      // Re-insert so the oldest entry is always the least recently used.
      this.childStreams.delete(childSessionId)
      this.childStreams.set(childSessionId, existing)
      return existing
    }
    const created: PiChildStreamState = {
      context: { sessionId: childSessionId, session: { messages: [] } },
      turnState: { assistantMessageId: null, turnIndex: 0 },
      parentSessionId,
      announcedWorking: false,
      settled: false
    }
    this.childStreams.set(childSessionId, created)
    while (this.childStreams.size > PI_CHILD_STREAM_MAX) {
      const oldest = this.childStreams.keys().next().value
      if (oldest === undefined) break
      this.childStreams.delete(oldest)
    }
    return created
  }

  /**
   * Consume the usage extension's `setStatus` records: a JSON payload of the
   * provider response's rate-limit headers. Mapped into display windows and
   * cached per session until the next provider response refreshes them.
   */
  private async handleUsageStatus(
    record: Record<string, unknown>,
    sessionId: string
  ): Promise<void> {
    const text = stringValue(record['statusText'])
    if (!text) return
    let payload: unknown
    try {
      payload = JSON.parse(text) as unknown
    } catch {
      return
    }
    const windows = mapPiRateLimitHeaders(payload)
    if (windows.length === 0) return
    const providerId = piUsageProviderId(payload)
    this.latestRateLimits.set(sessionId, { providerId, windows })
    if (providerId) await this.rememberPersistedRateLimits(providerId, windows)
  }

  /** Load the persisted per-project windows map once per driver lifetime. */
  private async loadPersistedRateLimits(): Promise<Map<string, AgentRateLimitWindow[]>> {
    if (this.persistedRateLimits) return this.persistedRateLimits
    const map = new Map<string, AgentRateLimitWindow[]>()
    try {
      const raw = await this.storage.readRaw(PiDriver.USAGE_WINDOWS_PATH)
      if (raw) {
        const parsed: unknown = JSON.parse(raw)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [key, value] of Object.entries(parsed)) {
            if (Array.isArray(value)) {
              map.set(
                key,
                value.filter(
                  (entry): entry is AgentRateLimitWindow =>
                    entry !== null && typeof entry === 'object' && !Array.isArray(entry)
                )
              )
            }
          }
        }
      }
    } catch (error) {
      Logger.dev('Pi usage windows read failed:', error)
    }
    this.persistedRateLimits = map
    return map
  }

  /** Store the latest windows for a pi provider; writes are serialized and
   *  bounded so a long-lived driver never grows the file without bound. */
  private async rememberPersistedRateLimits(
    providerId: string,
    windows: AgentRateLimitWindow[]
  ): Promise<void> {
    const map = await this.loadPersistedRateLimits()
    const storageKey = this.rateLimitStorageKey(providerId)
    map.delete(storageKey)
    map.set(storageKey, windows)
    while (map.size > PiDriver.USAGE_WINDOWS_MAX_PROVIDERS) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
    if (this.persistedRateLimitsWrite) return
    const snapshot = JSON.stringify(Object.fromEntries(map))
    this.persistedRateLimitsWrite = this.storage
      .writeRaw(PiDriver.USAGE_WINDOWS_PATH, snapshot)
      .catch((error: unknown) => Logger.dev('Pi usage windows write failed:', error))
      .finally(() => {
        this.persistedRateLimitsWrite = null
      })
    await this.persistedRateLimitsWrite
  }

  /**
   * Managed Pi accounts share CodeInOven's runtime storage, so provider-only
   * keys would let one account's captured windows appear for another account.
   * The legacy account keeps the historical provider key for compatibility.
   */
  private rateLimitStorageKey(providerId: string): string {
    const agentDirectory = this.accountEnvironment['PI_CODING_AGENT_DIR']?.trim()
    if (!agentDirectory) return providerId
    const accountKey = createHash('sha256').update(agentDirectory).digest('hex').slice(0, 16)
    return `account:${accountKey}:${providerId}`
  }

  private handleUiRequest(record: Record<string, unknown>, sessionId: string): void {
    const rawId = record['id']
    const method = stringValue(record['method'])
    const client = this.rpcClients.get(sessionId)
    if ((typeof rawId !== 'string' && typeof rawId !== 'number') || !method || !client) return
    const requestId = `pi-ui-${sessionId}-${String(rawId)}`.replace(/[^a-zA-Z0-9._-]/gu, '-')
    // Keep one authoritative pending entry for a raw Pi dialog until the user
    // or policy resolves it. Repeated transport records must not create two UI
    // decisions for one blocked tool call.
    if (this.pendingUiRequests.has(requestId)) return
    // The core-tools extension's permission gate marks its confirm dialogs
    // with a structured payload so they surface as real permission cards
    // (policy enrichment, allow/reject) instead of plain question cards.
    const permissionPayload = permissionMarkerPayload(record)
    if (permissionPayload) {
      this.pendingUiRequests.set(requestId, {
        sessionId,
        method: 'cio-permission',
        client,
        request: record
      })
      this.emit({
        type: 'permission.asked',
        sessionId,
        permission: {
          id: requestId,
          sessionId,
          permission: permissionPayload.permission,
          patterns: permissionPayload.patterns,
          metadata: {
            ...(permissionPayload.tool ? { tool: permissionPayload.tool } : {}),
            ...(permissionPayload.command ? { command: permissionPayload.command } : {}),
            reason: stringValue(record['title']) ?? 'Destructive action requires approval'
          }
        }
      })
      return
    }
    // Pi has no structured question RPC method. The core-tools extension sends
    // one tagged envelope through the dialog channel and the driver unwraps it
    // directly into the shared question contract.
    const markedQuestions = questionMarkerPayload(record)
    if (markedQuestions) {
      this.pendingUiRequests.set(requestId, {
        sessionId,
        method: 'cio-question',
        client,
        request: record
      })
      this.emit({ type: 'question.asked', sessionId, requestId, questions: markedQuestions })
      return
    }
    const questions = normalizeAgentQuestions({
      questions: [
        {
          prompt:
            stringValue(record['title']) ??
            stringValue(record['message']) ??
            'Pi needs your input.',
          header: stringValue(record['title']),
          description: stringValue(record['message']),
          options: Array.isArray(record['options']) ? record['options'] : undefined,
          custom: method !== 'confirm'
        }
      ]
    })
    this.pendingUiRequests.set(requestId, { sessionId, method, client, request: record })
    this.emit({ type: 'question.asked', sessionId, requestId, questions })
  }

  /** Resolve the core-tools permission gate's confirm dialog. `reject` also
   *  covers alternative-instruction rejects: the gate blocks the tool call and
   *  the engine delivers the corrective feedback to the model separately. */
  override async replyPermission(
    _projectPath: string,
    requestId: string,
    reply: PermissionReply,
    _message?: string,
    sessionId?: string
  ): Promise<void> {
    void _projectPath
    void _message
    const request = this.pendingUiRequests.get(requestId)
    if (!request || request.method !== 'cio-permission') {
      throw new PermissionRequestGoneError(sessionId, requestId, this.name)
    }
    const rawId = request.request['id']
    if (typeof rawId !== 'string' && typeof rawId !== 'number') {
      throw new Error(`Pi permission request has an invalid id: ${requestId}`)
    }
    request.client.respondToExtensionUiRequest(
      rawId,
      reply === 'reject' ? { cancelled: true } : { confirmed: true }
    )
    this.pendingUiRequests.delete(requestId)
  }

  override async replyToQuestion(
    _projectPath: string,
    sessionId: string,
    requestId: string,
    answers: string[][]
  ): Promise<void> {
    const request = this.pendingUiRequests.get(requestId)
    if (!request || request.sessionId !== sessionId) {
      throw new QuestionRequestGoneError(sessionId, requestId, this.name)
    }
    const answer = answers[0]?.[0] ?? ''
    const rawId = request.request['id']
    if (typeof rawId !== 'string' && typeof rawId !== 'number') {
      throw new Error(`Pi question request has an invalid id: ${requestId}`)
    }
    if (request.method === 'confirm') {
      request.client.respondToExtensionUiRequest(rawId, {
        confirmed: /^(true|yes|y|allow|ok)$/iu.test(answer)
      })
    } else if (request.method === 'cio-question') {
      request.client.respondToExtensionUiRequest(rawId, { value: JSON.stringify(answers) })
    } else {
      request.client.respondToExtensionUiRequest(rawId, { value: answer })
    }
    this.pendingUiRequests.delete(requestId)
  }

  override async rejectQuestion(
    _projectPath: string,
    sessionId: string,
    requestId: string
  ): Promise<void> {
    const request = this.pendingUiRequests.get(requestId)
    if (!request || request.sessionId !== sessionId) {
      throw new QuestionRequestGoneError(sessionId, requestId, this.name)
    }
    const rawId = request.request['id']
    if (typeof rawId !== 'string' && typeof rawId !== 'number') {
      throw new Error(`Pi question request has an invalid id: ${requestId}`)
    }
    request.client.respondToExtensionUiRequest(rawId, { cancelled: true })
    this.pendingUiRequests.delete(requestId)
  }

  /** Attach the final session-stats context usage to the last assistant message. */
  private async refreshSessionUsage(session: PersistentCliSession): Promise<void> {
    await refreshSessionUsageFromStats(session, {
      client: this.rpcClients.get(session.id) ?? null,
      sessionStatsBroken: this.sessionStatsBroken,
      rateLimits: this.latestRateLimits.get(session.id)?.windows ?? [],
      applyEvent: (target, event) => this.applyEventToSession(target, event),
      emit: (event) => this.emit(event)
    })
  }

  private async finishTurn(session: PersistentCliSession): Promise<void> {
    // Reconcile compactions against pi's durable session transcript before
    // persisting: the live RPC event stream loses compaction records on
    // process exit, watchdog finalization, and between-turn compactions, but
    // pi itself always wrote them durably to the session JSONL.
    try {
      await reconcileNativeCompactions(session, this.sessionProjects.get(session.id), (messages) =>
        this.mergeMessages(session, messages)
      )
    } catch (error) {
      Logger.dev('Pi compaction reconciliation failed:', error)
    }
    try {
      await this.persistSession(session)
    } catch (error) {
      Logger.error('Pi session persistence failed:', error)
    }
    this.emit({ type: 'session.idle', sessionId: session.id })
  }

  /**
   * Driver contract hook (`reconcileSession`): recover compaction reporting
   * from pi's durable session transcript when a session settled without
   * driver finalization, so the engine's finalization and the next turn's
   * history replay see the recovered boundary.
   */
  async reconcileSession(projectPath: string, sessionId: string): Promise<void> {
    const session = await this.requireSession(projectPath, sessionId)
    await reconcileNativeCompactions(session, this.sessionProjects.get(session.id), (messages) =>
      this.mergeMessages(session, messages)
    )
    await this.persistSession(session)
  }

  /**
   * Post-turn compaction reconciliation (see `finishTurn`).
   *
   * Compaction reporting normally rides the live RPC event stream
   * (`compaction_end` / `auto_compaction_end` records). That stream is lost
   * when pi exits during or right after a compaction, when the engine
   * finalizes a settled session through the synthetic-idle watchdog, or when
   * pi compacts between turns. In all three cases the compaction is already
   * written durably to pi's own session JSONL, so this pass reads that
   * transcript once and:
   *
   * 1. Backfills `firstKeptCreatedAt` onto mirrored compaction parts whose
   *    boundary timestamp lookup raced the session-id sync, so recap and fork
   *    boundaries never silently discard the compaction.
   * 2. Mirrors compaction entries that never arrived as events, using the
   *    same message shape as `parseNativePiSession`, deduplicated against
   *    what was already reported by retained-boundary id or summary text.
   */

  /**
   * Write the app-owned status extension to a shared temp file (once per
   * driver). The cached path is reused across sessions; a failed write
   * returns null and the session launches without status monitoring instead
   * of failing the turn.
   */
  /**
   * Materialize one app-owned gateway extension module plus its session-keyed
   * handoff file. The extension registers the gateway tools at pi spawn, while
   * the handoff is rewritten per turn by `publishUtilityGatewayEndpoint`;
   * this method only guarantees both files exist. The extension embeds the
   * absolute handoff path, so both files are session-keyed   concurrent
   * sessions never overwrite each other's turn credentials.
   */
  /**
   * Materialize the single app-owned "cio-core-tools" extension for a session  
   * status, usage, the utility gateway, and the core tools composed into one
   * self-contained module (see pi-cio-core-tools-extension.ts) so pi's boot
   * loads one extension instead of four. The gateway handoff file and the
   * per-turn system-prompt handoff file live beside the module; their
   * storage-relative paths feed the existing publish/remove flows unchanged.
   * Startup rejects a failed materialization: running without this module
   * would silently restore Pi's default compaction policy.
   */
  private async materializeCioCoreToolsExtension(sessionId: string): Promise<string | null> {
    const existing = this.cioCoreToolsExtensionPaths.get(sessionId)
    if (existing) return existing
    try {
      const directory = join('runtime', 'cio-core-tools', sessionId)
      const handoffRelative = join(directory, 'gateway-handoff.json')
      const systemPromptRelative = join(directory, 'system-prompt.txt')
      const allowedToolsRelative = join(directory, 'allowed-tools.json')
      const oversizedFlagRelative = join(directory, 'oversized-recovery.json')
      const stopFlagRelative = join(directory, 'stop-request.json')
      const watchFlagRelative = join(directory, 'watched-subagents.json')
      const extensionRelative = join(directory, 'cio-core-tools.ts')
      // Empty endpoint values: the gateway tools surface a clear gateway-inactive
      // error until the first direct-gateway turn publishes the real { url, token }.
      await this.storage.writeRaw(handoffRelative, JSON.stringify({ url: '', token: '' }))
      await this.storage.writeRaw(systemPromptRelative, '')
      await this.storage.writeRaw(allowedToolsRelative, '[]')
      await this.storage.writeRaw(oversizedFlagRelative, JSON.stringify({ armed: false }))
      await this.storage.writeRaw(stopFlagRelative, JSON.stringify(emptyStopRequest()))
      await this.storage.writeRaw(watchFlagRelative, JSON.stringify({ childSessionIds: [] }))
      await this.storage.writeRaw(
        extensionRelative,
        piCioCoreToolsExtension({
          // One-shot sessions (title, grading, lessons) are pure text turns:
          // they never publish a gateway endpoint, so the gateway/interactive
          // tools would only bloat the model request and invite spurious
          // tool calls. Status/usage/compaction stay for every session.
          oneShot: this.isTitleSession(sessionId),
          gatewayHandoffPath: this.storage.resolve(handoffRelative),
          systemPromptPath: this.storage.resolve(systemPromptRelative),
          allowedToolsPath: this.storage.resolve(allowedToolsRelative),
          oversizedFlagPath: this.storage.resolve(oversizedFlagRelative),
          stopFlagPath: this.storage.resolve(stopFlagRelative),
          subagentWatchPath: this.storage.resolve(watchFlagRelative),
          sessionId,
          // Same durable resolver the orchestration service publishes for the
          // prose recovery path; the gateway tools use it for host-level
          // self-healing when the loopback port moved across an app restart.
          retrieveScriptPath: this.storage.resolve(
            join('runtime', 'utility-gateway', `${RETRIEVE_MCP_HOST_TOOL_NAME}.mjs`)
          )
        })
      )
      this.gatewayHandoffPaths.set(sessionId, handoffRelative)
      this.cioSystemPromptPaths.set(sessionId, systemPromptRelative)
      this.cioAllowedToolsPaths.set(sessionId, allowedToolsRelative)
      this.cioOversizedFlagPaths.set(sessionId, oversizedFlagRelative)
      this.cioStopFlagPaths.set(sessionId, stopFlagRelative)
      this.cioWatchFlagPaths.set(sessionId, watchFlagRelative)
      this.cioWatchedChildren.set(sessionId, new Map())
      const extensionAbsolute = this.storage.resolve(extensionRelative)
      this.cioCoreToolsExtensionPaths.set(sessionId, extensionAbsolute)
      // Flush an endpoint that arrived before this materialization (first turn
      // of a fresh session); the handoff file still holds the empty seed otherwise.
      const pendingEndpoint = this.pendingGatewayEndpoints.get(sessionId)
      if (pendingEndpoint) {
        this.pendingGatewayEndpoints.delete(sessionId)
        await this.storage.writeRaw(handoffRelative, JSON.stringify(pendingEndpoint))
      }
      return extensionAbsolute
    } catch (error) {
      Logger.dev('Pi cio-core-tools extension materialization failed:', error)
      return null
    }
  }

  /** Rewrite the session's CIO system-prompt handoff file so the extension's
   *  `before_agent_start` hook picks it up on the next agent loop start. A
   *  missing materialized path (extension failed to load) means the turn
   *  falls back to Pi's own system prompt only   never blocks the turn. */
  private async publishCioSystemPrompt(sessionId: string, systemPrompt: string): Promise<void> {
    const path = this.cioSystemPromptPaths.get(sessionId)
    if (!path) return
    try {
      await this.storage.writeRaw(path, systemPrompt)
    } catch (error) {
      Logger.dev('Pi core-tools system-prompt handoff update failed:', error)
    }
  }

  /** Rewrite the session's allowed-tools handoff file so the extension's tool
   *  gate reflects the current permission scope (web-only chat vs. file
   *  access). Undefined/empty publishes an unrestricted session. Never blocks
   *  the turn when the extension was not materialized. */
  private async publishCioAllowedTools(sessionId: string, allowedTools?: string[]): Promise<void> {
    const path = this.cioAllowedToolsPaths.get(sessionId)
    if (!path) return
    try {
      // Some allowlists are authored in OpenCode tool naming; map the aliases
      // onto pi's built-in tool names so the gate matches intent.
      const aliases: Record<string, string> = { glob: 'find', list: 'ls' }
      const names = (allowedTools ?? []).map((tool) => aliases[tool] ?? tool)
      await this.storage.writeRaw(path, JSON.stringify(names))
    } catch (error) {
      Logger.dev('Pi core-tools allowed-tools handoff update failed:', error)
    }
  }

  private disposeRpcClient(sessionId: string): void {
    this.compactionReadySessions.delete(sessionId)
    this.pageCompactions.delete(sessionId)
    this.sessionActivityAt.delete(sessionId)
    // No process is left to read a watch list for this session, and the file
    // outlives the process: publish an empty list so a fresh spawn starts with
    // nothing wrongly marked as displayed.
    if (this.cioWatchedChildren.has(sessionId)) {
      this.cioWatchedChildren.set(sessionId, new Map())
      this.cioPublishedWatch.delete(sessionId)
      void this.publishWatchedChildren(sessionId)
    }
    const client = this.rpcClients.get(sessionId)
    if (client) {
      client.dispose()
      this.rpcClients.delete(sessionId)
    }
    if (this.rpcClients.size === 0) this.stopIdleSweep()
    this.resumedNativeSessions.delete(sessionId)
    this.appliedPiSettings.delete(sessionId)
    this.latestRateLimits.delete(sessionId)
    this.cioProvidersExtensionEnvs.delete(sessionId)
  }

  /** Stamp the last activity of a live session for the idle sweep. */
  private touchSessionActivity(sessionId: string): void {
    this.sessionActivityAt.set(sessionId, Date.now())
  }

  /** Arm the idle sweep with the first live client; it stops with the last one. */
  private ensureIdleSweep(): void {
    if (this.idleSweepTimer) return
    this.idleSweepTimer = setInterval(() => this.sweepIdleSessions(), PI_SESSION_IDLE_SWEEP_MS)
    // Never hold the app's event loop open for an eviction that can wait.
    if (typeof this.idleSweepTimer.unref === 'function') this.idleSweepTimer.unref()
  }

  private stopIdleSweep(): void {
    if (!this.idleSweepTimer) return
    clearInterval(this.idleSweepTimer)
    this.idleSweepTimer = null
  }

  /**
   * Dispose the harness process of every session that has been idle past the
   * eviction window. A session is skippable for as long as anything can still
   * produce output on it: a registered turn (which covers a run in progress,
   * an RPC compaction, and a pi-managed retry window, since only
   * `agent_settled` clears it), a nested worker that has not settled, or a
   * permission/question card the user has not answered yet.
   */
  private sweepIdleSessions(): void {
    const now = Date.now()
    // The same cadence lapses watch marks nobody refreshed: a closed sub-agent
    // view must stop its worker's token stream within a bounded window.
    for (const parentSessionId of this.cioWatchedChildren.keys()) {
      void this.publishWatchedChildren(parentSessionId)
    }
    for (const [sessionId] of this.rpcClients) {
      if (this.activeTurns.has(sessionId)) continue
      if (this.hasLiveChildSession(sessionId)) continue
      if (this.hasPendingUiRequest(sessionId)) continue
      const idleSince = this.sessionActivityAt.get(sessionId) ?? now
      if (now - idleSince < PI_SESSION_IDLE_DISPOSE_MS) continue
      Logger.info('Evicting the harness process of an idle session', {
        sessionId,
        idleMs: now - idleSince
      })
      this.disposeRpcClient(sessionId)
    }
  }

  /** True while a nested worker of this session is still running. */
  private hasLiveChildSession(parentSessionId: string): boolean {
    for (const state of this.childStreams.values()) {
      if (state.parentSessionId === parentSessionId && !state.settled) return true
    }
    return false
  }

  /**
   * True while the user still owes this session an answer. Pending requests are
   * keyed by their RPC request id, so they are matched on the session they
   * belong to: a card on screen must never lose the process that asked for it.
   */
  private hasPendingUiRequest(sessionId: string): boolean {
    for (const request of this.pendingUiRequests.values()) {
      if (request.sessionId === sessionId) return true
    }
    return false
  }

  /**
   * Remember that the app is displaying a child session's transcript. The
   * extension reads the resulting watch file and forwards token deltas for
   * watched children only: a worker nobody is looking at still reports every
   * message, tool call and settle, but stops shipping a per-token stream that
   * only a view would consume.
   */
  private watchSubagentSession(childSessionId: string): void {
    const parentSessionId = this.childStreams.get(childSessionId)?.parentSessionId
    if (!parentSessionId || !this.cioWatchFlagPaths.has(parentSessionId)) return
    const watched = this.cioWatchedChildren.get(parentSessionId) ?? new Map<string, number>()
    watched.set(childSessionId, Date.now() + PI_SUBAGENT_WATCH_WINDOW_MS)
    this.cioWatchedChildren.set(parentSessionId, watched)
    void this.publishWatchedChildren(parentSessionId)
  }

  /** Write the live watch list for one parent session, when it changed. */
  private async publishWatchedChildren(parentSessionId: string): Promise<void> {
    const path = this.cioWatchFlagPaths.get(parentSessionId)
    if (!path) return
    const childSessionIds = this.liveWatchedChildren(parentSessionId)
    const signature = childSessionIds.join(',')
    if (this.cioPublishedWatch.get(parentSessionId) === signature) return
    this.cioPublishedWatch.set(parentSessionId, signature)
    try {
      await this.storage.writeRaw(path, JSON.stringify({ childSessionIds, updatedAt: Date.now() }))
    } catch (error) {
      Logger.dev('Sub-agent watch publication failed:', error)
    }
  }

  /** Watched child ids of one session, dropping every lapsed mark. */
  private liveWatchedChildren(parentSessionId: string): string[] {
    const watched = this.cioWatchedChildren.get(parentSessionId)
    if (!watched) return []
    const now = Date.now()
    const live: string[] = []
    for (const [childSessionId, expiresAt] of watched) {
      if (expiresAt <= now) {
        watched.delete(childSessionId)
        continue
      }
      live.push(childSessionId)
    }
    return live.sort()
  }

  private async buildProviderOverlay(projectPath: string): Promise<ProviderOverlay> {
    const args: string[] = []
    const env: Record<string, string> = {}
    let directory: string | null = null
    const resolved = await this.resolveOverlayProviders()
    if (resolved) {
      directory = await mkdtemp(join(tmpdir(), 'codeinoven-pi-providers-'))
      const extensionPath = join(directory, 'codeinoven-providers.ts')
      await writeFile(extensionPath, piCustomProvidersExtension(resolved.providers), 'utf8')
      args.push('--extension', extensionPath)
      Object.assign(env, resolved.env)
    }
    void projectPath
    return {
      args,
      env,
      cleanup: async () => {
        if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }

  /**
   * Enabled custom providers for this driver plus the env carrying their keys.
   * Managed account containers run pi against their own agent dir, which has
   * no models.json; harness-global custom providers (keyless local servers
   * like llama.cpp) are mirrored in so their models stay selectable.
   */
  private async resolveOverlayProviders(): Promise<{
    providers: BaseUrlProvider[]
    env: Record<string, string>
  } | null> {
    const containerAgentDir = this.accountEnvironment['PI_CODING_AGENT_DIR']?.trim() || undefined
    const providers = this.baseUrlProviders
      ? await this.baseUrlProviders.listEnabled(this.id, containerAgentDir).catch(() => [])
      : []
    if (providers.length === 0 || !this.secretVault) return null
    const env: Record<string, string> = {}
    for (const provider of providers) {
      if (provider.apiKeyRef && provider.apiKeyEnvVar) {
        env[provider.apiKeyEnvVar] = await this.secretVault.resolve(provider.apiKeyRef)
        continue
      }
      // Native providers mirrored from the global models.json have no vault
      // reference; their key (when configured) rides the env var instead.
      if (!provider.apiKeyEnvVar && provider.harnessId === this.id && this.baseUrlProviders) {
        const nativeKey = await this.baseUrlProviders
          .readNativeApiKey(this.id, provider.id)
          .catch(() => undefined)
        if (nativeKey) {
          const envVar = apiKeyEnvVarFor(provider.id)
          env[envVar] = nativeKey
          provider.apiKeyEnvVar = envVar
        }
      }
    }
    return { providers, env }
  }

  /**
   * Materialize the per-session custom-providers extension next to the
   * cio-core-tools module so the long-lived RPC process registers the same
   * custom providers discovery showed (managed containers cannot see the
   * harness-global models.json on their own). Rewritten on every process boot,
   * so provider edits reach the next fresh session.
   */
  private async materializeCioProvidersExtension(sessionId: string): Promise<string | null> {
    try {
      const resolved = await this.resolveOverlayProviders()
      if (!resolved) return null
      const extensionRelative = join('runtime', 'cio-providers', sessionId, 'providers.ts')
      await this.storage.writeRaw(extensionRelative, piCustomProvidersExtension(resolved.providers))
      this.cioProvidersExtensionEnvs.set(sessionId, resolved.env)
      return this.storage.resolve(extensionRelative)
    } catch (error) {
      Logger.dev('Pi providers extension materialization failed:', error)
      return null
    }
  }
}
