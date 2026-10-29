import { readFile, stat } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { createHash } from 'crypto'
import { Logger } from '../../system/logger'
import { DEFAULT_HARNESS } from '../../../lib/harness-default'
import {
  validateBoundedString,
  validateEntityId,
  validateThreadSettings
} from '../../ipc/ipc-validation'
import type { HarnessDriver } from '../../drivers/driver.interface'
import type {
  EngineeringToolContext,
  ScopeToolExecutor
} from '../../utilities/utility-orchestration-service'
import type { EngineeringToolOperation } from '../../../lib/engineering-tools'
import type {
  AgentMessage,
  AgentPart,
  AgentToolCatalog,
  AgentToolDefinition,
  AgentToolHarness,
  AgentContextCapabilities,
  AgentCapabilityCatalog,
  AgentCapabilityEntry,
  FileChangeSource,
  Thread,
  UsageEventFeature
} from '../../../lib/types'
import { APPLICATION_AGENT_TOOLS } from '../../../lib/agent-tools'
import { UTILITY_SEARCH_TOOL_NAME } from '../../../lib/gateway-tools'
import { messageId as createMessageId } from '../../../lib/id'
import { detectUnavailableToolCall, searchNudgePromptForToolCall } from '../not-available-detector'
import type { SessionInfo } from './chat-engine-types'
import {
  TOOL_CATALOG_TTL_MS,
  dedupeCapabilities,
  mcpDetail,
  scopeAppliesToThread
} from './chat-engine-constants'
import {
  UNBOUNDED_MUTATING_TOOLS,
  changedPathsFromTool,
  fileChangeSource,
  normalizedToolName
} from './chat-engine-changes'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine utilities-tools: one concern, moved verbatim from the composition root. */
export class ChatEngineUtilitiesTools {
  constructor(private readonly host: ChatEngine) {}

  /**
   * Wire the app-owned scope and worktree capability that the utility gateway
   * exposes. The IPC layer owns the scope and worktree services, so it supplies
   * the executor the gateway calls.
   */
  setScopeToolService(executor: ScopeToolExecutor | null): void {
    this.host.state.utilityOrchestration.setScopeToolExecutor(executor)
  }

  /**
   * Return app tools and every registered harness's discoverable tool catalog.
   * Results are cached per discovery context for `TOOL_CATALOG_TTL_MS` so the
   * Tools tab opens instantly on repeat visits; `force` bypasses the cache so
   * the Refresh control still surfaces a freshly discovered catalog.
   */
  async listTools(
    projectId?: string,
    harnessId?: string,
    providerId?: string,
    modelId?: string,
    force = false
  ): Promise<AgentToolCatalog> {
    const context: AgentToolCatalog['context'] = {}

    if (projectId) {
      context.projectId = validateEntityId(projectId, 'Project ID')
    }
    if (harnessId) {
      context.harnessId = validateEntityId(harnessId, 'Harness ID')
    }
    if (providerId) {
      context.providerId = validateBoundedString(providerId, 'Provider ID', 1, 128)
    }
    if (modelId) {
      context.modelId = validateBoundedString(modelId, 'Model ID', 1, 256)
    }

    const cacheKey = [
      context.projectId ?? '',
      context.harnessId ?? '',
      context.providerId ?? '',
      context.modelId ?? ''
    ].join('\u0000')
    const cached = this.host.state.toolCatalogCache.get(cacheKey)
    if (!force && cached && Date.now() - cached.at < TOOL_CATALOG_TTL_MS) {
      return structuredClone(cached.catalog)
    }

    const catalog = await this.discoverToolCatalog(context, force)
    this.host.state.toolCatalogCache.set(cacheKey, { catalog, at: Date.now() })
    return structuredClone(catalog)
  }

