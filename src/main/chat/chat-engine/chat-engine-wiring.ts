import { BrowserWindow } from 'electron'
import { Logger } from '../../system/logger'
import { BrainstormAlignmentNotes } from '../brainstorm-alignment-notes'
import { AssistantAuthoringCheckpoints } from '../assistant-authoring-checkpoints'
import { ThreadCreationCoordinator } from '../thread-creation-coordinator'
import { sendToRenderer } from '../../ipc/renderer-delivery'
import { ProjectFilesService } from '../../editor/project-files-service'
import { ProjectManager } from '../../../lib/engines/project-manager'
import { ThreadManager } from '../../../lib/engines/thread-manager'
import { SpecEngine } from '../../../lib/engines/spec-engine'
import { AuditEngine } from '../../../lib/engines/audit-engine'
import { AssignmentEngine } from '../../../lib/engines/assignment-engine'
import { PrdEngine } from '../../../lib/engines/prd-engine'
import { EngineeringLifecycleEngine } from '../../../lib/engines/engineering-lifecycle-engine'
import {
  createOpenCodeHarnessDriver,
  isOpenCodeV2Installed
} from '../../drivers/opencode-harness-driver'
import { ClaudeCodeDriver } from '../../drivers/claude-code-driver'
import { CodexDriver } from '../../drivers/codex-driver'
import { ClineDriver } from '../../drivers/cline-driver'
import { AntigravityDriver } from '../../drivers/antigravity-driver'
import { MuseDriver } from '../../drivers/muse-driver'
import { PiDriver } from '../../drivers/pi-driver'
import { OvenChat } from '../../ovens/oven-chat'
import { CheckpointManager } from '../../storage/checkpoint-manager'
import { listHarnesses } from '../../agents/harness-registry'
import { broadcastThreadDeleted, broadcastThreadUpdate } from '../thread-events'
import { MemoryService } from '../memory-service'
import { PromptAssembler } from '../prompt-assembler'
import type { HarnessDriver } from '../../drivers/driver.interface'
import type { Database } from '../../database/database'
import { HarnessUsageRepo } from '../../database/repositories/harness-usage-repo'
import { ModelRankingRepo } from '../../database/repositories/model-ranking-repo'
import { AssistantRepo } from '../../database/repositories/assistant-repo'
import { ModelRankingSnapshotRepo } from '../../database/repositories/model-ranking-snapshot-repo'
import type { StorageEngine } from '../../storage/storage-engine'
import { WorkflowOwnershipService } from '../../system/workflow-ownership-service'
import { SecretVault } from '../../storage/secret-vault'
import { UtilityRuntimeService } from '../../utilities/utility-runtime-service'
import { UtilityRegistryService } from '../../utilities/utility-registry-service'
import { AgentSecretService } from '../../utilities/agent-secret-service'
import { createAppControlExecutor } from '../../app-control/app-control-executor'
import { CapabilityDiscoveryService } from '../../agents/capability-discovery-service'
import { McpConnectionTestService } from '../../utilities/mcp-connection-test-service'
import { McpOAuthService } from '../../utilities/mcp-oauth/mcp-oauth-service'
import { BaseUrlProviderService } from '../../providers/base-url-provider-service'
import { HarnessAccountRegistry } from '../../providers/harness-account-registry'
import { UtilityOrchestrationService } from '../../utilities/utility-orchestration-service'
import { createDesignAssignmentExecutor } from '../../design/design-assignment-executor'
import { ModelPricingService } from '../../providers/model-pricing-service'
import { BrainstormEngine } from '../../../lib/engines/brainstorm-engine'
import { inlineArtifactMessage } from '../inline-artifact-service'
import { GeneratedArtifactService } from '../generated-artifact-service'
import { validateEngineeringSpec } from '../../../lib/spec/spec-validation'
import { coordinatorHandoffQueuePath } from './chat-engine-pure'

import type { ChatEngine } from '../chat-engine'

