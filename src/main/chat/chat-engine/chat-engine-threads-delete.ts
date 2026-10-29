import { rm } from 'fs/promises'
import { join, resolve } from 'path'
import { Logger } from '../../system/logger'
import { DEFAULT_HARNESS } from '../../../lib/harness-default'
import { validateEntityId } from '../../ipc/ipc-validation'
import type { AgentMessage, Thread } from '../../../lib/types'
import {
  LEGACY_CHAT_ARTIFACTS_DIRECTORY,
  LEGACY_CHATS_ARTIFACTS_DIRECTORY,
  chatThreadWorkspaceDirectory
} from '../../../lib/project-artifacts'
import { presentableMessages } from './chat-engine-message-merge'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine threads-delete: one concern, moved verbatim from the composition root. */
export class ChatEngineThreadsDelete {
  constructor(private readonly host: ChatEngine) {}

  /**
   * Delete history around a message. `down` keeps the prefix before it;
   * `single` removes the message together with its turn (everything up to the
   * next user message) so earlier and later messages splice together; `up`
   * keeps only the messages after the message's turn. All modes discard the
   * harness session   the next send replays the remaining mirror as a recap.
   */
  async deleteMessages(
    projectId: string,
    threadId: string,
    messageId: string,
    mode: 'down' | 'single' | 'up'
  ): Promise<AgentMessage[]> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    messageId = validateEntityId(messageId, 'Message ID', 256)
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (!thread) throw new Error(`Thread not found: ${threadId}`)

    const mirror = await this.host.threadManager.loadMessageRecords(projectId, threadId)
    const cutoff = mirror.findIndex((m) => m.id === messageId)
    // An id missing from the mirror was never persisted (optimistic local
    // message)   nothing after it exists, so the mirror is kept whole.
    let kept: typeof mirror
    if (cutoff === -1) {
      kept = mirror
    } else if (mode === 'down') {
      kept = mirror.slice(0, cutoff)
    } else {
      // A turn spans from its user message to just before the next user
      // message (steers are user messages too, so contiguous user messages
      // stay inside the removed span only when they precede the target).
      let turnEnd = cutoff + 1
      while (turnEnd < mirror.length && mirror[turnEnd].role !== 'user') turnEnd++
      kept =
        mode === 'single'
          ? [...mirror.slice(0, cutoff), ...mirror.slice(turnEnd)]
          : mirror.slice(turnEnd)
    }
    // Working traces belong to the turn they were produced under. When the
    // anchor message is removed, drop every working_trace row inside the
    // removed span even if a late-arriving trace row sorted after the next
    // user message   an orphaned trace must never outlive its prompt.
    const removedSpanStart = cutoff !== -1 ? mirror[cutoff].createdAt : Number.POSITIVE_INFINITY
    kept = kept.filter(
      (message) =>
        !(message.visibility === 'working_trace' && message.createdAt >= removedSpanStart)
    )
    await this.host.threadManager.saveMessages(projectId, threadId, kept)

