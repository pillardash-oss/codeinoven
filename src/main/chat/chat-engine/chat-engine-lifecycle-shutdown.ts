import { Logger } from '../../system/logger'
import { instanceRegistry } from '../../system/instance-registry'
import { APP_NAME } from '../../../lib/brand'
import type { SessionInfo } from './chat-engine-types'
import { ChatEngine } from '../chat-engine'

/** ChatEngine lifecycle-shutdown: one concern, moved verbatim from the composition root. */
export class ChatEngineLifecycleShutdown {
  constructor(private readonly host: ChatEngine) {}

  /**
   * Terminate every harness connection that is still active. Called when the
   * user explicitly confirms a forced close (the working-threads confirmation
   * modal), so a local project's SSE stream / harness process is SIGTERM'd
   * immediately instead of lingering after the app exits. Best-effort and
   * never throws; sessions already idle are left alone for the normal dispose
   * path to tear down.
   */
  async terminateActiveConnections(): Promise<void> {
    const active: Array<{ sessionId: string; info: SessionInfo }> = []
    for (const [sessionId, status] of this.host.sessionStatuses) {
      // "Working" is a streaming turn; "waiting" is a live connection paused on
      // a permission/question reply. Both hold a harness process open.
      if (status.state !== 'working' && status.state !== 'waiting') continue
      const info = this.host.sessionRegistry.get(sessionId)
      if (info) active.push({ sessionId, info })
    }
    await Promise.allSettled(
      active.map(async ({ sessionId, info }) => {
        const driver = this.host.units['turns-dispatch'].driverForRuntime(
          info.driverId,
          info.accountId
        )
        if (!driver) return
        try {
          if (driver.terminate) {
            await driver.terminate(info.projectPath, sessionId)
          } else {
            await driver.abort(info.projectPath, sessionId)
          }
        } catch (error) {
          Logger.dev('Forced-close termination of a harness session failed:', error)
        }
      })
    )
  }

  /**
   * Stop the work behind this engine's session counts, for the force-install
   * override the user explicitly confirms.
   *
   * Named apart from {@link terminateActiveConnections} because the two are
   * reached from different promises: a forced close terminates the connections
   * and then lets the shutdown pipeline finish disposing everything, whereas a
   * forced install has no pipeline left to run, so anything holding a session
   * open has to be let go here too. Without it, a harness turn the user just
   * agreed to abandon would be torn down mid-dispatch by the installer's exit
   * instead of by the same deliberate path a close uses.
   *
   * Best-effort and never throws: the caller installs regardless, and one
   * uncooperative session must not keep the others alive.
   */
  async terminateActiveWork(): Promise<void> {
    try {
      await this.host.terminateActiveConnections()
    } catch (error) {
      Logger.error('Could not stop active sessions before a forced install', error)
    }
  }

