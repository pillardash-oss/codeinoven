import { invokeGatewayCapability } from '../utility-orchestration/utility-gateway-discovery'
import { normalizePlanDelivery, normalizePlanPriority } from '../../../lib/assistant-reporting'
import type { AssistantReportingPatch } from '../../../lib/assistant-authoring'
import { randomUUID } from 'crypto'
import type {
  ResolvedUtility,
  UtilityDefinition,
  UtilityDefinitionFor,
  AgentUtilitySuggestionEntry,
  UtilityDefinitionInput,
  ThreadSearchResult
} from '../../../lib/types'
import {
  APP_ARTIFACT_UTILITY_ID,
  APP_CITE_UTILITY_ID,
  APP_DESIGN_UTILITY_ID,
  APP_VIDEO_UTILITY_ID
} from '../../../lib/utility-ids'
import {
  APP_BROWSER_UTILITY_ID,
  APP_SCOPE_UTILITY_ID,
  UtilityRegistryService
} from '../utility-registry-service'
import { CITE_ENTRY_LIMIT, CITE_OPERATIONS, CITE_PATH_LIMIT } from '../../../lib/cited-work'
import { CUA_PLAYBOOK } from '../cio-cua-prompt'
import { mcpCatalogPayload } from '../mcp-tool-catalog'
import {
  ASK_SECRET_TOOL_NAME,
  GATEWAY_CAPABILITY_ID,
  GATEWAY_DISCOVERY_INSTRUCTION,
  UTILITY_DOCS_TOOL_NAME
} from '../../../lib/gateway-tools'
import { currentWorkRoots } from '../../design/work-roots-state'
import { acquireCuaSnapshotLease } from '../cua-snapshot-lease'
import {
  cuaActionReference,
  cuaRefusal,
  cuaSnapshotView,
  foreignSnapshotAdvice,
  groundCuaAction,
  isSupersededSnapshotRefusal,
  reanchorCuaAction,
  shapeCuaResult
} from '../../../lib/cua-driver'
import { type McpClient } from '../../agents/mcp-stdio-client'
import {
  WEB_TOOL_INPUT_SCHEMAS,
  WEB_TOOL_OUTPUT_SCHEMAS,
  executeWebTool,
  webSourceIndex
} from '../../agents/web-tool-providers'
import {
  IMAGE_DESCRIPTOR_INPUT_SCHEMA,
  IMAGE_DESCRIPTOR_OUTPUT_SCHEMA,
  resolveImageEntries
} from '../../providers/image-descriptor-provider'
import { budgetToolResult, DEFAULT_PROMPT_BUDGET } from '../../../lib/prompt-budget'
import { Logger } from '../../system/logger'
import {
  BRAINSTORM_ALIGNMENT_UTILITY_ID,
  BRAINSTORM_ALIGNMENT_OPERATIONS,
  BRAINSTORM_ALIGNMENT_NOTE_LIMIT
} from '../../../lib/brainstorm/brainstorm-alignment'
import {
  ASSISTANT_AUTHORING_UTILITY_ID,
  ASSISTANT_AUTHORING_OPERATIONS,
  ASSISTANT_AUTHORING_CHECKPOINT_LIMIT
} from '../../../lib/assistant-authoring'
import {
  ASSISTANT_REPORT_BODY_LIMIT,
  ASSISTANT_REPORT_OPERATIONS,
  ASSISTANT_REPORT_TITLE_LIMIT,
  ASSISTANT_REPORT_UTILITY_ID
} from '../../../lib/assistant-reports'
import { ASSISTANT_NAME_LIMIT } from '../../../lib/types'
import {
  matchesUtilityKinds,
  operationPid,
  projectTechnologyTerms,
  utilityProjectAffinityScore,
  utilitySearchScore
} from '../utility-orchestration/utility-search'
import {
  BROWSER_UTILITY_TOOLS,
  designUtilityTools,
  videoUtilityTools
} from '../utility-orchestration/utility-gateway-scripts'
import {
  optionalKinds,
  optionalNumber,
  optionalString,
  recordValue,
  requiredString
} from '../utility-orchestration/utility-input'
import {
  normalizeBundleDefinitions,
  normalizeBundleName
} from '../utility-orchestration/utility-bundle-input'
import { utilityInstallSource } from '../../../lib/utility-suggestion'
import { CUA_UTILITY_ID, cuaViewKey, refusalResult } from '../utility-orchestration-service'
import type {
  DesignCapabilityExecutor,
  TurnState,
  UtilitySuggestionExecutor,
  VideoCapabilityExecutor
} from '../utility-orchestration-service'
import type { UtilityOrchestrationService } from '../utility-orchestration-service'

/** UtilityOrchestrationService capability-invoke: one concern, moved verbatim from the composition root. */
export class UtilityOrchestrationServiceCapabilityInvoke {
  constructor(private readonly host: UtilityOrchestrationService) {}

  /** Attach the hybrid thread search used by the diagnostics `search_threads` action. */
  setThreadSearchProvider(
    provider: ((query: string) => Promise<ThreadSearchResult[]>) | null
  ): void {
    this.host.threadSearch = provider
  }

  /**
   * Register the executor behind the app-owned `cio_util_suggest` gateway tool.
   * A suggestion is an app capability rather than a utility operation: the agent
   * offers a capability it found, the user accepts or declines on the card, and
   * the app installs it through Utilities only on acceptance. The chat engine
   * supplies the executor because it owns the pending-question machinery.
   */
  setUtilitySuggestionExecutor(executor: UtilitySuggestionExecutor | null): void {
    this.host.utilitySuggestionExecutor = executor
  }

