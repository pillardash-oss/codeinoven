import { randomInt } from 'crypto'
import { Logger } from '../../../system/logger'
import {
  PAWN_DEFAULT_PERMISSION_LEVEL,
  PAWN_DEFAULT_THINKING_LEVEL
} from '../../../../lib/pawn-tools'
import { PAWN_AGENT_CONTRACT } from '../../../../lib/agent-behavior'
import { DEFAULT_HARNESS } from '../../../../lib/harness-default'
import { isUnrestrictedLevel } from '../../../../lib/permission-level'
import { isPawnWorkerThread } from '../../thread-transfer-service/thread-transfer-workers'
import { validateThreadSettings } from '../../../ipc/ipc-validation'
import type { HarnessDriver } from '../../../drivers/driver.interface'
import type { PawnToolContext } from '../../../utilities/utility-orchestration-service'
import type {
  AgentPart,
  AgentSubagentActivity,
  AgentToolStatus,
  Thread,
  ThreadSettings,
  ThreadStatus
} from '../../../../lib/types'
import { messageId as createMessageId } from '../../../../lib/id'
import { rawErrorMessage } from '../chat-engine-errors'
import { ChatEngine, pawnModelOverride, pawnThinkingOverride } from '../../chat-engine'
import {
  type DelegationTarget,
  delegationFieldsFromInput,
  resolveDelegationTarget
} from '../../delegation/delegation-target'
import { awaitDelegationOutcome } from '../../delegation/delegation-report-grace'

/**
 * Pawn agents: the worker threads an agent spawns for itself.
 *
 * A pawn is a real thread on a harness of its choosing that answers only to the
 * agent that spawned it. This unit owns its whole life   creating the thread
 * from a resolved target, steering it, following it to a real finish (including
 * through a provider retry), publishing its card into the spawner's trace, and
 * steering the finished report back.
 *
 * It owns nothing about Assignments, audits or transferred workers: those are
 * separate concerns in the composition root, which forwards the four pawn entry
 * points other units call.
 */
export class ChatEnginePawnAgents {
  constructor(private readonly host: ChatEngine) {}

  /** The pawn threads `spawnerThreadId` owns, whose runs this process holds. */
  async runningPawnThreads(projectId: string, spawnerThreadId: string): Promise<Thread[]> {
    const running: Thread[] = []
    for (const pawn of await this.pawnThreadsOf(projectId, spawnerThreadId)) {
      const ownerPid = await this.host.checkpointManager.activeTurnOwnerPid(projectId, pawn.id)
      if (ownerPid === process.pid) running.push(pawn)
    }
    return running
  }

  /** The pawn threads one thread spawned, whoever is running them. */
  async pawnThreadsOf(projectId: string, spawnerThreadId: string): Promise<Thread[]> {
    try {
      const threads = await this.host.threadManager.listThreads(projectId)
      return threads.filter((candidate) => isPawnWorkerThread(candidate, spawnerThreadId))
    } catch (error) {
      Logger.dev('Transferred-thread pawn lookup failed:', {
        projectId,
        spawnerThreadId,
        error: rawErrorMessage(error)
      })
      return []
    }
  }

  /**
   * Restart the pawn threads a release handed over.
   *
   * A pawn runs on a thread of its own, so a hand-off really does move it: the
   * departing instance stopped its run, and this instance continues the same
   * persisted session. Only the threads the release names are resumed, because a
   * pawn that had already finished must not be handed a fresh turn.
   */
  async resumeTransferredPawns(
    projectId: string,
    threadId: string,
    pawnThreadIds: readonly string[]
  ): Promise<void> {
    if (pawnThreadIds.length === 0) return
    for (const pawn of await this.pawnThreadsOf(projectId, threadId)) {
      if (!pawnThreadIds.includes(pawn.id)) continue
      try {
        await this.host.units['thread-lifecycle'].resumeThreadFromPersistedSession(pawn, {
          force: true,
          allowAgentOwnedThread: true
        })
      } catch (error) {
        // A pawn that will not resume must not fail the transfer: the primary is
        // already running here, and the pawn's thread is still open for the user.
        Logger.error('A transferred pawn agent could not be resumed:', {
          projectId,
          pawnThreadId: pawn.id,
          error: rawErrorMessage(error)
        })
      }
    }
  }

