import { type IncomingMessage, type ServerResponse } from 'http'
import type {
  ResolvedUtility,
  UtilityDefinition,
  McpUtilityConfig,
  UtilityKind
} from '../../../lib/types'
import { UTILITY_KIND_VALUES } from '../../../lib/types'
import { APP_DESIGN_UTILITY_ID, APP_VIDEO_UTILITY_ID } from '../../../lib/utility-ids'
import { isCuaDaemonTransportFailure } from '../cua-bridge-service'
import { designGroupBriefing } from '../../design/design-group-service'
import { designSessionBriefing } from '../cio-design-prompt'
import { videoSessionBriefing } from '../cio-video-prompt'
import type { AuthoredWorkKind } from '../../../lib/ipc/design'
import {
  ASK_SECRET_TOOL_NAME,
  GATEWAY_TOOLS,
  UTILITY_SEARCH_TOOL_NAME,
  UTILITY_ACTIVATE_TOOL_NAME,
  UTILITY_INVOKE_TOOL_NAME,
  UTILITY_DOCS_TOOL_NAME,
  UTILITY_MANAGE_TOOL_NAME,
  UTILITY_DIAGNOSTICS_TOOL_NAME,
  UTILITY_SUGGEST_TOOL_NAME
} from '../../../lib/gateway-tools'
import {
  ORCHESTRATION_DISPATCH_TOOL_NAME,
  ORCHESTRATION_STATUS_TOOL_NAME,
  ORCHESTRATION_TARGETS_TOOL_NAME
} from '../../../lib/orchestration-tools'
import {
  APP_CONTROL_CALL_TOOL_NAME,
  APP_CONTROL_CATALOG_TOOL_NAME
} from '../../../lib/app-control-tools'
import {
  CREATE_ASSIGNMENT_TOOL_NAME,
  CREATE_BRAINSTORM_TOOL_NAME,
  CREATE_PRD_TOOL_NAME,
  CREATE_SPEC_TOOL_NAME,
  type EngineeringToolOperation
} from '../../../lib/engineering-tools'
import { PAWN_AGENT_TOOL_NAME } from '../../../lib/pawn-tools'
import { NO_EXPERTS, type EffectiveExperts } from '../../../lib/experts'
import { currentWorkRoot, currentWorkRoots } from '../../design/work-roots-state'
import { gatewayStructuredResult } from '../../../lib/image-payload'
import {
  budgetGatewayOutput,
  type GatewayOutputMeasurement
} from '../utility-orchestration/utility-gateway-output'
import { acquireCuaSnapshotLease } from '../cua-snapshot-lease'
import {
  cuaRefusal,
  cuaSnapshotView,
  reanchorCuaAction,
  type CuaSnapshotView
} from '../../../lib/cua-driver'
import type { ExpertSettingsService } from '../../design/expert-settings-service'
import { ThreadRepo } from '../../database/repositories/thread-repo'
import { DesignRepo } from '../../database/repositories/design-repo'
import { ProjectRepo } from '../../database/repositories/project-repo'
import { type McpClient } from '../../agents/mcp-stdio-client'
import { Logger } from '../../system/logger'
import { UTILITY_EVENTS_LOG_FILE, dailyLogRelativePath } from '../../system/log-paths'
import {
  BRAINSTORM_ALIGNMENT_UTILITY_ID,
  brainstormAlignmentUtility
} from '../../../lib/brainstorm/brainstorm-alignment'
import {
  ASSISTANT_AUTHORING_UTILITY_ID,
  assistantAuthoringUtility
} from '../../../lib/assistant-authoring'
import { ASSISTANT_REPORT_UTILITY_ID, assistantReportUtility } from '../../../lib/assistant-reports'
import {
  UtilityScopeFootprintService,
  type UtilityScopeFootprintDeps
} from '../utility-scope-footprint'
import { normalizeCapability } from '../utility-orchestration/utility-search'
import {
  type ThreadBankEntry,
  forgetUtility,
  reconcileActivated
} from '../utility-orchestration/utility-turn-state'
import { readJsonBody } from '../utility-orchestration/utility-input'
import { credentialEnvironment as resolveCredentialEnvironment } from '../mcp-connection'
import {
  CUA_UTILITY_ID,
  ELIGIBILITY_REFRESH_INTERVAL_MS,
  THREAD_BANK_DESCRIPTION_LIMIT,
  THREAD_BANK_DIRECTORY,
  THREAD_BANK_MAX_ENTRIES,
  agentCursorPoint
} from '../utility-orchestration-service'
import type {
  AppControlOperation,
  AuthoredWorkSessionRecorder,
  GatewayBridgeHandler,
  OrchestrationToolOperation,
  TurnState,
  UtilityTurnRequest
} from '../utility-orchestration-service'
import type { UtilityOrchestrationService } from '../utility-orchestration-service'

/** UtilityOrchestrationService orchestration: one concern, moved verbatim from the composition root. */
export class UtilityOrchestrationServiceOrchestration {
  constructor(private readonly host: UtilityOrchestrationService) {}

