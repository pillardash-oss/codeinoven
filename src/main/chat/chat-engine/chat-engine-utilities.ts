import type { AssistantReportingPatch } from '../../../lib/assistant-authoring'
import { randomUUID } from 'crypto'
import { Logger } from '../../system/logger'
import type { HarnessDriver, PreparedUtilityRuntime } from '../../drivers/driver.interface'
import {
  CIO_UTILITY_REUSE_PROMPT,
  CIO_UTILITY_ASSISTANT_EDIT_PROMPT,
  CIO_UTILITY_RUN_PROMPT,
  CIO_UTILITY_SETUP_PROMPT,
  isCioUtilityRequest
} from '../../utilities/cio-utility-prompt'
import {
  designSessionBriefing,
  designSessionContinuation,
  type DesignSessionMode
} from '../../utilities/cio-design-prompt'
import { designGroupBriefing } from '../../design/design-group-service'
import {
  videoSessionBriefing,
  videoSessionContinuation,
  type VideoSessionMode
} from '../../utilities/cio-video-prompt'
import {
  CIO_ORCHESTRATE_CONTINUE_PROMPT,
  CIO_ORCHESTRATE_FULL_ACCESS_PROMPT,
  CIO_ORCHESTRATE_START_PROMPT
} from '../../orchestration/cio-orchestrate-prompt'
import { createAppControlExecutor } from '../../app-control/app-control-executor'
import { currentWorkRoot } from '../../design/work-roots-state'
import type {
  BrowserUtilityExecutor,
  UtilitySuggestionContext,
  UtilityResultAttribution,
  UtilityTurnBudgetContext,
  UtilityTurnGateway
} from '../../utilities/utility-orchestration-service'
import {
  utilitySuggestionQuestion,
  type UtilitySuggestionResolution
} from '../../../lib/utility-suggestion'
import type { AgentUtilitySuggestionEntry, ThreadSettings, UtilityKind } from '../../../lib/types'
import { type TurnStepTimer } from '../turn-dispatch-timer'
import type { PendingQuestionInfo } from './chat-engine-types'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine utilities: one concern, moved verbatim from the composition root. */
export class ChatEngineUtilities {
  constructor(private readonly host: ChatEngine) {}

  setBrowserUtilityExecutor(executor: BrowserUtilityExecutor | null): void {
    this.host.state.utilityOrchestration.setBrowserExecutor(executor)
    this.host.state.utilityOrchestration.setAppControlExecutor(
      createAppControlExecutor(
        executor ? (input, context) => executor('open', input, context) : undefined
      )
    )
  }

  /**
   * Land a utility registry change in the turns that are already running.
   *
   * Called by the renderer boundary after every successful write, so switching a
   * capability off in Utilities takes effect immediately instead of at the next
   * turn, and without the user restarting anything.
   */
  async applyUtilityRegistryChange(utilityId: string): Promise<void> {
    await this.host.state.utilityOrchestration.applyRegistryChange(utilityId)
  }

  /**
   * Surface one `cio_util_suggest` card and wait for the user.
   *
   * The request is app-owned, so nothing is sent to a harness: this registers
   * the pending question, broadcasts it, and settles a promise with the user's
   * decision. Installing is deliberately left to the gateway handler, which owns
   * the registry, so a card that is dismissed or expires can never install.
   */
  async requestUtilitySuggestion(
    entry: AgentUtilitySuggestionEntry,
    context: UtilitySuggestionContext
  ): Promise<UtilitySuggestionResolution> {
    const requestId = `cio-suggest-${randomUUID()}`
    const pending = this.host.registerPendingQuestion(
      context.harnessId,
      context.projectId,
      context.threadId,
      context.projectPath,
      {
        requestId,
        sessionId: context.sessionId,
        questions: [utilitySuggestionQuestion(entry)]
      },
      await this.host.units['questions'].pendingQuestionTimeoutMs()
    )
    const settled = new Promise<UtilitySuggestionResolution>((resolve) => {
      pending.settleUtilitySuggestion = resolve
    })
    await this.host.threadManager.setStatus(
      context.projectId,
      context.threadId,
      'awaiting_approval',
      {
        read: false
      }
    )
    this.host.broadcast({
      type: 'question.asked',
      sessionId: context.sessionId,
      requestId,
      questions: pending.request.questions
    })
    const resolution = await settled
    const driver = this.host.units['turns-dispatch'].driverForRuntime(
      context.harnessId,
      this.host.sessionRegistry.get(context.sessionId)?.accountId
    )
    if (
      pending.resumeUtilitySuggestionAfterSettlement &&
      driver &&
      !this.host.units['questions-ask'].questionAnswerCanReachLiveTurn(pending, driver)
    ) {
      await this.resumeAfterInactiveUtilitySuggestion(pending, entry, resolution)
    }
    return resolution
  }

