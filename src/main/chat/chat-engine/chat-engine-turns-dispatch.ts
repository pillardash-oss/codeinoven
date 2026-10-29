import { deliverWithWorkPathNotices } from '../../design/work-path-notices'
import { join, resolve } from 'path'
import { Logger } from '../../system/logger'
import { supportsIsolatedSessions } from '../../drivers/isolated-session'
import { DEFAULT_HARNESS } from '../../../lib/harness-default'
import {
  markNotificationAborting,
  clearNotificationAborting,
  updateRetryWakeWindow
} from '../thread-events'
import type { BehaviorExecutionScope, BehaviorMode, WorkspaceScopeMode } from '../prompt-assembler'
import {
  currentHarnessVersion,
  episodeFromPieces,
  tokenUsageAttribution
} from '../token-usage-attribution'
import { validateEntityId } from '../../ipc/ipc-validation'
import type { HarnessDriver } from '../../drivers/driver.interface'
import {
  buildOrchestrationReportPrompt,
  type PendingOrchestrationDispatch
} from '../chat-engine-orchestration'
import { legacyHarnessAccountId } from '../../providers/harness-account-registry'
import type { ResolvedImageEntry } from '../../providers/image-descriptor-provider'
import type {
  AgentMessage,
  AuditReport,
  HeartbeatConfig,
  PromptAttachment,
  Thread,
  ThreadSettings
} from '../../../lib/types'
import { INBOX_PROJECT_ID } from '../../../lib/types'
import { modelKey } from '../../../lib/model-keys'
import {
  DEFAULT_AGENT_BEHAVIOR_PROMPT,
  gateCuaDriverBehaviorPrompt
} from '../../../lib/agent-behavior'
import type { CioPromptId } from '../../../lib/cio-prompts'
import { isUsageResetWaitIssue } from '../../../lib/provider-issue'
import { GLOBAL_BROWSER_PROJECT_ID } from '../../../lib/ipc/browser'
import type { SessionInfo } from './chat-engine-types'
import { rawErrorMessage } from './chat-engine-errors'
import { attributionModeFor } from './chat-engine-constants'
import { MERMAID_OUTPUT_INSTRUCTION, formatOpenAnnotations } from './chat-engine-prompts'
import { formatAttachedImageDescriptions, isImagePromptAttachment } from './chat-engine-images'
import { turnStreamPath } from './chat-engine-pure'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine turns-dispatch: one concern, moved verbatim from the composition root. */
export class ChatEngineTurnsDispatch {
  constructor(private readonly host: ChatEngine) {}

  driverForRuntime(harnessId: string, accountId?: string): HarnessDriver | undefined {
    const resolvedId = accountId || legacyHarnessAccountId(harnessId)
    return resolvedId.startsWith(legacyHarnessAccountId(harnessId))
      ? this.host.drivers.get(harnessId)
      : this.host.state.accountDrivers.get(resolvedId)
  }

  cioPrompt(id: CioPromptId): Promise<string> {
    return this.host.storage.getCioPrompt(id)
  }

