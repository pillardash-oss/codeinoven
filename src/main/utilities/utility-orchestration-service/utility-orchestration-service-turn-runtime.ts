import { randomBytes, randomUUID } from 'crypto'
import {
  APP_ARTIFACT_UTILITY_ID,
  APP_ADB_UTILITY_ID,
  APP_DESIGN_UTILITY_ID,
  APP_VIDEO_UTILITY_ID
} from '../../../lib/utility-ids'
import { APP_BROWSER_UTILITY_ID, APP_SCOPE_UTILITY_ID } from '../utility-registry-service'
import {
  ASK_SECRET_TOOL_NAME,
  GATEWAY_TOOLS,
  GATEWAY_DISCOVERY_INSTRUCTION,
  initialGatewayTools,
  UTILITY_SEARCH_TOOL_NAME,
  UTILITY_ACTIVATE_TOOL_NAME,
  UTILITY_INVOKE_TOOL_NAME,
  UTILITY_DOCS_TOOL_NAME,
  UTILITY_MANAGE_TOOL_NAME,
  UTILITY_DIAGNOSTICS_TOOL_NAME,
  UTILITY_SUGGEST_TOOL_NAME
} from '../../../lib/gateway-tools'
import {
  isOrchestrationTool,
  ORCHESTRATION_DISPATCH_TOOL_NAME,
  ORCHESTRATION_STATUS_TOOL_NAME,
  ORCHESTRATION_TARGETS_TOOL_NAME
} from '../../../lib/orchestration-tools'
import {
  APP_CONTROL_CALL_TOOL_NAME,
  APP_CONTROL_CATALOG_TOOL_NAME,
  isAppControlTool
} from '../../../lib/app-control-tools'
import { isEngineeringTool } from '../../../lib/engineering-tools'
import { SCOPE_CAPABILITY_SEARCH_QUERY } from '../../../lib/scope-tool'
import { PAWN_AGENT_TOOL_NAME, isPawnTool } from '../../../lib/pawn-tools'
import { CIO_SPAWN_AGENT_TOOL_NAME } from '../../../lib/core-tools'
import { ADB_CAPABILITY_SEARCH_QUERY } from '../../../lib/adb-skill'
import { DESIGN_CAPABILITY_SEARCH_QUERY } from '../../../lib/design-skill'
import { VIDEO_CAPABILITY_SEARCH_QUERY } from '../../../lib/video-skill'
import { type McpClient } from '../../agents/mcp-stdio-client'
import { gatewayHarnessTimeoutMs } from '../../../lib/gateway-timeout'
import { Logger } from '../../system/logger'
import {
  BRIDGE_SCRIPT_PATH,
  buildCuaSessionId,
  buildUtilityGatewayScript,
  gatewayUtility
} from '../utility-orchestration/utility-gateway-scripts'
import type {
  TurnState,
  UtilityTurnGateway,
  UtilityTurnRequest
} from '../utility-orchestration-service'
import type { UtilityOrchestrationService } from '../utility-orchestration-service'

/** UtilityOrchestrationService turn-runtime: one concern, moved verbatim from the composition root. */
export class UtilityOrchestrationServiceTurnRuntime {
  constructor(private readonly host: UtilityOrchestrationService) {}

