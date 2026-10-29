import { resolve } from 'path'
import { Logger } from '../../system/logger'
import type { HarnessDriver } from '../../drivers/driver.interface'
import type { HarnessCommand, HarnessRuntimeRestartResult } from '../../../lib/types'
import { rawErrorMessage } from './chat-engine-errors'
import {
  mergeAgentMessages,
  restoreMirrorAccount,
  restoreMirrorThinkingLevel,
  stampAccount,
  stampHarnessId
} from './chat-engine-message-merge'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine providers-harness: one concern, moved verbatim from the composition root. */
export class ChatEngineProvidersHarness {
  constructor(private readonly host: ChatEngine) {}

  /**
   * Restart a harness's resident transports so the next turn runs the harness
   * binary currently on disk.
   *
   * Every long-lived harness process (OpenCode's `serve`, Codex's app-server
   * daemon, Pi's per-session RPC client) was spawned from the install that was
   * on disk when the session first needed it, and it keeps that build alive for
   * as long as it runs. A harness self-update therefore changes nothing for
   * sessions already using it: the version probe re-reads the new binary and
   * reports the update as applied while the app keeps talking to the old
   * process. Restarting is what makes an update take effect without an app
   * restart.
   *
   * Sessions persist in each harness's own store, so a restart resumes them.
   * `force` restarts even while threads are mid-turn, which stops those turns
   * (the manual action makes the user confirm exactly that); without it a busy
   * harness is remembered and restarted by the idle reaper once its threads
   * have all gone quiet, so a background update still lands.
   */
  async restartHarnessRuntime(
    harnessId: string,
    options: { force?: boolean } = {}
  ): Promise<HarnessRuntimeRestartResult> {
    const drivers = this.harnessDrivers(harnessId)
    if (drivers.length === 0) {
      return {
        harnessId,
        restarted: false,
        interruptedSessions: 0,
        detail: `CodeInOven has no ${harnessId} driver, so there is nothing to restart.`
      }
    }

    const busy = this.busySessionsForHarness(harnessId)
    if (busy.length > 0 && options.force !== true) {
      this.host.state.deferredHarnessRestarts.add(harnessId)
      return {
        harnessId,
        restarted: false,
        interruptedSessions: 0,
        detail: `${busy.length} thread${busy.length === 1 ? '' : 's'} still running on ${harnessId}; the restart waits for them to finish.`
      }
    }

    this.host.state.deferredHarnessRestarts.delete(harnessId)
    for (const driver of drivers) {
      try {
        await driver.restartRuntime?.()
      } catch (error) {
        // One container's transport failing to restart must not stop the rest.
        Logger.error('Harness runtime restart failed:', error)
      }
    }
    Logger.info('Restarted harness runtime', { harnessId, interruptedSessions: busy.length })
    return { harnessId, restarted: true, interruptedSessions: busy.length }
  }

  /**
   * A harness update that landed while a thread was still running is applied
   * here, once that harness has gone quiet. The reaper already runs on a fixed
   * cadence and already knows how to tell a busy harness from an idle one, so
   * the deferred restart rides that check instead of racing the idle
   * transition it would have to detect itself.
   */
  applyDeferredHarnessRestarts(): void {
    for (const harnessId of [...this.host.state.deferredHarnessRestarts]) {
      if (this.busySessionsForHarness(harnessId).length > 0) continue
      void this.host.restartHarnessRuntime(harnessId).catch((error) => {
        Logger.error('Deferred harness restart failed:', error)
      })
    }
  }