  /**
   * Install folders for scoped utilities, built on first use.
   *
   * A bundle the agent installs can be scoped to a project or a thread, and a
   * scoped capability is installed as a real folder in that scope. The app-wide
   * installer is built here from the database so this service needs nothing
   * handed to it, and a session with no database (a disposable one) simply skips
   * the disk step rather than failing the install.
   */
  footprint(): UtilityScopeFootprintService | null {
    if (this.host.scopeFootprintResolved) return this.host.scopeFootprint
    this.host.scopeFootprintResolved = true
    const database = this.host.database
    if (!database) return null
    const deps: UtilityScopeFootprintDeps = {
      resolveProjectPath: async (projectId) =>
        (await new ProjectRepo(database).getViaWorker(projectId))?.path ?? null,
      listProjectPaths: async () =>
        (await new ProjectRepo(database).listViaWorker())
          .filter((project) => project.source !== 'ssh' && project.path)
          .map((project) => ({ id: project.id, path: project.path }))
    }
    this.host.scopeFootprint = new UtilityScopeFootprintService(this.host.storage, deps)
    return this.host.scopeFootprint
  }

  /** Derive the route → handler map from `GATEWAY_TOOLS`, failing fast if a
   *  catalog tool has no bridge handler so drift surfaces at startup, not at
   *  runtime. */
  buildBridgeHandlers(): ReadonlyMap<string, GatewayBridgeHandler> {
    const handlers = new Map<string, GatewayBridgeHandler>()
    for (const tool of GATEWAY_TOOLS) {
      const handler = this.bridgeHandlerFor(tool.name)
      if (!handler) {
        throw new Error(`Utility gateway tool "${tool.name}" has no bridge handler`)
      }
      handlers.set(tool.route, handler)
    }
    return handlers
  }

  /**
   * Routes whose result travels as a structured payload as well as text.
   *
   * Read from the catalog rather than listed here, so a tool that declares an
   * `outputSchema` is answered in the shape that schema promises and no surface
   * can drift: a script resolves these calls to fields, a model reads the text.
   */
  buildStructuredRoutes(): ReadonlySet<string> {
    return new Set(
      GATEWAY_TOOLS.filter((tool) => tool.outputSchema !== undefined).map((tool) => tool.route)
    )
  }

  bridgeHandlerFor(name: string): GatewayBridgeHandler | null {
    switch (name) {
      case UTILITY_SEARCH_TOOL_NAME:
        return (state, input) => this.host.units['capability-invoke'].search(state, input)
      case UTILITY_ACTIVATE_TOOL_NAME:
        return (state, input) => this.host.units['capability-invoke'].activate(state, input)
      case UTILITY_INVOKE_TOOL_NAME:
        return (state, input) => this.host.units['capability-invoke'].invoke(state, input)
      case UTILITY_DOCS_TOOL_NAME:
        return (state, input) => this.host.units['capability-invoke'].docsLookup(state, input)
      case UTILITY_MANAGE_TOOL_NAME:
        return (state, input) => this.host.units['capability-invoke'].manage(state, input)
      case UTILITY_DIAGNOSTICS_TOOL_NAME:
        return (state, input) => this.host.units['diagnostics'].runDiagnostics(state, input)
      case ASK_SECRET_TOOL_NAME:
        return (state, input) => this.askSecret(state, input)
      case UTILITY_SUGGEST_TOOL_NAME:
        return (state, input) => this.host.units['capability-invoke'].suggestUtility(state, input)
      case ORCHESTRATION_TARGETS_TOOL_NAME:
        return (state, input) => this.orchestrate(state, input, 'targets')
      case ORCHESTRATION_DISPATCH_TOOL_NAME:
        return (state, input) => this.orchestrate(state, input, 'dispatch')
      case ORCHESTRATION_STATUS_TOOL_NAME:
        return (state, input) => this.orchestrate(state, input, 'status')
      case APP_CONTROL_CATALOG_TOOL_NAME:
        return (state, input) => this.appControl(state, input, 'catalog')
      case APP_CONTROL_CALL_TOOL_NAME:
        return (state, input) => this.appControl(state, input, 'call')
      case CREATE_BRAINSTORM_TOOL_NAME:
        return (state, input) => this.engineering(state, input, 'brainstorm')
      case CREATE_PRD_TOOL_NAME:
        return (state, input) => this.engineering(state, input, 'prd')
      case CREATE_SPEC_TOOL_NAME:
        return (state, input) => this.engineering(state, input, 'spec')
      case CREATE_ASSIGNMENT_TOOL_NAME:
        return (state, input) => this.engineering(state, input, 'assignment')
      case PAWN_AGENT_TOOL_NAME:
        return (state, input) => this.pawn(state, input)
      default:
        return null
    }
  }

  /**
   * Register what the app does when an agent picks up an authored-work
   * capability.
   *
   * Activating `cio:design` or `cio:video` is an agent entering that session,
   * whether or not the user typed the tag for it. The app records the kind the
   * moment that happens, which is what docks the coordinator board while the
   * work is being made rather than at the first preview, and what keeps the
   * thread's later turns inside the session. The engine supplies this because it
   * owns the thread rows and their broadcasts.
   */
  setAuthoredWorkSessionRecorder(recorder: AuthoredWorkSessionRecorder | null): void {
    this.host.authoredWorkSessionRecorder = recorder
  }

  /**
   * Register the service that owns what a thread decided about its experts.
   *
   * The playbook names the models the user staffed, so a thread whose experts are
   * muted has to be described by the same policy that refuses `delegate`, or a
   * session would be offered a delegation it cannot make.
   */
  setExpertSettings(settings: ExpertSettingsService | null): void {
    this.host.expertSettings = settings
  }