  /** Resume the thread when a suggestion card settles after its turn ended. */
  async resumeAfterInactiveUtilitySuggestion(
    pending: PendingQuestionInfo,
    entry: AgentUtilitySuggestionEntry,
    resolution: UtilitySuggestionResolution
  ): Promise<void> {
    await this.host.units['turns-sessions'].awaitInactiveResumeIdleFinalization(pending)
    await this.host.units['questions']
      .settleUnresumableQuestionTurn(pending.request.sessionId)
      .catch((error: unknown) => Logger.error('Utility suggestion turn settlement failed:', error))

    const thread = await this.host.threadManager.getThread(
      pending.request.projectId,
      pending.request.threadId
    )
    if (!thread?.settings) {
      throw new Error(`Thread settings are unavailable: ${pending.request.threadId}`)
    }

    const prompt = [
      'Your previous turn ended while waiting for the user to resolve a capability suggestion.',
      resolution.decision === 'accepted'
        ? `The user accepted "${entry.name}". The app is installing it now; search for it before relying on it, then continue the original request.`
        : resolution.decision === 'alternative'
          ? `The user did not accept or decline "${entry.name}"; they answered in their own words, and nothing was installed. Their answer is below. Follow it, and only re-propose the capability if it is still the right answer.\n\nUser answer: ${resolution.answer ?? ''}`
          : `The user declined "${entry.name}". Do not install it and do not claim it is available. Continue without it, or say plainly what is missing.`
    ].join('\n\n')
    await this.host.sendPrompt(
      pending.request.projectId,
      pending.request.threadId,
      thread.settings,
      prompt,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'internal'
    )
  }

  /**
   * True when the user has invoked @cio-utility in this thread's history
   * (including the current turn's message). Only positive results are memoized:
   * a thread that never invoked must keep re-scanning its (cheap, cached) user
   * messages so a rollback or edit that restores an @cio-utility prompt still
   * grants reuse.
   */
  async hasCioUtilityInvocation(projectId: string, threadId: string): Promise<boolean> {
    if (this.host.state.cioUtilityThreads.has(threadId)) return true
    const userMessages = await this.host.threadManager.loadUserMessages(projectId, threadId)
    const invoked = userMessages.some((message) => isCioUtilityRequest(message.content))
    if (invoked) this.host.state.cioUtilityThreads.set(threadId, true)
    return invoked
  }