  async getBehaviorPrompt(
    projectId: string,
    threadId: string,
    projectPath: string,
    mode: BehaviorMode,
    settings?: ThreadSettings,
    executionScope: BehaviorExecutionScope = 'project-thread',
    attributionKey?: string
  ): Promise<string> {
    let behaviorDriver: HarnessDriver | undefined
    try {
      const thread = await this.host.threadManager.getThread(projectId, threadId)
      const threadSettings = settings ?? thread?.settings
      const harnessId = threadSettings?.harnessId ?? DEFAULT_HARNESS
      const driver = this.host.drivers.get(harnessId)
      behaviorDriver = driver
      const config = await this.host.storage.getConfig()
      // An assistant task does not inherit the engineering work-ethics prompt:
      // the assistant is its own class and the app owns its standing behavior.
      const behaviorPrompt =
        executionScope === 'assistant'
          ? await this.cioPrompt('assistant')
          : config.agentBehaviorPrompt
      // Trimmed modes get a compact scope guard instead of the full workspace
      // block; pure inbox chat and image description (no project scope) omit it.
      const workspaceScope: WorkspaceScopeMode =
        executionScope === 'assistant'
          ? 'assistant'
          : executionScope === 'project-thread'
            ? 'full'
            : executionScope === 'ephemeral' || threadSettings?.fileSystemMode === true
              ? 'abbreviated'
              : 'omitted'
      // A native computer-use capability decides whether the prompt carries the
      // CUA driver clause at all, so it is read from the same device answer the
      // utility registry uses rather than from the driver's static claim.
      const nativeComputerUse = (
        await this.host.units['utilities'].nativeUtilitiesOf(driver, projectPath)
      ).includes('computer_use')
      const assembled = await this.host.state.promptAssembler.getAssembledPromptWithLayers(
        projectId,
        threadId,
        projectPath,
        driver
          ? {
              id: driver.id,
              name: driver.name,
              nativeComputerUse
            }
          : null,
        '',
        {
          SPEC_BRAINSTORM_SYSTEM_PROMPT: await this.cioPrompt('engineering-spec'),
          SPEC_IMPLEMENT_SYSTEM_PROMPT: await this.cioPrompt('engineering-implementation'),
          MERMAID_OUTPUT_INSTRUCTION
        },
        mode,
        behaviorPrompt,
        threadSettings?.providerId && threadSettings.modelId
          ? modelKey(harnessId, threadSettings.providerId, threadSettings.modelId)
          : undefined,
        executionScope,
        workspaceScope,
        thread?.assistantId
      )
      tokenUsageAttribution.recordPromptAttribution(
        episodeFromPieces({
          key: attributionKey ?? `${harnessId}:${threadId}`,
          mode: attributionModeFor(mode, executionScope, threadSettings?.fileSystemMode === true),
          driverId: harnessId,
          harnessVersion: currentHarnessVersion() ?? undefined,
          pieces: assembled.layers.map((layer) => ({
            title: layer.title,
            content: layer.content
          }))
        })
      )
      return assembled.prompt
    } catch (error) {
      Logger.error('Behavior prompt assembly failed', {
        projectId,
        threadId,
        mode,
        executionScope,
        error: rawErrorMessage(error)
      })
      return executionScope === 'project-thread'
        ? gateCuaDriverBehaviorPrompt(
            DEFAULT_AGENT_BEHAVIOR_PROMPT,
            (
              await this.host.units['utilities'].nativeUtilitiesOf(behaviorDriver, projectPath)
            ).includes('computer_use')
          )
        : ''
    }
  }

  // ─── Image descriptor   vision model for text-only models ──────────────

  /**
   * Describe image attachments before a text-only primary model receives the
   * turn. The normal descriptor executor owns selection persistence, retries,
   * and the existing user-facing error card, so automatic and tool-initiated
   * descriptions have identical failure behaviour.
   */
  async describePromptAttachments(
    attachments: readonly PromptAttachment[],
    projectId: string,
    threadId: string,
    projectPath: string,
    sessionId: string
  ): Promise<string> {
    const images: ResolvedImageEntry[] = attachments
      .filter(isImagePromptAttachment)
      .map((attachment, index) => ({
        id: `attached-image-${index + 1}`,
        source: attachment.url,
        type: attachment.url.startsWith('data:') ? 'binary' : 'path',
        attachment
      }))
    if (images.length === 0) return ''
    const results = await this.host.executeImageDescriptor({
      images,
      projectId,
      threadId,
      projectPath,
      sessionId
    })
    return formatAttachedImageDescriptions(results)
  }