  /**
   * Validate the harness id at the IPC boundary: it arrives from the renderer
   * as untrusted input, like every other privileged channel argument.
   */
  requireHarnessId(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
      throw new TypeError('Harness ID is invalid')
    }
    return value.trim()
  }

  /**
   * Sessions the engine still considers busy on a harness: a turn that is
   * running or waiting on its provider, a card the user has not answered, a
   * delegated worker inside the harness process, or a turn the engine is still
   * finalizing. Their transport may not be taken away unannounced.
   */
  busySessionsForHarness(harnessId: string): string[] {
    const busy = new Set<string>()
    for (const [sessionId, info] of this.host.sessionRegistry) {
      if (info.driverId !== harnessId) continue
      const state = this.host.sessionStatuses.get(sessionId)?.state
      if (state === 'working' || state === 'waiting') busy.add(sessionId)
    }
    // A card on screen owns the harness process that asked for it, even once
    // the session's own status has settled.
    for (const pending of this.host.pendingQuestions.values()) {
      if (pending.driverId === harnessId) busy.add(pending.request.sessionId)
    }
    for (const pending of this.host.state.pendingPermissions.values()) {
      if (pending.driverId === harnessId) busy.add(pending.request.sessionId)
    }
    for (const [childSessionId, child] of this.host.state.childSessionOwners) {
      if (child.driverId !== harnessId) continue
      const state = this.host.sessionStatuses.get(childSessionId)?.state
      if (state === 'working' || state === 'waiting') busy.add(childSessionId)
    }
    for (const sessionId of this.host.state.completionWaiters.keys()) {
      if (this.host.sessionRegistry.get(sessionId)?.driverId === harnessId) busy.add(sessionId)
    }
    for (const sessionId of this.host.state.utilityTurns.keys()) {
      if (this.host.sessionRegistry.get(sessionId)?.driverId === harnessId) busy.add(sessionId)
    }
    return [...busy]
  }

  /**
   * Every live driver instance serving a harness: the default one plus each
   * managed account container's own instance, which holds its own transports.
   */
  harnessDrivers(harnessId: string): HarnessDriver[] {
    return [this.host.drivers.get(harnessId), ...this.host.state.accountDrivers.values()].filter(
      (driver): driver is HarnessDriver => driver !== undefined && driver.id === harnessId
    )
  }

  /** True when any driver for a harness (default or account-scoped) has a live turn. */
  harnessHasActiveTurn(harnessId: string): boolean {
    for (const driver of this.harnessDrivers(harnessId)) {
      if (!driver.hasActiveTurn) continue
      for (const sessionId of this.host.sessionRegistry.keys()) {
        if (driver.hasActiveTurn(sessionId)) return true
      }
    }
    return false
  }

  /**
   * Best-effort retire a harness session that a thread abandoned when its
   * harness was switched. Retires in-memory state first so the orphaned
   * session never broadcasts again, then parks the previous driver's session:
   * the record and its native transcript stay on disk so a switch back to that
   * harness resumes it warm instead of rebuilding it cold. Drivers without a
   * parked-session contract keep the old behavior and release the session.
   * Never throws: a failed cleanup must not block the already-successful switch.
   */
  async releaseOrphanedHarnessSession(
    projectId: string,
    threadId: string,
    projectPath: string,
    previousHarnessId: string,
    previousAccountId: string,
    previousSessionId: string
  ): Promise<void> {
    this.host.units['turns-sessions'].retireSessionState(previousSessionId)
    const previousDriver = await this.host
      .driverForAccount(previousHarnessId, previousAccountId)
      .catch(() => undefined)
    // The orphaned session's transcript must land in the app mirror before its
    // native session is destroyed, so the user never loses the old harness's
    // final output when they switch harnesses. Best-effort and non-throwing:
    // the idle sync usually already mirrored the completed turn.
    if (previousDriver?.loadMessages) {
      try {
        const previousAccount = await this.host.state.accountRegistry.resolve(
          previousHarnessId,
          previousAccountId
        )
        const previousMessages = stampAccount(
          stampHarnessId(
            await previousDriver.loadMessages(projectPath, previousSessionId),
            previousHarnessId
          ),
          previousAccount.id,
          previousAccount.label
        )
        if (previousMessages.length > 0) {
          const mirror = await this.host.threadManager.loadMessageRecords(projectId, threadId)
          const merged = restoreMirrorAccount(
            restoreMirrorThinkingLevel(mergeAgentMessages(mirror, previousMessages), mirror),
            mirror
          )
          await this.host.threadManager.upsertMessages(
            projectId,
            threadId,
            merged,
            previousSessionId
          )
          Logger.info('Synced orphaned harness session transcript before release', {
            projectId,
            threadId,
            previousHarnessId,
            previousSessionId,
            messageCount: previousMessages.length
          })
        }
      } catch (error) {
        Logger.info('Orphaned harness session transcript sync skipped', {
          projectId,
          threadId,
          previousHarnessId,
          previousSessionId,
          detail: rawErrorMessage(error)
        })
      }
    }
    if (!previousDriver) return
    if (previousDriver.parkThreadSession) {
      try {
        await previousDriver.parkThreadSession(projectPath, threadId, previousSessionId)
        Logger.info('Parked orphaned harness session after harness switch', {
          projectId,
          threadId,
          previousHarnessId,
          previousSessionId
        })
        return
      } catch (error) {
        Logger.info('Failed to park orphaned harness session after harness switch', {
          projectId,
          threadId,
          previousHarnessId,
          previousSessionId,
          detail: rawErrorMessage(error)
        })
      }
    }
    if (!previousDriver.deleteSession) {
      Logger.info('Orphaned harness session has no deletable native session', {
        projectId,
        threadId,
        previousHarnessId,
        previousSessionId
      })
      return
    }
    try {
      await previousDriver.deleteSession(projectPath, previousSessionId)
      Logger.info('Released orphaned harness session after harness switch', {
        projectId,
        threadId,
        previousHarnessId,
        previousSessionId
      })
    } catch (error) {
      Logger.info('Failed to release orphaned harness session after harness switch', {
        projectId,
        threadId,
        previousHarnessId,
        previousSessionId,
        detail: rawErrorMessage(error)
      })
    }
  }

  /** Merge driver-native commands with skills the active headless harness can invoke. */
  async discoverHarnessCommands(
    driver: HarnessDriver,
    projectPath: string
  ): Promise<HarnessCommand[]> {
    const rawCommands = await driver.listCommands(projectPath)
    // A driver can report skills it loaded from the shared layer even when the
    // skill is actually owned by another harness's exclusive directory. Drop
    // those so the slash menu only offers skills the selected harness owns.
    const claims = await this.host.state.capabilityDiscovery.harnessSkillClaims(projectPath)
    const commands = rawCommands.filter((command) => {
      if (command.source !== 'skill') return true
      const claimants = claims.get(command.name.toLowerCase())
      return !claimants || claimants.has(driver.id)
    })
    const discovered = [...commands]
    if (driver.id === 'claude-code') {
      const capabilities = await this.host.state.capabilityDiscovery.discover(
        projectPath,
        driver.id
      )
      discovered.push(
        ...capabilities.skill
          .filter((skill) => skill.enabled)
          .map((skill): HarnessCommand => ({
            name: skill.name,
            description: skill.description || 'Invoke this skill in the active session',
            source: 'skill'
          }))
      )
    }
    return discovered.filter(
      (command) =>
        command.source === 'skill' ||
        command.name === 'config' ||
        command.name === 'settings' ||
        command.name === 'usage-credits'
    )
  }
}