  /**
   * Run one engineering artifact tool for the turn that asked for it.
   *
   * Each artifact is created through the same machinery the Studio buttons use:
   * an isolated generation session that persists a reviewable draft and
   * broadcasts the matching `ready` event. Nothing is approved, implemented or
   * signed off on the user's behalf, so the existing review surface keeps owning
   * that decision. A request that cannot produce the artifact throws with a
   * plain reason the agent can relay or act on.
   */
  /**
   * Publish a pawn agent's activity onto the thread that spawned it.
   *
   * A pawn is a real thread, so its own transcript lives on that thread; the
   * spawning conversation gets the same card a nested sub-agent gets, carrying
   * the prompt the agent gave, the pawn's own session id (which its transcript
   * view loads) and, when it settles, its final report. The part is written to
   * the thread as a working-trace message and broadcast, so it survives a reopen
   * and updates live, exactly like a sub-agent part the harness streamed.
   */
  async publishPawnActivity(
    projectId: string,
    spawnerThreadId: string,
    spawnerSessionId: string,
    activity: AgentSubagentActivity
  ): Promise<void> {
    const part: Extract<AgentPart, { type: 'subagent' }> = {
      type: 'subagent',
      id: `pawn:${projectId}:${activity.childSessionId ?? spawnerThreadId}`,
      messageID: `pawn:${projectId}:${activity.childSessionId ?? spawnerThreadId}`,
      callID: `pawn:${projectId}:${activity.childSessionId ?? spawnerThreadId}`,
      activity
    }
    await this.host.threadManager
      .upsertMessages(projectId, spawnerThreadId, [
        {
          id: part.messageID,
          role: 'assistant',
          origin: 'subagent',
          visibility: 'working_trace',
          createdAt: activity.time?.start ?? Date.now(),
          ...(activity.time?.end === undefined ? {} : { completedAt: activity.time.end }),
          parts: [part]
        }
      ])
      .catch((error: unknown) =>
        Logger.info('Pawn activity could not be persisted', {
          spawnerThreadId,
          error: error instanceof Error ? error.message : String(error)
        })
      )
    if (this.host.sessionRegistry.get(spawnerSessionId)) {
      this.host.broadcast({ type: 'message.part.updated', sessionId: spawnerSessionId, part })
    }
  }