  /** Add pending relocation updates only when a message reaches its harness. */
  async deliverWorkPrompt(
    projectId: string,
    threadId: string,
    userMessage: AgentMessage,
    text: string,
    deliver: (text: string) => Promise<void>
  ): Promise<void> {
    await deliverWithWorkPathNotices({
      database: this.host.database,
      projectId,
      threadId,
      text,
      deliver,
      recordTransport: async (transportText) => {
        const part = userMessage.transportParts?.find((part) => part.type === 'text')
        if (part?.type !== 'text') throw new Error('Outbound message has no transport text')
        part.text = transportText
        userMessage.transportOrigin = 'orchestrator'
        await this.host.threadManager.upsertMessages(projectId, threadId, [userMessage])
      }
    })
  }

  /**
   * Abort the thread's running session.
   *
   * `reason: 'transfer'` is the cross-instance hand-off stop: it tears the run
   * down exactly like a user Stop, except it never latches the user-stop flag,
   * because the run is not ending   it is moving to the instance that asked for
   * it, and that instance must be able to resume it automatically.
   */
  async abort(
    projectId: string,
    threadId: string,
    options: { reason?: 'user' | 'transfer' } = {}
  ): Promise<void> {
    this.host.units['messages'].touchUserActivity()
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (thread && this.host.state.ovenChat.remote(thread)) {
      await this.host.threadManager.markStoppedByUser(projectId, threadId)
      await this.host.state.ovenChat.stop(thread)
      return
    }

    // Latch the stop immediately so a failure that arrives mid-teardown cannot
    // re-track an auto-retry between this point and the status write below. A
    // transfer deliberately skips the latch: the run continues elsewhere.
    if (options.reason !== 'transfer') {
      await this.host.threadManager.markStoppedByUser(projectId, threadId)
    }
    const brainstormKey = `${projectId}:${threadId}`
    const activeBrainstorm = this.host.state.activeBrainstormSessions.get(brainstormKey)
    if (activeBrainstorm) {
      markNotificationAborting(projectId, threadId)
      this.host.state.userAbortedBrainstormOperations.add(brainstormKey)
      this.host.state.userAbortedSessions.add(activeBrainstorm.sessionId)
      if (activeBrainstorm.isolated && supportsIsolatedSessions(activeBrainstorm.driver)) {
        await activeBrainstorm.driver.abort(
          activeBrainstorm.projectPath,
          activeBrainstorm.sessionId,
          activeBrainstorm.isolated
        )
      } else {
        await activeBrainstorm.driver.abort(
          activeBrainstorm.projectPath,
          activeBrainstorm.sessionId
        )
      }
      await this.host.units['utilities'].cleanupTurnUtilities(activeBrainstorm.sessionId)
      this.host.sessionStatuses.set(activeBrainstorm.sessionId, { state: 'idle' })
      await this.host.threadManager.setStatus(projectId, threadId, 'interrupted', { read: true })
      clearNotificationAborting(projectId, threadId)
      return
    }
    const activeInitialSpec = this.host.state.activeInitialSpecSessions.get(brainstormKey)
    if (activeInitialSpec) {
      markNotificationAborting(projectId, threadId)
      this.host.state.userAbortedInitialSpecOperations.add(brainstormKey)
      this.host.state.userAbortedSessions.add(activeInitialSpec.sessionId)
      if (activeInitialSpec.isolated && supportsIsolatedSessions(activeInitialSpec.driver)) {
        await activeInitialSpec.driver.abort(
          activeInitialSpec.projectPath,
          activeInitialSpec.sessionId,
          activeInitialSpec.isolated
        )
      } else {
        await activeInitialSpec.driver.abort(
          activeInitialSpec.projectPath,
          activeInitialSpec.sessionId
        )
      }
      this.host.sessionStatuses.set(activeInitialSpec.threadSessionId, { state: 'idle' })
      this.host.units['turns-sessions'].clearSessionWatchdog(activeInitialSpec.sessionId)
      await this.host.threadManager.setStatus(projectId, threadId, 'interrupted', { read: true })
      clearNotificationAborting(projectId, threadId)
      return
    }
    const activeAssignmentDraft = this.host.state.activeAssignmentDraftSessions.get(brainstormKey)
    if (activeAssignmentDraft) {
      markNotificationAborting(projectId, threadId)
      this.host.state.userAbortedAssignmentDraftOperations.add(brainstormKey)
      this.host.state.userAbortedSessions.add(activeAssignmentDraft.sessionId)
      if (
        activeAssignmentDraft.isolated &&
        supportsIsolatedSessions(activeAssignmentDraft.driver)
      ) {
        await activeAssignmentDraft.driver.abort(
          activeAssignmentDraft.projectPath,
          activeAssignmentDraft.sessionId,
          activeAssignmentDraft.isolated
        )
      } else {
        await activeAssignmentDraft.driver.abort(
          activeAssignmentDraft.projectPath,
          activeAssignmentDraft.sessionId
        )
      }
      this.host.units['turns-sessions'].clearSessionWatchdog(activeAssignmentDraft.sessionId)
      await this.host.threadManager.setStatus(projectId, threadId, 'interrupted', { read: true })
      clearNotificationAborting(projectId, threadId)
      return
    }
    if (!thread?.sessionId) {
      // No session binding means there is nothing for a driver to interrupt, but
      // a Stop still has to land: the thread may be parked on a question raised
      // before its binding was written, and returning here is what leaves such a
      // thread reported as working with a card on screen that no press can clear.
      if (!thread) return
      markNotificationAborting(projectId, threadId)
      this.host.units['thread-lifecycle'].releaseParkedThreadGates(projectId, threadId)
      await this.host.threadManager.setStatus(projectId, threadId, 'interrupted', { read: true })
      clearNotificationAborting(projectId, threadId)
      return
    }
    // Suppress any stale notification the dying agent might emit during abort.
    markNotificationAborting(projectId, threadId)
    // Remember this is a deliberate user stop so the session's idle/error
    // finalization never rewrites the thread to `failed`.
    this.host.state.userAbortedSessions.add(thread.sessionId)
    this.host.state.activeCompactions.delete(thread.sessionId)
    this.host.units['runtime-connectivity'].rejectCompletionWaiter(
      thread.sessionId,
      'Agent run stopped by user'
    )
    // Stop targets the session already running in this thread. The picker may
    // have changed since that session started, so resolve its owning harness
    // before falling back to the current settings for legacy threads.
    const driverId =
      this.host.sessionRegistry.get(thread.sessionId)?.driverId ??
      thread.sessionHarnessId ??
      thread.settings?.harnessId ??
      DEFAULT_HARNESS
    const { driver, projectPath } = await this.host.resolve(
      projectId,
      driverId,
      threadId,
      this.host.sessionRegistry.get(thread.sessionId)?.accountId ?? thread.sessionAccountId
    )
    // Workers run in their own sessions and must stop with the thread they
    // were spawned from   see stopThreadChildSessions.
    await this.host.units['assignment-workers'].stopThreadChildSessions(projectId, threadId)
    // Everything past this call is the teardown that makes the stop real: the
    // parked question and permission are cleared, the watchdog is disarmed, and
    // the thread is written back as `interrupted`. A driver that throws must not
    // be able to skip any of it, because that is precisely the state no later
    // Stop can escape: the thread keeps reporting itself as working, a card
    // nothing owns stays on screen, and `clearNotificationAborting` below never
    // runs so the thread stops notifying at all. Capture the failure, finish the
    // teardown, then report it so the caller still learns the harness refused.
    let abortFailure: unknown = null
    try {
      await driver.abort(projectPath, thread.sessionId)
    } catch (error) {
      abortFailure = error
    }
    await this.host.units['utilities'].cleanupTurnUtilities(thread.sessionId)
    updateRetryWakeWindow(thread.sessionId, null)
    // A held steer's turn is dead   undo is no longer meaningful, drop it.
    this.host.units['turns-steer'].clearHeldSteers(thread.sessionId)
    // A thread waiting on a scheduled usage-reset retry has no live turn to
    // abort, so a Stop click must cancel the pending resume itself   otherwise
    // the scheduler fires later and silently revives the thread the user
    // deliberately stopped. Every record of this thread goes: a successor
    // session id (retry failures re-track under a new one) must not survive.
    this.host.state.retryScheduler?.clear(thread.sessionId)
    this.host.state.retryScheduler?.dropThread(threadId)
    // A queued specification generation must die with the run the user just
    // stopped. If the persisted spec-generation record survives, reopening the
    // thread resumes the exact spec work the user deliberately cancelled.
    // Only pending/generating records are removed: a failed record never
    // auto-resumes and backs the dedicated Retry card.
    const pendingInitialSpec = await this.host.units['spec-lifecycle'].readPendingInitialSpec(
      projectId,
      threadId
    )
    if (
      pendingInitialSpec &&
      (pendingInitialSpec.state === 'pending' || pendingInitialSpec.state === 'generating')
    ) {
      this.host.state.userAbortedInitialSpecOperations.add(
        this.host.units['spec'].initialSpecKey(projectId, threadId)
      )
      await this.host.units['spec-lifecycle'].clearPendingInitialSpec(projectId, threadId)
    }
    this.host.sessionStatuses.set(thread.sessionId, { state: 'idle' })
    this.host.units['questions'].clearPendingQuestionsForSession(thread.sessionId)
    this.host.units['permissions'].clearPendingPermissionsForSession(thread.sessionId)
    // A stop must leave nothing running on this thread, and the watchdog armed
    // for the turn it just ended would only re-check a session that is done.
    this.host.units['turns-sessions'].clearSessionWatchdog(thread.sessionId)
    // The user stopped this run deliberately   reflect it immediately so the
    // sidebar indicator never stays stuck on "working". A deliberate stop is
    // "done (read)": it is not an error and not pending the user's attention.
    // A stopped turn reports nothing from its provider (and may never run its
    // idle finalization at all), so the work it already streamed is persisted
    // from the durable log now, while its boundary still covers that work. Any
    // later turn, and the log's own compaction, would scope it out for good.
    await this.host.units['messages-write'].persistStreamedTurnWork(
      projectId,
      threadId,
      thread.sessionId
    )
    await this.host.threadManager.setStatus(projectId, threadId, 'interrupted', { read: true })
    if (projectId === GLOBAL_BROWSER_PROJECT_ID) {
      await this.host.storage.drainRaw(turnStreamPath(projectId, threadId))
      await this.host.threadManager.loadMessagePage(projectId, threadId, undefined, 1)
    }
    clearNotificationAborting(projectId, threadId)
    if (abortFailure) throw abortFailure
  }

