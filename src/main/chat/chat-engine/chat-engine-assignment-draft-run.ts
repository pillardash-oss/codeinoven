import { DEFAULT_HARNESS } from '../../../lib/harness-default'
import { validateEntityId, validateThreadSettings } from '../../ipc/ipc-validation'
import { parseGeneratedAssignmentContent } from '../../../lib/assignment/assignment-validation'
import { assignmentContinuationPrompt } from '../../../lib/assignment/assignment-draft-continuation'
import { assignmentDraftPartId } from '../../../lib/assignment/assignment-draft'
import type {
  AgentSubagentActivity,
  AssignmentDraftStart,
  AssignmentPlan,
  AssignmentPlanContent,
  ThreadSettings
} from '../../../lib/types'
import type { SendPromptOptions } from '../../drivers/driver.interface'
import { supportsIsolatedSessions } from '../../drivers/isolated-session'
import type { ActiveAssignmentDraftSession } from './chat-engine-types'
import { PROMPT_READ_ONLY_TOOLS } from './chat-engine-prompts'
import { Logger } from '../../system/logger'
import { parseGeneratedJson } from './chat-engine-generated-artifacts'
import type { ChatEngine } from '../chat-engine'

/** How long one continuation turn may run before the retry is reported failed. */
const CONTINUATION_TIMEOUT_MS = 180_000

/**
 * The Assignment draft run, as one job the user can watch like a sub-agent.
 *
 * A draft is not a second conversation: it is one delegated task on the parent
 * thread, so it publishes the same worker card a sub-agent gets, keeps its
 * session when it fails so a retry continues that work instead of starting over,
 * and answers the caller immediately instead of holding a harness request open.
 */
export class ChatEngineAssignmentDraftRun {
  constructor(private readonly host: ChatEngine) {}

  /** The identity a coordinator's draft run and its revision counter share. */
  draftKey(projectId: string, coordinatorThreadId: string): string {
    return `${projectId}:${coordinatorThreadId}`
  }

  private revision(key: string): number {
    return this.host.state.assignmentDraftRevisions.get(key) ?? 0
  }

  private partId(projectId: string, coordinatorThreadId: string): string {
    return assignmentDraftPartId(projectId, coordinatorThreadId)
  }

  /**
   * Publish (or refresh) the worker card the parent thread shows for this run.
   *
   * The part is persisted as a working-trace message and broadcast, so it
   * survives a reopen and advances live exactly like a harness-streamed
   * sub-agent part. `childSessionId` is what the session panel opens.
   */
  async publish(input: {
    projectId: string
    coordinatorThreadId: string
    activity: AgentSubagentActivity
  }): Promise<void> {
    const id = this.partId(input.projectId, input.coordinatorThreadId)
    const part = {
      type: 'subagent' as const,
      id,
      messageID: id,
      callID: id,
      activity: input.activity
    }
    await this.host.threadManager
      .upsertMessages(input.projectId, input.coordinatorThreadId, [
        {
          id,
          role: 'assistant',
          origin: 'subagent',
          visibility: 'working_trace',
          createdAt: input.activity.time?.start ?? Date.now(),
          ...(input.activity.time?.end === undefined
            ? {}
            : { completedAt: input.activity.time.end }),
          parts: [part]
        }
      ])
      .catch((error: unknown) =>
        Logger.info('Assignment draft card could not be persisted', {
          threadId: input.coordinatorThreadId,
          error: error instanceof Error ? error.message : String(error)
        })
      )
    const parentSessionId = this.host.state.assignmentDraftParentSessions.get(
      this.draftKey(input.projectId, input.coordinatorThreadId)
    )
    if (parentSessionId && this.host.sessionRegistry.get(parentSessionId)) {
      this.host.broadcast({ type: 'message.part.updated', sessionId: parentSessionId, part })
    }
  }

  /** The activity a freshly started draft run wears on its card. */
  private runningActivity(
    settings: ThreadSettings,
    startedAt: number,
    prompt?: string
  ): AgentSubagentActivity {
    return {
      status: 'running',
      agent: 'Sr. Engineer',
      description: 'Assignment draft',
      assignmentDraft: true,
      background: true,
      harnessId: settings.harnessId || DEFAULT_HARNESS,
      providerId: settings.providerId,
      modelId: settings.modelId,
      ...(prompt ? { prompt } : {}),
      time: { start: startedAt }
    }
  }