  /**
   * Install one tiny gateway plus always-on utilities for this turn. On-demand
   * schemas remain outside model context until the gateway activates them.
   */
  async prepareTurnUtilities(
    driver: HarnessDriver,
    projectId: string,
    threadId: string,
    sessionId: string,
    projectPath: string,
    settings: ThreadSettings,
    budgetContext: UtilityTurnBudgetContext,
    threadTitle: string,
    /** Scope the thread works in; `cio:scope` defaults to it when the agent omits a target. */
    scopeBucketId?: string,
    skipRuntime = false,
    allowManagement = false,
    brainstormInterview = false,
    explicitUtilityInvocation = false,
    /**
     * The assistant conversation this turn belongs to, when it is one.
     * `'run'`   a turn on a saved assistant's task (a scheduled run or a user
     * follow-up on the same thread): it carries the run grant (management is in
     * scope) rather than the reuse contract, which reserves installing for an
     * explicit request. `'edit'`   a user turn on a saved assistant's Getting
     * started thread: it does not run the assistant, but a connection the change
     * needs is installed here, so the grant is the same. A turn where the user
     * typed @cio-utility keeps the full setup briefing instead.
     */
    assistantTurn: 'none' | 'run' | 'edit' = 'none',
    /**
     * The assistant whose Getting started interview this turn belongs to, when it
     * is one. Binds the checkpoint capability to the turn so the agent can save
     * the interview state the app re-injects.
     */
    authoringAssistantId: string | null = null,
    /**
     * Whether this turn belongs to a design session the user opened with
     * `@cio-design`. `start` is the turn that typed the tag, `continue` is every
     * later turn of the same thread. Both promote the design capability to an
     * active capability for the turn and add the matching session contract.
     */
    designSession: DesignSessionMode = 'off',
    /**
     * Whether this turn belongs to a video session the user opened with
     * `@cio-video`. `start` is the turn that typed the tag, `continue` is every
     * later turn of the same thread. Both promote the video capability to an
     * active capability for the turn and add the matching session contract.
     */
    videoSession: VideoSessionMode = 'off',
    /**
     * Whether this turn belongs to an orchestration session the user opened
     * with `@cio-hey`. `start` is the turn that typed the tag,
     * `continue` is every later turn of the same thread. Both grant the
     * workstation tools and add the matching dispatch contract.
     */
    orchestrationSession: 'off' | 'start' | 'continue' = 'off',
    /**
     * Whether this turn may create the thread's engineering artifacts (Brainstorm,
     * PRD, specification, Assignment) through the app-owned artifact tools. Set
     * for a real project thread's turn, and left off for a chat, an assistant task
     * and an Assignment worker, which are offered none of those routes.
     */
    artifactTools = false,
    /**
     * The dispatch's own clock, so the utility runtime reports what it spent and
     * on what. This phase is where a slow project turn spends most of its wait,
     * and one mark around the whole call cannot say which part owned it.
     */
    dispatchTimer?: TurnStepTimer
  ): Promise<string> {
    // A new turn begins, so a report declared by an earlier turn that never settled
    // must not be filed under this one, and neither may the work it cited.
    this.host.state.declaredAssistantReports.delete(threadId)
    this.host.units['citations'].clearCitedPaths(threadId)
    // The plan and progress the thread is executing are republished before any
    // early return below: a session whose transcript can no longer be summarized
    // has to be able to rebuild its context from them.
    await this.host.units['misc'].timedStep(
      dispatchTimer,
      'compactionFallback',
      this.host.units['turns-sessions'].publishCompactionFallback(
        driver,
        projectId,
        threadId,
        sessionId,
        projectPath
      )
    )
    // A new agent turn begins here   re-enable a user-dismissed PiP so it may
    // show again if CUA is used, and cancel any auto-dismiss from the last turn.
    this.host.computerUsePip?.notifyTurnStarted(threadId)
    // A turn that owns no utility runtime (a temporary/isolated session with no
    // gateway) returns before any runtime is materialized, so its shared server
    // is never restarted on its behalf.
    if (skipRuntime) return ''
    // Capture both transports up front: control-flow analysis widens `driver` to
    // `HarnessDriver | IsolatedSessionDriver` further down, and the union hides
    // these optional methods.
    const applyRuntime = driver.applyPreparedUtilityRuntime?.bind(driver)
    const publishUtilityEndpoint = driver.publishUtilityGatewayEndpoint?.bind(driver)
    // A harness carries the app gateway through exactly one of those transports:
    // a direct endpoint (Pi, codex) or a prepared runtime its own launch folds in
    // (Claude Code, Cline, codex, OpenCode, Antigravity). A harness with neither
    // (Muse Code) cannot call a gateway tool at all, so it is offered no utility
    // prose either: advertising cio_util_* in a prompt whose tool list cannot
    // hold them sends the agent hunting for tools that do not exist, and it would
    // write the thread's secret files for a turn that can never read them.
    const carriesGateway =
      Boolean(publishUtilityEndpoint) || typeof driver.prepareUtilityRuntime === 'function'
    if (!applyRuntime || !carriesGateway) return ''
    // Re-expose this thread's stored secrets for the turn that is starting: the
    // hook lands before the transport split so a direct-gateway harness (Pi,
    // codex) interpolates exactly the same file paths as a runtime harness, and
    // a thread that never asked for a secret pays one small read.
    await this.host.units['misc'].timedStep(
      dispatchTimer,
      'secretFiles',
      this.host.state.agentSecrets
        .materializeSecretFiles(threadId)
        .catch((error: unknown) => Logger.dev('Agent secret files could not be written:', error))
    )
    const nativeCapabilities = await this.host.units['misc'].timedStep(
      dispatchTimer,
      'nativeCapabilities',
      this.host.units['utilities-tools'].nativeCapabilitiesFor(driver, projectPath)
    )
    // A native bridge owns credentials internally. Other harnesses use their
    // existing MCP runtime; prompt prose is never a transport fallback.
    const useDirectGateway = Boolean(publishUtilityEndpoint)
    await this.host.units['misc'].timedStep(
      dispatchTimer,
      'utilityCleanup',
      this.cleanupTurnUtilities(sessionId)
    )
    let gateway: UtilityTurnGateway | undefined
    let runtime: PreparedUtilityRuntime | undefined
    try {
      gateway = await this.host.units['misc'].timedStep(
        dispatchTimer,
        'utilityTurn',
        this.host.state.utilityOrchestration.startTurn({
          harnessId: driver.id,
          projectId,
          threadId,
          sessionId,
          threadTitle,
          projectPath,
          ...(scopeBucketId === undefined ? {} : { scopeBucketId }),
          nativeCapabilities,
          permissionLevel: settings.permissionLevel,
          resolveExecutingModelVisionCapable: () =>
            this.host.units['runtime-agents'].executingModelVisionCapable(projectId, settings),
          allowManagement,
          designSession,
          videoSession,
          orchestrationSession,
          artifactTools,
          ...(brainstormInterview
            ? {
                saveBrainstormNotes: (markdown: string) =>
                  this.host.units['brainstorm-review'].saveBrainstormAlignmentNotes(
                    projectId,
                    threadId,
                    sessionId,
                    markdown
                  )
              }
            : {}),
          ...(authoringAssistantId
            ? {
                saveAssistantCheckpoint: (markdown: string) =>
                  this.host.units['assistant-authoring'].saveAssistantCheckpoint(
                    authoringAssistantId,
                    markdown
                  ),
                saveAssistantSchedule: (scheduled: boolean) =>
                  this.host.units['assistant-authoring'].saveAssistantSchedule(
                    authoringAssistantId,
                    scheduled
                  ),
                saveAssistantReporting: (reporting: AssistantReportingPatch) =>
                  this.host.units['assistant-authoring'].saveAssistantReporting(
                    authoringAssistantId,
                    reporting
                  ),
                saveAssistantIdentity: (identity: { name: string }) =>
                  this.host.units['assistant-authoring'].saveAssistantIdentity(
                    authoringAssistantId,
                    identity
                  )
              }
            : {}),
          ...(assistantTurn === 'run'
            ? {
                saveAssistantReport: (title: string, markdown?: string) =>
                  Promise.resolve(
                    this.host.units['assistant-authoring'].declareAssistantReport(
                      threadId,
                      title,
                      markdown
                    )
                  )
              }
            : {}),
          citeWork: (paths: string[]) =>
            this.host.units['citations'].citeWork(projectId, threadId, paths),
          budgetContext,
          ...(dispatchTimer ? { telemetry: dispatchTimer } : {}),
          attributeReinjectedResult: (attribution) =>
            this.recordReinjectedUtilityResult(threadId, settings, budgetContext, attribution)
        })
      )
      const resolvedUtilities = gateway.resolvedUtilities
      const skillInstructions = resolvedUtilities.flatMap(({ utility }) =>
        utility.kind === 'skill'
          ? [
              `Utility skill: ${utility.name}\n${utility.description}\n\n${utility.config.instructions}`
            ]
          : []
      )
      // The full setup briefing belongs to the turn where the user explicitly
      // typed @cio-utility. Reuse turns (the invocation happened earlier in this
      // thread) get the compact contract instead so the full docs are never
      // re-dumped into context.
      const utilityContract = !allowManagement
        ? ''
        : assistantTurn === 'run'
          ? CIO_UTILITY_RUN_PROMPT
          : explicitUtilityInvocation
            ? CIO_UTILITY_SETUP_PROMPT
            : assistantTurn === 'edit'
              ? CIO_UTILITY_ASSISTANT_EDIT_PROMPT
              : CIO_UTILITY_REUSE_PROMPT
      // The design contract is separate from the utility contract because it is
      // not a setup grant: the capability it activates arrives with the turn
      // request, and what this adds is how to run the session the user opened,
      // under the folder the project is pointed at right now rather than the one
      // the playbook's default would name.
      const designContract =
        designSession === 'start'
          ? designSessionBriefing(
              'tag',
              currentWorkRoot('design', projectId),
              designGroupBriefing(this.host.database, projectId)
            )
          : designSession === 'continue'
            ? designSessionContinuation(
                currentWorkRoot('design', projectId),
                designGroupBriefing(this.host.database, projectId)
              )
            : ''
      // The video contract is the same shape as the design one, for the same
      // reason: the capability it activates arrives with the turn request.
      const videoContract =
        videoSession === 'start'
          ? videoSessionBriefing('tag', currentWorkRoot('video', projectId))
          : videoSession === 'continue'
            ? videoSessionContinuation(currentWorkRoot('video', projectId))
            : ''
      // The orchestration contract is the gate for the workstation tools: it is
      // what tells the agent the tools exist and how to resolve a request to a
      // machine, a model and an account before dispatching real work. A thread
      // running in full access reaches the tools with no tag, so it carries the
      // full-access contract on every turn the tag did not open.
      const orchestrationContract =
        orchestrationSession === 'start'
          ? CIO_ORCHESTRATE_START_PROMPT
          : orchestrationSession === 'continue'
            ? CIO_ORCHESTRATE_CONTINUE_PROMPT
            : settings.permissionLevel === 'full_access'
              ? CIO_ORCHESTRATE_FULL_ACCESS_PROMPT
              : ''
      if (useDirectGateway) {
        // Harnesses with persistent extension-backed sessions (Pi) receive the
        // turn-scoped endpoint through a session-keyed handoff so their
        // gateway extension can route tools without a per-turn relaunch.
        if (gateway.directEndpoint && publishUtilityEndpoint) {
          await this.host.units['misc'].timedStep(
            dispatchTimer,
            'gatewayEndpoint',
            // The endpoint handoff can wait on the harness's own extension being
            // materialized (`Pi utility gateway endpoint deferred: extension not
            // yet materialized`), which is exactly the wait that used to hide in
            // the turnContext phase.
            publishUtilityEndpoint(projectPath, sessionId, gateway.directEndpoint)
          )
        }
        this.host.state.utilityTurns.set(sessionId, {
          driver,
          projectId,
          projectPath,
          gateway,
          threadId
        })
        return [
          gateway.directInstructions,
          utilityContract,
          designContract,
          videoContract,
          orchestrationContract,
          ...skillInstructions
        ]
          .filter(Boolean)
          .join('\n\n')
      }
      const request = {
        projectPath,
        providerId: settings.providerId,
        resolvedUtilities,
        // Publish the app's own human-decision deadline to the transport, so a
        // harness whose client has a shorter request timeout (OpenCode's MCP
        // client) does not abandon a `cio_ask_secret` card mid-wait.
        ...(gateway.directEndpoint
          ? { gatewayRequestTimeoutMs: gateway.directEndpoint.timeoutMs }
          : {})
      }
      const overlay =
        (await this.host.units['misc'].timedStep(
          dispatchTimer,
          'utilityRuntimeOverlay',
          Promise.resolve(driver.prepareUtilityRuntime?.(request))
        )) ?? {}
      if (overlay.gatewayAvailable === false) {
        // Also clear any overlay left by an interrupted prior turn before the
        // harness launches against its normal authenticated profile.
        await this.host.units['misc'].timedStep(
          dispatchTimer,
          'utilityRuntimeClear',
          applyRuntime(projectPath, null, sessionId)
        )
        await gateway.cleanup()
        gateway = undefined
        return [
          utilityContract,
          designContract,
          videoContract,
          orchestrationContract,
          ...skillInstructions
        ]
          .filter(Boolean)
          .join('\n\n')
      }
      const environment = {
        ...(overlay.env ?? {}),
        // Free-standing secrets the app launchers must expose for this thread.
        // Pi and codex never reach this branch: Pi applies the same values to
        // its own session environment through the gateway extension instead.
        ...(await this.host.units['misc'].timedStep(
          dispatchTimer,
          'secretEnvironment',
          this.host.state.agentSecrets
            .secretEnvironment(threadId)
            .catch(() => ({}) as Record<string, string>)
        ))
      }
      for (const { utility } of resolvedUtilities) {
        for (const credential of utility.credentials) {
          if (!credential.environmentVariable) continue
          try {
            environment[credential.environmentVariable] = await this.host.state.secretVault.resolve(
              credential.secretRef
            )
          } catch (error) {
            if (credential.required) throw error
          }
        }
      }
      runtime = await this.host.units['misc'].timedStep(
        dispatchTimer,
        'utilityRuntimePrepare',
        this.host.state.utilityRuntime.prepare(request, {
          ...overlay,
          env: environment
        })
      )
      await this.host.units['misc'].timedStep(
        dispatchTimer,
        'utilityRuntimeApply',
        applyRuntime(projectPath, runtime, sessionId)
      )
      this.host.state.utilityTurns.set(sessionId, {
        driver,
        projectId,
        projectPath,
        runtime,
        gateway,
        threadId
      })
      return [
        gateway.instructions,
        ...(overlay.instructions ? [overlay.instructions] : []),
        utilityContract,
        designContract,
        videoContract,
        orchestrationContract,
        ...skillInstructions
      ]
        .filter(Boolean)
        .join('\n\n')
    } catch (error) {
      const cleanups: Array<Promise<unknown>> = []
      if (gateway) cleanups.push(gateway.cleanup())
      if (runtime) {
        cleanups.push(applyRuntime(projectPath, null, sessionId))
        cleanups.push(runtime.cleanup())
      }
      await Promise.allSettled(cleanups)
      throw error
    }
  }