  /**
   * Spawn or continue a pawn agent: an independent worker thread owned by the
   * agent whose turn called the tool.
   *
   * The pawn is a real thread, not a nested session: it carries
   * `coordinatorThreadId` (which hides it from the thread list and keeps it out
   * of capacity accounting), `userInputLocked` (which refuses user-origin
   * prompts while internal turns still run), and the spawner's own permission
   * level, so a pawn can never do more than the agent that spawned it.
   *
   * Nothing here writes the user's pawn default: the configured selection is read
   * once per spawn and never replaced, so only the settings page can change it.
   */
  async runPawnTool(input: Record<string, unknown>, context: PawnToolContext): Promise<unknown> {
    const { projectId, threadId } = context
    const spawner = await this.host.threadManager.getThread(projectId, threadId)
    if (!spawner?.settings) {
      throw new Error('Select a model for this thread before spawning a pawn agent.')
    }
    if (spawner.userInputLocked === true || spawner.coordinatorThreadId) {
      throw new Error(
        'A pawn agent cannot spawn pawn agents. Report to the agent that spawned you instead.'
      )
    }
    const spawnerSettings = validateThreadSettings(spawner.settings)
    const rawInstructions = input['instructions']
    const instructions = typeof rawInstructions === 'string' ? rawInstructions.trim() : ''
    if (!instructions) {
      throw new Error('Describe the complete task for the pawn agent in `instructions`.')
    }
    const rawPurpose = input['purpose']
    const purpose = typeof rawPurpose === 'string' ? rawPurpose.trim() : ''
    const rawPawnId = input['pawn_id']
    const pawnId = typeof rawPawnId === 'string' ? rawPawnId.trim() : ''
    const background = input['background'] === true

    const pawn = pawnId
      ? await this.requirePawnThread(projectId, threadId, pawnId)
      : await this.spawnPawnThread(
          projectId,
          spawner,
          spawnerSettings,
          input,
          purpose,
          instructions
        )
    const settings = pawn.settings
    if (!settings) throw new Error('The pawn agent has no model settings.')

    const driverId = settings.harnessId || DEFAULT_HARNESS
    const { driver, projectPath } = await this.host.resolve(
      projectId,
      driverId,
      pawn.id,
      settings.accountId
    )
    const sessionId = await this.host.ensureSession(projectId, pawn.id, driverId)
    const startedAt = Date.now()
    // A pawn's session belongs to the pawn's own thread. Registering the owner
    // here is what lets the spawning conversation's card open the pawn's
    // transcript: the child-session lookup resolves this session to that thread
    // and reads its mirrored messages, while the pawn keeps running.
    this.host.state.childSessionOwners.set(sessionId, {
      projectId,
      threadId: pawn.id,
      projectPath,
      driverId,
      accountId: settings.accountId
    })
    this.host.state.childSessionActivityStatuses.set(sessionId, 'running')
    const pawnActivity = (
      status: AgentToolStatus,
      patch: Partial<AgentSubagentActivity> = {}
    ): AgentSubagentActivity => ({
      status,
      agent: purpose || 'Pawn agent',
      description: purpose,
      prompt: instructions,
      childSessionId: sessionId,
      providerId: settings.providerId,
      modelId: settings.modelId,
      background,
      pawn: true,
      time: { start: startedAt, ...(status === 'running' ? {} : { end: Date.now() }) },
      ...patch
    })
    await this.publishPawnActivity(projectId, threadId, context.sessionId, pawnActivity('running'))
    const prompt = [
      `You are a CodeInOven pawn agent: an independent worker thread spawned by the agent working on thread ${threadId}, and you answer to that agent alone.`,
      purpose ? `Purpose: ${purpose}.` : '',
      `You run on ${settings.harnessId}${settings.ovenId === spawner.settings?.ovenId ? '' : ` on the Oven ${settings.ovenId}`}, which may be a different harness from the agent that spawned you. Nothing about your instructions changes because of that: work in this checkout, use this harness's own tools, and report back the same way.`,
      'The user cannot prompt you and does not answer you. Work autonomously, do not ask the user questions, and do not commit: the agent that spawned you reviews your work and commits it. Your report lists every path you changed as uncommitted, because that list is the only thing its commit can rely on.',
      isUnrestrictedLevel(settings.permissionLevel)
        ? 'You have full access to this project.'
        : 'Destructive actions need approval, which is surfaced on the thread that spawned you.',
      PAWN_AGENT_CONTRACT,
      '',
      'Instruction from the agent that spawned you:',
      '',
      instructions
    ]
      .filter(Boolean)
      .join('\n')

    const messageId = createMessageId()
    // Steering: an instruction for a pawn that is still working goes into the
    // work in progress, because a harness takes a prompt sent to a live session
    // into its running turn instead of refusing it. That is how a user who
    // dislikes the direction reaches a pawn: they tell the agent that spawned it,
    // and that agent calls this tool again with the same `pawn_id`.
    //
    // A steer must not arm a second completion waiter. There is exactly one per
    // session, so replacing the one the spawn armed would strand it until its
    // timer fired and then report a failure that never happened.
    const pawnIsWorking =
      this.host.state.childSessionActivityStatuses.get(sessionId) === 'running' ||
      this.host.sessionStatuses.get(sessionId)?.state === 'working'
    const steer = pawnId !== '' && pawnIsWorking
    if (steer) {
      await this.host.sendPrompt(
        projectId,
        pawn.id,
        settings,
        prompt,
        [],
        undefined,
        messageId,
        undefined,
        undefined,
        undefined,
        'internal',
        {
          action: `Update from the agent that spawned you · ${pawn.title}`.slice(0, 120),
          body: instructions.slice(0, 20_000)
        }
      )
      return {
        pawnId: pawn.id,
        threadId: pawn.id,
        title: pawn.title,
        status: 'running',
        steered: true,
        model: { providerId: settings.providerId, modelId: settings.modelId },
        thinkingLevel: settings.thinkingLevel,
        note: 'The update reached the pawn while it works, so it applies to the work in progress. Its report will steer you when it finishes; do not end your turn with nothing to do while it runs.'
      }
    }
    const completion = this.host.units['turns-sessions'].waitForSessionCompletion(
      sessionId,
      ChatEngine.PAWN_RUN_TIMEOUT_MS,
      'Pawn agent'
    )
    try {
      await driver.sendPrompt(projectPath, {
        sessionId,
        settings,
        text: prompt,
        attachments: [],
        userMessageId: messageId
      })
    } catch (error) {
      // The turn never started, so nothing will ever resolve this waiter. Keep
      // its rejection handled and let the original failure reach the agent.
      void completion.catch(() => undefined)
      throw error
    }

    /**
     * Follow the pawn until it has really finished, and report then.
     *
     * The waiter is not trusted once. A provider failure settles this turn, but
     * the app parks the thread on `working-paused` and retries it, so the failure
     * is not the answer: the report waits out the grace window and, when a retry
     * owns the thread, follows that turn instead of telling the spawner its pawn
     * died on a limit that has already reset.
     */
    const followPawnOutcome = (waiter: Promise<unknown>): void => {
      void waiter
        .then(
          () => ({ ok: true as const, message: '' }),
          (error: unknown) => ({
            ok: false as const,
            message: `The pawn agent failed: ${error instanceof Error ? error.message : String(error)}`
          })
        )
        .then(async (result) => {
          let outcome = result
          if (!outcome.ok) {
            const settlement = await awaitDelegationOutcome('failed', () =>
              this.pawnThreadStatus(projectId, pawn.id)
            )
            if (!settlement.report) {
              // The retry is running. Keep the card live and follow that turn.
              this.host.state.childSessionActivityStatuses.set(sessionId, 'running')
              followPawnOutcome(
                this.host.units['turns-sessions'].waitForSessionCompletion(
                  sessionId,
                  ChatEngine.PAWN_RUN_TIMEOUT_MS,
                  'Pawn agent'
                )
              )
              return
            }
            if (settlement.status === 'completed') outcome = { ok: true, message: '' }
          }
          const output = outcome.ok
            ? await this.pawnFinalMessage(driver, projectPath, sessionId)
            : outcome.message
          const report = output || 'The pawn agent returned no message.'
          this.host.state.childSessionActivityStatuses.set(
            sessionId,
            outcome.ok ? 'completed' : 'error'
          )
          await this.publishPawnActivity(
            projectId,
            threadId,
            context.sessionId,
            pawnActivity(
              outcome.ok ? 'completed' : 'error',
              outcome.ok ? { output: report } : { error: report }
            )
          )
          await this.reportPawnCompletion(projectId, spawnerSettings, pawn, purpose, report)
        })
        .catch((error: unknown) =>
          Logger.info('Pawn agent report could not reach its spawner', {
            threadId: pawn.id,
            spawnerThreadId: threadId,
            error: error instanceof Error ? error.message : String(error)
          })
        )
    }

    if (!background) {
      const verdict = await Promise.race([
        completion.then(
          () => 'completed' as const,
          (error: unknown) =>
            error instanceof Error ? error.message : 'The pawn agent session failed'
        ),
        new Promise<'running'>((resolve) => {
          const timer = setTimeout(() => resolve('running'), ChatEngine.PAWN_FOREGROUND_WAIT_MS)
          // Never let the budget timer hold the process open on its own.
          timer.unref?.()
        })
      ])
      if (verdict === 'completed') {
        const output = await this.pawnFinalMessage(driver, projectPath, sessionId)
        const report = output || 'The pawn agent returned no message.'
        this.host.state.childSessionActivityStatuses.set(sessionId, 'completed')
        await this.publishPawnActivity(
          projectId,
          threadId,
          context.sessionId,
          pawnActivity('completed', { output: report })
        )
        return {
          pawnId: pawn.id,
          threadId: pawn.id,
          title: pawn.title,
          status: 'completed',
          model: { providerId: settings.providerId, modelId: settings.modelId },
          thinkingLevel: settings.thinkingLevel,
          output: report
        }
      }
      if (verdict !== 'running') {
        // The retry policy may already own this thread, so the same grace applies
        // to a call that was waiting inline: report the failure only once the run
        // is still failed a minute later, and follow the retry when one started.
        const settlement = await awaitDelegationOutcome('failed', () =>
          this.pawnThreadStatus(projectId, pawn.id)
        )
        if (!settlement.report) {
          followPawnOutcome(
            this.host.units['turns-sessions'].waitForSessionCompletion(
              sessionId,
              ChatEngine.PAWN_RUN_TIMEOUT_MS,
              'Pawn agent'
            )
          )
          return {
            pawnId: pawn.id,
            threadId: pawn.id,
            title: pawn.title,
            status: 'running',
            model: { providerId: settings.providerId, modelId: settings.modelId },
            thinkingLevel: settings.thinkingLevel,
            note: 'The pawn hit a provider error and the app is retrying it, so this is not a failure yet. Its report will steer you when the retry settles; do not re-spawn it.'
          }
        }
        if (settlement.status === 'completed') {
          const output = await this.pawnFinalMessage(driver, projectPath, sessionId)
          const report = output || 'The pawn agent returned no message.'
          this.host.state.childSessionActivityStatuses.set(sessionId, 'completed')
          await this.publishPawnActivity(
            projectId,
            threadId,
            context.sessionId,
            pawnActivity('completed', { output: report })
          )
          return {
            pawnId: pawn.id,
            threadId: pawn.id,
            title: pawn.title,
            status: 'completed',
            model: { providerId: settings.providerId, modelId: settings.modelId },
            thinkingLevel: settings.thinkingLevel,
            output: report
          }
        }
        this.host.state.childSessionActivityStatuses.set(sessionId, 'error')
        await this.publishPawnActivity(
          projectId,
          threadId,
          context.sessionId,
          pawnActivity('error', { error: verdict })
        )
        throw new Error(`Pawn agent failed: ${verdict}`)
      }
    }

    // Background, or a foreground call that outlived its inline budget: report
    // once, when the pawn's thread has actually finished.
    followPawnOutcome(completion)
    return {
      pawnId: pawn.id,
      threadId: pawn.id,
      title: pawn.title,
      status: 'running',
      model: { providerId: settings.providerId, modelId: settings.modelId },
      thinkingLevel: settings.thinkingLevel,
      note: 'The pawn is still working. Its final report will steer you when it finishes; continue with other work and do not end the turn with nothing to do while it runs.'
    }
  }