  async loopReworkPrompt(report: AuditReport, iteration: number): Promise<string> {
    const auditPath = await this.host.units['media-artifacts'].artifactRef(
      report.projectId,
      report.threadId,
      join('versions', `${report.id}-audit-v${report.version}.md`)
    )
    return [
      `Achievement audit ${iteration} found required corrections.`,
      'Act as the primary implementation agent. Address every actionable finding against the approved specification.',
      'Inspect the cited evidence, implement the corrections, run all relevant scoped checks, and report concrete verification evidence. Do not stop at recommendations.',
      await this.cioPrompt('achievement-implementation'),
      `Audit report: ${auditPath}`,
      `Open audit annotations:\n${formatOpenAnnotations(report.annotations)}`
    ].join('\n\n')
  }

  /**
   * Report a settled dispatch back into the thread that asked for it.
   *
   * Best-effort by design: the run thread's own row and its notification are
   * the durable record, so a report that cannot land (the requesting thread is
   * mid-turn, or has been closed) must never fail the run's finalization.
   */
  async reportOrchestrationDispatch(
    dispatch: PendingOrchestrationDispatch,
    status: string
  ): Promise<void> {
    try {
      const thread = await this.host.threadManager.getThread(
        dispatch.requestingProjectId,
        dispatch.requestingThreadId
      )
      if (!thread?.settings) return
      await this.host.sendPrompt(
        dispatch.requestingProjectId,
        dispatch.requestingThreadId,
        thread.settings,
        buildOrchestrationReportPrompt(dispatch, status),
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'internal'
      )
    } catch (error) {
      Logger.dev('Orchestration dispatch report skipped:', error)
    }
  }