  /** Kill all pooled driver resources (called on app quit). */
  async dispose(): Promise<void> {
    this.host.state.stopRemoteRetryReconciliation?.()
    this.host.state.stopRemoteRetryReconciliation = null
    for (const [requestId, pending] of this.host.state.pendingPermissions) {
      if (!pending.settleBrowserAction) continue
      this.host.state.pendingPermissions.delete(requestId)
      pending.settleBrowserAction(false)
    }
    this.host.state.ovenChat.dispose()
    if (this.host.state.streamBroadcastTimer) {
      clearTimeout(this.host.state.streamBroadcastTimer)
      this.host.state.streamBroadcastTimer = null
    }
    this.host.state.pendingStreamBroadcasts.clear()
    this.clearIdleReaper()
    if (this.host.state.assignmentApiServer) {
      await new Promise<void>((resolveClose) => {
        this.host.state.assignmentApiServer?.close(() => resolveClose())
      })
      this.host.state.assignmentApiServer = null
      this.host.state.assignmentApiBaseUrl = ''
    }
    // Kill agent-owned descendants before any slower session/runtime cleanup so
    // the shutdown failsafe cannot leave a development server behind.
    for (const driver of this.host.units['turns'].allDrivers()) {
      try {
        driver.prepareForProcessCleanup?.()
      } catch (error) {
        Logger.error(`${driver.name} process cleanup preparation failed:`, error)
      }
    }
    await this.host.state.agentProcesses.killAll()
    await Promise.allSettled(
      [...this.host.state.temporaryChats.keys()].map((temporaryChatId) =>
        this.host.closeTemporaryChat(temporaryChatId)
      )
    )
    await Promise.allSettled(
      [...this.host.state.utilityTurns.keys()].map((sessionId) =>
        this.host.units['utilities'].cleanupTurnUtilities(sessionId)
      )
    )
    for (const driver of this.host.units['turns'].allDrivers()) {
      driver.dispose()
    }
    this.host.state.accountDrivers.clear()
    await this.host.state.utilityOrchestration.dispose()
    await this.host.state.utilityRuntime.dispose()
    this.host.state.retryScheduler?.dispose()
    this.host.state.retryScheduler = null
    this.host.state.connectivity = null
    this.host.sessionRegistry.clear()
    this.host.state.childSessionOwners.clear()
    this.host.state.childCaptureTasks.clear()
    this.host.state.childSessionActivityStatuses.clear()
    this.host.sessionStatuses.clear()
    this.host.state.pendingPermissions.clear()
    for (const pending of this.host.pendingQuestions.values()) {
      clearTimeout(pending.timer)
    }
    this.host.pendingQuestions.clear()
    for (const pending of this.host.state.pendingImageDescriptorDecisions.values()) {
      this.host.units['media-visual'].settleImageDescriptorDecision(pending)
    }
    for (const waiter of this.host.state.completionWaiters.values()) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer)
      waiter.reject(new Error(`${APP_NAME} is shutting down`))
    }
    this.host.state.completionWaiters.clear()
    this.host.state.pendingMemoryDecisions.clear()
    this.host.state.initialSpecTasks.clear()
    this.host.state.activeInitialSpecSessions.clear()
    this.host.state.userAbortedInitialSpecOperations.clear()
    this.host.state.activeAssignmentDraftRuns.clear()
    this.host.state.activeAssignmentDraftSessions.clear()
    this.host.state.userAbortedAssignmentDraftOperations.clear()
    this.host.state.activeAchievementAuditorEnsures.clear()
    this.host.state.activeAchievementAuditRuns.clear()
    this.host.state.unsupportedStructuredOutputModels.clear()
    this.host.state.activeBrainstormOperations.clear()
    this.host.state.activeBrainstormFinalizes.clear()
    this.host.state.activeBrainstormSessions.clear()
    this.host.state.activeBrainstormConversationTurns.clear()
    this.host.state.userAbortedBrainstormOperations.clear()
    this.host.state.activeBrainstormEntryOperations.clear()
    this.host.state.pendingSpecRevisions.clear()
    this.host.state.pendingPrdTurns.clear()
    this.host.state.pendingAssignmentTurns.clear()
    this.host.state.pendingBrainstormTurns.clear()
    this.host.state.activeCompactions.clear()
    this.host.state.specRevisionTasks.clear()
    this.host.state.prdTurnTasks.clear()
    this.host.state.assignmentTurnTasks.clear()
    this.host.state.preparedImplementationSessions.clear()
    this.host.state.planningSessions.clear()
    this.host.handledIdleSessions.clear()
    this.host.state.userAbortedSessions.clear()
    this.host.state.engineeringImplementationSessions.clear()
    this.host.state.providerCache.clear()
    this.host.state.assignmentApiCapabilities.clear()
    this.host.state.assignmentApiQueues.clear()
    this.host.state.coordinatorHandoffQueueLocks.clear()
    this.host.state.coordinatorHandoffDrains.clear()
    this.host.state.dispatchingCoordinatorHandoffIds.clear()
  }

  /**
   * Release each harness's in-memory resources for projects that have been
   * fully idle (no working turns, no pending input, no in-flight work) for the
   * grace period: pooled servers are stopped, CLI session caches are evicted,
   * and any agent-spawned processes are released. Sessions persist in each
   * harness's own store, so they rehydrate the next time the project is used  
   * the same session ids are simply re-served.
   */
  async reapIdleResources(): Promise<void> {
    // Session ids that must keep their project's resources alive.
    const protectedSessions = new Set<string>()
    for (const pending of this.host.pendingQuestions.values()) {
      protectedSessions.add(pending.request.sessionId)
    }
    for (const pending of this.host.state.pendingPermissions.values()) {
      protectedSessions.add(pending.request.sessionId)
    }
    for (const sessionId of this.host.state.completionWaiters.keys()) {
      protectedSessions.add(sessionId)
    }
    for (const sessionId of this.host.state.utilityTurns.keys()) {
      protectedSessions.add(sessionId)
    }

    // Seed projects from every driver operation, including probes that run
    // before a session exists, then merge registered session activity over it.
    const projects = new Map<string, { projectPaths: Set<string>; active: boolean }>()
    for (const [projectId, projectPaths] of this.host.state.projectResourcePaths) {
      projects.set(projectId, { projectPaths: new Set(projectPaths), active: false })
    }
    for (const [sessionId, info] of this.host.sessionRegistry) {
      const status = this.host.sessionStatuses.get(sessionId)?.state
      const active =
        status === 'working' || status === 'waiting' || protectedSessions.has(sessionId)
      const existing = projects.get(info.projectId)
      projects.set(info.projectId, {
        projectPaths: new Set([...(existing?.projectPaths ?? []), info.projectPath]),
        active: (existing?.active ?? false) || active
      })
    }
    // A delegated worker keeps its project busy even when the thread that
    // spawned it looks idle: the worker lives inside its parent harness
    // process, so releasing that process would silently kill work in flight.
    for (const [childSessionId, owner] of this.host.state.childSessionOwners) {
      const status = this.host.sessionStatuses.get(childSessionId)?.state
      const active = status === 'working' || status === 'waiting'
      const existing = projects.get(owner.projectId)
      projects.set(owner.projectId, {
        projectPaths: new Set([...(existing?.projectPaths ?? []), owner.projectPath]),
        active: (existing?.active ?? false) || active
      })
    }

    const now = Date.now()
    for (const [projectId, project] of projects) {
      if (project.active) {
        this.host.state.projectIdleSince.delete(projectId)
        this.host.state.releasedProjects.delete(projectId)
        continue
      }
      // Already released once this active→idle cycle   do not re-release.
      if (this.host.state.releasedProjects.has(projectId)) continue
      const since = this.host.state.projectIdleSince.get(projectId) ?? now
      if (now - since < ChatEngine.IDLE_PROJECT_GRACE_MS) {
        this.host.state.projectIdleSince.set(projectId, since)
        continue
      }
      this.host.state.projectIdleSince.delete(projectId)
      this.host.state.releasedProjects.add(projectId)
      this.host.state.projectResourcePaths.delete(projectId)
      Logger.info('Releasing idle project harness resources to free memory', {
        projectId,
        projectPaths: [...project.projectPaths]
      })
      for (const projectPath of project.projectPaths) {
        for (const driver of this.host.units['turns'].allDrivers()) {
          try {
            await driver.releaseProjectResources?.(projectPath)
          } catch (error) {
            Logger.error('Idle harness resource release failed:', error)
          }
        }
      }
      // Drop the per-session bookkeeping for this project's sessions. The
      // harness sessions themselves are untouched   they rehydrate from disk.
      for (const [sessionId, info] of this.host.sessionRegistry) {
        if (info.projectId !== projectId) continue
        this.host.sessionStatuses.delete(sessionId)
        this.host.state.reasoningTimes.delete(sessionId)
        this.host.state.toolTimes.delete(sessionId)
        this.host.handledIdleSessions.delete(sessionId)
        this.host.state.outboundMessageIdsBySession.delete(sessionId)
      }
    }

    this.host.units['providers-harness'].applyDeferredHarnessRestarts()
    await this.host.units['processes'].sweepOrphanedProcesses()
    // The pass may have released the last project, or emptied the last queue it
    // was running for: the reaper only stays armed while there is something left
    // to look at. A session that arrives while this pass was awaiting re-arms it.
    this.syncIdleReaper()
  }

  /**
   * Arm or clear the idle reaper for what this engine is actually holding.
   *
   * The reaper releases the harness resources of idle projects, applies harness
   * restarts that were deferred while a session was busy, and reclaims harness
   * processes from a sibling that died. Every one of those needs something to act
   * on: a registered session, a project whose resources are still tracked, a queued
   * restart, or a peer instance that could leave an orphan behind. With none of
   * them the pass would only prove there is still nothing to do, once a minute,
   * for as long as the app is open.
   */
  syncIdleReaper(): void {
    if (this.shouldReap()) this.armIdleReaper()
    else this.clearIdleReaper()
  }

  shouldReap(): boolean {
    if (this.host.sessionRegistry.size > 0) return true
    if (this.host.state.projectResourcePaths.size > 0) return true
    if (this.host.state.deferredHarnessRestarts.size > 0) return true
    // A sibling's harness roots are journaled in the journal this app shares, so
    // only a live peer can leave a process for the periodic sweep to reclaim; a
    // launch reaps whatever a crash left before any of this runs.
    try {
      return instanceRegistry.hasOtherLiveInstance()
    } catch {
      // An unreadable registry is not evidence that a peer is gone.
      return true
    }
  }

  armIdleReaper(): void {
    if (this.host.state.idleReaperTimer) return
    this.host.state.idleReaperTimer = setInterval(
      () => void this.reapIdleResources(),
      ChatEngine.IDLE_REAP_INTERVAL_MS
    )
    this.host.state.idleReaperTimer.unref?.()
  }

  clearIdleReaper(): void {
    if (!this.host.state.idleReaperTimer) return
    clearInterval(this.host.state.idleReaperTimer)
    this.host.state.idleReaperTimer = null
  }
}