  /** Whether the agent has called the app utility-search tool at least once this turn. */
  hasSearched(gatewayId: string): boolean {
    return this.host.turns.get(gatewayId)?.state.searched === true
  }

  /** Whether the agent directly activated an on-demand utility this turn. */
  hasActivatedOnDemand(gatewayId: string): boolean {
    const state = this.host.turns.get(gatewayId)?.state
    return (
      state !== undefined &&
      [...state.activated.values()].some(({ utility }) => utility.activation === 'on_demand')
    )
  }

  /** Snapshot of utilities installed by an explicit setup turn. */
  managedUtilities(gatewayId: string): UtilityDefinition[] {
    return structuredClone(this.host.turns.get(gatewayId)?.state.managedUtilities ?? [])
  }

  async manage(state: TurnState, input: Record<string, unknown>): Promise<unknown> {
    if (state.request.allowManagement !== true) {
      throw new Error('Utility management is not enabled for this turn')
    }
    if (input['action'] !== 'install_bundle') {
      throw new TypeError('Utility management action is invalid')
    }
    const definitions = normalizeBundleDefinitions(input['bundle'])
    const outcomes = await this.host.registry.installMany(definitions, { consolidate: true })
    // A capability scoped to a project or a thread is installed on disk as well
    // as in the registry, so the install the user asked for exists outside app
    // state. Best effort: the entry is already saved.
    await this.host.units['orchestration']
      .footprint()
      ?.reconcile(await this.host.registry.list())
      .catch((error: unknown) =>
        Logger.dev('Scoped utility install folder was not written:', error)
      )
    state.managedUtilities.push(...outcomes.map((outcome) => outcome.utility))
    // Hot reload: make what this turn just installed reachable by the next search
    // or activation in the same turn, without waiting for a reload.
    await this.host.units['orchestration'].refreshEligible(state, { force: true })
    await this.host.units['orchestration'].audit(state, 'utility.managed', {
      action: 'install_bundle',
      utilityIds: outcomes.map((outcome) => outcome.utility.id),
      updatedUtilityIds: outcomes
        .filter((outcome) => outcome.action === 'updated')
        .map((outcome) => outcome.utility.id),
      removedUtilityIds: outcomes.flatMap((outcome) => outcome.removed.map(({ id }) => id))
    })
    // Reinstalling is reported apart from installing: the agent must not claim a
    // second install when the bundle replaced what was already there.
    const describe = (outcome: (typeof outcomes)[number]) => ({
      id: outcome.utility.id,
      kind: outcome.utility.kind,
      name: outcome.utility.name
    })
    return {
      installed: outcomes.filter((outcome) => outcome.action === 'installed').map(describe),
      updated: outcomes.filter((outcome) => outcome.action === 'updated').map(describe),
      removed: outcomes.flatMap((outcome) => outcome.removed)
    }
  }

  /**
   * Offer one capability the agent found for the user to install.
   *
   * The card owns the decision, so the install happens here and not in the
   * engine: the executor surfaces the proposal and reports back only what the
   * user chose. Installing software is never automatic, so a declined, expired
   * or abandoned card leaves the registry untouched, and the bundle is always
   * secret-free   a credential is collected afterwards with `cio_ask_secret`.
   *
   * The bundle is validated against the registry's own rules before the card is
   * ever shown, and the card lists the utilities it would install. The user is
   * therefore never asked to approve a bundle that cannot install (which is what
   * produced an "accepted" decision followed by `MCP transport is invalid`), and
   * every card names the real tools rather than a bundle title.
   */
  async suggestUtility(state: TurnState, input: Record<string, unknown>): Promise<unknown> {
    const executor = this.host.utilitySuggestionExecutor
    if (!executor) throw new Error('Utility suggestions are unavailable in this deployment')
    const reason = requiredString(input['reason'], 'reason', 1_000)
    const name = normalizeBundleName(input['bundle'])
    const definitions = normalizeBundleDefinitions(input['bundle'])
    // Pre-flight with the registry's install rules: a proposal the registry would
    // reject is answered as invalid here, and the user is never shown a card for
    // it. The message is the registry's own, so the fix is unambiguous.
    let installable: UtilityDefinitionInput[]
    try {
      installable = this.host.registry.validateMany(definitions)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return {
        status: 'invalid',
        error: detail,
        message:
          'This bundle cannot be installed, so the user was not asked. Fix the definition and call this tool again: ' +
          detail
      }
    }
    const entry: AgentUtilitySuggestionEntry = {
      id: randomUUID().replace(/-/gu, '').slice(0, 8).toUpperCase(),
      name,
      kinds: [...new Set(installable.map((definition) => definition.kind))],
      reason,
      utilities: installable.map((definition) => ({
        name: definition.name,
        kind: definition.kind,
        source: utilityInstallSource(definition),
        ...(definition.description ? { description: definition.description } : {})
      }))
    }
    const resolution = await executor(entry, {
      projectId: state.request.projectId,
      threadId: state.request.threadId,
      projectPath: state.request.projectPath,
      sessionId: state.request.sessionId,
      harnessId: state.request.harnessId
    })
    await this.host.units['orchestration'].audit(state, 'utility.suggested', {
      name,
      kinds: entry.kinds,
      decision: resolution.decision
    })
    if (resolution.decision === 'alternative') {
      return {
        status: 'alternative',
        userAnswer: resolution.answer ?? '',
        message:
          'The user answered with their own instruction instead of installing or declining. Nothing was installed. Follow what they wrote, and only call this tool again if the capability is still the right answer.'
      }
    }
    if (resolution.decision !== 'accepted') {
      return {
        status: 'declined',
        message:
          'The user declined the proposed capability. Do not install it, and never claim it is available. Continue without it, or say plainly what is missing.'
      }
    }
    let outcomes: Awaited<ReturnType<UtilityRegistryService['installMany']>>
    try {
      outcomes = await this.host.registry.installMany(definitions, { consolidate: true })
    } catch (error) {
      // The card is already answered, so the failure has to come back as data the
      // agent can act on   never as an unlabelled tool error the agent paraphrases
      // to the user as "the app rejected it".
      const detail = error instanceof Error ? error.message : String(error)
      Logger.error('Accepted capability suggestion failed to install:', error)
      return {
        status: 'failed',
        error: detail,
        message:
          'The user accepted, but the install failed, so nothing was added. Tell them plainly that the install did not happen and why, then fix the definition and call this tool again: ' +
          detail
      }
    }
    await this.host.units['orchestration']
      .footprint()
      ?.reconcile(await this.host.registry.list())
      .catch((error: unknown) =>
        Logger.dev('Suggested utility install folder was not written:', error)
      )
    state.managedUtilities.push(...outcomes.map((outcome) => outcome.utility))
    // Hot reload: what the user just accepted is reachable by the next search or
    // activation in this same turn, without waiting for a reload.
    await this.host.units['orchestration'].refreshEligible(state, { force: true })
    const describe = (outcome: (typeof outcomes)[number]) => ({
      id: outcome.utility.id,
      kind: outcome.utility.kind,
      name: outcome.utility.name
    })
    return {
      status: 'accepted',
      installed: outcomes.filter((outcome) => outcome.action === 'installed').map(describe),
      updated: outcomes.filter((outcome) => outcome.action === 'updated').map(describe),
      message:
        'Installed and available for the rest of this turn. If it needs a credential, collect it with ' +
        ASK_SECRET_TOOL_NAME +
        ' using the installed id and the variable the connection reads.'
    }
  }