  /**
   * Send one disposable "ping" completion for a configured Heartbeat, pinned
   * to its exact harness/provider/model   no visible thread, no cheap-model
   * substitution. It owns no thread, so it runs in the shared inbox scratch
   * root rather than in any chat's own workspace directory.
   */
  async sendHeartbeatPing(config: HeartbeatConfig): Promise<boolean> {
    const driver = await this.host.driverForAccount(config.harnessId, config.accountId)
    const projectPath = await this.host.units['turns'].resolveProjectPath(INBOX_PROJECT_ID)
    await driver.ensureReady(projectPath)
    return driver.sendHeartbeatPing(projectPath, {
      settings: {
        harnessId: config.harnessId,
        accountId: config.accountId ?? legacyHarnessAccountId(config.harnessId),
        providerId: config.providerId,
        modelId: config.modelId,
        inferenceMode: config.inferenceMode,
        contextWindow: config.contextWindow,
        thinkingLevel: config.thinkingLevel ?? 'minimal',
        permissionLevel: 'auto_review'
      }
    })
  }

  /**
   * Resolve a usage-reset wait's retry time from the same provider-scoped
   * account telemetry the usage battery shows: harness-native capture, then
   * OpenUsage, then a custom provider's usage route. Scoping by the thread's
   * provider matters for Pi, whose provider-account read is skipped without a
   * provider id. A harness can report several concurrent windows, so pick
   * among the windows that actually caused this wait (fully used) rather than
   * the farthest one overall   otherwise an unrelated model's fresh window can
   * push the retry hours or days past the real reset.
   */
  async deriveUsageResetRetryAt(
    info: SessionInfo,
    driver: HarnessDriver
  ): Promise<number | undefined> {
    try {
      const thread = await this.host.threadManager.getThread(info.projectId, info.threadId)
      const harnessId = info.driverId
      const providerId = thread?.settings?.providerId ?? harnessId
      const account = await this.host.state.accountRegistry.resolveForProvider(
        harnessId,
        providerId,
        info.accountId
      )
      const usage = await this.host.units['providers-accounts'].readHarnessAccountUsage({
        harnessId,
        providerId,
        accountId: account.id,
        accountEnvironment: this.host.state.accountRegistry.environment(account),
        driver,
        projectPath: info.projectPath
      })
      const futureResets = (usage?.rateLimits ?? []).filter(
        (limit): limit is typeof limit & { resetsAt: number } =>
          typeof limit.resetsAt === 'number' &&
          Number.isFinite(limit.resetsAt) &&
          limit.resetsAt > Date.now()
      )
      const exhaustedResets = futureResets
        .filter((limit) => (limit.usedPercent ?? 0) >= 100)
        .map((limit) => limit.resetsAt)
      if (exhaustedResets.length > 0) return Math.min(...exhaustedResets)
      if (futureResets.length > 0) return Math.max(...futureResets.map((limit) => limit.resetsAt))
      return undefined
    } catch (error) {
      Logger.dev('Auto-resume retry time derivation unavailable:', error)
      return undefined
    }
  }

  /**
   * True when the session is currently showing a provider reset or connection wait.
   * the unified will-retry state. Any later terminal-looking signal (trailing
   * idle finalization, issue-less teardown failure) must defer to it instead of
   * overwriting the pause with a terminal error.
   */
  isAutomaticRetryWaitActive(sessionId: string): boolean {
    const status = this.host.sessionStatuses.get(sessionId)
    return (
      status?.state === 'waiting' &&
      (isUsageResetWaitIssue(status.issue) || status.issue.kind === 'network')
    )
  }
}