  /**
   * Run one pawn agent operation for the turn that asked for it.
   *
   * The executor owns thread creation, model resolution and turn completion, so
   * this handler only forwards the call with the turn it belongs to. A missing
   * executor means the feature is unavailable in this deployment, reported
   * plainly rather than as an empty result.
   */
  async pawn(state: TurnState, input: Record<string, unknown>): Promise<unknown> {
    const executor = this.host.pawnExecutor
    if (!executor) throw new Error('Pawn agents are unavailable in this deployment')
    return executor(input, {
      projectId: state.request.projectId,
      threadId: state.request.threadId,
      projectPath: state.request.projectPath,
      sessionId: state.request.sessionId,
      harnessId: state.request.harnessId
    })
  }

  /**
   * Run one engineering artifact operation for the turn that asked for it.
   *
   * The executor owns the engines and the review gates, so this handler only
   * forwards the operation with the turn it belongs to. A missing executor means
   * the app was built without them, reported plainly rather than as an empty
   * result.
   */
  async engineering(
    state: TurnState,
    input: Record<string, unknown>,
    operation: EngineeringToolOperation
  ): Promise<unknown> {
    const executor = this.host.engineeringExecutor
    if (!executor) throw new Error('Engineering artifact tools are unavailable in this deployment')
    return executor(operation, input, {
      projectId: state.request.projectId,
      threadId: state.request.threadId,
      projectPath: state.request.projectPath,
      sessionId: state.request.sessionId,
      harnessId: state.request.harnessId
    })
  }

  /**
   * Run one app-control operation for the turn that asked for it.
   *
   * The executor owns the channel list and the guardrails, so this handler only
   * forwards the operation with the turn it belongs to. A missing executor means
   * the app was built without app control, reported plainly rather than as an
   * empty result.
   */
  async appControl(
    state: TurnState,
    input: Record<string, unknown>,
    operation: AppControlOperation
  ): Promise<unknown> {
    const executor = this.host.appControlExecutor
    if (!executor) throw new Error('App control is unavailable in this deployment')
    const context = {
      projectId: state.request.projectId,
      projectPath: state.request.projectPath,
      threadId: state.request.threadId,
      permissionLevel: state.request.permissionLevel
    }
    return operation === 'catalog'
      ? executor.catalog(input, context)
      : executor.call(input, context)
  }

  /**
   * Run one orchestration operation for the turn that asked for it.
   *
   * The executor owns the ids and the guardrails, so this handler only forwards
   * the operation with the turn it belongs to. A missing executor means the app
   * was built without orchestration, which is a deployment fault rather than a
   * model error, so it says so plainly instead of returning an empty result.
   */
  async orchestrate(
    state: TurnState,
    input: Record<string, unknown>,
    operation: OrchestrationToolOperation
  ): Promise<unknown> {
    const executor = this.host.orchestrationExecutor
    if (!executor) throw new Error('Orchestration is unavailable in this deployment')
    return executor(operation, input, {
      projectId: state.request.projectId,
      threadId: state.request.threadId,
      projectPath: state.request.projectPath,
      sessionId: state.request.sessionId,
      harnessId: state.request.harnessId
    })
  }

  /** True when the harness already performs computer-use, so the Cua Driver MCP
   *  utility must stay hidden from it. */
  hasNativeComputerUse(request: UtilityTurnRequest): boolean {
    return request.nativeCapabilities.map(normalizeCapability).includes('computer_use')
  }

  /** Whether the executing model sees images itself, so the image descriptor
   *  must stay out of this turn's reachable utilities. A capability lookup that
   *  fails keeps the descriptor reachable rather than hiding a capability the
   *  turn may legitimately need. */
  async executingModelVisionCapable(request: UtilityTurnRequest): Promise<boolean> {
    if (!request.resolveExecutingModelVisionCapable) return false
    try {
      return await request.resolveExecutingModelVisionCapable()
    } catch (error) {
      Logger.dev('Executing-model vision capability lookup failed:', error)
      return false
    }
  }

  /**
   * Resolve the utilities one turn may reach, from the registry plus the
   * interview-bound brainstorm capability. Shared by turn start and the mid-turn
   * refresh, so a utility installed while the turn runs becomes searchable and
   * activatable without waiting for the next turn, and the two paths cannot drift.
   */
  async resolveEligibleUtilities(request: UtilityTurnRequest): Promise<ResolvedUtility[]> {
    let eligible = await this.host.registry.resolve({
      harnessId: request.harnessId,
      projectId: request.projectId,
      threadId: request.threadId,
      nativeCapabilities: request.nativeCapabilities,
      includeOnDemand: true
    })
    // These capabilities are bound to the live turn, never installed globally.
    eligible = eligible.filter(
      ({ utility }) =>
        utility.id !== BRAINSTORM_ALIGNMENT_UTILITY_ID &&
        utility.id !== ASSISTANT_AUTHORING_UTILITY_ID &&
        utility.id !== ASSISTANT_REPORT_UTILITY_ID
    )
    if (request.saveBrainstormNotes) {
      eligible.push(
        brainstormAlignmentUtility(request.harnessId, request.projectId, request.threadId)
      )
    }
    if (request.saveAssistantCheckpoint) {
      eligible.push(
        assistantAuthoringUtility(request.harnessId, request.projectId, request.threadId)
      )
    }
    if (request.saveAssistantReport) {
      eligible.push(assistantReportUtility(request.harnessId, request.projectId, request.threadId))
    }
    if (this.hasNativeComputerUse(request)) {
      // Existing registries may predate the computer-use capability binding,
      // so enforce the native preference by stable utility identity too.
      eligible = eligible.filter(({ utility }) => utility.id !== CUA_UTILITY_ID)
    }
    // A model that can already see images must never see the image descriptor:
    // announcing it invites the model to call it, which is exactly the
    // false-positive report path the app's vision record exists to prevent.
    if (await this.executingModelVisionCapable(request)) {
      eligible = eligible.filter(({ utility }) => utility.kind !== 'image_descriptor')
    }
    // Stamp the thread's permission level onto the Cua Driver MCP utility so
    // its launch environment always matches how this thread runs tools.
    for (const entry of eligible) {
      if (entry.utility.id !== 'cio:cua-driver') continue
      const config = entry.utility.config as McpUtilityConfig
      config.environment = {
        ...config.environment,
        ...(request.permissionLevel === 'full_access'
          ? { CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS: 'true' }
          : { CUA_DRIVER_DISABLE_UNRESTRICTED: 'true' })
      }
    }
    return eligible
  }