/** The one-time assembly a ChatEngine performs when it is constructed. */
export function wireChatEngine(
  engine: ChatEngine,
  storage: StorageEngine,
  database: Database,
  computerUsePip?: import('../../utilities/computer-use-pip-service').ComputerUsePipService,
  harnessManifest?: import('../../agents/harness-manifest-service').HarnessManifestService,
  threadCreation?: ThreadCreationCoordinator,
  processJournalPath?: string
): void {
  {
    engine.modelPricing ??= new ModelPricingService(storage)
    engine.state.agentProcesses.attachJournal(processJournalPath)
    engine.threadCreation = threadCreation ?? new ThreadCreationCoordinator()
    engine.state.usageRepo = new HarnessUsageRepo(database)
    engine.rankingRepo = new ModelRankingRepo(database)
    engine.rankingSnapshotRepo = new ModelRankingSnapshotRepo(database)
    engine.state.assistantRepo = new AssistantRepo(database)
    engine.state.projectManager = new ProjectManager(database)
    // Tagged composer references are resolved against the sending thread's
    // scope root, so this service needs the same scope authority every other
    // file surface uses. Without it, a thread that carries a scope bucket
    // (the Default scope included) fails closed before a turn can start.
    engine.state.projectFilesService = new ProjectFilesService(
      engine.state.projectManager,
      engine.scopeRoots
    )
    engine.checkpointManager = new CheckpointManager(database)
    engine.state.workflowOwnership = new WorkflowOwnershipService(database)
    engine.threadManager = new ThreadManager(
      database,
      broadcastThreadUpdate,
      async (thread) => {
        engine.state.chatAttachmentAllowlists.delete(thread.id)
        await engine.deleteThreadSession(thread.projectId, thread.id)
        await engine.state.memoryService.deleteThreadMemory(thread.projectId, thread.id)
        await engine.storage.remove(coordinatorHandoffQueuePath(thread.projectId, thread.id))
      },
      async (threads) => {
        for (const thread of threads) broadcastThreadDeleted(thread)
        for (const threadId of threads.map((thread) => thread.id)) {
          engine.state.cioUtilityThreads.delete(threadId)
        }
        for (const projectId of new Set(threads.map((thread) => thread.projectId))) {
          await engine.checkpointManager.pruneUnusedBlobs(projectId)
        }
      },
      engine.scopeRoots
    )
    engine.threadManager.onThreadsDeletedForRanking = (_projectId, threadIds) => {
      void _projectId
      engine.rankingSnapshotRepo.closeForThreads(threadIds, Date.now())
      engine.scheduleRankingDrain()
    }
    engine.state.memoryService = new MemoryService(storage)
    engine.state.generatedArtifactService = new GeneratedArtifactService(storage)
    engine.state.promptAssembler = new PromptAssembler(engine.state.memoryService)
    engine.state.secretVault = new SecretVault(storage)
    engine.state.utilityRuntime = new UtilityRuntimeService(storage)
    engine.state.utilityRegistry = new UtilityRegistryService(storage)
    engine.state.agentSecrets = new AgentSecretService(
      engine.state.secretVault,
      engine.state.utilityRegistry,
      storage
    )
    engine.state.capabilityDiscovery = new CapabilityDiscoveryService()
    engine.state.mcpOAuthService = new McpOAuthService({
      registry: engine.state.utilityRegistry,
      vault: engine.state.secretVault,
      // Any window showing the Utilities page follows the same flow, so a second
      // one never reports a grant the first one already moved past.
      broadcast: (payload) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (window.isDestroyed()) continue
          sendToRenderer(window.webContents, 'utilities:mcpOAuthEvent', payload)
        }
      }
    })
    engine.state.mcpConnectionTest = new McpConnectionTestService({
      registry: engine.state.utilityRegistry,
      resolveSecret: (secretRef) => engine.state.secretVault.resolve(secretRef),
      readNativeMcp: (source) => engine.state.capabilityDiscovery.readMcp(source),
      oauth: engine.state.mcpOAuthService
    })
    engine.state.baseUrlProviders = new BaseUrlProviderService(storage)
    engine.state.accountRegistry = new HarnessAccountRegistry(storage)
    engine.state.ovenChat = new OvenChat(
      storage,
      engine.state.secretVault,
      engine.threadManager,
      engine.state.accountRegistry,
      engine.state.projectManager,
      (event) => {
        if (event.type === 'session.status')
          engine.sessionStatuses.set(event.sessionId, event.status)
        if (event.type === 'session.idle')
          engine.sessionStatuses.set(event.sessionId, { state: 'idle' })
        if (event.type === 'message.part.updated' || event.type === 'message.part.delta') {
          const owner = engine.sessionRegistry.get(event.sessionId)
          if (owner)
            void engine
              .persistTurnStreamEvent(owner, event)
              .catch((error: unknown) => Logger.dev('Oven working trace write failed', error))
        }
        engine.broadcast(event)
      }
    )
    engine.state.utilityOrchestration = new UtilityOrchestrationService(
      storage,
      database,
      undefined,
      engine.state.mcpOAuthService
    )
    engine.state.utilityOrchestration.setArtifactExecutor(async (_operation, input, context) => {
      const thread = await engine.threadManager.getThread(context.projectId, context.threadId)
      if (!thread) throw new Error('Artifact thread no longer exists')
      const root = await engine.resolveThreadPath(context.projectId, context.threadId)
      const message = await inlineArtifactMessage(input, { ...context, root })
      // The guard reads engine, so a published artifact is the only thing that can
      // satisfy a visual request: prose cannot mark the turn as delivered.
      if (thread.sessionId) engine.state.artifactRenderedSessions.add(thread.sessionId)
      await engine.threadManager.upsertMessages(context.projectId, context.threadId, [message])
      engine.broadcast({
        type: 'artifact.rendered',
        sessionId: thread.sessionId ?? `${context.projectId}:${context.threadId}`,
        ...context,
        message
      })
      return { rendered: true, messageId: message.id }
    })
    engine.state.brainstormAlignmentNotes = new BrainstormAlignmentNotes(storage)
    engine.state.assistantAuthoringCheckpoints = new AssistantAuthoringCheckpoints(storage)
    engine.state.utilityOrchestration.setImageDescriptorExecutor((request) =>
      engine.executeImageDescriptor(request)
    )
    // The diagnostics tool is the one app capability every turn carries, so the
    // hybrid thread search hangs off it: an agent gathering context searches the
    // user's conversation history by meaning, not only by the words it guessed.
    engine.state.utilityOrchestration.setThreadSearchProvider(async (query) => {
      const { results } = await engine.threadManager.searchThreadsWithIntent(
        query,
        { limit: 20 },
        12_000
      )
      return results
    })
    // An agent can enter a design or a video session without the user typing the
    // tag for it, by picking up the capability itself, and the session that opens
    // is the same session: the memo the tag sets is set here, and the thread's row
    // is written, which is what docks the coordinator board while the work is
    // being made and what keeps the thread's later turns carrying the session's
    // contract instead of leaving each turn to rediscover the tool mid-flight.
    engine.state.utilityOrchestration.setAuthoredWorkSessionRecorder(
      ({ projectId, threadId, kind }) => {
        if (kind === 'design') engine.state.cioDesignThreads.set(threadId, true)
        else engine.state.cioVideoThreads.set(threadId, true)
        void engine.rememberAuthoredWorkKind(projectId, threadId, kind)
      }
    )
    // Design work the user routed to a model of their own choosing. The config
    // is read per call, so re-assigning a model applies to the next delegation
    // rather than the next app run, and the app never substitutes a model.
    engine.state.utilityOrchestration.setDesignAssignmentExecutor(
      createDesignAssignmentExecutor({
        database,
        experts: (context) => engine.expertsForThread(context.threadId),
        run: (request) => engine.runDesignAssignment(request)
      })
    )
    // Secret collection is an app-owned gateway tool, so the tool call has to be
    // able to wait for the user: the engine registers the card and settles a
    // promise when it is submitted or dismissed.
    engine.state.utilityOrchestration.setSecretRequestExecutor((input, context) =>
      engine.requestUtilitySecrets(input, context)
    )
    // A proposed capability is an app-owned gateway tool too, so the call has to
    // be able to wait for the user: the engine surfaces the card and settles a
    // promise with the decision, and only the gateway installs on acceptance.
    engine.state.utilityOrchestration.setUtilitySuggestionExecutor((entry, context) =>
      engine.requestUtilitySuggestion(entry, context)
    )
    // The workstation tools: reading the Ovens, harnesses, models and accounts,
    // and dispatching real work onto a chosen machine. The engine owns every
    // piece a dispatch needs, so it supplies the executor to the same gateway.
    engine.attachOrchestrationRuntime()
    // The app-control tools: driving the app's own rails, panels, browser and
    // settings through the same gateway. The engine owns the gateway, so it
    // supplies this executor too.
    engine.state.utilityOrchestration.setAppControlExecutor(createAppControlExecutor())
    // The engineering artifact tools: creating the thread's Brainstorm, PRD,
    // specification and Assignment through the same gateway. The engine owns the
    // engines, the isolated generation sessions and the review surfaces, so it
    // supplies this executor too.
    engine.state.utilityOrchestration.setEngineeringExecutor((operation, input, context) =>
      engine.runEngineeringTool(operation, input, context)
    )
    // The pawn agent tool: spawning and continuing an independent worker thread
    // that answers only to the agent that called the tool. The engine owns
    // thread creation, sessions and turn completion, so it supplies engine
    // executor too.
    engine.state.utilityOrchestration.setPawnExecutor((input, context) =>
      engine.runPawnTool(input, context)
    )
    if (engine.computerUsePip) {
      const computerUsePip = engine.computerUsePip
      engine.state.utilityOrchestration.onCuaActivity((event) => computerUsePip.onActivity(event))
    }
    engine.state.specEngine = new SpecEngine(storage, database, {
      validateForApproval: validateEngineeringSpec
    })
    engine.state.brainstormEngine = new BrainstormEngine(storage, database)
    engine.state.prdEngine = new PrdEngine(storage, database)
    engine.state.engineeringLifecycleEngine = new EngineeringLifecycleEngine(database)
    engine.state.auditEngine = new AuditEngine(storage, database)
    engine.state.assignmentEngine = new AssignmentEngine(storage, database)
    // Every audit-cycle transition lands on the plan's coordinator thread, so a
    // retry or dismissal performed on the auditor's card clears the matching
    // card on the Sr. Engineer (and the reverse). Re-announcing the coordinator
    // thread is what reaches every mounted view of the plan.
    engine.state.assignmentEngine.setAuditCycleListener((plan) => {
      void engine.reannounceAssignmentAudit(plan)
    })
    // Register available harness drivers. Order follows the harness registry
    // the single source of truth   so the model list and providers settings
    // page agree. Only harnesses with an integrated driver are instantiated.
    const driverFactories: Record<string, () => HarnessDriver> = {
      opencode: () =>
        createOpenCodeHarnessDriver(engine.state.baseUrlProviders, engine.state.secretVault),
      codex: () =>
        new CodexDriver(storage, engine.state.baseUrlProviders, engine.state.secretVault),
      'claude-code': () =>
        new ClaudeCodeDriver(storage, engine.state.baseUrlProviders, engine.state.secretVault),
      pi: () => new PiDriver(storage, engine.state.baseUrlProviders, engine.state.secretVault),
      cline: () =>
        new ClineDriver(storage, engine.state.baseUrlProviders, engine.state.secretVault),
      antigravity: () => new AntigravityDriver(storage),
      muse: () => new MuseDriver(storage)
    }
    for (const harness of listHarnesses()) {
      const create = driverFactories[harness.id]
      if (create) engine.drivers.set(harness.id, create())
    }
    // Remember which OpenCode transport the map was built for, so a runtime
    // install/upgrade can swap it without rebuilding the whole map.
    engine.state.openCodeDriverIsV2 = isOpenCodeV2Installed()

    // Wire each driver's event output to the broadcast + permission policy.
    for (const driver of engine.drivers.values()) {
      driver.setProcessObserver?.(engine.state.agentProcesses)
      driver.onEvent((event) => engine.handleDriverEvent(driver.id, event, driver))
    }
  }
}