  /** Run one full discovery pass for a tool-catalog context. */
  async discoverToolCatalog(
    context: AgentToolCatalog['context'],
    force: boolean
  ): Promise<AgentToolCatalog> {
    const applicationDefinitions = structuredClone(APPLICATION_AGENT_TOOLS)
    const applicationTools: AgentToolDefinition[] = [...this.host.drivers.keys()].flatMap(
      (harnessId) => applicationDefinitions.map((tool) => ({ ...tool, harnessId }))
    )
    const notices: string[] = []

    if (!context.projectId) {
      notices.push('Open a configured thread to inspect the live harness and model tool catalog.')
      return {
        context,
        tools: applicationTools,
        harnesses: [...this.host.drivers.values()].map((driver) => ({
          id: driver.id,
          name: driver.name,
          status: driver.listTools ? 'unavailable' : 'unsupported',
          toolCount: applicationTools.filter((tool) => tool.harnessId === driver.id).length,
          detail: driver.listTools
            ? 'Open a configured thread to inspect this harness.'
            : 'This harness does not expose model-visible tool schemas.'
        })),
        notices
      }
    }

    const projectId = context.projectId
    const projectPath = await this.host.units['turns'].resolveProjectPath(projectId)
    const discovered = await Promise.all(
      [...this.host.drivers.values()].map(async (driver) => {
        const applicationCount = applicationTools.filter(
          (tool) => tool.harnessId === driver.id
        ).length
        if (!driver.listTools) {
          return {
            harness: {
              id: driver.id,
              name: driver.name,
              status: 'unsupported',
              toolCount: applicationCount,
              detail: 'This harness does not expose model-visible tool schemas.'
            } satisfies AgentToolHarness,
            tools: []
          }
        }

        try {
          let resolvedProviderId = driver.id === context.harnessId ? context.providerId : undefined
          let resolvedModelId = driver.id === context.harnessId ? context.modelId : undefined
          if (!resolvedProviderId || !resolvedModelId) {
            const resolved = await this.host.units['turns'].resolveDriverDefaultModel(
              driver.id,
              projectPath,
              projectId,
              force
            )
            resolvedProviderId = resolved.providerId
            resolvedModelId = resolved.modelId
          }
          if (!resolvedProviderId || !resolvedModelId) {
            return {
              harness: {
                id: driver.id,
                name: driver.name,
                status: 'unavailable',
                toolCount: applicationCount,
                detail: 'No provider and model are available for discovery.'
              } satisfies AgentToolHarness,
              tools: []
            }
          }

          const harnessTools = await driver.listTools(
            projectPath,
            resolvedProviderId,
            resolvedModelId
          )
          return {
            harness: {
              id: driver.id,
              name: driver.name,
              status: 'available',
              toolCount: applicationCount + harnessTools.length,
              providerId: resolvedProviderId,
              modelId: resolvedModelId
            } satisfies AgentToolHarness,
            tools: harnessTools.map((tool) => ({
              ...tool,
              source: 'harness' as const,
              harnessId: driver.id,
              sentWhen:
                driver.id === context.harnessId
                  ? 'Current project, provider, and model'
                  : `${driver.name} default provider and model`
            }))
          }
        } catch (error) {
          return {
            harness: {
              id: driver.id,
              name: driver.name,
              status: 'unavailable',
              toolCount: applicationCount,
              detail:
                error instanceof Error ? error.message : `${driver.name} tool discovery failed.`
            } satisfies AgentToolHarness,
            tools: []
          }
        }
      })
    )

    return {
      context,
      tools: [...applicationTools, ...discovered.flatMap((entry) => entry.tools)],
      harnesses: discovered.map((entry) => entry.harness),
      notices
    }
  }

  /**
   * MCP servers and skills actually available to the thread's active harness.
   *
   * `harnessId` overrides the thread's persisted harness. Temporary side chats
   * own no Thread row and pick their harness in the composer before their first
   * turn, so their view supplies the parent thread for project scope and utility
   * scoping together with the side chat's own harness.
   */
  async listContextCapabilities(
    projectId: string,
    threadId: string,
    harnessId?: string
  ): Promise<AgentContextCapabilities> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    const harnessOverride =
      harnessId === undefined ? undefined : validateBoundedString(harnessId, 'Harness ID', 1, 64)
    // A thread created optimistically may still be finalizing its DB row; wait
    // for persistence before querying it, mirroring ensureSession/sendMessage.
    await this.host.threadCreation?.awaitReady(threadId)
    if (this.host.threadCreation?.didFinalizationFail(threadId)) {
      throw new Error(`Thread not found: ${threadId} (its creation did not complete)`)
    }
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (!thread) throw new Error(`Thread not found: ${threadId}`)
    const resolvedHarnessId = harnessOverride ?? thread.settings?.harnessId ?? DEFAULT_HARNESS
    const driver = this.host.drivers.get(resolvedHarnessId)
    const harnessName = driver?.name ?? resolvedHarnessId
    const projectPath = await this.host.units['turns'].resolveProjectPath(projectId)

