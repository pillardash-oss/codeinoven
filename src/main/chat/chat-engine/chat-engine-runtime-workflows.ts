import { userSuppliedPaths } from '../user-supplied-paths'
import { Logger } from '../../system/logger'
import { validateEntityId } from '../../ipc/ipc-validation'
import { instanceRegistry } from '../../system/instance-registry'
import { createOrchestrationRuntime } from '../chat-engine-orchestration'
import { LOCAL_OVEN_ID } from '../../../lib/ovens'
import { OvenRegistry } from '../../ovens/oven-registry'
import { OvenService } from '../../ovens/oven-service'
import { OvenHarnessService } from '../../ovens/oven-harness-service'
import type { AgentEvent, PromptAttachment, Thread } from '../../../lib/types'
import { DEFAULT_SCOPE_BUCKET_ID } from '../../../lib/types'
import { workflowGroupThreads } from '../../../lib/engines/thread-manager-lineage'
import type { SessionInfo } from './chat-engine-types'
import { assistantText } from './chat-engine-message-text'
import { readableRelayAttachments } from './continuation-attachments'
import { deliverBroadcast } from './chat-engine-pure'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine runtime-workflows: one concern, moved verbatim from the composition root. */
export class ChatEngineRuntimeWorkflows {
  constructor(private readonly host: ChatEngine) {}

  async achievementOwnsDecisions(thread: Thread | null): Promise<boolean> {
    if (thread?.settings?.loopMode !== true) return false
    const assignment = this.host.state.assignmentEngine.getActive(thread.projectId, thread.id)
    if (assignment) return assignment.status !== 'draft'
    if (this.host.units['turns'].engineeringLifecycleActive(thread.projectId, thread.id))
      return false
    return (
      (await this.host.units['spec'].getActiveSpec(thread.projectId, thread.id))?.status ===
      'approved'
    )
  }

  /** Whether this process is the one driving the workflow, by row or by turn. */
  async ownsWorkflow(
    projectId: string,
    coordinatorThreadId: string,
    group: Thread[]
  ): Promise<boolean> {
    if (
      (await this.host.state.workflowOwnership.ownerPid(projectId, coordinatorThreadId)) ===
      process.pid
    ) {
      return true
    }
    for (const member of group) {
      if (
        (await this.host.checkpointManager.activeTurnOwnerPid(projectId, member.id)) === process.pid
      ) {
        return true
      }
    }
    return false
  }

  /** Enable Achievement coordination without changing the thread's workspace scope. */
  async ensureAchievementScope(projectId: string, coordinatorThreadId: string): Promise<Thread> {
    projectId = validateEntityId(projectId, 'Project ID')
    coordinatorThreadId = validateEntityId(coordinatorThreadId, 'Coordinator thread ID')
    const coordinator = await this.host.threadManager.getThread(projectId, coordinatorThreadId)
    if (!coordinator) throw new Error('Achievement coordinator not found.')
    if (coordinator.achievementRole === 'auditor') {
      throw new Error('An Achievement Auditor cannot coordinate Achievement.')
    }
    await this.host.threadManager.updateThread(projectId, coordinatorThreadId, {
      achievementRole: 'coordinator',
      scopeBucketId: coordinator.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID
    })
    return (await this.host.threadManager.getThread(projectId, coordinatorThreadId)) ?? coordinator
  }

  /** Every thread of the workflow rooted at `coordinatorThreadId`, coordinator first. */
  async workflowGroup(
    projectId: string,
    coordinatorThreadId: string,
    threads?: Thread[]
  ): Promise<Thread[]> {
    const snapshot =
      threads ??
      (await this.host.threadManager.listProjectThreads(projectId, { includeArchived: true }))
    return workflowGroupThreads(snapshot, coordinatorThreadId)
  }

  /**
   * Whether this process may drive the workflow `thread` belongs to.
   *
   * A coordinated workflow is one unit of ownership, so the whole group answers
   * one question, never per thread. The owner is the durable `workflow_owners`
   * row; a live in-flight turn on any member also counts, so a workflow a peer is
   * running right now is never adopted even when its ownership row was never
   * written (an older build, or a failed write). Work that is not part of a
   * workflow keeps the blanket live-instance gate it has always used.
   */
  async claimWorkflowForDrive(
    projectId: string,
    thread: Thread,
    reason: string,
    threads?: Thread[]
  ): Promise<boolean> {
    const coordinatorThreadId = await this.host.units['assignment'].workflowCoordinatorFor(
      projectId,
      thread,
      threads
    )
    if (coordinatorThreadId === null)
      return !this.host.units['runtime-connectivity'].deferAutomaticResumeToLiveInstance(reason)
    const claimOwner = await this.host.state.workflowOwnership.ownerPid(
      projectId,
      coordinatorThreadId
    )
    if (claimOwner === process.pid) return true
    if (claimOwner !== null && instanceRegistry.isRunOwnerAlive(claimOwner)) {
      this.host.units['runtime-connectivity'].logWorkflowResumeDeferred(
        coordinatorThreadId,
        claimOwner
      )
      return false
    }
    const driver = await this.host.units['turns'].workflowActiveTurnOwner(
      projectId,
      coordinatorThreadId,
      threads
    )
    if (driver !== null && driver !== process.pid && instanceRegistry.isRunOwnerAlive(driver)) {
      this.host.units['runtime-connectivity'].logWorkflowResumeDeferred(coordinatorThreadId, driver)
      return false
    }
    const claimed = await this.host.state.workflowOwnership.claimIfOwnerGone(
      projectId,
      coordinatorThreadId
    )
    if (!claimed)
      this.host.units['runtime-connectivity'].logWorkflowResumeDeferred(
        coordinatorThreadId,
        claimOwner
      )
    return claimed
  }