  async search(state: TurnState, input: Record<string, unknown>): Promise<unknown> {
    // A capability installed moments ago must be findable in this same turn.
    await this.host.units['orchestration'].refreshEligible(state)
    const query = optionalString(input['query'], 500)
    if (query && /^(?:cio:gateway|cio_(?:app_|orchestrate_|create_)\w+)$/.test(query)) {
      return {
        notFound: false,
        utilities: [
          {
            id: GATEWAY_CAPABILITY_ID,
            name: 'App tools',
            kind: 'skill',
            active: true,
            description: GATEWAY_DISCOVERY_INSTRUCTION
          }
        ]
      }
    }
    const kinds = optionalKinds(input['kinds'])
    const requestedLimit = optionalNumber(input['limit'])
    const limit = Math.min(Math.max(requestedLimit ?? 8, 1), 20)
    state.projectSearchTerms ??= projectTechnologyTerms(state.request.projectPath)
    const projectTerms = await state.projectSearchTerms
    const ranked = [...state.eligible.values()]
      .filter((resolved) => matchesUtilityKinds(resolved, kinds))
      .map((resolved) => ({
        resolved,
        lexicalScore: utilitySearchScore(resolved, query),
        projectScore: utilityProjectAffinityScore(resolved, projectTerms)
      }))
      .sort(
        (left, right) =>
          right.lexicalScore - left.lexicalScore || right.projectScore - left.projectScore
      )
    const matches = query ? ranked.filter(({ lexicalScore }) => lexicalScore > 0) : ranked
    const fallback = Boolean(query) && matches.length === 0 && ranked.length > 0
    const utilities = (fallback ? ranked : matches)
      .slice(0, limit)
      .map(({ resolved: { utility } }) => ({
        id: utility.id,
        name: utility.name,
        kind: utility.kind,
        description: utility.description,
        active: state.activated.has(utility.id),
        banked: state.bank.has(utility.id)
      }))
    // Lexical mismatch is not proof of semantic irrelevance. Candidate results
    // are intentionally left for the calling agent to evaluate against the
    // user's task; only an empty eligible set is an unambiguous absence verdict.
    const notFound = ranked.length === 0
    const matchType = notFound ? 'none' : fallback ? 'candidates' : 'direct'
    state.searched = true
    await this.host.units['orchestration'].audit(state, 'utility.searched', {
      query,
      fallback,
      notFound,
      matchType,
      resultIds: utilities.map(({ id }) => id)
    })
    return {
      utilities,
      fallback,
      notFound,
      matchType,
      ...(fallback
        ? {
            message:
              'No direct lexical match was found. Review these project-aware candidates against the task intent, then activate a relevant result or refine the search. If none of them fits, research the official source online (your own web tools, or a web/search capability from this library) before concluding the capability cannot be supplied.'
          }
        : {})
    }
  }