  async startTurn(request: UtilityTurnRequest): Promise<UtilityTurnGateway> {
    const id = randomUUID()
    const eligible = await this.host.units['orchestration'].timed(
      request,
      'utilityRegistry',
      this.host.units['orchestration'].resolveEligibleUtilities(request)
    )
    if (!this.host.units['orchestration'].hasNativeComputerUse(request)) {
      // Resolved once per turn: it inspects the installed Cua Driver binary, which
      // is far too expensive for the mid-turn refresh below to repeat.
      const cuaUtility = await this.host.units['orchestration'].timed(
        request,
        'cuaDriver',
        this.host.cuaBridge.resolveUtility(request.harnessId, request.permissionLevel)
      )
      if (cuaUtility) eligible.push(cuaUtility)
    }
    const imageDescriptorEligible = eligible.some(
      ({ utility }) => utility.kind === 'image_descriptor'
    )
    // Neither an MCP server nor a skill is ever launched natively into a harness:
    // both are `on_demand` and reached through the gateway. Keep the kind check even
    // though the registry normalizes the activation: a legacy entry read straight
    // from disk must not sneak into a harness launch. See normalizeActivation in the
    // registry.
    const always = eligible.filter(
      ({ utility }) =>
        utility.activation === 'always' && utility.kind !== 'mcp' && utility.kind !== 'skill'
    )
    // A design session was opened by the user, so the design capability is active
    // from the first token: the playbook travels with the turn and the preview
    // operation is callable at once. Its instructions are resolved from live
    // settings here for the same reason activation resolves them, because the
    // seeded copy cannot know which CDN origins the user has approved.
    if (request.designSession && request.designSession !== 'off') {
      const design = eligible.find(({ utility }) => utility.id === APP_DESIGN_UTILITY_ID)
      if (design && !always.some(({ utility }) => utility.id === APP_DESIGN_UTILITY_ID)) {
        const instructions = await this.host.units['orchestration'].timed(
          request,
          'designPlaybook',
          this.host.units['executors'].designPlaybook(request.threadId)
        )
        always.push({
          binding: design.binding,
          utility: { ...design.utility, kind: 'skill', config: { instructions } }
        })
      }
    }
    // A video session works the same way: the user opened it, so the edit pass
    // travels with the turn and both operations are callable from the first
    // token. Its craft notes are a constant, but the paragraph about the models
    // the user staffed is resolved from live settings, because the same experts
    // staff a composition and a design.
    if (request.videoSession && request.videoSession !== 'off') {
      const video = eligible.find(({ utility }) => utility.id === APP_VIDEO_UTILITY_ID)
      if (video && !always.some(({ utility }) => utility.id === APP_VIDEO_UTILITY_ID)) {
        const instructions = await this.host.units['orchestration'].timed(
          request,
          'videoPlaybook',
          this.host.units['executors'].videoPlaybook(request.threadId)
        )
        always.push({
          binding: video.binding,
          utility: {
            ...video.utility,
            kind: 'skill',
            config: { instructions }
          }
        })
      }
    }
    const hasOnDemand = eligible.some(({ utility }) => utility.activation === 'on_demand')
    // The app-owned scope utility is advertised as a one-line pointer, never as
    // a schema: whether it is offered at all is the registry's call, so
    // disabling it in Utilities removes the pointer too.
    const hasScopeCapability = eligible.some(({ utility }) => utility.id === APP_SCOPE_UTILITY_ID)
    // The Android device skill is advertised the same way, as a pointer rather
    // than a schema. It is knowledge an agent applies with its own shell, so the
    // only thing a turn needs from the app is to know the playbook exists.
    const hasAdbCapability = eligible.some(({ utility }) => utility.id === APP_ADB_UTILITY_ID)
    // The design capability is advertised the same way: the app wants an agent
    // that is about to design an interface to know the guidance and the preview
    // exist, without carrying the design pass in every turn's context.
    const hasDesignCapability = eligible.some(({ utility }) => utility.id === APP_DESIGN_UTILITY_ID)
    // The video capability is advertised the same way. Its playbook is heavier
    // than a pointer would be and belongs to a session, so a turn that is not
    // making a video learns it exists without carrying the edit pass.
    const hasVideoCapability = eligible.some(({ utility }) => utility.id === APP_VIDEO_UTILITY_ID)
    const gatewayTools = GATEWAY_TOOLS.filter(({ name }) => {
      // Installing is a state change, so it stays behind the explicit setup grant.
      if (name === UTILITY_MANAGE_TOOL_NAME) return request.allowManagement === true
      // Reading the app's own evidence trail is not a state change, and it is an
      // app capability rather than a utility operation: an agent asked to look
      // into a reported problem must be able to read the thread and the log
      // itself, instead of sending the user back to re-send the same message
      // with @cio-utility.
      if (name === UTILITY_DIAGNOSTICS_TOOL_NAME) return true
      // Asking for a secret is an app capability rather than a utility
      // operation, and it never needs a secret to be installed: it is offered on
      // every turn that carries the gateway at all, plus every explicit setup
      // turn, where the capability being installed is what needs the value.
      if (name === ASK_SECRET_TOOL_NAME) return hasOnDemand || request.allowManagement === true
      // Proposing a capability is likewise an app capability, not a utility
      // operation: an agent that finds something the task needs but the user
      // does not have must be able to offer it instead of dead-ending on a
      // harness-native suggestion the app cannot render.
      if (name === UTILITY_SUGGEST_TOOL_NAME) return hasOnDemand || request.allowManagement === true
      // The workstation tools start real work on a machine. A thread running in
      // full access reaches them with no tag, exactly like the app-control tools
      // below; every other thread reaches them only after the user opens an
      // @cio-hey session. The gateway refuses a route the turn never received.
      if (isOrchestrationTool(name)) {
        return (
          request.permissionLevel === 'full_access' ||
          (request.orchestrationSession !== undefined && request.orchestrationSession !== 'off')
        )
      }
      // The engineering artifact tools are granted by the turn's own flag: they
      // create a real Brainstorm, PRD, spec or Assignment for the thread, so a
      // chat, an assistant task and a worker thread are offered none of them.
      if (isEngineeringTool(name)) {
        return request.artifactTools === true
      }
      // A pawn agent is how any agent keeps work out of its own context: the
      // tool spawns a thread that answers only to the caller, so it is offered
      // on every turn that carries the gateway at all, the same way asking for
      // a secret or reporting a problem is.
      if (isPawnTool(name)) {
        return true
      }
      // The app-control tools let a turn drive the app itself. A thread running
      // in full access reaches them with no tag, which is the starting block for
      // the per-channel permission gates to come; every other thread reaches
      // them only after the user opens an @cio-hey session. The gateway refuses
      // a route the turn never received.
      if (isAppControlTool(name)) {
        return (
          request.permissionLevel === 'full_access' ||
          (request.orchestrationSession !== undefined && request.orchestrationSession !== 'off')
        )
      }
      return (
        hasOnDemand ||
        request.permissionLevel === 'full_access' ||
        request.artifactTools === true ||
        request.allowManagement === true ||
        (request.orchestrationSession !== undefined && request.orchestrationSession !== 'off')
      )
    })
    if (gatewayTools.length === 0) {
      return {
        id,
        resolvedUtilities: always,
        instructions: '',
        directInstructions: '',
        directEndpoint: null,
        managementEnabled: false,
        cleanup: async () => undefined
      }
    }
    const state: TurnState = {
      grantedTools: gatewayTools,
      id,
      request,
      eligible: new Map(eligible.map((entry) => [entry.utility.id, entry])),
      activated: new Map(always.map((entry) => [entry.utility.id, entry])),
      clients: new Map(),
      connecting: new Map(),
      attributionSequence: 0,
      searched: false,
      cuaSessionIds: new Map(),
      cuaViews: new Map(),
      managedUtilities: [],
      diagnostics: null,
      projectSearchTerms: null,
      bank: new Map(),
      eligibilityRefreshedAt: Date.now()
    }
    // Surface the thread's durable utilities bank so later turns can go
    // straight to usage: only banked utilities that are still eligible this
    // turn are advertised (the rest would fail the eligibility gate anyway).
    const bankEntries = await this.host.units['orchestration'].timed(
      request,
      'threadBank',
      this.host.units['orchestration'].loadThreadBank(request.threadId)
    )
    for (const entry of bankEntries) {
      if (state.eligible.has(entry.id)) state.bank.set(entry.id, entry)
    }
    const bridgeUrl = await this.host.units['orchestration'].timed(
      request,
      'gatewayServer',
      this.host.units['gateway-endpoints'].ensureGatewayServer()
    )
    const token = randomBytes(32).toString('hex')
    const scriptPath = `${BRIDGE_SCRIPT_PATH}.${id}.mjs`
    await this.host.units['orchestration'].timed(
      request,
      'gatewayScript',
      this.host.storage.writeRaw(
        scriptPath,
        buildUtilityGatewayScript(initialGatewayTools(gatewayTools))
      )
    )
    this.host.turns.set(id, { state, scriptPath, token })
    this.host.turnIdsByToken.set(token, id)

    const gateway = gatewayUtility(request, this.host.storage.resolve(scriptPath), bridgeUrl, token)
    // A real project thread (the same turns that may create the thread's own
    // engineering artifacts) that is neither in full access nor in an @cio-hey
    // session does not receive the app-control or workstation tools. It is still
    // told they exist, so it asks the user to tag it instead of working around
    // them.
    const sessionToolsAskRequired =
      request.artifactTools === true &&
      request.permissionLevel !== 'full_access' &&
      (request.orchestrationSession === undefined || request.orchestrationSession === 'off')
    const toolInstructions = [
      GATEWAY_DISCOVERY_INSTRUCTION,
      'Use available code mode to batch independent tool calls in one model request. Run independent reads with bounded parallelism and inspect every result; keep dependent operations, mutations, approvals and retries sequential. Filter large results before returning them to the model. Reuse loaded documentation and activated utilities. Read workstation targets only when dispatching work, and the app catalog only when driving the app.',
      'When you need more than one MCP request or tool call, ALWAYS batch them in ONE code mode script: MAKING EACH REQUEST ONE AT A TIME IS FORBIDDEN, and a burst of individual MCP or tool calls that could have been batched is as good as failing the task. NEVER break this rule, it is of the most importance.',
      `App-managed utilities are available as first-class tools in this session: call ${UTILITY_SEARCH_TOOL_NAME} to search, ${UTILITY_ACTIVATE_TOOL_NAME} to activate, and ${UTILITY_INVOKE_TOOL_NAME} to invoke. The tools hold the turn-scoped gateway credentials internally   never call the gateway through the shell, and never print or persist tokens.`,
      `One utility invocation per item is the most expensive shape a turn can take: when the same inspect-only operation must run for many inputs (a validator over every changed file, a documentation read for several topics, the same lookup for several ids), loop over the inputs inside ONE code-mode script with bounded concurrency and return only the findings, never one invocation per item. The gateway's own batch operation covers the app's read-only tools only, so a server-side utility or MCP operation is scripted, not batched.`,
      `Never ask the user to paste a secret into chat. When you need one (an API key, token, or password), call ${ASK_SECRET_TOOL_NAME} with one entry per secret and a short title; you receive the environment variable name   and, for a value you interpolate in a shell command, a 0600 secret_path you read with \`"$(cat secret_path)"\`   never the value itself.`,
      `When a needed capability is missing, check first whether your own tools already cover the work: text, code, SVG and HTML are yours to author, and a missing generator is not a missing capability when the request is vector or written work. That covers documents and assets only: an interface, a screen, a prototype or a set of design variations is not one of them and is never hand-written here, it is designed in the app's design session. Only what you genuinely cannot produce yourself earns an installation card: load ${UTILITY_SUGGEST_TOOL_NAME} through cio:gateway and offer it. Claim it is connected only after accepted. Keep credentials out of bundles and collect them with ${ASK_SECRET_TOOL_NAME}.`,
      `Read-only app diagnostics are available with ${UTILITY_DIAGNOSTICS_TOOL_NAME} (lookup_thread, search_threads, read_messages, read_log, list_schema, query_sql). When the user reports a problem with the app, a thread, an assistant, or a log line, look the evidence up yourself with it instead of asking them to re-send the request with a tag: it reads threads across projects, mirrored conversation pages, log tails, the app schema, and read-only SELECTs, and it never writes, deletes, or reconfigures anything.`,
      ...(gatewayTools.some(({ name }) => isPawnTool(name))
        ? [
            `A pawn agent (${PAWN_AGENT_TOOL_NAME}) is an independent worker thread that answers only to you: it is how you do real work without spending your own context. Spawn one for a long implementation, a broad refactor, independent verification, or research that would otherwise flood this conversation, and give it the complete task, the files it owns, and how to check its own work. It runs on the user's pawn default model when one is configured, otherwise on your model at the lowest thinking level, and it never commits: read its report, inspect the files it touched, and commit them yourself. You keep directing it: when the user corrects or redirects a pawn's work, call the tool again with that pawn's pawn_id and their instruction, and it reaches the work in progress instead of starting over. Do not spawn a second pawn to change direction. It is not extra sub-agent capacity: ${CIO_SPAWN_AGENT_TOOL_NAME} runs at most four workers at once, so a pawn is the way past that ceiling only when the work genuinely needs five or more worker runs in flight at the same time and waiting for a free slot would stall it, or when the user explicitly asks for pawns   and then it is one pawn carrying the overflow, never a fan-out of pawns you decided on yourself.`
          ]
        : []),
      ...(gatewayTools.some(({ name }) => isEngineeringTool(name))
        ? [
            `For a requested Brainstorm, PRD, spec or Assignment, discover the matching cio_create_* schema through cio:gateway and invoke it. Ask once whether the user wants independently promptable Assignment workers or inline sub-agents when that preference is unknown.`
          ]
        : []),
      ...(sessionToolsAskRequired
        ? [
            `You can read and drive the app itself (its panels, settings, git and cloud deployments) with ${APP_CONTROL_CATALOG_TOOL_NAME} and ${APP_CONTROL_CALL_TOOL_NAME}. This thread is not running in full access and no @cio-hey session is open, so those tools are not in your tool list. When the task needs them, say so and ask the user to tag their next message with @cio-hey, or to switch the thread to full access. Do not try to reach the app's channels another way.`
          ]
        : []),
      ...(sessionToolsAskRequired
        ? [
            `You can read the workstation and dispatch real work onto a chosen machine with ${ORCHESTRATION_TARGETS_TOOL_NAME}, ${ORCHESTRATION_DISPATCH_TOOL_NAME} and ${ORCHESTRATION_STATUS_TOOL_NAME}. This thread is not running in full access and no @cio-hey session is open, so those tools are not in your tool list. When the task needs them, say so and ask the user to tag their next message with @cio-hey, or to switch the thread to full access. Do not dispatch work another way.`
          ]
        : []),
      ...(hasScopeCapability
        ? [
            `The app-owned worktree capability is not exposed directly. Only when the user explicitly requests a separate worktree, search with ${UTILITY_SEARCH_TOOL_NAME} (query "${SCOPE_CAPABILITY_SEARCH_QUERY}"), activate the result and invoke it. Never create one on your own or run raw git worktree add.`
          ]
        : []),
      ...(hasAdbCapability
        ? [
            `Before probing an Android device or emulator, search with ${UTILITY_SEARCH_TOOL_NAME} (query "${ADB_CAPABILITY_SEARCH_QUERY}") and activate the device playbook. Follow project Android guidance first; use this playbook for gaps. Re-list lost docs with ${UTILITY_DOCS_TOOL_NAME}.`
          ]
        : []),
      ...(eligible.some(({ utility }) => utility.id === APP_ARTIFACT_UTILITY_ID)
        ? [
            `For requested inline artifacts, activate ${APP_ARTIFACT_UTILITY_ID} before producing output; it covers image, audio, video, HTML and SVG delivery. Ordinary design or video work uses its task-specific capability.`
          ]
        : []),
      ...(eligible.some(({ utility }) => utility.id === APP_BROWSER_UTILITY_ID)
        ? [
            `Use the in-app browser (${APP_BROWSER_UTILITY_ID}) to inspect every authored or changed renderable page at its served URL. Activate with ${UTILITY_ACTIVATE_TOOL_NAME}; inspect screenshot, viewport, snapshot and console in background. The page this conversation's thread browser is on is readable in whatever box the user put it: pass page "user" when they refer to the page they are looking at, and page "agent" for a page you opened. Drive a multi-step browser flow (open, navigate, click, type, snapshot, screenshot) through code mode in one model request instead of one invocation per step: every separate browser call is its own model step, and its result stays in context for the rest of the turn. Never substitute your own browser, headless Chromium, Playwright, Puppeteer or curl.`
          ]
        : []),
      ...(hasDesignCapability
        ? [
            `Interface design is a session, not a file. When the user asks to design, redesign, mock up, prototype, explore or show variations of an interface, a screen, a panel, a header, a page, a dashboard or a site, search with ${UTILITY_SEARCH_TOOL_NAME} (query "${DESIGN_CAPABILITY_SEARCH_QUERY}") and activate ${APP_DESIGN_UTILITY_ID} before writing any markup. Activating it is what opens the thread's design session: it serves the folder, lists the work on the board and docks the panel the user is watching, so markup you write with your own write tool instead leaves the user with a design they will not find and a panel that never opens. Its playbook owns folders, screens, preview, checkpoints, delegation and media generation. Inspect its preview in ${APP_BROWSER_UTILITY_ID}. Follow project design language first.`
          ]
        : []),
      ...(hasVideoCapability
        ? [
            `Video work is a session, not a file: before writing a composition, search with ${UTILITY_SEARCH_TOOL_NAME} (query "${VIDEO_CAPABILITY_SEARCH_QUERY}") and activate ${APP_VIDEO_UTILITY_ID}. Activating it is what opens the thread's video session, serves the folder, lists the composition on the board and docks the panel the user is watching. Its playbook covers composition, preview, checkpoints and frame capture. Inspect every changed frame and use ${APP_BROWSER_UTILITY_ID} for motion. Follow project motion guidance first.`
          ]
        : []),
      ...(hasOnDemand
        ? [
            "A utility you activate is registered in this thread's utilities bank for the whole thread lifecycle: in later turns you can invoke it directly with " +
              UTILITY_INVOKE_TOOL_NAME +
              ' and its id, no re-activation needed. If context compaction dropped its capability docs, re-list them with ' +
              UTILITY_DOCS_TOOL_NAME +
              ' (accepts only the utility id). MCP clients are reconnected per turn as needed, so direct reuse costs nothing until you actually invoke.',
            ...(state.bank.size > 0
              ? [
                  `Thread utilities bank (registered in earlier turns; invoke directly with ${UTILITY_INVOKE_TOOL_NAME}): ${[
                    ...state.bank.values()
                  ]
                    .map(
                      (entry) => `${entry.id} (${entry.kind}) ${entry.name} — ${entry.description}`
                    )
                    .join('; ')}`
                ]
              : []),
            'A search result reports an explicit `notFound` boolean and may return project-aware candidates (`matchType: "candidates"`) to evaluate semantically. Before concluding that any capability (MCP, skill, tool, utility) is unavailable or does not exist, call ' +
              UTILITY_SEARCH_TOOL_NAME +
              ' first; only conclude unavailability when the result reports notFound:true. Never treat "the tools are not exposed in this session" as proof of absence. If you already know an eligible utility id, activate it directly without searching first.',
            ...(imageDescriptorEligible
              ? [
                  'Describe images: search for the image descriptor utility, activate its id, then invoke it with operation "describe" and input {"images":[{"id":"image-1","source":"path-or-url","type":"path"}]}.'
                ]
              : [])
          ]
        : []),
      ...(request.allowManagement
        ? [
            `Explicit utility setup is enabled. Discover ${UTILITY_MANAGE_TOOL_NAME} through cio:gateway; install secret-free definitions, then collect credentials with ${ASK_SECRET_TOOL_NAME}.`
          ]
        : [])
    ].join('\n')
    await this.host.units['orchestration'].timed(
      request,
      'turnAudit',
      this.host.units['orchestration'].audit(state, 'turn.started', {
        eligibleUtilityIds: eligible.map(({ utility }) => utility.id),
        alwaysUtilityIds: always.map(({ utility }) => utility.id)
      })
    )

    let cleanupPromise: Promise<void> | null = null
    const cleanup = async (): Promise<void> => {
      cleanupPromise ??= this.cleanupTurn(id)
      await cleanupPromise
    }
    return {
      id,
      resolvedUtilities: [...always, gateway],
      instructions: toolInstructions,
      directInstructions: toolInstructions,
      directEndpoint: {
        url: bridgeUrl,
        token,
        toolNames: initialGatewayTools(gatewayTools).map(({ name }) => name),
        timeoutMs: gatewayHarnessTimeoutMs((await this.host.storage.getConfig()).questionTimeoutMs)
      },
      managementEnabled: request.allowManagement === true,
      cleanup
    }
  }