  /**
   * Revoke the run's authority and abort its model session.
   *
   * The preserved session of an earlier failure goes with it: a newer draft,
   * an authored graph or a Stop all make continuing that work wrong.
   */
  cancel(
    projectId: string,
    coordinatorThreadId: string,
    reason: 'superseded' | 'stopped' = 'superseded'
  ): void {
    const key = this.draftKey(projectId, coordinatorThreadId)
    this.host.state.assignmentDraftRevisions.set(key, this.revision(key) + 1)
    const session = this.host.state.activeAssignmentDraftSessions.get(key)
    const wasRunning = this.host.state.activeAssignmentDraftRuns.has(key) || session !== undefined
    if (session) {
      this.host.state.userAbortedAssignmentDraftOperations.add(key)
      void this.abortSession(session)
      this.host.state.activeAssignmentDraftSessions.delete(key)
    }
    this.host.state.activeAssignmentDraftRuns.delete(key)
    this.host.state.assignmentDraftFailures.delete(key)
    this.disposePreserved(key)
    // A user Stop ends the run the user is watching, so its card must say so
    // instead of claiming to work forever. A superseded run is replaced by
    // whatever superseded it, which owns the card from now on.
    if (reason === 'stopped' && wasRunning) {
      const startedAt = this.host.state.assignmentDraftStartedAt.get(key) ?? Date.now()
      this.host.state.assignmentDraftStartedAt.delete(key)
      void this.publish({
        projectId,
        coordinatorThreadId,
        activity: {
          status: 'error',
          agent: 'Sr. Engineer',
          description: 'Assignment draft',
          assignmentDraft: true,
          background: true,
          error: 'The Assignment draft was stopped by the user.',
          time: { start: startedAt, end: Date.now() }
        }
      })
    }
  }

  private abortSession(session: ActiveAssignmentDraftSession): Promise<void> {
    const abort =
      session.isolated && supportsIsolatedSessions(session.driver)
        ? session.driver.abort(session.projectPath, session.sessionId, session.isolated)
        : session.driver.abort(session.projectPath, session.sessionId)
    return abort.catch(() => undefined)
  }

  /** Close a session the run is finished with, so no transport outlives it. */
  private releaseSession(session: ActiveAssignmentDraftSession): void {
    this.host.units['runtime-connectivity'].clearCompletionWaiter(session.sessionId)
    this.host.sessionRegistry.delete(session.sessionId)
    this.host.state.reasoningTimes.delete(session.sessionId)
    this.host.state.toolTimes.delete(session.sessionId)
    if (session.isolated && supportsIsolatedSessions(session.driver)) {
      session.driver.disposeIsolatedSession(session.isolated)
    }
  }

  /** Keep a failed run's session so a retry can continue it. */
  preserve(key: string, session: ActiveAssignmentDraftSession): void {
    this.host.state.preservedAssignmentDraftSessions.set(key, session)
  }

  private isPreserved(key: string, sessionId: string): boolean {
    return this.host.state.preservedAssignmentDraftSessions.get(key)?.sessionId === sessionId
  }

  private disposePreserved(key: string): void {
    const session = this.host.state.preservedAssignmentDraftSessions.get(key)
    this.host.state.preservedAssignmentDraftSessions.delete(key)
    if (!session) return
    void this.abortSession(session)
    this.releaseSession(session)
  }

  /**
   * Answer the caller at once and build the draft in the background.
   *
   * One-way and idempotent: an existing draft is returned, an in-flight run is
   * joined, and only an idle thread starts a new run.
   */
  async request(input: {
    projectId: string
    coordinatorThreadId: string
    settings: ThreadSettings
    instructions?: string
    /** The validator's refusal of the previous answer, handed to the next one. */
    rejected?: string
    sessionId: string
    generate: (
      projectId: string,
      coordinatorThreadId: string,
      settings: ThreadSettings,
      instructions?: string,
      rejected?: string
    ) => Promise<AssignmentPlan>
  }): Promise<AssignmentDraftStart> {
    const projectId = validateEntityId(input.projectId, 'Project ID')
    const coordinatorThreadId = validateEntityId(input.coordinatorThreadId, 'Coordinator thread ID')
    const settings = validateThreadSettings(input.settings)
    const active = this.host.state.assignmentEngine.getActive(projectId, coordinatorThreadId)
    if (active) return { state: 'draft', assignment: active }
    const spec = await this.host.units['spec'].getActiveSpec(projectId, coordinatorThreadId)
    if (spec && spec.status !== 'approved') {
      throw new Error(
        'Approve the specification before generating an Assignment from it, or dismiss the specification to build the Assignment from this conversation.'
      )
    }
    const key = this.draftKey(projectId, coordinatorThreadId)
    if (this.host.state.activeAssignmentDraftRuns.has(key)) return { state: 'formulating' }
    this.host.state.assignmentDraftParentSessions.set(key, input.sessionId)
    this.disposePreserved(key)
    const revision = this.revision(key)
    const startedAt = Date.now()
    this.host.state.assignmentDraftStartedAt.set(key, startedAt)
    void this.publish({
      projectId,
      coordinatorThreadId,
      activity: this.runningActivity(settings, startedAt, input.instructions)
    })
    // A new run supersedes the refused answer it replaces, so it never inherits a
    // stale failure.
    this.host.state.assignmentDraftFailures.delete(key)
    const task = input.generate(
      projectId,
      coordinatorThreadId,
      settings,
      input.instructions,
      input.rejected
    )
    this.host.state.activeAssignmentDraftRuns.set(key, task)
    void task.then(
      (assignment) => this.settle({ projectId, coordinatorThreadId, revision, assignment }),
      (error: unknown) => this.settle({ projectId, coordinatorThreadId, revision, error })
    )
    return { state: 'formulating' }
  }