  async activate(state: TurnState, input: Record<string, unknown>): Promise<unknown> {
    const utilityId = requiredString(input['utility_id'], 'utility_id', 256)
    if (utilityId === GATEWAY_CAPABILITY_ID)
      return {
        id: utilityId,
        instructions: GATEWAY_DISCOVERY_INSTRUCTION,
        operations: ['catalog', 'call', 'batch']
      }
    // Re-check the registry first: the agent may be activating a utility that was
    // installed or enabled after this turn started.
    await this.host.units['orchestration'].refreshEligible(state)
    const resolved = state.eligible.get(utilityId)
    if (!resolved) throw new Error('Utility is unavailable in this project, thread, or harness')
    // Re-activating an already-active utility must be a no-op: re-listing the
    // full capability would duplicate an unchanged schema into the transcript
    // for nothing, and for MCP/computer-use kinds the old code also tore down
    // the live client (killing an in-flight CUA session) just to reconnect it.
    if (state.activated.has(utilityId) && input['force'] !== true) {
      await this.host.units['orchestration'].audit(state, 'utility.activated', {
        utilityId,
        kind: resolved.utility.kind,
        alreadyActive: true
      })
      return {
        utility: {
          id: resolved.utility.id,
          name: resolved.utility.name,
          kind: resolved.utility.kind
        },
        capability: {
          note: 'Already active in this turn. Its capability description was returned by the earlier activation and is unchanged; invoke it directly. If compaction dropped that description from context, re-list it with cio_util_docs_lookup (or re-activate with input {"force": true}).'
        }
      }
    }
    state.activated.set(utilityId, resolved)
    // The agent just entered an authored-work session by picking the capability
    // up, so the app is told about it now rather than at the first preview.
    this.host.units['orchestration'].noteAuthoredWorkSession(state, utilityId)
    // First activation in this thread registers the utility in the durable
    // thread utilities bank so every later turn can invoke it by id directly.
    await this.host.units['orchestration'].registerThreadBankEntry(state, resolved.utility)
    const capability = await this.capabilityFor(
      state,
      resolved,
      await this.host.units['orchestration'].sessionOpeningFor(state, utilityId)
    )
    await this.host.units['orchestration'].audit(state, 'utility.activated', {
      utilityId,
      kind: resolved.utility.kind
    })
    return {
      utility: {
        id: resolved.utility.id,
        name: resolved.utility.name,
        kind: resolved.utility.kind
      },
      capability
    }
  }