  /**
   * Create the pawn's thread.
   *
   * The target is resolved exactly as a dispatch resolves one: nothing named
   * inherits the spawner's harness, account, model and Oven, and anything named
   * is validated against the real catalogs before a thread exists. A pawn is
   * therefore not tied to the harness that spawned it   `harnessId`, `accountId`
   * and `ovenId` decide where it runs, and the thread is created there.
   *
   * Hidden (owned by the spawner) and locked against user input, with the
   * thinking level at the lowest one unless this call named another.
   */
  async spawnPawnThread(
    projectId: string,
    spawner: Thread,
    spawnerSettings: ThreadSettings,
    input: Record<string, unknown>,
    purpose: string,
    instructions: string
  ): Promise<Thread> {
    const target = await this.resolvePawnTarget(projectId, spawnerSettings, input)
    const settings: ThreadSettings = {
      ...target.settings,
      // A pawn owns one task, so the Engineering planning modes and any audit
      // loop never follow it in: they belong to the thread the user is watching.
      assignmentMode: false,
      loopMode: false,
      loopAuditor: undefined,
      reportToCoordinator: undefined
    }
    const names = await this.host.storage.getWorkerNames()
    const name = names[randomInt(names.length)] ?? 'agent'
    const label = purpose || instructions.split('\n')[0].slice(0, 60)
    return this.host.threadManager.createThread({
      projectId,
      providerId: settings.providerId,
      title: `pawn-${name}: ${label}`.slice(0, 120),
      titleSource: 'manual',
      settings,
      featureSlug: spawner.featureSlug,
      scopeBucketId: spawner.scopeBucketId,
      // A working directory belongs to the machine that holds it. A pawn moved to
      // another Oven checks that machine's own checkout, so the spawner's local
      // path would point at a tree the pawn cannot see.
      ...(settings.ovenId === spawner.settings?.ovenId && spawner.workingDirectory
        ? { workingDirectory: spawner.workingDirectory }
        : {}),
      coordinatorThreadId: spawner.id,
      userInputLocked: true
    })
  }