  /**
   * Retry the failed draft by continuing its own session.
   *
   * A continuation keeps everything the model already read and reasoned about,
   * which is why it is the retry: only the answer has to be produced again. A
   * retry under a different harness cannot resume a provider-native session, so
   * that case starts a fresh run instead of pretending to continue.
   */
  async retry(input: {
    projectId: string
    coordinatorThreadId: string
    generate: (
      projectId: string,
      coordinatorThreadId: string,
      settings: ThreadSettings,
      instructions?: string,
      rejected?: string
    ) => Promise<AssignmentPlan>
    /** Store the graph a continued turn produced as the thread's draft. */
    persist: (content: AssignmentPlanContent) => Promise<AssignmentPlan>
  }): Promise<AssignmentDraftStart> {
    const projectId = validateEntityId(input.projectId, 'Project ID')
    const coordinatorThreadId = validateEntityId(input.coordinatorThreadId, 'Coordinator thread ID')
    const thread = await this.host.threadManager.getThread(projectId, coordinatorThreadId)
    if (!thread?.settings) {
      throw new Error('Select a model for this thread before retrying the Assignment.')
    }
    const settings = validateThreadSettings(thread.settings)
    const key = this.draftKey(projectId, coordinatorThreadId)
    if (this.host.state.activeAssignmentDraftRuns.has(key)) return { state: 'formulating' }
    const preserved = this.host.state.preservedAssignmentDraftSessions.get(key)
    const rejected = this.host.state.assignmentDraftFailures.get(key)
    const requestedHarness = settings.harnessId || DEFAULT_HARNESS
    if (!preserved || preserved.driverId !== requestedHarness) {
      return this.request({
        projectId,
        coordinatorThreadId,
        settings,
        ...(rejected ? { rejected } : {}),
        sessionId: thread.sessionId ?? '',
        generate: input.generate
      })
    }
    this.host.state.preservedAssignmentDraftSessions.delete(key)
    const revision = this.revision(key)
    const startedAt = this.host.state.assignmentDraftStartedAt.get(key) ?? Date.now()
    void this.publish({
      projectId,
      coordinatorThreadId,
      activity: {
        ...this.runningActivity(settings, startedAt),
        childSessionId: preserved.sessionId
      }
    })
    const task = this.continueRun(
      projectId,
      coordinatorThreadId,
      settings,
      preserved,
      revision,
      rejected
    ).then((content) => input.persist(content))
    this.host.state.activeAssignmentDraftRuns.set(key, task)
    void task.then(
      (assignment) => {
        this.releaseSession(preserved)
        this.settle({ projectId, coordinatorThreadId, revision, assignment })
      },
      (error: unknown) => this.settle({ projectId, coordinatorThreadId, revision, error })
    )
    return { state: 'formulating' }
  }