  async capabilityFor(
    state: TurnState,
    resolved: ResolvedUtility,
    /**
     * The session briefing that opens a design or video session, handed to the
     * agent with the capability it just activated. Empty for a docs re-dump and
     * for any activation in a turn that already carries its session.
     */
    sessionOpening = ''
  ): Promise<unknown> {
    if (resolved.utility.id === BRAINSTORM_ALIGNMENT_UTILITY_ID) {
      return { tools: BRAINSTORM_ALIGNMENT_OPERATIONS }
    }
    if (resolved.utility.id === ASSISTANT_AUTHORING_UTILITY_ID) {
      return { tools: ASSISTANT_AUTHORING_OPERATIONS }
    }
    if (resolved.utility.id === ASSISTANT_REPORT_UTILITY_ID) {
      return { tools: ASSISTANT_REPORT_OPERATIONS }
    }
    if (resolved.utility.id === APP_CITE_UTILITY_ID) {
      return {
        instructions: (resolved.utility.config as { instructions: string }).instructions,
        tools: CITE_OPERATIONS
      }
    }
    if (resolved.utility.id === APP_ARTIFACT_UTILITY_ID) {
      return {
        instructions: (resolved.utility.config as { instructions: string }).instructions,
        tools: [
          {
            name: 'render',
            description:
              'Render a generated local file inline in this conversation. The app validates its path and format and chooses the image, audio, video or themed HTML/SVG preview.',
            inputSchema: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: 'Absolute or workspace-relative path to an existing generated file.'
                }
              },
              required: ['path'],
              additionalProperties: false
            }
          }
        ]
      }
    }
    if (resolved.utility.id === APP_BROWSER_UTILITY_ID) {
      if (!this.host.browserExecutor) throw new Error('The in-app browser is unavailable')
      return { tools: BROWSER_UTILITY_TOOLS }
    }
    if (resolved.utility.id === APP_DESIGN_UTILITY_ID) {
      // The operation catalog travels with the playbook, because unlike the scope
      // capability this one is invoked with typed fields. The briefing an
      // activation that opens the session carries sits in front of it, so the
      // turn reads how to run the session before it reads what it can call.
      return {
        instructions: [
          sessionOpening,
          await this.host.units['executors'].designPlaybook(state.request.threadId)
        ]
          .filter(Boolean)
          .join('\n\n'),
        tools: designUtilityTools(currentWorkRoots(state.request.projectId))
      }
    }
    if (resolved.utility.id === APP_VIDEO_UTILITY_ID) {
      // Same shape as the design capability: knowledge plus a typed operation
      // catalog, handed back together so an activation or a post-compaction
      // docs re-dump is one payload.
      return {
        instructions: [
          sessionOpening,
          await this.host.units['executors'].videoPlaybook(state.request.threadId)
        ]
          .filter(Boolean)
          .join('\n\n'),
        tools: videoUtilityTools(currentWorkRoots(state.request.projectId))
      }
    }
    if (resolved.utility.id === CUA_UTILITY_ID) {
      // The driver's catalog is a list of single actions, so the activation hands
      // the batching contract with it: a desktop task that takes one script must
      // not be driven one gateway call per keystroke.
      const client = await this.host.units['mcp-lifecycle'].ensureMcpClient(state, resolved)
      return { instructions: CUA_PLAYBOOK, tools: mcpCatalogPayload(await client.listTools()) }
    }
    if (resolved.utility.kind === 'mcp' || resolved.utility.kind === 'computer_use') {
      const client = await this.host.units['mcp-lifecycle'].ensureMcpClient(state, resolved)
      return { tools: mcpCatalogPayload(await client.listTools()) }
    }
    if (resolved.utility.kind === 'skill') {
      // Skills hand back their instructions: the full contract, only now, and
      // only because this turn asked for the capability. The app-owned scope
      // utility travels this path.
      return { instructions: resolved.utility.config.instructions }
    }
    if (resolved.utility.kind === 'web_search' || resolved.utility.kind === 'web_fetch') {
      return {
        operations: [resolved.utility.kind],
        inputSchema: WEB_TOOL_INPUT_SCHEMAS[resolved.utility.kind],
        outputSchema: WEB_TOOL_OUTPUT_SCHEMAS[resolved.utility.kind]
      }
    }
    if (resolved.utility.kind === 'image_descriptor') {
      return {
        operations: ['describe'],
        inputSchema: IMAGE_DESCRIPTOR_INPUT_SCHEMA,
        outputSchema: IMAGE_DESCRIPTOR_OUTPUT_SCHEMA
      }
    }
    return {
      note: 'Provider activation changes launch configuration and cannot safely mutate a running turn.'
    }
  }

  /**
   * Re-dump one utility's full capability docs by id alone. This is the
   * post-compaction recovery path: the model may have forgotten the original
   * activation payload, so the banked id is all it needs to re-list the docs.
   * It also marks the utility active so a following invoke works directly.
   */
  async docsLookup(state: TurnState, input: Record<string, unknown>): Promise<unknown> {
    const utilityId = requiredString(input['utility_id'], 'utility_id', 256)
    if (utilityId === GATEWAY_CAPABILITY_ID)
      return {
        id: utilityId,
        instructions: GATEWAY_DISCOVERY_INSTRUCTION,
        operations: ['catalog', 'call', 'batch']
      }
    const resolved = state.activated.get(utilityId) ?? state.eligible.get(utilityId)
    if (!resolved) {
      throw new Error(
        state.bank.has(utilityId)
          ? 'This banked utility is not available to the current turn (disabled, out of scope, or filtered); ask the user to re-enable it in Utilities'
          : 'Utility is unavailable in this project, thread, or harness'
      )
    }
    state.activated.set(utilityId, resolved)
    await this.host.units['orchestration'].registerThreadBankEntry(state, resolved.utility)
    const capability = await this.capabilityFor(state, resolved)
    await this.host.units['orchestration'].audit(state, 'utility.docs_looked_up', {
      utilityId,
      kind: resolved.utility.kind
    })
    return {
      utility: {
        id: resolved.utility.id,
        name: resolved.utility.name,
        kind: resolved.utility.kind
      },
      capability
    }
  }

  async invoke(state: TurnState, input: Record<string, unknown>): Promise<unknown> {
    const utilityId = requiredString(input['utility_id'], 'utility_id', 256)
    const operation = requiredString(input['operation'], 'operation', 256)
    const operationInput = recordValue(input['input'] ?? {})
    if (utilityId === GATEWAY_CAPABILITY_ID) {
      return invokeGatewayCapability(
        operation,
        operationInput,
        state.grantedTools,
        async (tool, args) => {
          const handler = this.host.bridgeHandlers.get(tool.route)
          if (!handler) throw new Error('Gateway handler is unavailable')
          return handler(state, args)
        }
      )
    }
    let resolved = state.activated.get(utilityId)
    if (!resolved) {
      // Straight-to-usage banked reuse: a utility registered in this thread's
      // utilities bank can be invoked by id without re-activating it. The
      // per-turn eligibility gate still applies; the MCP client is reconnected
      // lazily below (stateless per turn, id persistent per thread).
      if (!state.bank.has(utilityId)) {
        const reason = await this.host.units['orchestration'].unreachableUtilityReason(utilityId)
        throw new Error(reason ?? 'Activate this utility before invoking it')
      }
      const eligible = state.eligible.get(utilityId)
      if (!eligible) {
        const reason = await this.host.units['orchestration'].unreachableUtilityReason(utilityId)
        throw new Error(
          reason ??
            'This banked utility is not available to the current turn (disabled, out of scope, or filtered); search for a replacement or ask the user to re-enable it in Utilities'
        )
      }
      resolved = eligible
      state.activated.set(utilityId, resolved)
    }

    let result: unknown
    if (resolved.utility.id === APP_SCOPE_UTILITY_ID) {
      // The capability's `operation` is the scope action, and its `input` is
      // exactly the field set the scope capability accepts.
      result = await this.host.units['tool-catalog'].runScopeTool(state, {
        ...operationInput,
        action: operation
      })
    } else if (resolved.utility.id === BRAINSTORM_ALIGNMENT_UTILITY_ID) {
      if (operation !== 'save_notes' || !state.request.saveBrainstormNotes) {
        throw new Error('Alignment notes are only available during an active Brainstorm interview')
      }
      const markdown = requiredString(
        operationInput['markdown'],
        'markdown',
        BRAINSTORM_ALIGNMENT_NOTE_LIMIT
      )
      result = await state.request.saveBrainstormNotes(markdown)
    } else if (resolved.utility.id === ASSISTANT_AUTHORING_UTILITY_ID) {
      if (operation === 'save_schedule') {
        if (!state.request.saveAssistantSchedule) {
          throw new Error('Scheduling can only be saved in an assistant setup conversation')
        }
        const scheduled = operationInput['scheduled']
        if (typeof scheduled !== 'boolean') {
          throw new Error('save_schedule needs a boolean scheduled value')
        }
        await state.request.saveAssistantSchedule(scheduled)
        result = { status: 'saved', scheduled }
      } else if (operation === 'save_reporting') {
        if (!state.request.saveAssistantReporting) {
          throw new Error('Reporting can only be saved in an assistant setup conversation')
        }
        const reporting: AssistantReportingPatch = {}
        if (operationInput['delivery'] !== undefined) {
          const delivery = normalizePlanDelivery(operationInput['delivery'])
          if (!delivery) throw new Error('Delivery needs a valid channel')
          reporting.delivery = delivery
        }
        if (operationInput['priority'] !== undefined) {
          const priority = normalizePlanPriority(operationInput['priority'])
          if (!priority) throw new Error('Priority needs both timeliness and impact')
          reporting.priority = priority
        }
        if (!reporting.delivery && !reporting.priority) {
          throw new Error('save_reporting needs delivery or priority')
        }
        await state.request.saveAssistantReporting(reporting)
        result = { status: 'saved', ...reporting }
      } else if (operation === 'save_checkpoint') {
        if (!state.request.saveAssistantCheckpoint) {
          throw new Error(
            'The getting-started checkpoint is only available while an assistant\u2019s knowledge is being written'
          )
        }
        const markdown = requiredString(
          operationInput['markdown'],
          'markdown',
          ASSISTANT_AUTHORING_CHECKPOINT_LIMIT
        )
        result = await state.request.saveAssistantCheckpoint(markdown)
      } else if (operation === 'save_identity') {
        if (!state.request.saveAssistantIdentity) {
          throw new Error(
            'Renaming the assistant is only available while its knowledge is being written'
          )
        }
        // Only the name is settled here. How the assistant behaves is a section of
        // the knowledge, so it arrives with the knowledge block instead.
        result = await state.request.saveAssistantIdentity({
          name: requiredString(operationInput['name'], 'name', ASSISTANT_NAME_LIMIT)
        })
      } else {
        throw new Error(
          'The getting-started capability exposes save_checkpoint, save_identity, save_schedule and save_reporting'
        )
      }
    } else if (resolved.utility.id === ASSISTANT_REPORT_UTILITY_ID) {
      if (operation !== 'save_report') {
        throw new Error('The run report capability exposes save_report only')
      }
      const saveReport = state.request.saveAssistantReport
      if (!saveReport) {
        throw new Error('A report can only be declared on a turn that runs a saved assistant')
      }
      const title = requiredString(operationInput['title'], 'title', ASSISTANT_REPORT_TITLE_LIMIT)
      const body = operationInput['markdown']
      const markdown =
        body === undefined
          ? undefined
          : requiredString(body, 'markdown', ASSISTANT_REPORT_BODY_LIMIT)
      result = await saveReport(title, markdown)
    } else if (resolved.utility.id === APP_CITE_UTILITY_ID) {
      if (operation !== 'cite_report') {
        throw new Error('The cited-work capability exposes cite_report only')
      }
      const cite = state.request.citeWork
      if (!cite) throw new Error('Cited work can only be recorded on a live turn')
      const requested = operationInput['paths']
      if (!Array.isArray(requested) || requested.length === 0) {
        throw new Error('paths must list at least one workspace-relative path')
      }
      const paths = requested
        .slice(0, CITE_ENTRY_LIMIT)
        .map((path) => requiredString(path, 'paths', CITE_PATH_LIMIT))
      result = await cite(paths)
    } else if (resolved.utility.id === APP_BROWSER_UTILITY_ID) {
      const executor = this.host.browserExecutor
      if (!executor) throw new Error('The in-app browser is unavailable')
      result = await executor(operation, operationInput, {
        projectId: state.request.projectId,
        threadId: state.request.threadId,
        permissionLevel: state.request.permissionLevel,
        sessionId: state.request.sessionId
      })
    } else if (resolved.utility.id === APP_ARTIFACT_UTILITY_ID) {
      if (operation !== 'render' || !this.host.artifactExecutor)
        throw new Error('The artifact capability exposes render only')
      result = await this.host.artifactExecutor(operation, operationInput, {
        projectId: state.request.projectId,
        threadId: state.request.threadId
      })
    } else if (resolved.utility.id === APP_DESIGN_UTILITY_ID) {
      // One capability, operation groups with different owners: `preview`
      // serves the design folder, `checkpoint` saves a named step, `delegate` runs
      // the model the user assigned to text work, `generate` produces media with the model assigned to a media
      // craft, and `save-media` brings a generated asset in as a file.
      const executors = new Map<string, DesignCapabilityExecutor | null>([
        ['preview', this.host.designPreviewExecutor],
        ['checkpoint', this.host.designPreviewExecutor],
        ['groups', this.host.designPreviewExecutor],
        ['organize-designs', this.host.designPreviewExecutor],
        ['read-contract', this.host.designPreviewExecutor],
        ['write-contract', this.host.designPreviewExecutor],
        ['lint', this.host.designPreviewExecutor],
        ['critique', this.host.designPreviewExecutor],
        ['extract-reference', this.host.designPreviewExecutor],
        ...['motion-read', 'motion-preview', 'motion-apply', 'motion-inspect'].map(
          (name): [string, DesignCapabilityExecutor | null] => [
            name,
            this.host.designPreviewExecutor
          ]
        ),
        ['delegate', this.host.designAssignmentExecutor],
        ['generate', this.host.mediaGenerationExecutor],
        ['save-media', this.host.designMediaExecutor]
      ])
      const executor = executors.get(operation)
      if (!executor) {
        throw new Error(
          executors.has(operation)
            ? `The design capability's "${operation}" operation is unavailable`
            : `The design capability has no operation named "${operation}"`
        )
      }
      result = await executor(operation, operationInput, {
        projectId: state.request.projectId,
        threadId: state.request.threadId
      })
    } else if (resolved.utility.id === APP_VIDEO_UTILITY_ID) {
      // Preview serves the composition, checkpoint saves an edit step, generate
      // makes media, and capture renders and pictures one frame.
      const executors = new Map<string, VideoCapabilityExecutor | null>([
        ['preview', this.host.videoPreviewExecutor],
        ['critique', this.host.videoPreviewExecutor],
        ['checkpoint', this.host.videoPreviewExecutor],
        ['generate', this.host.mediaGenerationExecutor],
        ...[
          'probe',
          'filmstrip',
          'waveform',
          'listen',
          'transcribe',
          'cut',
          'export',
          'jobs',
          'studio',
          'runtime',
          'captions',
          'track',
          'analyze-motion',
          'remove-background'
        ].map((name): [string, VideoCapabilityExecutor | null] => [
          name,
          this.host.videoPreviewExecutor
        ]),
        ['capture', this.host.videoCaptureExecutor]
      ])
      const executor = executors.get(operation)
      if (!executor) {
        throw new Error(
          executors.has(operation)
            ? `The video capability's "${operation}" operation is unavailable`
            : `The video capability has no operation named "${operation}"`
        )
      }
      result = await executor(operation, operationInput, {
        projectId: state.request.projectId,
        threadId: state.request.threadId
      })
    } else if (resolved.utility.kind === 'mcp' || resolved.utility.kind === 'computer_use') {
      if (
        this.host.units['orchestration'].isComputerUseUtility(resolved) &&
        [
          'start_session',
          'end_session',
          'set_agent_cursor_enabled',
          'set_agent_cursor_motion'
        ].includes(operation)
      ) {
        throw new Error(
          'The app owns the computer-use session and cursor lifecycle. Invoke actions directly without starting, ending, or reconfiguring sessions.'
        )
      }
      const client = await this.host.units['mcp-lifecycle'].ensureMcpClient(state, resolved)
      const routedInput = this.host.units['orchestration'].routeComputerUseInput(
        state,
        utilityId,
        operationInput
      )
      if (this.host.units['orchestration'].isComputerUseUtility(resolved)) {
        result = await this.invokeComputerUse(
          state,
          resolved,
          client,
          utilityId,
          operation,
          routedInput
        )
      } else {
        try {
          result = await client.callTool(operation, routedInput)
        } catch (error) {
          await this.host.units['orchestration'].dropUnusableTransport(
            state,
            resolved,
            client,
            error
          )
          throw error
        }
      }
      if (this.host.units['orchestration'].isComputerUseUtility(resolved)) {
        this.host.cuaActivityListener?.({
          threadId: state.request.threadId,
          operation,
          pid: operationPid(routedInput),
          sessionId: state.cuaSessionIds.get(utilityId),
          cursor: await this.host.units['orchestration'].readAgentCursor(state, utilityId, client),
          permissionLevel: state.request.permissionLevel
        })
      }
    } else if (resolved.utility.kind === 'web_search' || resolved.utility.kind === 'web_fetch') {
      result = await this.invokeWeb(state, resolved.utility, operation, operationInput)
    } else if (resolved.utility.kind === 'image_descriptor') {
      if (operation !== 'describe') {
        throw new Error(`Image descriptor does not expose the operation "${operation}"`)
      }
      const executor = this.host.imageDescriptorExecutor
      if (!executor) {
        throw new Error('The image descriptor vision model is not configured')
      }
      result = {
        results: await executor({
          images: resolveImageEntries(operationInput),
          projectId: state.request.projectId,
          threadId: state.request.threadId,
          projectPath: state.request.projectPath,
          sessionId: state.request.sessionId,
          pinnedSelection:
            await this.host.units['gateway-endpoints'].pinnedImageDescriptorSelection()
        })
      }
    } else if (resolved.utility.kind === 'skill') {
      // A skill is documentation. Its whole contract arrived at activation, so
      // there is nothing to invoke; say so instead of reporting a kind mismatch.
      throw new Error(
        `\`${resolved.utility.id}\` is a skill: it exposes no tool. Its instructions arrived when it was activated, so re-list them with ${UTILITY_DOCS_TOOL_NAME} if they are gone, then do the work with your own tools.`
      )
    } else {
      throw new Error(`Utility kind "${resolved.utility.kind}" does not expose runtime operations`)
    }
    await this.host.units['orchestration'].audit(state, 'utility.invoked', {
      utilityId,
      operation,
      transport: 'gateway'
    })
    // A computer-use snapshot reaches the model as its structured payload plus
    // the screenshot as an image part. The payload is where the element handles
    // and the geometry live that the driver asks a later action to name, and the
    // tree in it is the same tree the driver's markdown repeats, so the markdown
    // is what would be paid for twice.
    if (this.host.units['orchestration'].isComputerUseUtility(resolved)) {
      const snapshot = shapeCuaResult(result)
      if (snapshot) return snapshot
    }
    // A picture that travels inline as base64 is billed as text, at roughly one
    // token per character; the same bytes delivered as an image content part are
    // billed on the pixels they cover, which measured about 22x cheaper on a real
    // screenshot (40,788 tokens against 1,844 at 1568px). The route exit shapes
    // the result into content parts plus a structured payload, so nothing is
    // converted here: a raw result stays raw, and the computer-use snapshot keeps
    // the shape it was given above.
    return result
  }

  /**
   * One computer-use operation, with the snapshot it addresses owned here.
   *
   * The driver refuses every element and pixel action whose snapshot has been
   * replaced, and a window's snapshot is replaced by the next snapshot of that
   * window from any client. The app is itself such a client: the computer-use
   * preview photographs the window being driven after every action, so
   * a reference the model read on one call is normally superseded by the time it
   * acts on the next one.
   *
   * The gateway therefore names the snapshot the model's address truly belongs
   * to, and when the driver answers that the reference is stale it takes one
   * fresh snapshot, re-anchors the same address onto it and tries once more.
   * Nothing is guessed: an element is re-anchored only when its identity is
   * provable, a pixel address only when both images state their size, and a
   * reference into a snapshot the app never handed out is answered with what to
   * do instead of with an action.
   */
  async invokeComputerUse(
    state: TurnState,
    resolved: ResolvedUtility,
    client: McpClient,
    utilityId: string,
    operation: string,
    input: Record<string, unknown>
  ): Promise<unknown> {
    const view = this.host.units['executors'].cuaViewFor(state, input)
    const grounding = groundCuaAction(operation, input, view)
    const grounded = grounding.kind === 'grounded' ? grounding.input : input
    const reference = cuaActionReference(operation, input)
    const window = this.host.units['executors'].cuaActionWindow(state, input)
    if (reference?.session === 'implicit') {
      // This tool cannot read a snapshot taken under the turn's session label,
      // so its pixels are re-read from a snapshot of the same window taken on
      // the connection's own session, and the model's coordinates are moved
      // into that image before the call. One attempt, then whatever the driver
      // answers is the answer.
      const release = window ? await acquireCuaSnapshotLease(window.pid, window.windowId) : null
      try {
        const fresh = await this.host.units['orchestration'].refreshComputerUseView(
          state,
          client,
          utilityId,
          input,
          'pixels',
          'implicit'
        )
        const mapped = fresh ? reanchorCuaAction(operation, grounded, view, fresh) : null
        const anchor = mapped && 'input' in mapped ? mapped.input : grounded
        return await this.host.units['orchestration'].callComputerUse(
          state,
          resolved,
          client,
          operation,
          anchor
        )
      } finally {
        release?.()
      }
    }
    const snapshotting = operation === 'get_window_state'
    const result = snapshotting
      ? await this.host.units['orchestration'].snapshotUnderLease(
          state,
          resolved,
          client,
          operation,
          grounded,
          window
        )
      : await this.host.units['orchestration'].callComputerUse(
          state,
          resolved,
          client,
          operation,
          grounded
        )
    const snapshot = cuaSnapshotView(result)
    if (snapshot) {
      // The snapshot the model asked for is the mapping its next element or
      // pixel address refers to. A snapshot the gateway takes on its own behalf
      // deliberately never lands here: the model's indices were read from a tree
      // this one may not match row for row.
      state.cuaViews.set(cuaViewKey(snapshot.pid, snapshot.windowId), snapshot)
      return result
    }
    if (!isSupersededSnapshotRefusal(result)) return result
    const refusal = cuaRefusal(result)
    if (grounding.kind === 'ungrounded' && grounding.reason === 'foreign-snapshot') {
      if (!reference) return result
      return refusalResult(foreignSnapshotAdvice(reference, view))
    }
    const refreshed = await this.host.units['orchestration'].reanchorComputerUse(
      state,
      resolved,
      client,
      utilityId,
      operation,
      grounded,
      view,
      window,
      reference?.pixels ? 'pixels' : 'elements',
      reference?.session ?? 'labelled'
    )
    if (!refreshed) return result
    if ('refusal' in refreshed) {
      Logger.dev('Cua action could not be re-anchored', {
        utilityId,
        operation,
        code: refusal?.code,
        reason: refreshed.refusal
      })
      return refusalResult(refreshed.refusal)
    }
    Logger.dev('Cua action re-anchored on a fresh snapshot', {
      utilityId,
      operation,
      code: refusal?.code,
      snapshotId: refreshed.snapshotId
    })
    return refreshed.result
  }

  async invokeWeb(
    state: TurnState,
    utility: UtilityDefinitionFor<'web_search'> | UtilityDefinitionFor<'web_fetch'>,
    operation: string,
    input: Record<string, unknown>
  ): Promise<unknown> {
    state.attributionSequence += 1
    const featureCallId = `${state.id}:${utility.id}:${operation}:${state.attributionSequence}`
    try {
      const environment = await this.host.units['orchestration'].credentialEnvironment(utility)
      const provider = utility.config.provider ?? 'custom'
      const text = await executeWebTool(utility.kind, provider, input, utility.config, environment)
      let budgeted = budgetToolResult({
        content: text,
        turnTokens: state.request.budgetContext.composedTurnTokens,
        contextWindow:
          state.request.budgetContext.selectedModelInputTokens +
          DEFAULT_PROMPT_BUDGET.outputReserveTokens +
          DEFAULT_PROMPT_BUDGET.toolHeadroomTokens
      })
      if (budgeted.truncated) {
        const sourceIndex = webSourceIndex(text)
        if (sourceIndex) {
          budgeted = budgetToolResult({
            content: `${sourceIndex}\n\n${text}`,
            turnTokens: state.request.budgetContext.composedTurnTokens,
            contextWindow:
              state.request.budgetContext.selectedModelInputTokens +
              DEFAULT_PROMPT_BUDGET.outputReserveTokens +
              DEFAULT_PROMPT_BUDGET.toolHeadroomTokens
          })
        }
      }
      state.request.attributeReinjectedResult({
        featureCallId,
        utilityId: utility.id,
        reinjectedTokens: budgeted.reinjectedTokens,
        truncatedTokens: budgeted.truncatedTokens,
        success: true,
        retryCause: null
      })
      return { content: [{ type: 'text', text: budgeted.content }] }
    } catch (error) {
      state.request.attributeReinjectedResult({
        featureCallId,
        utilityId: utility.id,
        reinjectedTokens: 0,
        truncatedTokens: 0,
        success: false,
        retryCause: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }
}