  /**
   * Read where a pawn should run.
   *
   * The same resolver a dispatch uses, with the two pawn policies layered on: it
   * thinks at the lowest level unless told otherwise, and it starts at the app
   * default permission tier rather than inheriting full access from a
   * conversation nobody is watching.
   */
  async resolvePawnTarget(
    projectId: string,
    spawnerSettings: ThreadSettings,
    input: Record<string, unknown>
  ): Promise<DelegationTarget> {
    const deps = this.host.orchestration?.delegationDeps
    if (!deps) {
      throw new Error('Delegating work is not available on this thread yet. Try again.')
    }
    // `model` is the compact form the tool has always accepted. A model is only
    // "named" when this call named one: filling the rest in from the spawner
    // would turn every inheritance into a validated model switch.
    const compactModel = pawnModelOverride(input['model'])
    const explicit = delegationFieldsFromInput(input)
    const namedProviderId =
      explicit.providerId ??
      (compactModel && 'providerId' in compactModel ? compactModel.providerId : undefined)
    const namedModelId = explicit.modelId ?? compactModel?.modelId
    const namesModel = Boolean(explicit.harnessId || namedProviderId || namedModelId)
    // A provider and model named without a harness run on this thread's harness,
    // which is what the compact `provider/model` form has always meant. A harness
    // named on its own is passed through alone so the resolver refuses it with
    // the rule the agent has to follow.
    const namedHarnessId =
      explicit.harnessId ??
      (namedProviderId && namedModelId ? spawnerSettings.harnessId : undefined)
    const thinkingLevel = pawnThinkingOverride(input['thinking_level'])
    return resolveDelegationTarget(deps, {
      projectId,
      base: spawnerSettings,
      ...(namesModel && namedHarnessId ? { harnessId: namedHarnessId } : {}),
      ...(namedProviderId ? { providerId: namedProviderId } : {}),
      ...(namedModelId ? { modelId: namedModelId } : {}),
      ...(explicit.accountId ? { accountId: explicit.accountId } : {}),
      ...(explicit.ovenId ? { ovenId: explicit.ovenId } : {}),
      ...(explicit.ovenPath ? { ovenPath: explicit.ovenPath } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      thinkingFloor: PAWN_DEFAULT_THINKING_LEVEL,
      ...(explicit.permissionLevel ? { permissionLevel: explicit.permissionLevel } : {}),
      permissionFallback: PAWN_DEFAULT_PERMISSION_LEVEL
    })
  }

  /**
   * Resolve a pawn the caller already spawned. Ownership is enforced here and
   * nowhere else: a thread is a pawn of this turn only when it is locked and
   * points back at the calling thread, so one agent can never continue another's
   * pawn.
   */
  async requirePawnThread(
    projectId: string,
    spawnerThreadId: string,
    pawnId: string
  ): Promise<Thread> {
    const pawn = await this.host.threadManager.getThread(projectId, pawnId)
    if (
      !pawn ||
      pawn.coordinatorThreadId !== spawnerThreadId ||
      pawn.userInputLocked !== true ||
      pawn.auditorThreadId !== undefined
    ) {
      throw new Error(
        'That id is not a pawn agent this thread spawned. Spawn one by calling this tool without `pawn_id`.'
      )
    }
    return pawn
  }

  /** The pawn's own final message: the last assistant text on its thread. */
  async pawnFinalMessage(
    driver: HarnessDriver,
    projectPath: string,
    sessionId: string
  ): Promise<string> {
    const messages = await driver.loadMessages(projectPath, sessionId)
    const response = [...messages].reverse().find((message) => message.role === 'assistant')
    if (!response) return ''
    return response.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim()
  }

  /**
   * The pawn thread's status now, or null when the row is gone.
   *
   * Read after the grace window rather than remembered from the settle that
   * scheduled the check, because the app's retry policy may have parked and then
   * resumed the thread in the meantime.
   */
  async pawnThreadStatus(projectId: string, pawnId: string): Promise<ThreadStatus | null> {
    const thread = await this.host.threadManager.getThread(projectId, pawnId).catch(() => null)
    return thread?.status ?? null
  }

  /**
   * Steer the spawning thread with a finished pawn's report, which is the whole
   * point of a background pawn: its work lands in the agent's context as a short
   * report instead of the thousands of steps that produced it.
   */
  async reportPawnCompletion(
    projectId: string,
    spawnerSettings: ThreadSettings,
    pawn: Thread,
    purpose: string,
    output: string
  ): Promise<void> {
    if (!pawn.coordinatorThreadId) return
    await this.host.sendPrompt(
      projectId,
      pawn.coordinatorThreadId,
      spawnerSettings,
      [
        `Pawn agent ${pawn.title} finished its task.`,
        purpose ? `Purpose: ${purpose}.` : '',
        'Read its report, inspect the files it touched, and commit the work you accept: a pawn never commits, so the commit is yours or nobody makes it. If you leave any reported path uncommitted, name every one of those paths and say why.',
        output || 'The pawn agent returned no message.'
      ]
        .filter(Boolean)
        .join('\n\n'),
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'internal',
      {
        action: `Pawn finished · ${pawn.title}`.slice(0, 120),
        body: output.slice(0, 20_000)
      }
    )
  }
}