  /** Send one continuation turn into the preserved session and decode its answer. */
  private async continueRun(
    projectId: string,
    coordinatorThreadId: string,
    settings: ThreadSettings,
    session: ActiveAssignmentDraftSession,
    revision: number,
    rejected?: string
  ): Promise<AssignmentPlanContent> {
    const key = this.draftKey(projectId, coordinatorThreadId)
    this.host.state.activeAssignmentDraftSessions.set(key, session)
    const completion = this.host.units['turns-sessions'].waitForSessionCompletion(
      session.sessionId,
      CONTINUATION_TIMEOUT_MS,
      'Assignment generation'
    )
    try {
      const request: SendPromptOptions = {
        sessionId: session.sessionId,
        settings: {
          ...settings,
          permissionLevel: 'auto_review',
          assignmentMode: false,
          loopMode: false
        },
        text: assignmentContinuationPrompt(rejected),
        attachments: [],
        allowedTools: PROMPT_READ_ONLY_TOOLS
      }
      if (session.isolated && supportsIsolatedSessions(session.driver)) {
        await session.driver.sendPrompt(session.projectPath, request, session.isolated)
      } else {
        await session.driver.sendPrompt(session.projectPath, request)
      }
      const streamed = await completion
      if (streamed !== undefined) return parseGeneratedAssignmentContent(streamed)
      const generated =
        session.isolated && supportsIsolatedSessions(session.driver)
          ? await session.driver.loadMessages(
              session.projectPath,
              session.sessionId,
              session.isolated
            )
          : await session.driver.loadMessages(session.projectPath, session.sessionId)
      const response = [...generated].reverse().find((message) => message.role === 'assistant')
      if (!response) throw new Error('The Sr. Engineer returned no Assignment')
      if (response.error) throw new Error(response.error)
      if (response.structuredOutput !== undefined) {
        return parseGeneratedAssignmentContent(response.structuredOutput)
      }
      const text = response.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
      return parseGeneratedAssignmentContent(
        parseGeneratedJson(text, 'The Sr. Engineer returned invalid Assignment JSON')
      )
    } catch (error) {
      await this.abortSession(session)
      // A continuation that fails keeps the session again, so the next retry is
      // still a continuation rather than a fresh start. A cancelled run keeps
      // nothing.
      if (this.revision(key) === revision && !this.isPreserved(key, session.sessionId)) {
        this.preserve(key, session)
      }
      throw error instanceof Error ? error : new Error('Assignment generation failed.')
    } finally {
      await this.host.units['messages-write'].recordEphemeralSessionUsage({
        projectId,
        threadId: coordinatorThreadId,
        sessionId: session.sessionId,
        projectPath: session.projectPath,
        driver: session.driver,
        isolated: session.isolated
      })
      this.host.units['runtime-connectivity'].clearCompletionWaiter(session.sessionId)
      if (this.host.state.activeAssignmentDraftSessions.get(key)?.sessionId === session.sessionId) {
        this.host.state.activeAssignmentDraftSessions.delete(key)
      }
    }
  }

  /** Announce the one terminal state a settled draft run leaves behind. */
  private settle(input: {
    projectId: string
    coordinatorThreadId: string
    revision: number
    assignment?: AssignmentPlan
    error?: unknown
  }): void {
    const key = this.draftKey(input.projectId, input.coordinatorThreadId)
    if (this.revision(key) !== input.revision) return
    this.host.state.activeAssignmentDraftRuns.delete(key)
    const startedAt = this.host.state.assignmentDraftStartedAt.get(key) ?? Date.now()
    this.host.state.assignmentDraftStartedAt.delete(key)
    if (input.assignment) {
      this.host.state.assignmentDraftFailures.delete(key)
      void this.settleStatus(input.projectId, input.coordinatorThreadId, 'spec')
      void this.publish({
        projectId: input.projectId,
        coordinatorThreadId: input.coordinatorThreadId,
        activity: {
          status: 'completed',
          agent: 'Sr. Engineer',
          description: 'Assignment draft',
          assignmentDraft: true,
          background: true,
          output: `Assignment draft v${input.assignment.version} is ready for review.`,
          time: { start: startedAt, end: Date.now() }
        }
      })
      this.host.broadcast({
        type: 'assignment.ready',
        sessionId: this.host.state.assignmentDraftParentSessions.get(key) ?? '',
        projectId: input.projectId,
        threadId: input.coordinatorThreadId,
        assignmentId: input.assignment.id,
        version: input.assignment.version
      })
      return
    }
    const error =
      input.error instanceof Error ? input.error.message : 'Assignment generation failed.'
    this.host.state.assignmentDraftFailures.set(key, error)
    void this.settleStatus(input.projectId, input.coordinatorThreadId, 'failed', error)
    void this.publish({
      projectId: input.projectId,
      coordinatorThreadId: input.coordinatorThreadId,
      activity: {
        status: 'error',
        agent: 'Sr. Engineer',
        description: 'Assignment draft',
        assignmentDraft: true,
        background: true,
        error,
        time: { start: startedAt, end: Date.now() }
      }
    })
    this.host.broadcast({
      type: 'assignment.failed',
      sessionId: this.host.state.assignmentDraftParentSessions.get(key) ?? '',
      projectId: input.projectId,
      threadId: input.coordinatorThreadId,
      error
    })
  }

  private async settleStatus(
    projectId: string,
    coordinatorThreadId: string,
    status: 'spec' | 'failed',
    error?: string
  ): Promise<void> {
    try {
      await this.host.threadManager.setStatus(projectId, coordinatorThreadId, status, {
        read: false,
        ...(error ? { error } : {})
      })
    } catch {
      // A thread deleted while its draft was settling has no status left to own.
    }
  }
}