    if (thread.sessionId) {
      // Forget the old session so its idle sync cannot resurrect the
      // truncated messages into the mirror.
      this.host.units['turns-steer'].clearHeldSteers(thread.sessionId)
      this.host.sessionRegistry.delete(thread.sessionId)
      this.host.state.reasoningTimes.delete(thread.sessionId)
      this.host.state.toolTimes.delete(thread.sessionId)
      this.host.sessionStatuses.delete(thread.sessionId)
      this.host.state.planningSessions.delete(thread.sessionId)
      this.host.state.preparedImplementationSessions.delete(thread.sessionId)
      this.host.state.outboundMessageIdsBySession.delete(thread.sessionId)
      await this.host.threadManager.clearSessionId(projectId, threadId)
      // Destroy the stale driver record   and with it the native transcript
      // binding   so the pre-edit conversation can never be restored onto a
      // later session. The next turn seeds a fresh native transcript from the
      // edited mirror (see ensureSession's prefill).
      const sessionOwner = this.host.sessionRegistry.get(thread.sessionId)
      const driver = this.host.units['turns-dispatch'].driverForRuntime(
        sessionOwner?.driverId ??
          thread.sessionHarnessId ??
          thread.settings?.harnessId ??
          DEFAULT_HARNESS,
        sessionOwner?.accountId ?? thread.sessionAccountId
      )
      try {
        const projectPath = await this.host.units['turns'].resolveProjectPath(projectId)
        await driver?.deleteSession?.(projectPath, thread.sessionId)
      } catch (error) {
        Logger.dev('Stale session cleanup after message deletion failed:', error)
      }
    }
    return presentableMessages(kept)
  }

  /**
   * Tear down every harness resource owned by a thread before its rows are
   * removed: abort in-flight turns, release utility runtimes, retire session
   * state, and delete the harness sessions (main + child) so any server or
   * port the agent opened in this thread is released. Applies to every harness
   *   pooled HTTP servers and one-process-per-turn CLIs alike. Best-effort: it
   * never throws and must not block DB deletion.
   */
  async deleteThreadSession(projectId: string, threadId: string): Promise<void> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    await this.host.state.agentProcesses.releaseThread(projectId, threadId)
    // The durable stream log is per-thread and lives in the directory the
    // deletion removes, so its cache and its queued appends are dropped before
    // anything else: neither may outlive the file.
    await this.host.units['thread-lifecycle'].forgetThreadStream(projectId, threadId)

    if (await this.host.state.ovenChat.release(projectId, threadId)) {
      let localSession = false
      for (const [sessionId, owner] of this.host.sessionRegistry) {
        if (owner.projectId === projectId && owner.threadId === threadId) {
          if (!sessionId.startsWith('oven-')) {
            localSession = true
            continue
          }
          this.host.sessionRegistry.delete(sessionId)
          this.host.sessionStatuses.delete(sessionId)
        }
      }
      if (!localSession) return
    }

    const tearDownSession = async (
      sessionId: string,
      info?: { driverId?: string; projectPath?: string; accountId?: string }
    ): Promise<void> => {
      const registered = this.host.sessionRegistry.get(sessionId)
      const driverId = info?.driverId ?? registered?.driverId
      const projectPath = info?.projectPath ?? registered?.projectPath
      const accountId = info?.accountId ?? registered?.accountId
      const driver = driverId
        ? this.host.units['turns-dispatch'].driverForRuntime(driverId, accountId)
        : undefined
      // Abort only a turn we believe is running   aborting an idle session
      // would otherwise force pooled drivers to spawn their server just to
      // tear this thread down.
      if (driver && projectPath && this.host.sessionStatuses.get(sessionId)?.state === 'working') {
        try {
          await driver.abort(projectPath, sessionId)
        } catch (error) {
          Logger.dev('Thread deletion abort was incomplete:', error)
        }
      }
      try {
        await this.host.units['utilities'].cleanupTurnUtilities(sessionId)
      } catch (error) {
        Logger.dev('Thread deletion utility cleanup was incomplete:', error)
      }
      const waiter = this.host.state.completionWaiters.get(sessionId)
      if (waiter) {
        this.host.units['runtime-connectivity'].clearCompletionWaiter(sessionId)
        waiter.reject(new Error('Thread was deleted'))
      }
      this.host.state.pendingSpecRevisions.delete(sessionId)
      this.host.state.pendingPrdTurns.delete(sessionId)
      this.host.state.pendingBrainstormTurns.delete(sessionId)
      this.host.state.specRevisionTasks.delete(sessionId)
      this.host.units['turns-sessions'].retireSessionState(sessionId)
      if (driver?.deleteSession && projectPath) {
        try {
          await driver.deleteSession(projectPath, sessionId)
        } catch (error) {
          Logger.dev('Thread deletion session removal was incomplete:', error)
        }
      }
    }

    // Child (subagent) sessions owned by this thread.
    const sessionIds = new Set<string>()
    const childSessionInfo = new Map<
      string,
      { driverId: string; projectPath: string; accountId?: string }
    >()
    for (const [childSessionId, owner] of this.host.state.childSessionOwners) {
      if (owner.projectId !== projectId || owner.threadId !== threadId) continue
      sessionIds.add(childSessionId)
      childSessionInfo.set(childSessionId, {
        driverId: owner.driverId,
        projectPath: owner.projectPath,
        accountId: owner.accountId
      })
      this.host.state.childCaptureTasks.delete(
        `${owner.projectId}:${owner.threadId}:${childSessionId}`
      )
      this.host.state.childSessionOwners.delete(childSessionId)
      this.host.state.childSessionActivityStatuses.delete(childSessionId)
    }
    // Temporary audit/loop chats bound to this thread.
    for (const temporaryChatId of [...this.host.state.temporaryChats.keys()]) {
      const temporary = this.host.state.temporaryChats.get(temporaryChatId)
      if (temporary && temporary.projectId === projectId && temporary.threadId === threadId) {
        await this.host.units['temporary-chats'].destroyTemporaryChat(temporaryChatId)
      }
    }
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (thread?.sessionId) {
      sessionIds.add(thread.sessionId)
      childSessionInfo.set(thread.sessionId, {
        driverId: thread.sessionHarnessId ?? thread.settings?.harnessId ?? DEFAULT_HARNESS,
        projectPath: await this.host.units['turns'].resolveTeardownPath(thread),
        accountId: thread.sessionAccountId
      })
    }

    await Promise.allSettled(
      [...sessionIds].map((sessionId) =>
        tearDownSession(sessionId, childSessionInfo.get(sessionId))
      )
    )

    // Spec generation and Achievement loop bookkeeping keyed by the thread.
    this.host.state.initialSpecTasks.delete(
      this.host.units['spec'].initialSpecKey(projectId, threadId)
    )
    this.host.state.activeLoopRuns.delete(`${projectId}:${threadId}`)
    this.host.state.activeAchievementAuditorEnsures.delete(`${projectId}:${threadId}`)
    this.host.state.activeAchievementAuditRuns.delete(`${projectId}:${threadId}`)

    // The thread's own workspace directory (the directory its session ran in
    // and the mount root of its file tree) is per-thread app data, as are the
    // legacy artifact roots older chats wrote to; all of it goes away with the
    // thread.
    for (const directory of [
      chatThreadWorkspaceDirectory(threadId),
      join(LEGACY_CHATS_ARTIFACTS_DIRECTORY, threadId),
      join(LEGACY_CHAT_ARTIFACTS_DIRECTORY, threadId)
    ]) {
      void rm(this.host.storage.resolve(directory), { recursive: true, force: true }).catch(
        (error) => Logger.dev('Thread artifact directory cleanup was incomplete:', error)
      )
    }

    // The thread utilities bank is per-thread bookkeeping; it dies with the
    // thread so deleted threads never leave stale utility entries behind.
    await this.host.state.utilityOrchestration
      .deleteThreadBank(threadId)
      .catch((error: unknown) => Logger.dev('Thread utilities bank cleanup failed:', error))

    // Secrets collected for this thread (vault entries, their runtime files and
    // the registry that re-exposes them) are thread state too: a deleted thread
    // must not leave a readable secret behind.
    await this.host.state.agentSecrets
      .deleteThreadSecrets(threadId)
      .catch((error: unknown) => Logger.error('Thread secret cleanup failed:', error))

    // A capability the user scoped to this thread is thread state as well: its
    // entry can never resolve for another conversation, and its install folder
    // goes with the thread's own directories, so the entry goes here. Credentials
    // it collected go with it rather than lingering in the vault unreferenced.
    await this.host.units['utilities'].removeThreadScopedUtilities(threadId)
  }
}