  /**
   * Broadcast an agent event to every renderer window.
   *
   * Provider token streams can emit hundreds of snapshots/deltas per second.
   * Renderers only need the newest part snapshot and the concatenated deltas
   * for a frame, so collapse those mutations here before Electron serializes
   * them for every subscriber. Lifecycle events flush buffered mutations first
   * to preserve stream-before-completion ordering.
   */
  broadcast(event: AgentEvent): void {
    // A session lifecycle transition is when this process's set of running
    // threads can change, which is the one thing a sibling window cannot see by
    // itself   it has no harness for these turns. Change-guarded inside.
    if (event.type === 'session.status') this.host.units['turns'].announceTurnActivityChange()
    if (
      event.type === 'message.part.updated' ||
      event.type === 'message.part.delta' ||
      event.type === 'usage.updated' ||
      (event.type === 'session.status' && event.status.state === 'working')
    ) {
      this.host.units['turns-stream'].queueStreamBroadcast(event)
      return
    }
    this.host.units['turns-stream'].flushStreamBroadcasts()
    deliverBroadcast(event)
  }

  /**
   * Build the workstation tools' executor and hand it to the utility gateway.
   *
   * The engine owns everything a dispatch needs: the Oven registry and its
   * harness inventory, the account registry, the provider catalogs, and the
   * thread lifecycle a run has to enter so it appears in the sidebar and streams
   * its status like any other thread. The dispatch book the runtime returns is
   * what the turn finalizer reads to report an outcome back into the thread that
   * asked for it.
   */
  attachOrchestrationRuntime(): void {
    const ovenRegistry = new OvenRegistry(this.host.storage, this.host.state.secretVault)
    const ovenHarness = new OvenHarnessService(new OvenService(ovenRegistry), this.host.storage)
    this.host.orchestration = createOrchestrationRuntime({
      listProviderCatalogs: (projectId) => this.host.listProviderSnapshot(projectId),
      // A dispatch that cannot find its model discovers once instead of
      // bouncing the agent back to a target list built from the same snapshot.
      refreshProviderCatalogs: (projectId) =>
        this.host.refreshProviderCatalog(projectId, { force: true }),
      listProjects: async () =>
        (await this.host.state.projectManager.listProjects()).map((project) => ({
          id: project.id,
          name: project.name,
          path: project.path
        })),
      listAccounts: () => this.host.state.accountRegistry.list(),
      listOvens: () => ovenRegistry.state(),
      harnessInventory: async (ovenId) => {
        // This computer is never probed the way a remote Oven is, and the
        // composer treats its harnesses as selectable without one.
        if (ovenId === LOCAL_OVEN_ID) return []
        try {
          return await ovenHarness.getInventory(ovenId)
        } catch {
          // An unreachable Oven still answers with its last known scan.
          return ovenHarness.cachedInventory(ovenId)
        }
      },
      listModelProfiles: async () => (await this.host.storage.getConfig()).modelProfiles ?? [],
      getThread: (projectId, threadId) => this.host.threadManager.getThread(projectId, threadId),
      latestAssistantText: async (projectId, threadId) => {
        const messages = await this.host.threadManager.loadMessages(projectId, threadId)
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index]
          if (message.role !== 'assistant') continue
          const text = assistantText(message).trim()
          if (text) return text
        }
        return null
      },
      createThread: (input) => this.host.units['threads-create'].createOrchestrationThread(input),
      sendPrompt: async (input) => {
        await this.host.sendPrompt(
          input.projectId,
          input.threadId,
          input.settings,
          input.text,
          [],
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          // Internal with a visible turn, the same shape the Assignment worker
          // dispatch uses, so the first message reads as the user's own.
          'internal',
          undefined,
          undefined,
          true
        )
      }
    })
    this.host.state.utilityOrchestration.setOrchestrationExecutor(this.host.orchestration.executor)
  }

  /**
   * The attachments a continuation relay can still materialize. A relay
   * re-sends a request the user made earlier, and its files can be gone from
   * disk by the time the retry runs; a vanished file drops from the relay, and
   * the drop is recorded so a half-delivered retry is never silent.
   */
  async relayAttachments(
    projectId: string,
    threadId: string,
    attachments: PromptAttachment[]
  ): Promise<PromptAttachment[]> {
    const readable = await readableRelayAttachments(attachments)
    if (readable.length !== attachments.length) {
      const kept = new Set(readable)
      Logger.info('Dropped missing files from a continuation relay', {
        projectId,
        threadId,
        dropped: attachments
          .filter((attachment) => !kept.has(attachment))
          .map((attachment) => attachment.filename ?? attachment.url)
      })
    }
    return readable
  }

  /** Local inputs explicitly supplied by the user, never paths from agent output. */
  async collectChatAttachmentPaths(info: SessionInfo): Promise<string[]> {
    const records = await this.host.threadManager.loadMessageRecords(info.projectId, info.threadId)
    const paths = new Set<string>()
    for (let index = 0; index < records.length; index++) {
      // Long project transcripts must yield rather than monopolize the main process.
      if (index > 0 && index % 64 === 0) await new Promise<void>((done) => setImmediate(done))
      const message = records[index]
      if (message.role !== 'user' || message.origin === 'orchestrator') continue
      for (const path of userSuppliedPaths(message.parts, info.projectPath)) paths.add(path)
    }
    return [...paths]
  }
}
