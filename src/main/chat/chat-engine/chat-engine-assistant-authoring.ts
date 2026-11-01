import type { AssistantReportingPatch } from '../../../lib/assistant-authoring'
import { Logger } from '../../system/logger'
import {
  broadcastAssistantCheckpointChanged,
  broadcastAssistantsChanged
} from '../../scheduler/assistant-events'
import { broadcastThreadUpdate } from '../thread-events'
import { validateEntityId } from '../../ipc/ipc-validation'
import {
  ASSISTANT_AUTHORING_DECISION_LIMIT,
  assistantAuthoringContext,
  assistantAuthoringProgressContext,
  assistantKnowledgeUpdateContext
} from '../../../lib/assistant-authoring'
import { ASSISTANT_VOICE_INSTRUCTION } from '../../../lib/assistant-voice'
import { assistantRunContext } from '../../../lib/assistant-run'
import type {
  AgentMessage,
  AgentProviderIssue,
  UsageBearingMessage,
  ThreadStatus,
  Thread,
  ThreadSettings,
  ThinkingLevel,
  UsageEventCost,
  UsageEventDetails,
  UsageEventFeature,
  UsagePricingProvenance,
  AssistantAgents
} from '../../../lib/types'
import {
  ASSISTANT_SPACE_ID,
  isAssistantSetupThread,
  assistantKnowledgeComplete
} from '../../../lib/types'
import { nextAssistantModel, settingsWithAssistantModel } from '../../../lib/assistant-agents'
import { writeAssistantReport, type AssistantReportFile } from '../assistant-report-service'
import { assistantReportIsTerminal, isAssistantReportThread } from '../../../lib/assistant-reports'
import type { SessionInfo } from './chat-engine-types'
import { rawErrorMessage } from './chat-engine-errors'
import { assistantText, formatInterviewDecisions } from './chat-engine-message-text'
import { assistantTurnCostAccounting } from './chat-engine-pure'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine assistant-authoring: one concern, moved verbatim from the composition root. */
export class ChatEngineAssistantAuthoring {
  constructor(private readonly host: ChatEngine) {}

  /**
   * Whether a turn belongs to an assistant's Getting started authoring interview:
   * an assistant-space thread whose assistant has no knowledge yet. Derived from the
   * thread every turn and never memoized, so the interview ends the moment the
   * knowledge is saved.
   */
  isAssistantAuthoringThread(thread: Thread | null | undefined): boolean {
    return this.assistantConversation(thread) === 'authoring'
  }

  /**
   * Which assistant conversation a thread is on, when it is one of the three. The
   * single source of truth for them, so a turn can never be read as two at once:
   *
   * - `authoring`: a thread of an assistant that still has no knowledge, the Getting
   *   started interview that drafts it. The user confirms the recap and the app
   *   saves the assistant from it.
   * - `update`: the Getting started thread of an assistant that is already saved.
   *   The user is back to tweak the knowledge, the schedule, or the connections, so
   *   the turn carries the editing contract and never runs the assistant.
   * - `run`: any other thread of a saved assistant. This is where the assistant
   *   actually runs, and what carries the knowledge plus the self-provisioning
   *   contract.
   *
   * `null` for every thread that belongs to no assistant.
   */
  assistantConversation(thread: Thread | null | undefined): 'authoring' | 'update' | 'run' | null {
    if (!thread || thread.projectId !== ASSISTANT_SPACE_ID || !thread.assistantId) return null
    const assistant = this.host.state.assistantRepo.get(thread.assistantId)
    if (!assistant) return null
    // An assistant with no knowledge cannot run, so every one of its threads is the
    // interview, exactly as before the Getting started thread's flag existed.
    if (!assistantKnowledgeComplete(assistant)) return 'authoring'
    // An assistant's Getting started thread is its later editing host, never a run:
    // runs are dispatched on their own run threads.
    return isAssistantSetupThread(thread) ? 'update' : 'run'
  }