    const [native, utilities] = await Promise.all([
      this.host.state.capabilityDiscovery.discover(projectPath, resolvedHarnessId),
      this.host.state.utilityRegistry.list()
    ])

    const mcp: AgentCapabilityEntry[] = [...native.mcp]
    const skill: AgentCapabilityEntry[] = [...native.skill]
    for (const utility of utilities) {
      if (!scopeAppliesToThread(utility.scope, projectId, threadId)) continue
      if (utility.kind === 'mcp' || utility.kind === 'skill') {
        const entry: AgentCapabilityEntry = {
          id: `application:${utility.kind}:${utility.id}`,
          name: utility.name,
          kind: utility.kind,
          origin: 'application',
          enabled: utility.enabled,
          description: utility.description || undefined,
          detail: utility.kind === 'mcp' ? mcpDetail(utility) : undefined,
          source: { kind: 'registry', utilityId: utility.id }
        }
        ;(utility.kind === 'mcp' ? mcp : skill).push(entry)
      }
    }

    return {
      harnessId: resolvedHarnessId,
      harnessName,
      mcp: dedupeCapabilities(mcp),
      skill: dedupeCapabilities(skill)
    }
  }

  /**
   * Settings-level catalog of every MCP server and skill the app can see across
   * all harnesses, the shared global layer, and registered local projects.
   */
  async listAllCapabilities(): Promise<AgentCapabilityCatalog> {
    const projects = (await this.host.state.projectManager.listProjects()).filter(
      (project) => project.source !== 'ssh'
    )
    const references = projects.map((project) => ({ id: project.id, path: project.path }))
    const [catalog, piMcp] = await Promise.all([
      this.host.state.capabilityDiscovery.discoverAll(references),
      this.discoverPiMcpCapabilities(references)
    ])
    return { mcp: [...catalog.mcp, ...piMcp], skill: catalog.skill }
  }

  /**
   * Pi's own mcp.json servers, one file per agent directory. The legacy
   * account keeps Pi's harness default; every managed account reads its own
   * container through `PI_CODING_AGENT_DIR`. They are listed so the Utilities
   * page can edit them in place, and are deliberately never re-registered in
   * the app's own MCP bridge: Pi loads them itself, so the user's one
   * configuration keeps working with or without CodeInOven.
   */
  async discoverPiMcpCapabilities(
    projects: Array<{ id: string; path: string }>
  ): Promise<AgentCapabilityEntry[]> {
    const directories = [join(homedir(), '.pi', 'agent')]
    try {
      for (const account of await this.host.state.accountRegistry.list('pi')) {
        const root = this.host.state.accountRegistry
          .environment(account)
          ['PI_CODING_AGENT_DIR']?.trim()
        if (root) directories.push(root)
      }
    } catch {
      // A failed account listing must not blank the catalog: the harness
      // default directory still lists the account every user has.
    }
    return this.host.state.capabilityDiscovery.discoverPiMcp(directories, projects)
  }

  /** Capability names one utility turn is told the harness already supplies. */
  async nativeCapabilitiesFor(driver: HarnessDriver, projectPath: string): Promise<string[]> {
    const capabilities = Object.entries(driver.capabilities ?? {})
      .filter(([, supported]) => supported === true)
      .map(([name]) => name)
    capabilities.push(
      ...(await this.host.units['utilities'].nativeUtilitiesOf(driver, projectPath))
    )
    return capabilities
  }

  /** Whether the session's active turn has a tool call that has not ended yet
   *  (tracked via the same lifecycle the streaming event feed already stamps). */
  hasInFlightTool(sessionId: string): boolean {
    const times = this.host.state.toolTimes.get(sessionId)
    if (times) {
      for (const entry of times.values()) {
        if (entry.end === undefined) return true
      }
    }
    // Sub-agent delegation (OpenCode's "task" tool and similar) runs tool
    // calls under a child session, not the thread's own session   a steer's
    // in-flight check must follow those down or it never sees them as busy.
    for (const [childSessionId, owner] of this.host.state.childSessionOwners) {
      if (owner.parentSessionId !== sessionId) continue
      const childTimes = this.host.state.toolTimes.get(childSessionId)
      if (!childTimes) continue
      for (const entry of childTimes.values()) {
        if (entry.end === undefined) return true
      }
    }
    return false
  }

  async runEngineeringTool(
    operation: EngineeringToolOperation,
    input: Record<string, unknown>,
    context: EngineeringToolContext
  ): Promise<unknown> {
    const { projectId, threadId } = context
    const rawInstructions = input['instructions']
    const instructions = typeof rawInstructions === 'string' ? rawInstructions.trim() : ''
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (!thread?.settings) {
      throw new Error('Select a model for this thread before creating an artifact.')
    }
    const settings = validateThreadSettings(thread.settings)

    switch (operation) {
      case 'brainstorm': {
        this.host.state.brainstormEngine.ensureWorkflow(projectId, threadId)
        const document = await this.host.units['brainstorm'].createBrainstormSessionReport(
          projectId,
          threadId,
          instructions
        )
        return {
          artifact: 'brainstorm',
          id: document.id,
          version: document.version,
          message: `The Brainstorm draft v${document.version} is ready for review.`
        }
      }
      case 'prd': {
        const active = this.host.state.prdEngine.getActive(projectId, threadId)
        if (active) {
          return {
            artifact: 'prd',
            id: active.id,
            version: active.version,
            message: `The active PRD v${active.version} already exists.`
          }
        }
        let workflow = this.host.state.prdEngine.ensureWorkflow(projectId, threadId)
        if (workflow.stage === 'choice_pending') {
          workflow = this.host.state.prdEngine.chooseEntry(projectId, threadId, 'start_prd')
        }
        if (workflow.stage === 'brainstorming') {
          throw new Error(
            'Finalize the Brainstorm before creating the PRD, or choose to start the PRD without it.'
          )
        }
        if (workflow.stage !== 'drafting') {
          throw new Error('The PRD workflow is not ready for a new draft.')
        }
        const document = await this.host.generatePrd(
          projectId,
          threadId,
          settings,
          instructions ||
            'Create the product requirements document from the conversation in this thread.',
          [],
          createMessageId()
        )
        this.host.broadcast({
          type: 'prd.ready',
          sessionId: context.sessionId,
          projectId,
          threadId,
          prdId: document.id,
          version: document.version
        })
        return {
          artifact: 'prd',
          id: document.id,
          version: document.version,
          message: `The PRD draft v${document.version} is ready for review.`
        }
      }
      case 'spec': {
        const active = await this.host.units['spec'].getActiveSpec(projectId, threadId)
        if (active) {
          return {
            artifact: 'spec',
            id: active.id,
            version: active.version,
            message: `The active specification v${active.version} already exists.`
          }
        }
        if (!this.host.units['turns'].engineeringLifecycleActive(projectId, threadId)) {
          this.host.state.engineeringLifecycleEngine.select(projectId, threadId, {
            stages: ['spec'],
            autopilot: false
          })
          this.host.state.engineeringLifecycleEngine.start(projectId, threadId, 'spec')
        }
        const spec = await this.host.ensureInitialSpec(projectId, threadId)
        return {
          artifact: 'spec',
          id: spec.id,
          version: spec.version,
          message: `The specification draft v${spec.version} is ready for review.`
        }
      }
      case 'assignment': {
        const active = this.host.state.assignmentEngine.getActive(projectId, threadId)
        if (active && active.status !== 'draft') {
          return {
            artifact: 'assignment',
            id: active.id,
            version: active.version,
            message: `This thread already has an Assignment with status ${active.status}.`
          }
        }
        // Assignment generation is gated on the mode flag, which a plain thread
        // does not carry. The gate stops an ordinary turn from silently raising a
        // board; this call is the agent acting on the user's request, so the flag
        // is supplied for this dispatch only and never persisted.
        const assignment = await this.host.generateAssignmentDraft(
          projectId,
          threadId,
          { ...settings, assignmentMode: true },
          instructions || undefined
        )
        this.host.broadcast({
          type: 'assignment.ready',
          sessionId: context.sessionId,
          projectId,
          threadId,
          assignmentId: assignment.id,
          version: assignment.version
        })
        return {
          artifact: 'assignment',
          id: assignment.id,
          version: assignment.version,
          message: `The Assignment draft v${assignment.version} is ready for review and sign-off.`
        }
      }
    }
  }

  /**
   * Steer the active turn immediately after a native capability tool reports
   * that its MCP/skill/utility is unavailable. This is deliberately attached
   * to the tool error event: a direct app-utility activation is allowed to
   * proceed, while a native-harness miss gets one chance to discover the same
   * capability through the app utility-search tool (UTILITY_SEARCH_TOOL_NAME)
   * before the agent gives up.
   */
  async nudgeUnavailableToolCall(
    driverId: string,
    sessionId: string,
    part: Extract<AgentPart, { type: 'tool' }>
  ): Promise<void> {
    const info = this.host.sessionRegistry.get(sessionId)
    if (!info || info.ephemeral || !info.activeTurnId) return
    if ((this.host.state.searchNudgeAttempts.get(sessionId) ?? 0) >= 1) return
    const toolName = part.tool.trim()
    if (!toolName || toolName.toLocaleLowerCase().includes(UTILITY_SEARCH_TOOL_NAME)) return
    const toolError = [part.state.error, part.state.output, part.state.title]
      .filter((value): value is string => Boolean(value?.trim()))
      .join('\n')
    const claim = detectUnavailableToolCall(toolName, toolError)
    if (!claim) return

    const utilityTurn = this.host.state.utilityTurns.get(sessionId)
    if (
      !utilityTurn ||
      (!utilityTurn.gateway.instructions.trim() && !utilityTurn.gateway.directInstructions.trim())
    ) {
      return
    }
    if (
      this.host.state.utilityOrchestration.hasSearched(utilityTurn.gateway.id) ||
      this.host.state.utilityOrchestration.hasActivatedOnDemand(utilityTurn.gateway.id)
    ) {
      return
    }
    const thread = await this.host.threadManager.getThread(info.projectId, info.threadId)
    const driver = this.host.units['turns-dispatch'].driverForRuntime(driverId, info.accountId)
    if (!thread?.settings || !driver?.steerPrompt) return

    this.host.state.searchNudgeAttempts.set(sessionId, 1)
    await this.host.sendPrompt(
      info.projectId,
      info.threadId,
      thread.settings,
      searchNudgePromptForToolCall(claim, toolName, toolError),
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'internal'
    )
  }

  recordToolUsageEvents(threadId: string, parentTurnId: string, message: AgentMessage): void {
    for (const part of message.parts) {
      if (part.type !== 'tool') continue
      const normalizedTool = part.tool.toLowerCase()
      const feature: UsageEventFeature | null = normalizedTool.includes('computer')
        ? 'computer_use'
        : normalizedTool.includes('web') || normalizedTool.includes('fetch')
          ? 'web'
          : normalizedTool.includes('image_descriptor')
            ? 'image_descriptor'
            : null
      if (!feature) continue
      const failure =
        part.state.status === 'error' ? (part.state.error ?? 'Tool call failed') : null
      this.host.state.usageRepo.recordEvent({
        id: `tool:${parentTurnId}:${part.callID}`,
        threadId,
        parentTurnId,
        featureCallId: part.callID,
        attempt: 1,
        feature,
        harnessId: message.harnessId ?? null,
        accountId: message.accountId ?? null,
        providerId: message.providerId ?? null,
        modelId: message.modelId ?? null,
        thinkingLevel: message.thinkingLevel ?? null,
        utilityId: part.tool,
        rawProviderUsage: {},
        tokens: {
          uncachedInput: null,
          cachedInput: null,
          cacheWrite: null,
          output: null,
          reasoning: null
        },
        rawTotal: null,
        totalSemantics: 'unavailable',
        toolFeeUsd: null,
        success: part.state.status === 'completed',
        retryCause: failure,
        durationMs:
          part.state.time?.start !== undefined && part.state.time.end !== undefined
            ? Math.max(0, Math.floor(part.state.time.end - part.state.time.start))
            : 0,
        createdAt: part.state.time?.end ?? part.state.time?.start ?? message.createdAt,
        costStatus: 'unavailable',
        costUsd: null,
        pricingProvenance: null
      })
    }
  }

  /** Apply in-memory tool time stamps to loaded messages (populated during streaming). */
  applyToolStamps(sessionId: string, messages: AgentMessage[]): void {
    const sessionToolTimes = this.host.state.toolTimes.get(sessionId)
    if (!sessionToolTimes) return
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue
      let changed = false
      for (const part of msg.parts) {
        if (part.type === 'tool') {
          const stamp = sessionToolTimes.get(part.id)
          if (stamp && (!part.state.time?.start || !part.state.time?.end)) {
            part.state.time = { start: stamp.start, end: stamp.end }
            changed = true
          }
        }
      }
      if (changed) msg.parts = [...msg.parts]
    }
  }

  /**
   * Every tool can hide writes. Bracket in-flight tools with asynchronous
   * stat fingerprints, then verify candidate paths against captured content.
   * Final completion reconciles the full diff against user and foreign work.
   */
  trackUnboundedToolWindow(session: SessionInfo, part: Extract<AgentPart, { type: 'tool' }>): void {
    const toolPartId = part.id
    const status = part.state.status
    const openTools = (session.openUnboundedTools ??= new Set())
    if (status === 'pending' || status === 'running') {
      if (openTools.has(toolPartId)) return
      // Keep at most one scan in flight per session. Completion's content
      // snapshot catches tools that finish while the previous scan is pending.
      if ((session.pendingWindowScans?.size ?? 0) > 0) return
      if (openTools.size === 0) {
        session.unboundedWindowStart = this.host.checkpointManager
          .fingerprint(session.projectId, session.projectPath)
          .catch((error) => {
            Logger.error('turn change window scan failed:', error)
            return null
          })
      }
      openTools.add(toolPartId)
      session.unboundedWindowToolIds ??= new Set()
      session.unboundedWindowToolIds.add(toolPartId)
      return
    }
    if (!openTools.delete(toolPartId)) return
    if (openTools.size > 0) return
    this.closeUnboundedToolWindow(session)
  }

  closeUnboundedToolWindow(session: SessionInfo): void {
    const start = session.unboundedWindowStart
    const toolIds = session.unboundedWindowToolIds ?? new Set<string>()
    session.unboundedWindowToolIds = undefined
    session.unboundedWindowStart = undefined
    session.openUnboundedTools?.clear()
    if (!start) return
    const turnId = session.activeTurnId
    // Snapshot any open user-terminal windows for this project: paths that
    // moved while the user was typing commands in an in-app terminal are the
    // user's edits, not this turn's bash work. Only windows rooted in the
    // turn's own worktree apply.
    const userWindows = this.host.units['processes'].matchingUserTerminalWindows(session)
    const userBefore = userWindows.map((entry) => ({
      fingerprint: entry.fingerprint,
      projectRoot: entry.projectRoot
    }))
    const pendingScans = (session.pendingWindowScans ??= new Set())
    const scan = (async (): Promise<void> => {
      try {
        const before = await start
        if (!before || session.activeTurnId !== turnId) return
        const after = await this.host.checkpointManager.fingerprint(
          session.projectId,
          session.projectPath
        )
        if (session.activeTurnId !== turnId) return
        // A turn whose project root changed mid-window (scope switch, worktree
        // move) has no comparable baseline: drop the window instead of letting
        // the cross-root comparison throw and kill the whole scan.
        if (before.projectRoot !== after.projectRoot) {
          Logger.dev('turn change window skipped: project root changed mid-window')
          return
        }
        let userMoved: Set<string> | undefined
        for (const entry of userBefore) {
          const [userStart, windowRoot] = await Promise.all([entry.fingerprint, entry.projectRoot])
          // A window whose baseline failed, or whose terminal worktree differs
          // from the turn's root, does not apply here: those edits stay
          // unattributed rather than being claimed by either side.
          if (!userStart || !windowRoot || windowRoot !== after.projectRoot) continue
          userMoved ??= new Set()
          for (const path of this.host.checkpointManager.diffFingerprints(
            session.projectId,
            userStart,
            after
          )) {
            userMoved.add(path)
          }
        }
        session.changedPaths ??= new Set()
        const moved = new Set(
          this.host.checkpointManager.diffFingerprints(session.projectId, before, after)
        )
        for (const [path, sources] of session.changeSources ?? []) {
          if (moved.has(path) && !userMoved?.has(path)) continue
          const kept = sources.filter((source) => !toolIds.has(source.toolPartId))
          for (const source of sources) {
            if (!toolIds.has(source.toolPartId)) continue
            session.rejectedChangeSources ??= new Map()
            const rejected = session.rejectedChangeSources.get(path) ?? new Set<string>()
            rejected.add(source.toolPartId)
            session.rejectedChangeSources.set(path, rejected)
          }
          if (kept.length) session.changeSources?.set(path, kept)
          else {
            session.changeSources?.delete(path)
            session.changedPaths.delete(path)
          }
        }
        for (const path of moved) {
          if (userMoved?.has(path)) continue
          if (session.userTouchedPaths?.has(path)) continue
          // Tool provenance enriches the card when available. A measured file
          // change survives even when the tool's write syntax is opaque.
          const sources = session.changeSources?.get(path) ?? []
          session.changeSources?.set(
            path,
            sources.map((source) =>
              toolIds.has(source.toolPartId)
                ? {
                    ...source,
                    verification: 'shell-window-and-content',
                    window: { startedAt: before.capturedAt, endedAt: after.capturedAt }
                  }
                : source
            )
          )
          session.changedPaths.add(path)
        }
      } catch (error) {
        Logger.error('turn change window scan failed:', error)
      }
    })()
    // Completion must wait for content verification too, before clearing the
    // session's live paths. Track the entire chain, not just the stat scan.
    const verified = scan.then(() =>
      this.scanLivePathsAfterTool(session).catch((error) =>
        Logger.dev('live scan after window failed:', error)
      )
    )
    pendingScans.add(verified)
    void verified.finally(() => pendingScans.delete(verified))
  }

  /** Record bounded provenance from terminal tool calls; the checkpoint validates content. */
  recordToolChangeSources(
    session: SessionInfo,
    part: Extract<AgentPart, { type: 'tool' }>
  ): string[] {
    const source = fileChangeSource(part)
    if (!source) return []
    const paths = changedPathsFromTool(session.projectPath, part)
    session.changeSources ??= new Map()
    session.changedPaths ??= new Set()
    for (const path of paths) {
      if (session.userTouchedPaths?.has(path)) continue
      if (session.rejectedChangeSources?.get(path)?.has(source.toolPartId)) continue
      const sources = session.changeSources.get(path) ?? []
      if (!sources.some((entry) => entry.toolPartId === source.toolPartId)) {
        // Bound retained evidence per file. Every entry still links to its full transcript call.
        session.changeSources.set(path, [...sources.slice(-3), source])
      }
      session.changedPaths.add(path)
    }
    return paths
  }

  /**
   * Re-assert the mutating-tool evidence a settled turn's own transcript
   * proves. Live part events are the normal source, but they can be missed: a
   * driver that mirrors parts only once the turn settles, a mid-turn session
   * re-registration, or a dropped event. Completion reads that evidence to
   * decide which workspace changes belong to the turn, and an empty set means
   * "this turn claimed nothing", which records no diff at all and silently
   * deletes real edits from the card. This only ever widens what completion
   * considers the turn's own, and every path must still appear in the workspace
   * diff, so no change is invented.
   */
  reassertTurnToolEvidence(session: SessionInfo, messages: readonly AgentMessage[]): void {
    const anchor = session.activeTurnUserMessageId
      ? messages.findLastIndex((message) => message.id === session.activeTurnUserMessageId)
      : -1
    for (const message of anchor >= 0 ? messages.slice(anchor + 1) : messages) {
      if (message.role !== 'assistant') continue
      for (const part of message.parts) {
        if (part.type !== 'tool') continue
        if (UNBOUNDED_MUTATING_TOOLS.has(normalizedToolName(part.tool))) {
          session.unboundedToolObserved = true
        }
        const paths = this.recordToolChangeSources(session, part)
        if (paths.length === 0) continue
        session.changedPaths ??= new Set()
        session.preciseChangedPaths ??= new Map()
        const claimedAt = Date.now()
        for (const path of paths) {
          // A path the user saved through the in-app editor during this turn is
          // the user's edit, exactly as in the live part handler.
          if (session.userTouchedPaths?.has(path)) continue
          session.changedPaths.add(path)
          if (!UNBOUNDED_MUTATING_TOOLS.has(normalizedToolName(part.tool))) {
            session.preciseChangedPaths.set(path, claimedAt)
          }
        }
      }
    }
  }

  /**
   * Fold write evidence the durable mirror proves into the turn's own claims.
   *
   * A driver that publishes only settled messages, or a session whose in-memory
   * transcript was re-registered, can hand completion an empty source map while
   * the mirror still holds the turn's tool calls. Those paths count as this
   * turn's evidence, never as a change: completion still intersects them with
   * the real snapshot diff, and another turn's precise claim still wins.
   */
  absorbTranscriptEvidence(
    session: SessionInfo,
    evidence: ReadonlyMap<string, FileChangeSource[]>
  ): void {
    if (evidence.size === 0) return
    session.changeSources ??= new Map()
    session.changedPaths ??= new Set()
    for (const [path, sources] of evidence) {
      // A path the user saved through the in-app editor is the user's edit.
      if (session.userTouchedPaths?.has(path)) continue
      const existing = session.changeSources.get(path) ?? []
      const merged = [...existing]
      for (const source of sources) {
        if (merged.some((entry) => entry.toolPartId === source.toolPartId)) continue
        if (session.rejectedChangeSources?.get(path)?.has(source.toolPartId)) continue
        merged.push(source)
      }
      if (merged.length === 0) continue
      session.changeSources.set(path, merged.slice(-4))
      session.changedPaths.add(path)
    }
  }

  /**
   * Scanner hook: at the end of each file-related tool call or bash window,
   * prune claimed paths that didn't actually change vs the turn's before
   * snapshot. Runs batched and fires a live update so the Changes tab can
   * surface the next file immediately instead of waiting for the 2.5s poll.
   */
  async scanLivePathsAfterTool(session: SessionInfo): Promise<void> {
    if (!session.activeTurnId || !session.changedPaths || session.changedPaths.size === 0) return
    const checkpoint = await this.host.checkpointManager.getActive(
      session.projectId,
      session.threadId
    )
    if (!checkpoint) return
    // The user's own in-app editor saves are never the thread's changes.
    if (session.userTouchedPaths) {
      for (const path of session.userTouchedPaths) {
        session.changedPaths.delete(path)
        session.preciseChangedPaths?.delete(path)
      }
      if (session.changedPaths.size === 0) return
    }
    const toCheck = [...session.changedPaths]
    const BATCH = 8
    const keep = new Set<string>()
    for (let i = 0; i < toCheck.length; i += BATCH) {
      const batch = toCheck.slice(i, i + BATCH)
      const results = await Promise.all(
        batch.map(async (path) => {
          const before = checkpoint.before.files[path]
          const abs = join(checkpoint.before.projectRoot, path)
          try {
            const buf = await readFile(abs)
            if (!before) return path // created
            const hash = createHash('sha256').update(buf).digest('hex')
            return hash !== before.hash ? path : null
          } catch (error) {
            if (
              error instanceof Error &&
              'code' in error &&
              (error as NodeJS.ErrnoException).code === 'ENOENT'
            ) {
              return before ? path : null // deleted vs never existed
            }
            return null
          }
        })
      )
      for (const p of results) if (p) keep.add(p)
    }
    // Prune stale claims (touched but not actually changed)
    for (const p of [...session.changedPaths]) if (!keep.has(p)) session.changedPaths.delete(p)
    for (const p of [...(session.preciseChangedPaths?.keys() ?? [])])
      if (!keep.has(p)) session.preciseChangedPaths?.delete(p)
    // Notify renderers that the live file list changed
    this.host.broadcast({
      type: 'checkpoint.liveUpdated',
      sessionId: session.sessionId,
      projectId: session.projectId,
      threadId: session.threadId
    })
  }
}