  async cleanupTurnUtilities(sessionId: string, expectedGatewayId?: string): Promise<void> {
    const turn = this.host.state.utilityTurns.get(sessionId)
    if (!turn || (expectedGatewayId !== undefined && turn.gateway.id !== expectedGatewayId)) return
    turn.cleanupPromise ??= (async () => {
      this.host.computerUsePip?.notifyTurnEnded(turn.threadId)
      try {
        await turn.driver.publishUtilityGatewayEndpoint?.(turn.projectPath, sessionId, null)
        await turn.driver.applyPreparedUtilityRuntime?.(turn.projectPath, null, sessionId)
      } catch (error) {
        Logger.error('Harness utility runtime cleanup failed:', error)
      } finally {
        await Promise.allSettled([
          turn.runtime?.cleanup(),
          turn.gateway.cleanup(),
          this.host.state.agentSecrets.purgeSecretFiles(turn.threadId)
        ])
        if (this.host.state.utilityTurns.get(sessionId) === turn)
          this.host.state.utilityTurns.delete(sessionId)
      }
    })()
    await turn.cleanupPromise
  }

  /**
   * Re-arm the turn-scoped utility gateway for a steered turn. Steers skip
   * prepareTurnUtilities (no prompt recomposition happens), but native gateway
   * tools are registered at process spawn and work from the handoff file
   * alone   so a steer that lands after the previous turn's cleanup only
   * needs a fresh utility turn + endpoint publish to keep the tools alive.
   * MCP runtime harnesses keep their live overlay until turn completion.
   */
  async rearmSteerUtilities(
    driver: HarnessDriver,
    projectId: string,
    threadId: string,
    sessionId: string,
    projectPath: string,
    settings: ThreadSettings
  ): Promise<void> {
    const previous = this.host.state.utilityTurns.get(sessionId)
    if (previous?.cleanupPromise) await previous.cleanupPromise
    const steeringThread = await this.host.threadManager.getThread(projectId, threadId)
    // An assistant's knowledge authoring thread keeps management for the whole
    // authoring conversation, exactly like a turn where the user typed
    // @cio-utility; a steer landing mid-conversation must not drop it. A run of
    // a saved assistant keeps it for the same reason: a steer must not drop the
    // ability to supply a connection the run needs. A user editing a saved
    // assistant's knowledge on its Getting started thread keeps it too, because the
    // tweak may need a capability installed.
    const allowManagement =
      this.host.units['assistant-authoring'].assistantConversation(steeringThread) !== null ||
      (await this.hasCioUtilityInvocation(projectId, threadId))
    // A steer landing mid-authoring keeps the checkpoint capability alive for
    // the rest of the turn, so an answer the user steered with is still saved.
    // A steer on a saved assistant's Getting started thread is an editing turn,
    // not an interview: it has no checkpoint to keep.
    const authoringAssistantId =
      this.host.units['assistant-authoring'].assistantConversation(steeringThread) === 'authoring'
        ? (steeringThread?.assistantId ?? null)
        : null
    if (this.host.state.utilityTurns.has(sessionId)) {
      // A steer that invokes @cio-utility has to manage utilities for the rest of
      // the turn. A gateway fixes its tool set when the turn starts, and the live
      // one was built for an earlier message, so granting management means
      // rebuilding the utility turn. A gateway that already manages, or a steer
      // without the setup contract, keeps the live turn untouched.
      if (!allowManagement || previous?.gateway.managementEnabled === true) return
      await this.cleanupTurnUtilities(sessionId)
    }
    const publishUtilityEndpoint = driver.publishUtilityGatewayEndpoint?.bind(driver)
    if (!publishUtilityEndpoint) return
    const nativeCapabilities = await this.host.units['utilities-tools'].nativeCapabilitiesFor(
      driver,
      projectPath
    )
    const budgetContext: UtilityTurnBudgetContext = {
      selectedModelInputTokens: 0,
      composedTurnTokens: 0,
      parentTurnId: sessionId
    }
    let gateway: UtilityTurnGateway | undefined
    try {
      gateway = await this.host.state.utilityOrchestration.startTurn({
        harnessId: driver.id,
        projectId,
        threadId,
        sessionId,
        threadTitle: steeringThread?.title,
        ...(steeringThread?.scopeBucketId === undefined
          ? {}
          : { scopeBucketId: steeringThread.scopeBucketId }),
        projectPath,
        nativeCapabilities,
        permissionLevel: settings.permissionLevel,
        resolveExecutingModelVisionCapable: () =>
          this.host.units['runtime-agents'].executingModelVisionCapable(projectId, settings),
        // A steered turn keeps the setup + diagnostics contract alive when the
        // user has invoked @cio-utility in this thread, so reuse survives a
        // steer landing after the previous turn's gateway cleanup.
        allowManagement,
        ...(this.host.state.pendingBrainstormTurns.has(sessionId)
          ? {
              saveBrainstormNotes: (markdown: string) =>
                this.host.units['brainstorm-review'].saveBrainstormAlignmentNotes(
                  projectId,
                  threadId,
                  sessionId,
                  markdown
                )
            }
          : {}),
        ...(authoringAssistantId
          ? {
              saveAssistantCheckpoint: (markdown: string) =>
                this.host.units['assistant-authoring'].saveAssistantCheckpoint(
                  authoringAssistantId,
                  markdown
                ),
              saveAssistantSchedule: (scheduled: boolean) =>
                this.host.units['assistant-authoring'].saveAssistantSchedule(
                  authoringAssistantId,
                  scheduled
                ),
              saveAssistantReporting: (reporting: AssistantReportingPatch) =>
                this.host.units['assistant-authoring'].saveAssistantReporting(
                  authoringAssistantId,
                  reporting
                ),
              saveAssistantIdentity: (identity: { name: string }) =>
                this.host.units['assistant-authoring'].saveAssistantIdentity(
                  authoringAssistantId,
                  identity
                )
            }
          : {}),
        ...(this.host.units['assistant-authoring'].assistantConversation(steeringThread) === 'run'
          ? {
              saveAssistantReport: (title: string, markdown?: string) =>
                Promise.resolve(
                  this.host.units['assistant-authoring'].declareAssistantReport(
                    threadId,
                    title,
                    markdown
                  )
                )
            }
          : {}),
        citeWork: (paths: string[]) =>
          this.host.units['citations'].citeWork(projectId, threadId, paths),
        budgetContext,
        attributeReinjectedResult: (attribution) =>
          this.recordReinjectedUtilityResult(threadId, settings, budgetContext, attribution)
      })
      if (gateway.directEndpoint) {
        await publishUtilityEndpoint(projectPath, sessionId, gateway.directEndpoint)
      }
      this.host.state.utilityTurns.set(sessionId, {
        driver,
        projectId,
        projectPath,
        gateway,
        threadId
      })
      // Rebuilding the turn purged this thread's secret files, and a steered turn
      // keeps running, so put them back for the rest of the turn's tool calls.
      await this.host.state.agentSecrets
        .materializeSecretFiles(threadId)
        .catch((error: unknown) => Logger.dev('Agent secret files could not be written:', error))
    } catch (error) {
      await gateway?.cleanup()
      Logger.error('Steer utility re-arm failed:', error)
      throw error
    }
  }