  /**
   * The contract for a turn on an assistant's Getting started thread: the authoring
   * interview while the assistant still has no knowledge, and the editing contract
   * once it is saved.
   *
   * The authoring form carries the interview's own app-owned state beside it: the
   * checkpoint the agent keeps current and every answer the user already
   * submitted.
   *
   * The contract is a property of the thread, so the engine composes it rather
   * than the composer: a resend from the message editor, a steer, or a queued
   * delivery reaches the agent with the same contract as a fresh composer send.
   * It rides the system prompt instead of the user message because every
   * harness rewrites that prompt each turn, while text appended to a user
   * message is kept in the harness transcript and replayed once more on every
   * later turn.
   *
   * Re-injecting the checkpoint and the decision ledger is what makes the
   * interview survive a mid-way model or harness switch: the replacement session
   * starts with the app's record of the interview instead of only a budgeted
   * recap of the transcript, so it resumes the conversation instead of re-asking
   * questions the user already answered.
   */
  async assistantAuthoringInstruction(
    projectId: string,
    threadId: string,
    thread: Thread | null | undefined
  ): Promise<string | undefined> {
    const conversation = this.assistantConversation(thread)
    // Only the two Getting started conversations have a contract here: a run
    // thread carries the run contract instead, and the app's own next-steps turn
    // on a task thread carries none.
    if ((conversation !== 'authoring' && conversation !== 'update') || !thread?.assistantId) {
      return undefined
    }
    const assistant = this.host.state.assistantRepo.get(thread.assistantId)
    if (!assistant) return undefined
    // The assistant is saved, so this is no longer an interview: the user is back
    // to tweak the knowledge, the schedule, or the connections, and the saved state
    // is what the agent revises. The interview checkpoint belongs to the authoring
    // conversation, so it is neither read nor injected here.
    if (conversation === 'update') {
      return [this.assistantPersonaContext(), assistantKnowledgeUpdateContext(assistant)]
        .filter(Boolean)
        .join('\n\n')
    }
    const [checkpoint, messages] = await Promise.all([
      this.host.state.assistantAuthoringCheckpoints
        .read(assistant.id)
        .catch((error: unknown): string | null => {
          Logger.error('Getting started checkpoint could not be read:', error)
          return null
        }),
      this.host.threadManager.loadMessageRecords(projectId, threadId)
    ])
    const decisions = formatInterviewDecisions(messages, ASSISTANT_AUTHORING_DECISION_LIMIT)
    return [
      this.assistantPersonaContext(),
      assistantAuthoringContext(assistant),
      assistantAuthoringProgressContext({ checkpoint, decisions })
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  /** Persist the clock choice while setup is still underway. */
  async saveAssistantSchedule(assistantId: string, scheduled: boolean): Promise<void> {
    if (!(await this.host.state.assistantRepo.getViaWorker(assistantId))) {
      throw new Error('The assistant no longer exists')
    }
    this.host.state.assistantRepo.updateScheduled(assistantId, scheduled, Date.now())
    broadcastAssistantsChanged(await this.host.state.assistantRepo.listViaWorker())
  }

  /** Save settled reporting fields and publish the live panel state. */
  async saveAssistantReporting(
    assistantId: string,
    reporting: AssistantReportingPatch
  ): Promise<void> {
    if (!(await this.host.state.assistantRepo.getViaWorker(assistantId))) {
      throw new Error('The assistant no longer exists')
    }
    this.host.state.assistantRepo.updateReporting(assistantId, reporting, Date.now())
    broadcastAssistantsChanged(await this.host.state.assistantRepo.listViaWorker())
  }

  /**
   * Record the name the conversation settles for the assistant.
   *
   * The user names their assistant in the first answer of the setup conversation,
   * and waiting for the recap to save would leave every surface calling it "New
   * assistant" for the whole interview. This writes the name straight onto the row
   * and broadcasts the assistant list, so the sidebar, the panel, the tab and the
   * thread's own head rename themselves as the answer lands. The capability that
   * calls it is bound to the live authoring turn, so the write is app-owned and the
   * agent never names an id.
   *
   * How the assistant behaves is not written here: it is the `Personality` section
   * of the knowledge, which the recap saves with the rest of the instructions.
   */
  async saveAssistantIdentity(assistantId: string, identity: { name: string }): Promise<void> {
    const updated = this.host.state.assistantRepo.updateIdentity(assistantId, identity, Date.now())
    if (!updated) return
    broadcastAssistantsChanged(this.host.state.assistantRepo.list())
  }

  /**
   * Replace an assistant's Getting started checkpoint. The capability that calls
   * this is bound to the live authoring turn, so the write is app-owned and the
   * agent never names a path. The open knowledge panel is told afterwards, so what
   * the interview has agreed is visible without reopening it.
   */
  async saveAssistantCheckpoint(assistantId: string, markdown: string): Promise<{ path: string }> {
    const saved = await this.host.state.assistantAuthoringCheckpoints.save(assistantId, markdown)
    broadcastAssistantCheckpointChanged(assistantId)
    return saved
  }

  /**
   * One assistant's Getting started checkpoint, for the knowledge panel. Read-only:
   * only the authoring agent writes it, and only through the capability bound to
   * its own turn.
   */
  async readAssistantCheckpoint(assistantId: string): Promise<string | null> {
    return this.host.state.assistantAuthoringCheckpoints.read(
      validateEntityId(assistantId, 'Assistant ID')
    )
  }

  /**
   * The self-provisioning contract for a turn on an assistant task whose assistant
   * already has its knowledge   a real run (scheduled or "Run now"), or a follow-up
   * on that task. The knowledge is the instruction set; this contract covers a
   * connection the assistant needs that is not set up in this session: the agent
   * supplies it itself and asks the user for what only the user can give,
   * instead of ending the turn by pointing at the Connections tab.
   *
   * Derived from the thread every turn and never memoized, so it is the same
   * whether the run is dispatched by the scheduler, a missed-run "Run now", or a
   * user message on the task.
   */
  assistantRunHiddenContext(thread: Thread | null | undefined): string | undefined {
    if (this.assistantConversation(thread) !== 'run') return undefined
    const assistant = thread?.assistantId
      ? this.host.state.assistantRepo.get(thread.assistantId)
      : null
    if (!assistant) return undefined
    return assistantRunContext(assistant)
  }

  /**
   * The persona layer for any turn on an assistant's own threads: how it talks.
   * It rides ahead of the knowledge, so an assistant sounds like itself while it is
   * setting up, while the user is changing what it knows, and when it runs.
   *
   * Who the user asked the assistant to be is not a layer of its own: it is the
   * `Personality` section at the top of the knowledge, so it arrives with the
   * document the user edits.
   *
   * The voice rule is unconditional: it is what makes an assistant's answer read
   * as a message from a person rather than a report, and the Assistant view is
   * used by people who did not come here to read a report.
   */
  assistantPersonaContext(): string {
    return ASSISTANT_VOICE_INSTRUCTION
  }

  /**
   * The layers a task turn carries for the assistant that owns it: the persona,
   * then the knowledge the assistant and the user wrote together.
   *
   * The knowledge is the assistant's instruction set and changes only when the
   * user edits the assistant, so it belongs in the system prompt beside the
   * contract rather than on each scheduled run's message, where every run would
   * append another copy to the harness transcript. Putting it here also means a
   * follow-up turn still carries the instruction set the contract refers to,
   * even after a session rotation dropped the run messages from the native
   * transcript.
   */
  assistantPersonaLayers(thread: Thread | null | undefined): string | undefined {
    if (!thread || thread.projectId !== ASSISTANT_SPACE_ID || !thread.assistantId) return undefined
    const assistant = this.host.state.assistantRepo.get(thread.assistantId)
    if (!assistant || !assistantKnowledgeComplete(assistant)) return undefined
    return [this.assistantPersonaContext(), assistant.knowledge.trim()]
      .filter((layer) => layer.length > 0)
      .join('\n\n')
  }

  /**
   * Register the resolver that supplies an assistant task's assistant model set.
   * A scheduled assistant run that hits a provider failure falls over to the
   * assistant's next model instead of waiting out the failed provider's reset.
   */
  attachAssistantAgentsResolver(resolver: (task: Thread) => AssistantAgents | undefined): void {
    this.host.state.assistantAgentsResolver = resolver
  }

  /**
   * Wire the assistant run-outcome recorder. Fired when a turn on an assistant
   * task settles with its final thread status, so the assistant manager can stamp
   * the task's last successful run once the run actually completes.
   */
  attachAssistantRunSettledRecorder(
    recorder: ((threadId: string, status: ThreadStatus) => void) | null
  ): void {
    this.host.state.assistantRunSettled = recorder
  }

  /**
   * File one settled assistant run's report as a durable Markdown file under
   * `reports/` in the assistant's own workspace.
   *
   * Only a run that declared a report through the report capability reaches the
   * write: the app never derives a report from an ordinary answer, so a question,
   * a check-in or a chat reply leaves no file and is never dressed up as a report.
   *
   * A thread is capped and evicted, so a report that only ever lived in the run
   * transcript disappears with it. Swallowed on error: the durable copy is
   * best-effort bookkeeping and must never block or fail the turn's finalization.
   *
   * The filed file is returned rather than announced here. Announcing belongs to
   * the citations unit, which publishes one row for everything the turn left
   * behind, and the report joins it because its path is app-owned.
   */
  async captureAssistantReport(
    thread: Thread,
    turnAssistant: AgentMessage | undefined,
    status: ThreadStatus
  ): Promise<{ title: string; citation: string } | null> {
    const declared = this.host.state.declaredAssistantReports.get(thread.id)
    this.host.state.declaredAssistantReports.delete(thread.id)
    if (!declared) return null
    if (!isAssistantReportThread(thread)) return null
    if (!assistantReportIsTerminal(status)) return null
    if (!turnAssistant) return null
    const report = (declared.markdown ?? assistantText(turnAssistant)).trim()
    if (report.length === 0) return null
    const written = await this.writeAssistantReportFor(thread, declared.title, report, status)
    return written ? { title: declared.title, citation: written.citation } : null
  }

  async writeAssistantReportFor(
    thread: Thread,
    title: string,
    report: string,
    status: ThreadStatus
  ): Promise<AssistantReportFile | null> {
    try {
      const assistant = thread.assistantId
        ? this.host.state.assistantRepo.get(thread.assistantId)
        : null
      // A run's own title is just its start time, so the report's header names the
      // task it ran for. A turn on the task's own thread is already titled.
      let taskTitle = thread.title
      if (thread.assistantTaskId) {
        const task = await this.host.threadManager.getThread(
          thread.projectId,
          thread.assistantTaskId
        )
        if (task) taskTitle = task.title
      }
      return await writeAssistantReport(this.host.storage, {
        thread,
        title,
        taskTitle,
        assistantName: assistant?.name,
        priority: assistant?.priority,
        report,
        status,
        at: Date.now()
      })
    } catch (error) {
      Logger.error('Assistant report could not be written to disk', {
        threadId: thread.id,
        error: rawErrorMessage(error)
      })
      return null
    }
  }

  /**
   * Hold the report a run declared for this turn. The capability that calls this
   * is bound to the live run turn, so the app owns the path and the file is
   * written when the turn actually settles.
   */
  declareAssistantReport(
    threadId: string,
    title: string,
    markdown?: string
  ): { status: 'queued'; title: string } {
    this.host.state.declaredAssistantReports.set(threadId, {
      title,
      ...(markdown ? { markdown } : {})
    })
    return { status: 'queued', title }
  }

  /**
   * Create the fresh thread one assistant run executes on.
   *
   * Every scheduled fire and every manual "Run now" gets its own thread: a run
   * never lands in the task's own conversation, so the task's history stays the
   * user's and a run's transcript carries only that execution. The run thread
   * inherits the task's assistant (so the engine keeps composing the assistant's
   * knowledge and the run contract into its system prompt) and links back to the
   * task through `assistantTaskId`. It is created with the settings the run
   * will actually use, so opening the run shows the model it ran on.
   */
  async createAssistantRunThread(input: {
    task: Thread
    title: string
    settings?: ThreadSettings
  }): Promise<Thread> {
    const { thread, finalize } = this.host.threadManager.prepareCreateThread(
      {
        projectId: ASSISTANT_SPACE_ID,
        providerId: input.task.providerId,
        title: input.title,
        // A run's title is its time, never a prompt-derived label: it is the
        // row's identity under the task, not a conversation title.
        titleSource: 'manual',
        workingDirectory: input.task.workingDirectory,
        settings: input.settings ?? input.task.settings,
        assistantId: input.task.assistantId,
        assistantTaskId: input.task.id
      },
      {
        onEviction: (outcome) => {
          if (outcome.failedIds.length === 0) return
          Logger.error('Assistant run thread eviction failed', {
            taskId: input.task.id,
            evictedId: outcome.evictedId,
            failedIds: outcome.failedIds.join(','),
            error: String(outcome.error)
          })
        }
      }
    )
    await finalize()
    // The sidebar draws the run's row from this broadcast the moment it
    // exists, so it must reach every renderer.
    broadcastThreadUpdate(thread)
    return thread
  }

  /**
   * Move an assistant task whose assistant carries fallback models onto the next
   * one and re-run it immediately, instead of parking the thread for the failed
   * provider's reset window.
   *
   * The model is persisted onto the thread before the resume, so the re-run
   * reads it from the thread's own settings like any other turn. A current
   * model that is not part of the assistant's set is left untouched: that is the
   * user's own pick, and an assistant's fallbacks never override it. Returns true
   * when a fallback was armed.
   *
   * One resume per thread is in flight at a time, and a resume that could not
   * even be dispatched advances to the next candidate instead of only logging:
   * a released session or a dead server must not strand the assistant on the
   * model that just failed.
   */
  async tryAssistantModelFallback(
    info: SessionInfo,
    sessionId: string,
    issue: AgentProviderIssue
  ): Promise<boolean> {
    const resolver = this.host.state.assistantAgentsResolver
    if (!resolver) return false
    let thread: Thread | null
    try {
      thread = await this.host.threadManager.getThread(info.projectId, info.threadId)
    } catch (error) {
      Logger.error('Assistant model fallback could not read the thread:', error)
      return false
    }
    if (!thread || thread.archived) return false
    // Only the thread's own live session may fall over. A provider failure is
    // broadcast for every session ever bound to the thread, and advancing once
    // per bound session would skip straight past the first fallback.
    if (thread.sessionId !== sessionId) return false
    const settings = thread.settings
    if (!settings) return false
    // One fallback at a time per thread. The same provider failure is reported
    // more than once (the session event, the idle finalization, the rejected
    // send), and a second call landing while the first resume is still in
    // flight reads the model the first one just wrote and arms the candidate
    // AFTER it, skipping a model and racing two sends onto one thread.
    const fallbackKey = `${info.projectId}:${info.threadId}`
    if (this.host.state.assistantFallbackResumes.has(fallbackKey)) return true
    const next = nextAssistantModel(settings, resolver(thread))
    if (!next) return false
    try {
      await this.host.threadManager.updateSettings(
        info.projectId,
        info.threadId,
        settingsWithAssistantModel(settings, next)
      )
    } catch (error) {
      Logger.error('Assistant model fallback could not be persisted:', error)
      return false
    }
    Logger.info('Assistant task falling back to the next assistant model', {
      projectId: info.projectId,
      threadId: info.threadId,
      harnessId: next.harnessId,
      providerId: next.providerId,
      modelId: next.modelId,
      issueKind: issue.kind
    })
    this.host.state.assistantFallbackResumes.add(fallbackKey)
    // Fire-and-forget: the resume re-enters this engine's own send pipeline,
    // and its first statement awaits, so the failing turn unwinds first.
    void this.host
      .continueScheduledThread({
        sessionId,
        projectId: info.projectId,
        threadId: info.threadId,
        harnessId: next.harnessId,
        issueKind: issue.kind,
        issueMessage: issue.message,
        ...(issue.rawError === undefined ? {} : { rawError: issue.rawError })
      })
      .then(() => {
        this.host.state.assistantFallbackResumes.delete(fallbackKey)
      })
      .catch(async (error) => {
        Logger.error('Assistant model fallback resume failed:', error)
        // Release the claim first, then advance: the next candidate is read
        // from the model that just failed to dispatch. The chain ends when the
        // assistant has nothing left to try.
        this.host.state.assistantFallbackResumes.delete(fallbackKey)
        try {
          await this.tryAssistantModelFallback(info, sessionId, issue)
        } catch (recoveryError) {
          Logger.error('Assistant model fallback recovery failed:', recoveryError)
        }
      })
    return true
  }

  /**
   * Record one assistant turn in the durable usage ledger.
   *
   * Shared by real thread turns, nested sub-agent worker sessions and
   * disposable sessions, so every assistant message that reports usage reaches
   * the same place with the same cost accounting. The event id is derived from
   * the feature and the message, and the ledger ignores a replayed id, which is
   * what lets the sub-agent sweep run repeatedly without double counting.
   */
  recordAssistantUsageEvent(input: {
    idPrefix: string
    threadId: string
    /** Stated project for work with no owning thread, taken from the caller. */
    projectId: string | null
    parentTurnId: string
    feature: UsageEventFeature
    featureCallId: string
    message: UsageBearingMessage
    /** Whole-turn cost when the caller folded several responses into one row. */
    cost?: UsageEventCost
    /**
     * Rewrite this turn's row instead of appending. Set by the turn-scoped
     * caller, whose aggregate already covers every response the row holds.
     */
    replace?: boolean
    thinkingLevelFallback: ThinkingLevel | null
    failure?: string
  }): void {
    const { message } = input
    const normalizedUsage = message.normalizedUsage
    const details: UsageEventDetails = {
      id: `${input.idPrefix}:${message.id}`,
      threadId: input.threadId,
      parentTurnId: input.parentTurnId,
      featureCallId: input.featureCallId,
      attempt: 1,
      feature: input.feature,
      projectId: input.projectId,
      harnessId: message.harnessId ?? null,
      accountId: message.accountId ?? null,
      providerId: message.providerId ?? null,
      modelId: message.modelId ?? null,
      thinkingLevel: message.thinkingLevel ?? input.thinkingLevelFallback,
      utilityId: null,
      rawProviderUsage: normalizedUsage?.rawProviderUsage ?? {},
      tokens: normalizedUsage
        ? {
            uncachedInput: normalizedUsage.uncachedInput,
            cachedInput: normalizedUsage.cachedInput,
            cacheWrite: normalizedUsage.cacheWrite,
            output: normalizedUsage.output,
            reasoning: normalizedUsage.reasoning
          }
        : {
            uncachedInput: null,
            cachedInput: null,
            cacheWrite: null,
            output: null,
            reasoning: null
          },
      rawTotal: normalizedUsage?.rawTotal ?? null,
      totalSemantics: normalizedUsage?.totalSemantics ?? 'unavailable',
      toolFeeUsd: null,
      success: !input.failure && !message.error,
      retryCause: input.failure ?? message.error ?? null,
      durationMs: Math.max(
        0,
        Math.floor((message.completedAt ?? message.createdAt) - message.createdAt)
      ),
      createdAt: message.completedAt ?? message.createdAt
    }
    let cost: UsageEventCost
    if (input.cost) {
      cost = input.cost
    } else {
      const { costUsd, costStatus } = assistantTurnCostAccounting(message)
      cost =
        costUsd === null
          ? { costStatus: 'unavailable', costUsd: null, pricingProvenance: null }
          : {
              costStatus: costStatus === 'estimated' ? 'estimated' : 'known',
              costUsd,
              pricingProvenance:
                message.costProvenance ??
                ({
                  source: 'provider',
                  currency: 'USD',
                  capturedAt: message.completedAt ?? message.createdAt
                } satisfies UsagePricingProvenance)
            }
    }
    if (input.replace) this.host.state.usageRepo.recordReplacingEvent({ ...details, ...cost })
    else this.host.state.usageRepo.recordEvent({ ...details, ...cost })
  }
}