  async cleanupTurn(id: string): Promise<void> {
    const turn = this.host.turns.get(id)
    if (!turn) return
    this.host.turns.delete(id)
    this.host.turnIdsByToken.delete(turn.token)
    await this.endComputerUseSessions(turn.state)
    await Promise.allSettled([...turn.state.clients.values()].map((client) => client.close()))
    // Last, so the claim covers the clients it was taken for: an unrestricted
    // daemon is stopped here once nothing needs it any more.
    await this.host.cuaBridge.releaseDaemonClaim(turn.state.id)
    await this.host.storage.remove(turn.scriptPath)
    await this.host.units['orchestration'].audit(turn.state, 'turn.cleaned', {
      activatedUtilityIds: [...turn.state.activated.keys()]
    })
  }

  /** Establish a visible, never-idle-hidden cursor for one Cua turn. */
  async prepareComputerUseSession(
    state: TurnState,
    utilityId: string,
    client: McpClient
  ): Promise<void> {
    const sessionId = buildCuaSessionId(state.request.threadTitle, state.id)
    try {
      const result: unknown = await client.callTool('start_session', { session: sessionId })
      if (
        result &&
        typeof result === 'object' &&
        (result as Record<string, unknown>)['isError'] === true
      ) {
        throw new Error('The driver refused the managed computer-use session.')
      }
    } catch (error) {
      Logger.dev('Cua cursor session could not be started:', error)
      throw new Error(
        'The managed computer-use session could not be started. No action was executed.',
        {
          cause: error
        }
      )
    }
    state.cuaSessionIds.set(utilityId, sessionId)
    try {
      await client.callTool('set_agent_cursor_enabled', { session: sessionId, enabled: true })
    } catch (error) {
      Logger.dev('Cua agent cursor could not be enabled:', error)
    }
    try {
      await client.callTool('set_agent_cursor_motion', {
        session: sessionId,
        idle_hide_ms: 0
      })
    } catch (error) {
      Logger.dev('Cua agent cursor motion could not be configured:', error)
    }
  }

  async endComputerUseSessions(state: TurnState): Promise<void> {
    await Promise.allSettled(
      [...state.cuaSessionIds.entries()].map(async ([utilityId, sessionId]) => {
        const client = state.clients.get(utilityId)
        if (!client) return
        await client.callTool('end_session', { session: sessionId }).catch(() => undefined)
      })
    )
    state.cuaSessionIds.clear()
  }
}