  /**
   * Time one unit of turn-utility preparation into the dispatching turn's clock.
   *
   * An untimed caller (a refresh, a test, an isolated session) simply runs the
   * work: the clock is a diagnostic, never a dependency.
   */
  timed<T>(request: UtilityTurnRequest, step: string, work: Promise<T>): Promise<T> {
    return request.telemetry ? request.telemetry.step(step, work) : work
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [...this.host.turns.keys()].map((id) => this.host.units['turn-runtime'].cleanupTurn(id))
    )
    await this.host.units['gateway-endpoints'].closeGatewayServer()
  }

  // ─── Thread utilities bank — durable per-thread bookkeeping ─────────────

  /** Bank file path for one thread; rejects anything path-like. */
  bankPath(threadId: string): string {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(threadId)) {
      throw new Error('Invalid thread id for the utilities bank')
    }
    return `${THREAD_BANK_DIRECTORY}/${threadId}.json`
  }

  /** Load the persisted bank for one thread; corrupt or missing files read as empty. */
  async loadThreadBank(threadId: string): Promise<ThreadBankEntry[]> {
    try {
      const raw = await this.host.storage.readRaw(this.bankPath(threadId))
      if (!raw) return []
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed
        .flatMap((value: unknown) => {
          if (typeof value !== 'object' || value === null) return []
          const record = value as Record<string, unknown>
          const id = record['id']
          const name = record['name']
          const kind = record['kind']
          const description = record['description']
          if (
            typeof id !== 'string' ||
            typeof name !== 'string' ||
            typeof kind !== 'string' ||
            !UTILITY_KIND_VALUES.includes(kind as UtilityKind) ||
            typeof description !== 'string'
          ) {
            return []
          }
          return [
            {
              id,
              name,
              kind: kind as UtilityKind,
              description: description.slice(0, THREAD_BANK_DESCRIPTION_LIMIT)
            }
          ]
        })
        .slice(0, THREAD_BANK_MAX_ENTRIES)
    } catch (error) {
      Logger.dev('Thread utilities bank could not be read:', error)
      return []
    }
  }

  /** Persist the bank for one thread; serialized per thread to avoid clobbering. */
  async saveThreadBank(threadId: string, entries: ThreadBankEntry[]): Promise<void> {
    const previous = this.host.bankWrites.get(threadId) ?? Promise.resolve()
    const next = previous
      .then(() => this.host.storage.writeRaw(this.bankPath(threadId), JSON.stringify(entries)))
      .catch((error: unknown) => Logger.dev('Thread utilities bank write failed:', error))
    this.host.bankWrites.set(threadId, next)
    await next
  }

  /**
   * Record one utility in its thread's bank the first time it is activated.
   * Transient per-turn capabilities (the gateway itself, interview-bound
   * alignment notes, the getting-started checkpoint, and a run's report) are
   * never banked.
   */
  async registerThreadBankEntry(state: TurnState, utility: UtilityDefinition): Promise<void> {
    if (
      utility.id.startsWith('cio:utility-gateway:') ||
      utility.id === BRAINSTORM_ALIGNMENT_UTILITY_ID ||
      utility.id === ASSISTANT_AUTHORING_UTILITY_ID ||
      utility.id === ASSISTANT_REPORT_UTILITY_ID
    ) {
      return
    }
    const threadId = state.request.threadId
    const bankEntry: ThreadBankEntry = {
      id: utility.id,
      name: utility.name,
      kind: utility.kind,
      description: utility.description.slice(0, THREAD_BANK_DESCRIPTION_LIMIT)
    }
    // Register the entry for this turn too, so a search later in the same turn
    // already reports the utility it just activated as banked.
    state.bank.set(utility.id, bankEntry)
    const entries = await this.loadThreadBank(threadId)
    if (entries.some((entry) => entry.id === utility.id)) return
    entries.push(bankEntry)
    await this.saveThreadBank(threadId, entries.slice(-THREAD_BANK_MAX_ENTRIES))
  }

  /** Drop one thread's bank; called when the thread itself is deleted. */
  async deleteThreadBank(threadId: string): Promise<void> {
    try {
      await this.host.storage.remove(this.bankPath(threadId))
    } catch {
      // A missing file is the desired end state; nothing to report.
    }
  }

  /** Project id → name map used to label diagnostic thread results. */
  projectNames(): Map<string, string> {
    if (!this.host.database) return new Map()
    try {
      const projects = new ProjectRepo(this.host.database).list()
      return new Map(projects.map((project) => [project.id, project.name]))
    } catch {
      return new Map()
    }
  }

  /**
   * Collect one or more secrets from the user on the agent's behalf.
   *
   * The executor owns the card, the waiting and the storing; this handler owns
   * the tool contract. It returns the environment variable names   plus the
   * owner-only file paths for plain secrets   and never a value. The reserved
   * `environment` field is attached only for a transport that applies it to its
   * own process, and every MCP transport strips it before the result reaches a
   * model.
   */
  async askSecret(state: TurnState, input: Record<string, unknown>): Promise<unknown> {
    const executor = this.host.secretRequestExecutor
    if (!executor) throw new Error('Secret collection is unavailable in this deployment')
    const resolution = await executor(input, {
      projectId: state.request.projectId,
      threadId: state.request.threadId,
      projectPath: state.request.projectPath,
      sessionId: state.request.sessionId,
      harnessId: state.request.harnessId
    })
    // Credential metadata and connected MCP clients are snapshots. A key
    // collected mid-turn must replace both before the next utility call.
    const boundUtilityIds = new Set(
      resolution.secrets.flatMap((secret) => (secret.boundUtilityId ? [secret.boundUtilityId] : []))
    )
    for (const turn of this.host.turns.values()) {
      const affected = [...boundUtilityIds].filter(
        (utilityId) => turn.state.eligible.has(utilityId) || turn.state.activated.has(utilityId)
      )
      if (affected.length === 0) continue
      for (const utilityId of affected) {
        // Let a connection already being established settle before retiring
        // it, so it cannot restore a client carrying the previous credential.
        const connecting = turn.state.connecting.get(utilityId)
        if (connecting) await connecting.catch(() => undefined)
        turn.state.activated.delete(utilityId)
        await this.releaseUtility(turn.state, utilityId)
      }
      // Preserve bank entries: the next invocation reconnects lazily using
      // the updated definition without asking the agent to activate again.
      await this.refreshEligible(turn.state, { force: true })
    }
    const sharedNote = `Each value is stored in the encrypted device vault. Reference it only at its target: \`$ENVIRONMENT_VARIABLE\` in a command, or \`"$(cat secret_path)"\` for a value you interpolate. Never print, echo, log, or read a secret, and never paste one into chat.`
    const secretEntries = resolution.secrets.map((secret) => ({
      label: secret.label,
      environment_variable: secret.environmentVariable,
      ...(secret.secretPath ? { secret_path: secret.secretPath } : {}),
      ...(secret.boundUtilityId ? { bound_to_utility: secret.boundUtilityId } : {}),
      ...(secret.reusedFrom ? { reused_from: secret.reusedFrom } : {})
    }))
    const result: Record<string, unknown> =
      resolution.status === 'dismissed'
        ? {
            status: 'dismissed',
            message:
              'The user dismissed the secret request without providing a value. Continue without it, and ask again only if the secret is essential.'
          }
        : resolution.status === 'alternative'
          ? {
              status: 'alternative',
              message:
                'The user answered with an instruction instead of a value. This is an answer, not a dismissal: do not ask for the same secret again in this turn. Follow the instruction and continue.',
              user_instruction: resolution.alternative,
              secrets: secretEntries,
              ...(resolution.unresolved?.length
                ? {
                    unresolved_environment_variables: resolution.unresolved,
                    unresolved_note:
                      'Nothing was exposed for these names. Continue with the user instruction. If one of them is already defined in your own environment, use it directly and never print, echo, or log it; otherwise take a different route or say plainly what is missing.'
                  }
                : {}),
              note: sharedNote
            }
          : {
              status: 'set',
              message: 'Secret set, you may proceed.',
              secrets: secretEntries,
              note: sharedNote
            }
    // A reused value must reach the session environment exactly like a pasted
    // one, which is what a user answering "this key was already supplied" needs.
    if (input['apply_environment'] !== true || resolution.secrets.length === 0) return result
    // Only an in-process gateway transport asks for this, and it applies the map
    // to its own session environment before the result is shown to the model.
    return {
      ...result,
      environment: Object.fromEntries(
        resolution.secrets.map((secret) => [secret.environmentVariable, secret.value])
      )
    }
  }

  async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const authorization = request.headers.authorization
      const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
      const turnId = this.host.turnIdsByToken.get(token)
      const state = turnId ? this.host.turns.get(turnId)?.state : undefined
      if (request.method !== 'POST' || !state || !request.url) {
        this.respond(response, 404, { error: 'Not found' })
        return
      }
      const input = await readJsonBody(request)
      const handler = this.host.bridgeHandlers.get(request.url)
      if (!handler) {
        this.respond(response, 404, { error: 'Not found' })
        return
      }
      const direct = GATEWAY_TOOLS.find((tool) => tool.route === request.url)
      if (!direct || !state.grantedTools.some((tool) => tool.name === direct.name))
        throw new Error('Tool is not granted to this turn')
      const result = await handler(state, input)
      // A tool that declares an output schema is answered with the payload both
      // ways: content parts for a model, the same data for a script. Every other
      // route keeps the exact body it has always returned.
      let measurement: GatewayOutputMeasurement | undefined
      const prepared = await budgetGatewayOutput(
        this.host.structuredRoutes.has(request.url) ? gatewayStructuredResult(result) : result,
        state.request.projectPath,
        (value) => {
          measurement = value
        }
      )
      if (measurement) {
        await this.audit(state, 'gateway.output_budgeted', {
          ...measurement,
          route: request.url,
          stage: 'gateway_text_preview',
          nativeModelInputCharacters: null
        }).catch((error: unknown) => {
          Logger.error('Could not record gateway output measurement:', error)
        })
      }
      this.respond(response, 200, prepared)
    } catch (error) {
      this.respond(response, 400, {
        error: error instanceof Error ? error.message : 'Utility gateway request failed'
      })
    }
  }

  /**
   * Re-read the registry for the current turn so a utility installed or removed
   * while the turn is running is visible to the very next gateway call instead of
   * only after a reload. Rate-limited because a chatty agent may search several
   * times per second, and forced right after this turn installs something.
   */
  async refreshEligible(state: TurnState, options: { force?: boolean } = {}): Promise<void> {
    const now = Date.now()
    if (
      options.force !== true &&
      now - state.eligibilityRefreshedAt < ELIGIBILITY_REFRESH_INTERVAL_MS
    ) {
      return
    }
    state.eligibilityRefreshedAt = now
    const next = new Map(
      (await this.resolveEligibleUtilities(state.request)).map((entry) => [entry.utility.id, entry])
    )
    // The Cua Driver entry came from inspecting the installed binary, so keep that
    // resolution rather than paying installation discovery again.
    const cuaUtility = state.eligible.get(CUA_UTILITY_ID)
    if (cuaUtility && !next.has(CUA_UTILITY_ID)) next.set(CUA_UTILITY_ID, cuaUtility)
    state.eligible = next
    // A refresh lists only what is eligible now, so an activated utility missing
    // from it was disabled, deleted, or moved out of scope while this turn ran.
    // Dropping it here is what lands that change mid-turn: the call the transcript
    // already made has returned, and keeping the id alive on its behalf was what
    // made a disabled capability stay callable until the user sent another message.
    await this.forgetUtilities(state, reconcileActivated(state, new Set(next.keys())))
  }

  /**
   * Why a utility an agent asked for is unreachable, when the registry can say.
   *
   * A user who switches a capability off expects it to stop being callable, and
   * an agent should report that as the user's change rather than as a broken app,
   * so the registry is consulted once on the failure path only.
   */
  async unreachableUtilityReason(utilityId: string): Promise<string | null> {
    const utility = await this.host.registry.get(utilityId)
    if (!utility) return `\`${utilityId}\` is no longer installed.`
    if (!utility.enabled) {
      return `\`${utilityId}\` was switched off in Utilities, so it is unavailable for the rest of this session.`
    }
    return null
  }

  /**
   * Land a registry change in every turn that is already running.
   *
   * The read inside `refreshEligible` covers the next search or activation, but
   * not a utility a turn already activated. Without this, switching a capability
   * off would leave it callable until the turn ended, which reads as the change
   * needing a restart. Dropping it from live turn state means the very next
   * invoke reports it as unavailable.
   */
  async applyRegistryChange(utilityId: string): Promise<void> {
    for (const turn of this.host.turns.values()) {
      const state = turn.state
      const wasReachable = forgetUtility(state, utilityId)
      await this.forgetUtilities(state, [utilityId])
      // The next search must re-read the registry instead of serving the set this
      // turn built before the change.
      state.eligibilityRefreshedAt = 0
      if (wasReachable) await this.audit(state, 'utility.registry_changed', { utilityId })
    }
  }

  /** Forget utilities a turn may no longer reach, releasing what belonged to them. */
  async forgetUtilities(state: TurnState, utilityIds: readonly string[]): Promise<void> {
    await Promise.all(utilityIds.map((utilityId) => this.releaseUtility(state, utilityId)))
  }

  /** End one utility's CUA session and close its MCP client, if it had either. */
  async releaseUtility(state: TurnState, utilityId: string): Promise<void> {
    const sessionId = state.cuaSessionIds.get(utilityId)
    const client = state.clients.get(utilityId)
    state.cuaSessionIds.delete(utilityId)
    state.clients.delete(utilityId)
    if (!client) return
    if (sessionId) {
      await client.callTool('end_session', { session: sessionId }).catch(() => undefined)
    }
    await Promise.allSettled([client.close()])
  }

  /**
   * Tell the app that this turn entered an authored-work session.
   *
   * Only the two app-owned authored-work capabilities count as entering one:
   * picking up any other utility is neither a design nor a composition. Reported
   * on the real activation and not on the already-active no-op, because the
   * first activation is the moment the agent entered the session. Best-effort,
   * because the record is how the user watches the work rather than the work
   * itself, and a failed write must never fail the activation that was asked
   * for.
   */
  noteAuthoredWorkSession(state: TurnState, utilityId: string): void {
    const kind: AuthoredWorkKind | null =
      utilityId === APP_DESIGN_UTILITY_ID
        ? 'design'
        : utilityId === APP_VIDEO_UTILITY_ID
          ? 'video'
          : null
    if (!kind) return
    try {
      this.host.authoredWorkSessionRecorder?.({
        projectId: state.request.projectId,
        threadId: state.request.threadId,
        kind
      })
    } catch (error) {
      Logger.error('Authored-work session record failed:', error)
    }
  }

  /**
   * The design capability's playbook, with the external-asset paragraph rebuilt
   * from the current settings policy and the delegation section rebuilt from the
   * experts this thread may use.
   *
   * Resolved rather than seeded because both facts are user settings: the CDN
   * allowlist decides which hosts will actually load, and the experts decide which
   * models a design turn is allowed to delegate to, and whether it may at all.
   * All paths that hand the playbook to a model   activation, the promotion a
   * `@cio-design` session performs at turn start, and a post-compaction docs
   * re-dump   come through here, so they cannot disagree.
   */
  async workContext(
    threadId: string
  ): Promise<{ roots: ReturnType<typeof currentWorkRoots>; note: string }> {
    if (!this.host.database) return { roots: currentWorkRoots(), note: '' }
    const thread = await new ThreadRepo(this.host.database).getViaWorker(threadId)
    const current = await new DesignRepo(this.host.database).forThreadViaWorker(threadId)
    return {
      roots: currentWorkRoots(thread?.projectId),
      note: current
        ? `\nThe current ${current.kind} is in ${JSON.stringify(current.directory)}. Continue editing this folder. An individual save-path change affects only this folder. The project save root controls new work. Use the current recorded path rather than paths in older messages.\n`
        : ''
    }
  }

  /**
   * The experts a thread's session may delegate to.
   *
   * The expert settings service owns the decision, so a service graph that has
   * not wired one reads as "nothing is staffed", which is the honest answer for a
   * deployment without the design capability rather than a promise the app cannot
   * keep.
   */
  async expertsForThread(threadId: string): Promise<EffectiveExperts> {
    return this.host.expertSettings ? this.host.expertSettings.effectiveFor(threadId) : NO_EXPERTS
  }

  /** Build the capability payload (tools, operations, or instructions) that
   *  activation and cio_util_docs_lookup hand back to the model. Shared so a
   *  post-compaction docs re-dump is byte-identical to the original listing. */
  /**
   * The session briefing to hand back with an activation, when that activation is
   * what opens the session.
   *
   * A turn the user tagged carries its contract in the prompt, which was composed
   * before the agent read anything. A turn where the agent reaches for the
   * capability itself has no such prompt, so the briefing travels with the
   * activation and the session opens the same way, naming the folder the project is
   * pointed at right now. That folder is read live rather than left to the playbook,
   * because by the time an agent activates the capability it may already have written
   * files somewhere else, and the briefing is the one place it is certain to read
   * before it writes more. Empty when the turn already carries the session, because
   * the prompt is then the copy in hand and a second one would say the same thing
   * twice.
   */
  async sessionOpeningFor(state: TurnState, utilityId: string): Promise<string> {
    if (utilityId === APP_DESIGN_UTILITY_ID) {
      const session = state.request.designSession
      return session === undefined || session === 'off'
        ? designSessionBriefing(
            'activation',
            currentWorkRoot('design', state.request.projectId),
            this.host.database === undefined
              ? ''
              : designGroupBriefing(this.host.database, state.request.projectId)
          )
        : ''
    }
    if (utilityId === APP_VIDEO_UTILITY_ID) {
      const session = state.request.videoSession
      return session === undefined || session === 'off'
        ? videoSessionBriefing('activation', currentWorkRoot('video', state.request.projectId))
        : ''
    }
    return ''
  }

  isComputerUseUtility(resolved: ResolvedUtility): boolean {
    if (resolved.utility.id === CUA_UTILITY_ID) return true
    const capability = normalizeCapability(resolved.binding.nativeCapability ?? '')
    return capability === 'computer_use'
  }

  /**
   * Forget a connection that cannot answer any more, so the next call reconnects.
   *
   * Two failures land here. The Cua daemon can die under a live run (a crash, a
   * driver update, another run restarting it in its own mode), and the `cua-driver
   * mcp` server owns one connection to it and never re-establishes it: the
   * connected server keeps answering `daemon transport error ... cua-driver.sock:
   * No such file or directory` while a freshly spawned one starts a new daemon and
   * works. Any other MCP server can simply stop answering, which the client reports
   * as a request that ran out of budget and a connection it retired on the way out.
   *
   * Closing the client and forgetting its session is what lets the next call
   * reconnect: reconnecting re-claims the daemon, which starts a fresh one on
   * macOS, and the cursor session is re-created on it. The session id is dropped
   * with the client because that session lived inside the daemon that just died.
   *
   * The call that failed is deliberately never retried: a computer-use operation
   * may already have moved the mouse or typed, so replaying it is not safe.
   *
   * The failing client is the one named here, and it is only forgotten when it is
   * still the cached one: the gateway serves concurrent requests, so another call
   * may already have replaced it with a fresh connection that must survive.
   */
  async dropUnusableTransport(
    state: TurnState,
    resolved: ResolvedUtility,
    client: McpClient,
    error: unknown
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    const daemonLost = this.isComputerUseUtility(resolved) && isCuaDaemonTransportFailure(message)
    if (client.usable && !daemonLost) return
    const utilityId = resolved.utility.id
    if (state.clients.get(utilityId) === client) {
      state.clients.delete(utilityId)
      if (this.isComputerUseUtility(resolved)) state.cuaSessionIds.delete(utilityId)
    }
    await client.close().catch(() => undefined)
    Logger.dev('MCP connection retired; the next call reconnects', { utilityId, daemonLost })
  }

  /**
   * Where this run's Cua cursor sits right now, in screen points, or null when
   * the driver has reported no position yet or the read failed.
   *
   * The read is decoration for the PiP monitor and never changes the run's state,
   * so a failure is a dev-level detail and the next operation reports again: the
   * operation that just ran already changed whatever the run meant to change.
   */
  async readAgentCursor(
    state: TurnState,
    utilityId: string,
    client: McpClient
  ): Promise<{ x: number; y: number } | null> {
    const sessionId = state.cuaSessionIds.get(utilityId)
    if (!sessionId) return null
    try {
      return agentCursorPoint(
        await client.callTool('get_agent_cursor_state', { session: sessionId })
      )
    } catch (error) {
      Logger.dev('Cua agent cursor position could not be read:', error)
      return null
    }
  }

  /** Keep every Cua operation on the app-owned visible session. */
  routeComputerUseInput(
    state: TurnState,
    utilityId: string,
    input: Record<string, unknown>
  ): Record<string, unknown> {
    const sessionId = state.cuaSessionIds.get(utilityId)
    return sessionId ? { ...input, session: sessionId } : input
  }

  /**
   * One fresh snapshot, the address moved onto it, and the action tried once
   * more, all under a lease on the window's snapshot slot.
   *
   * Without that lease the retry would race the rest of this app: a preview
   * frame, or another thread's gateway snapshot, arriving between the snapshot
   * and the action would take the slot with it, which is the very failure the
   * retry exists to repair.
   */
  async reanchorComputerUse(
    state: TurnState,
    resolved: ResolvedUtility,
    client: McpClient,
    utilityId: string,
    operation: string,
    input: Record<string, unknown>,
    view: CuaSnapshotView | null,
    window: { pid: number; windowId: number } | null,
    want: 'elements' | 'pixels',
    session: 'labelled' | 'implicit'
  ): Promise<{ result: unknown; snapshotId: string } | { refusal: string } | null> {
    const release = window ? await acquireCuaSnapshotLease(window.pid, window.windowId) : null
    try {
      const refreshed = await this.refreshComputerUseView(
        state,
        client,
        utilityId,
        input,
        want,
        session
      )
      if (!refreshed) return null
      const reanchored = reanchorCuaAction(operation, input, view, refreshed)
      if ('refusal' in reanchored) return { refusal: reanchored.refusal }
      const result = await this.callComputerUse(
        state,
        resolved,
        client,
        operation,
        reanchored.input
      )
      return { result, snapshotId: refreshed.snapshotId }
    } finally {
      release?.()
    }
  }

  /** One driver call, retiring a connection that cannot answer any more. */
  async callComputerUse(
    state: TurnState,
    resolved: ResolvedUtility,
    client: McpClient,
    operation: string,
    input: Record<string, unknown>
  ): Promise<unknown> {
    try {
      const target = input['target']
      const desktop =
        input['scope'] === 'desktop' ||
        (typeof target === 'object' &&
          target !== null &&
          (target as Record<string, unknown>)['kind'] === 'desktop')
      const background =
        this.host.backgroundInputTools.get(client)?.has(operation) &&
        input['delivery_mode'] === undefined &&
        !desktop
      // Preserve explicit foreground requests and desktop-only operations. Never
      // replay uncertain or partial input: the agent must observe those first.
      const routed = background ? { ...input, delivery_mode: 'background' } : input
      const result = await client.callTool(operation, routed)
      if (background && cuaRefusal(result)?.code === 'background_unavailable') {
        return await client.callTool(operation, { ...input, delivery_mode: 'foreground' })
      }
      return result
    } catch (error) {
      await this.dropUnusableTransport(state, resolved, client, error)
      throw error
    }
  }

  /**
   * A snapshot the model asked for, taken under the window's lease.
   *
   * Another turn's gateway holds the same window while it re-anchors an action
   * it is about to perform, and this call would take that snapshot's place. The
   * lease is milliseconds long in practice, so waiting for it costs a snapshot
   * nothing and is the difference between the other turn's action landing and it
   * being refused.
   */
  async snapshotUnderLease(
    state: TurnState,
    resolved: ResolvedUtility,
    client: McpClient,
    operation: string,
    input: Record<string, unknown>,
    window: { pid: number; windowId: number } | null
  ): Promise<unknown> {
    const release = window ? await acquireCuaSnapshotLease(window.pid, window.windowId) : null
    try {
      return await this.callComputerUse(state, resolved, client, operation, input)
    } finally {
      release?.()
    }
  }

  /**
   * One snapshot of the window an action addresses, taken for the gateway's own
   * re-anchoring. An element address needs the tree and nothing else, and the
   * driver returns the handles with it; a pixel address needs the screenshot and
   * no accessibility walk at all. The walk gets a 5 second budget because
   * re-anchoring a large app's element against a tree that was truncated on
   * arrival would refuse an action the driver could otherwise have performed.
   */
  async refreshComputerUseView(
    state: TurnState,
    client: McpClient,
    utilityId: string,
    input: Record<string, unknown>,
    want: 'elements' | 'pixels',
    session: 'labelled' | 'implicit'
  ): Promise<CuaSnapshotView | null> {
    const pid = typeof input['pid'] === 'number' ? input['pid'] : null
    const windowId = typeof input['window_id'] === 'number' ? input['window_id'] : null
    if (pid === null || windowId === null) return null
    const request = {
      pid,
      window_id: windowId,
      include_screenshot: want === 'pixels',
      include_accessibility_tree: want === 'elements',
      ...(want === 'elements' ? { timeout_ms: 5000 } : {})
    }
    const routed =
      session === 'labelled' ? this.routeComputerUseInput(state, utilityId, request) : request
    const result = await client.callTool('get_window_state', routed).catch((error: unknown) => {
      Logger.dev('Cua snapshot refresh failed:', error)
      return null
    })
    return cuaSnapshotView(result)
  }

  async credentialEnvironment(utility: UtilityDefinition): Promise<Record<string, string>> {
    return resolveCredentialEnvironment(utility.credentials, (secretRef) =>
      this.host.vault.resolve(secretRef)
    )
  }

  async audit(state: TurnState, action: string, details: Record<string, unknown>): Promise<void> {
    await this.host.storage.appendRaw(
      dailyLogRelativePath(UTILITY_EVENTS_LOG_FILE),
      `${JSON.stringify({
        timestamp: Date.now(),
        action,
        turnId: state.id,
        harnessId: state.request.harnessId,
        projectId: state.request.projectId,
        threadId: state.request.threadId,
        ...details
      })}\n`
    )
  }

  respond(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(body))
  }
}