  /**
   * Utility kinds this harness really supplies on this machine for the turn being
   * assembled.
   *
   * The driver's static declaration is the default. A harness whose native
   * capability is an installed component answers for itself, so the app-owned
   * equivalent is only suppressed when the native one actually exists.
   */
  async nativeUtilitiesOf(
    driver: HarnessDriver | undefined,
    projectPath: string
  ): Promise<UtilityKind[]> {
    const declared = driver?.capabilities.nativeUtilities ?? []
    if (!driver?.resolveNativeUtilities) return declared
    try {
      return await driver.resolveNativeUtilities(projectPath)
    } catch (error) {
      Logger.dev('Native utility resolution failed:', error)
      return declared
    }
  }

  /** Drop every capability scoped to one deleted thread, credentials included. */
  async removeThreadScopedUtilities(threadId: string): Promise<void> {
    try {
      const removed = await this.host.state.utilityRegistry.deleteThreadScoped(threadId)
      for (const utility of removed) {
        for (const credential of utility.credentials) {
          await this.host.state.secretVault.remove(credential.secretRef).catch(() => undefined)
        }
      }
    } catch (error) {
      Logger.dev('Thread-scoped utility cleanup failed:', error)
    }
  }

  recordReinjectedUtilityResult(
    threadId: string,
    settings: ThreadSettings,
    budgetContext: UtilityTurnBudgetContext,
    attribution: UtilityResultAttribution
  ): void {
    const reinjectedTokens = Math.max(0, Math.floor(attribution.reinjectedTokens))
    const truncatedTokens = Math.max(0, Math.floor(attribution.truncatedTokens))
    this.host.state.usageRepo.recordEvent({
      id: `utility-result:${budgetContext.parentTurnId}:${attribution.featureCallId}`,
      threadId,
      parentTurnId: budgetContext.parentTurnId,
      featureCallId: attribution.featureCallId,
      attempt: 1,
      feature: 'web',
      harnessId: settings.harnessId,
      accountId: settings.accountId ?? null,
      providerId: settings.providerId,
      modelId: settings.modelId,
      thinkingLevel: settings.thinkingLevel ?? null,
      utilityId: attribution.utilityId,
      rawProviderUsage: {
        reinjectedTokens,
        truncatedTokens,
        selectedModelInputTokens: budgetContext.selectedModelInputTokens,
        composedTurnTokens: budgetContext.composedTurnTokens
      },
      tokens: {
        uncachedInput: reinjectedTokens,
        cachedInput: null,
        cacheWrite: null,
        output: null,
        reasoning: null
      },
      rawTotal: null,
      totalSemantics: 'unavailable',
      toolFeeUsd: null,
      success: attribution.success,
      retryCause: attribution.retryCause,
      durationMs: 0,
      createdAt: Date.now(),
      costStatus: 'unavailable',
      costUsd: null,
      pricingProvenance: null
    })
  }
}
