import { join, resolve } from 'path'
import { randomBytes } from 'crypto'
import { Logger } from '../../system/logger'
import { DEFAULT_HARNESS } from '../../../lib/harness-default'
import { formatTime } from '../../../lib/date-time-format'
import type { UtilityTurnBudgetContext } from '../../utilities/utility-orchestration-service'
import type { AuditReport, AuditReportContent, Thread, ThreadSettings } from '../../../lib/types'
import { estimateTextTokens } from '../../../lib/prompt-budget'
import { ensureFeatureSlug } from '../../../lib/project-artifacts'
import { messageId as createMessageId } from '../../../lib/id'
import { buildTranscriptMarkdown } from '../../../lib/transcript'
import {
  AuditReportValidationError,
  parseAuditReportContent,
  validateAuditReportContent
} from '../../../lib/audit/audit-validation'
import type { AssignmentAuditRepairManifest } from './chat-engine-types'
import { rawErrorDetail, rawErrorMessage } from './chat-engine-errors'
import {
  ASSIGNMENT_AUDIT_EVIDENCE_CONTRACT,
  AUDIT_ALLOWED_TOOLS,
  formatOpenAnnotations
} from './chat-engine-prompts'
import {
  assignmentAuditErrorsUnchanged,
  assignmentAuditRepairPrompt,
  auditCorrectionPrompt,
  auditRequiresRework,
  latestAssignmentAuditOutput,
  validateAssignmentAuditExecutionEvidence
} from './chat-engine-pure'
import { ChatEngine } from '../chat-engine'

/** ChatEngine audit-run: one concern, moved verbatim from the composition root. */
export class ChatEngineAuditRun {
  constructor(private readonly host: ChatEngine) {}

  async runIndependentAudit(
    projectId: string,
    coordinatorThreadId: string,
    settings: ThreadSettings
  ): Promise<{ report: AuditReport; auditorThread: Thread }> {
    const coordinator = await this.host.threadManager.getThread(projectId, coordinatorThreadId)
    if (!coordinator || coordinator.independentAudit !== true) {
      throw new Error('Independent audit is not enabled for this thread.')
    }
    const auditorThread = await this.host.ensureIndependentAuditorThread(
      projectId,
      coordinatorThreadId,
      settings
    )
    const auditorSettings = auditorThread.settings ?? settings
    const driverId = auditorSettings.harnessId || DEFAULT_HARNESS
    const { driver, projectPath } = await this.host.resolve(projectId, driverId, auditorThread.id)
    const sessionId = await this.host.ensureSession(projectId, auditorThread.id, driverId)
    const transcript = buildTranscriptMarkdown(
      await this.host.loadMessages(projectId, coordinatorThreadId),
      { includeTrace: false }
    )
    if (!transcript.trim()) {
      throw new Error('The thread has no auditable conversation yet.')
    }
    // A rework cycle: a previous report exists and the coordinator agent was
    // sent rework feedback after it. The next audit verifies that rework
    // against the previous findings instead of re-judging the whole thread.
    const previousReport =
      coordinator.activeAuditId !== undefined
        ? (this.host.state.auditEngine
            .listVersions(projectId, coordinatorThreadId, coordinator.activeAuditId)
            .sort((left, right) => right.version - left.version)[0] ?? null)
        : null
    const previousReportPath = previousReport
      ? await this.host.units['media-artifacts'].artifactRef(
          projectId,
          coordinatorThreadId,
          join('versions', `${previousReport.id}-audit-v${previousReport.version}.md`)
        )
      : undefined
    const basePrompt = [
      'Independently audit the current work of this thread.',
      'No specification exists: the transcript below contains the user\u2019s requests and the agent\u2019s final outputs. Treat it as the contract, and verify the delivered work against the repository with read-only tools before reporting.',
      ...(previousReport && previousReportPath
        ? [
            '',
            `This is a rework-verification pass. A previous audit report (v${previousReport.version}) exists at ${previousReportPath}; read it first. The transcript below also contains the rework instructions and the agent\u2019s latest response that acted on that report.`,
            'Judge this run against the previous report: keep every previous finding that is still unresolved (same id, updated evidence), omit findings the rework resolved, report new findings the rework introduced, and state the resolution outcome of every previous finding in the executive summary. Re-run the applicable verification checks against the reworked files.'
          ]
        : []),
      '',
      'Thread transcript:',
      '',
      transcript
    ].join('\n')
    const auditStartedAt = Date.now()
    const runId = `${auditStartedAt}-${randomBytes(4).toString('hex')}`
    let lastError: Error | null = null
    /** The most recent structurally-valid report content plus the evidence
     *  gaps that kept it from full validation. When the correction attempts are
     *  exhausted this is persisted as a partial report instead of discarding
     *  a generated report. */
    let partialCandidate: {
      content: AuditReportContent
      issues: string[]
    } | null = null
    // A previous failed run leaves the auditor's durable session intact, so
    // the next run continues from where it stopped instead of re-auditing
    // the whole thread from scratch.
    let promptKind: 'initial' | 'resume' | 'correct' =
      auditorThread.status === 'failed' ? 'resume' : 'initial'
    let previousFailure = auditorThread.lastError ?? 'The previous run failed.'
    /** Timestamp of the current dispatch. Responses older than this belong to
     *  the previous attempt (or run) and must never be accepted as this
     *  attempt's answer: a resumed codex session can replay its prior
     *  structured output, and validating that stale report re-throws the
     *  identical evidence error with zero new auditor work. */
    let continuationRetries = 0

    /** Continuation prompt for a run that stopped partway: the auditor keeps
     *  its prior session context, so it resumes rather than restarting. */
    const resumePrompt = (failure: string): string =>
      [
        'Your previous independent audit run stopped partway with an error, and no report was delivered.',
        `Previous failure: ${failure}`,
        'Your session still contains the work from that run; continue the audit from where you left off instead of starting over. The transcript below is unchanged and remains the contract. Finish the remaining verification and return exactly one audit-report JSON object with no Markdown fences or commentary.',
        '',
        'Thread transcript:',
        '',
        transcript
      ].join('\n')

    // The first run permanently initializes the independent audit: the
    // composer switch disappears and the coordinator stays for the thread's
    // lifetime.
    await this.host.threadManager.updateThread(projectId, coordinatorThreadId, {
      independentAuditInitialized: true
    })
    for (let attemptIndex = 0; attemptIndex < 3; attemptIndex += 1) {
      const attemptStartedAt = Date.now()
      await this.host.threadManager.setStatus(projectId, auditorThread.id, 'executing')
      this.host.handledIdleSessions.delete(sessionId)
      this.host.units['turns-sessions'].markSessionWorking(sessionId)
      const messageId = createMessageId()
      const prompt =
        promptKind === 'initial'
          ? basePrompt
          : promptKind === 'resume'
            ? resumePrompt(previousFailure)
            : auditCorrectionPrompt(lastError)
      await this.host.units['messages-write'].persistOutboundMessage(
        projectId,
        auditorThread.id,
        messageId,
        'Independent audit of the current thread work',
        prompt,
        [],
        [],
        [],
        promptKind === 'resume'
          ? {
              action: 'Independent audit',
              body: 'Continuing the audit from where the previous run stopped.'
            }
          : promptKind === 'initial'
            ? {
                action: 'Independent audit',
                body: 'Auditing the current thread work against its transcript and the repository.'
              }
            : undefined,
        'internal'
      )
      const outboundIds =
        this.host.state.outboundMessageIdsBySession.get(sessionId) ?? new Set<string>()
      outboundIds.add(messageId)
      this.host.state.outboundMessageIdsBySession.set(sessionId, outboundIds)
      const completion = this.host.units['turns-sessions'].waitForSessionCompletion(
        sessionId,
        ChatEngine.AUDIT_RUN_TIMEOUT_MS,
        'Independent audit'
      )
      try {
        const auditUtilityBudgetContext: UtilityTurnBudgetContext = {
          selectedModelInputTokens: this.host.units['runtime-agents'].selectedModelInputBudget(
            auditorSettings.providerId,
            auditorSettings.modelId,
            projectId
          ),
          composedTurnTokens: estimateTextTokens(prompt),
          parentTurnId: messageId
        }
        const utilityTurn = await this.host.units['audit'].prepareAuditUtilities(
          driver,
          projectId,
          auditorThread,
          sessionId,
          projectPath,
          auditorSettings,
          auditUtilityBudgetContext
        )
        await driver.sendPrompt(projectPath, {
          sessionId,
          settings: auditorSettings,
          text: prompt,
          attachments: [],
          systemPrompt: [
            await this.host.units['turns-dispatch'].cioPrompt('independent-audit-report'),
            utilityTurn.instructions
          ]
            .filter(Boolean)
            .join('\n\n'),
          allowedTools: AUDIT_ALLOWED_TOOLS,
          userMessageId: messageId
        })
        const streamed = await completion
        let content: AuditReportContent
        if (streamed !== undefined) {
          content = validateAuditReportContent(streamed, { requireVerification: true })
        } else {
          const messages = await driver.loadMessages(projectPath, sessionId)
          const response = [...messages].reverse().find((message) => message.role === 'assistant')
          if (!response) throw new Error('The Auditor returned no response')
          if (response.createdAt < attemptStartedAt - 1_000) {
            throw new Error(
              'The Auditor session replayed a stale response from a previous turn instead of answering this attempt.'
            )
          }
          if (response.error) throw new Error(response.error)
          content =
            response.structuredOutput !== undefined
              ? validateAuditReportContent(response.structuredOutput, {
                  requireVerification: true
                })
              : parseAuditReportContent(
                  response.parts
                    .filter((part) => part.type === 'text')
                    .map((part) => part.text)
                    .join('\n'),
                  { requireVerification: true }
                )
        }
        // Most recent structurally-valid content, kept as the partial fallback
        // whenever the evidence matcher still leaves gaps on that response.
        partialCandidate = { content, issues: [] }
        const evidence = validateAssignmentAuditExecutionEvidence({
          content,
          messages: await driver.loadMessages(projectPath, sessionId),
          auditStartedAt,
          utilitySearchRequired: utilityTurn.runtimeAvailable
        })
        const checkInvocations = evidence.checkInvocations
        const evidenceIssues = evidence.issues
        if (evidenceIssues.length > 0) {
          // The auditor still has its correction attempts; this content is kept
          // as the partial fallback if every attempt stays unvalidated.
          partialCandidate = { content, issues: evidenceIssues }
          content = await this.host.units['audit-report'].persistAssignmentAuditCheckEvidence({
            projectId,
            threadId: coordinatorThreadId,
            runId,
            content,
            checkInvocations,
            requireInvocations: false
          })
          throw new AuditReportValidationError(evidenceIssues)
        }
        content = await this.host.units['audit-report'].persistAssignmentAuditCheckEvidence({
          projectId,
          threadId: coordinatorThreadId,
          runId,
          content,
          checkInvocations
        })
        const report = await this.host.state.auditEngine.create({
          projectId,
          threadId: coordinatorThreadId,
          independent: true,
          content,
          outcome: auditRequiresRework(content) ? 'rework_required' : 'passed',
          provenance: {
            source: 'agent',
            actor: 'auditor',
            harnessId: auditorSettings.harnessId,
            providerId: auditorSettings.providerId,
            modelId: auditorSettings.modelId
          }
        })
        await this.host.threadManager.setAuditState(
          projectId,
          coordinatorThreadId,
          'report_ready',
          {
            id: report.id,
            version: report.version
          }
        )
        await this.host.threadManager.setStatus(projectId, auditorThread.id, 'completed', {
          read: false
        })
        // Park the coordinator on `spec` while the report is under review: the
        // same settle the implementation and Achievement audits end on, because
        // a ready report is a finished artifact waiting on the user. Landing on
        // `completed` instead read as done, so the audited thread stayed in the
        // Done group with no spec mark and no review-ready count on its project
        // strip. `setStatus` also advances the thread's activity and clears its
        // manual sort anchor, so the report bubbling up is the same write.
        await this.host.threadManager.setStatus(projectId, coordinatorThreadId, 'spec', {
          read: false
        })
        await this.host.loadMessages(projectId, auditorThread.id)
        await this.host.units['audit'].notifyIndependentAuditCompletion(
          projectId,
          coordinatorThreadId,
          'completed'
        )
        return {
          report,
          auditorThread:
            (await this.host.threadManager.getThread(projectId, auditorThread.id)) ?? auditorThread
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('The Auditor failed.')
        previousFailure = lastError.message
        // A provider usage/rate-limit reset parks the session in a retry wait
        // (sometimes hours away). Every further prompt in this run bounces off
        // it within seconds, so burning the remaining attempts only delays the
        // inevitable: fail fast with the reset window instead.
        const pendingRetry = this.host.state.retryScheduler?.getPendingRetry(sessionId)
        if (pendingRetry?.retryAt !== undefined && pendingRetry.retryAt > Date.now() + 60_000) {
          lastError = new Error(
            `The Auditor's provider hit its usage limit before the audit could finish. The provider resets at ${formatTime(pendingRetry.retryAt)}; run the audit again after that window.`
          )
          break
        }
        const correctableOutput =
          lastError instanceof AuditReportValidationError ||
          lastError instanceof SyntaxError ||
          lastError.message === 'The Auditor returned no response'
        if (correctableOutput) {
          promptKind = 'correct'
        } else if (continuationRetries < 1 && attemptIndex < 2) {
          // A mid-run failure (stream error, timeout, transport crash) gets one
          // automatic continuation attempt before the run is marked failed:
          // the auditor resumes its own session rather than starting over.
          continuationRetries += 1
          promptKind = 'resume'
        } else {
          break
        }
      } finally {
        this.host.units['runtime-connectivity'].clearCompletionWaiter(sessionId)
        await this.host.units['audit'].cleanupAuditUtilities(
          'Independent',
          projectId,
          coordinatorThreadId,
          auditorThread.id,
          sessionId
        )
      }
    }

    // The auditor generated a structurally-valid report but every correction
    // attempt still left evidence gaps in the transcript. Persist it as a
    // partial report instead of discarding the work: it stays viewable in Spec
    // Studio, and the half-report card offers re-validation or a model change.
    if (partialCandidate !== null && partialCandidate.issues.length > 0) {
      const report = await this.host.state.auditEngine.create({
        projectId,
        threadId: coordinatorThreadId,
        independent: true,
        content: partialCandidate.content,
        outcome: auditRequiresRework(partialCandidate.content) ? 'rework_required' : 'passed',
        evidenceValidation: 'partial',
        evidenceIssues: partialCandidate.issues,
        provenance: {
          source: 'agent',
          actor: 'auditor',
          harnessId: auditorSettings.harnessId,
          providerId: auditorSettings.providerId,
          modelId: auditorSettings.modelId
        }
      })
      await this.host.threadManager.setAuditState(projectId, coordinatorThreadId, 'report_ready', {
        id: report.id,
        version: report.version
      })
      await this.host.threadManager.setStatus(projectId, auditorThread.id, 'completed', {
        read: false
      })
      // Same settle as the validated path above: a partial report is still a
      // report the user has to read, so its thread parks on `spec` too.
      await this.host.threadManager.setStatus(projectId, coordinatorThreadId, 'spec', {
        read: false
      })
      await this.host.loadMessages(projectId, auditorThread.id)
      await this.host.units['audit'].notifyIndependentAuditCompletion(
        projectId,
        coordinatorThreadId,
        'completed'
      )
      Logger.error('Independent audit persisted with unvalidated evidence', {
        projectId,
        threadId: coordinatorThreadId,
        reportId: report.id,
        version: report.version,
        issues: partialCandidate.issues.length,
        error: (lastError ?? new Error('Evidence validation failed.')).message
      })
      return {
        report,
        auditorThread:
          (await this.host.threadManager.getThread(projectId, auditorThread.id)) ?? auditorThread
      }
    }

    await this.host.threadManager.setStatus(projectId, auditorThread.id, 'failed', {
      read: false,
      error: (lastError ?? new Error('The independent audit failed.')).message,
      errorDetail: lastError ? rawErrorDetail(lastError) : undefined
    })
    await this.host.units['audit'].notifyIndependentAuditCompletion(
      projectId,
      coordinatorThreadId,
      'error',
      lastError ? rawErrorDetail(lastError) : undefined
    )
    throw lastError ?? new Error('The independent audit failed.')
  }

  async runAssignmentAudit(
    projectId: string,
    coordinatorThreadId: string,
    settings: ThreadSettings
  ): Promise<{ report: AuditReport; auditorThread: Thread }> {
    // A spec-less Assignment is audited against its own conversation contract,
    // exactly like an independent audit: the user's requests and the completed
    // Assignment graph are the standard, and every claim is verified against
    // the repository. An approved specification wins whenever it exists.
    const activeSpec = await this.host.units['spec'].getActiveSpec(projectId, coordinatorThreadId)
    const spec = activeSpec && activeSpec.status === 'approved' ? activeSpec : null
    const assignment = this.host.state.assignmentEngine.getActive(projectId, coordinatorThreadId)
    if (!assignment || assignment.status !== 'completed') {
      throw new Error('A completed Assignment is required before its durable audit can start.')
    }
    const auditRunKey = `${projectId}:${assignment.id}`
    const auditorThread = await this.host.ensureAssignmentAuditorThread(
      projectId,
      coordinatorThreadId,
      settings
    )
    const auditorSettings = auditorThread.settings ?? settings
    const driverId = auditorSettings.harnessId || DEFAULT_HARNESS
    const { driver, projectPath } = await this.host.resolve(projectId, driverId, auditorThread.id)
    const sessionId = await this.host.ensureSession(projectId, auditorThread.id, driverId)
    // Durable sessions must remain loadable after the run. OpenCode accepts a
    // JSON-schema request but cannot decode that persisted message later, so
    // enforce the same contract through JSON-only prompts and validation.
    const specPath = spec
      ? await this.host.units['media-artifacts'].artifactRef(
          projectId,
          coordinatorThreadId,
          join('versions', `${spec.id}-v${spec.version}.md`)
        )
      : null
    const assignmentPath = await this.host.units['media-artifacts'].artifactRef(
      projectId,
      coordinatorThreadId,
      'assignment.md'
    )
    const featureSlug = await ensureFeatureSlug(this.host.database, projectId, coordinatorThreadId)
    const taskScope = assignment.content.tasks
      .map((task) => {
        const evidenceThreadId = task.threadId ?? assignment.coordinatorThreadId
        const checklist = task.auditChecklist.map((item) => `  - ${item}`).join('\n') || '  - None'
        const expectedFiles =
          task.expectedFiles.map((path) => `  - ${path}`).join('\n') || '  - None'
        const reportedEvidence = task.report?.evidence.map((item) => `  - ${item}`).join('\n')
        const reviewEvidence = task.review?.checklistResults
          .map(
            (result) =>
              `  - ${result.passed ? 'PASS' : 'FAIL'}: ${result.item}${result.evidence ? `   ${result.evidence}` : ''}`
          )
          .join('\n')
        return [
          `Task ${task.id}: ${task.title}`,
          `Expected files:\n${expectedFiles}`,
          `Audit checklist:\n${checklist}`,
          `Baseline evidence: .cio/specs/${featureSlug}/tasks/${evidenceThreadId}/test/baseline.txt`,
          `Final-check evidence: .cio/specs/${featureSlug}/tasks/${evidenceThreadId}/test/check.txt`,
          ...(task.report?.commitHash ? [`Reported commit: ${task.report.commitHash}`] : []),
          ...(reportedEvidence ? [`Worker-reported evidence:\n${reportedEvidence}`] : []),
          ...(reviewEvidence ? [`Sr. Engineer checklist review:\n${reviewEvidence}`] : [])
        ].join('\n')
      })
      .join('\n\n')
    const basePrompt = [
      spec
        ? 'Audit the current project implementation against the approved specification and completed Assignment:'
        : 'Audit the current project implementation against the completed Assignment and the thread that defined it. No specification exists for this work; the Assignment graph and its task prompts are the contract.',
      ...(specPath ? [`Specification: ${specPath}`] : []),
      `Assignment: ${assignmentPath}`,
      `Assignment implementation scope and persisted evidence:\n${taskScope}`,
      'Treat the expected-file lists as the minimum scope, then use the reported commits, repository status/history, imports, and affected consumers to enumerate every additional implementation file that must be audited.',
      ...(spec
        ? [`Open annotations on the specification:\n${formatOpenAnnotations(spec.annotations)}`]
        : [])
    ].join('\n\n')
    let terminalFailure: Error
    /** Latest shape-valid attempt content plus its remaining evidence gaps,
     *  persisted as a partial report when the repair loop exhausts. */
    let partialCandidate: {
      content: AuditReportContent
      issues: string[]
    } | null = null
    const resumingAudit = assignment.auditCycle?.status === 'running'
    const auditStartedAt =
      resumingAudit && assignment.auditCycle?.startedAt !== undefined
        ? assignment.auditCycle.startedAt
        : Date.now()
    const runId = `${auditStartedAt}-${randomBytes(4).toString('hex')}`
    // Mark the cycle running before any driver or recovery work: a retry must
    // flip both audit cards (the Sr. Engineer's and the auditor's) the moment it
    // starts, even if the harness session is slow to come back. The recovery
    // block below is guarded so it can never leave the cycle running.
    if (!resumingAudit) {
      await this.host.state.assignmentEngine.beginAuditCycle(projectId, coordinatorThreadId)
    }
    await this.host.threadManager.setAuditState(projectId, coordinatorThreadId, 'running')
    await this.host.threadManager.setStatus(projectId, coordinatorThreadId, 'executing', {
      read: false
    })
    const priorRepair = await this.host.units['audit'].readAssignmentAuditRepairManifest(
      projectId,
      coordinatorThreadId
    )
    let repairManifest: AssignmentAuditRepairManifest | null =
      priorRepair?.status === 'invalid' &&
      priorRepair.assignmentId === assignment.id &&
      priorRepair.specId === spec?.id &&
      priorRepair.specVersion === spec?.version
        ? priorRepair
        : null
    let recoveredContent: AuditReportContent | null = null
    if (
      repairManifest === null &&
      (resumingAudit ||
        assignment.auditCycle?.status === 'failed' ||
        auditorThread.status === 'failed')
    ) {
      // Reading the interrupted session is best-effort: a stale or unreachable
      // harness must not abort the retry after the cycle is already running.
      let previousOutput: string | null = null
      try {
        previousOutput = latestAssignmentAuditOutput(
          await driver.loadMessages(projectPath, sessionId)
        )
      } catch (error) {
        Logger.dev('Assignment audit recovery read failed:', error)
      }
      if (previousOutput !== null) {
        const recoveredAttempt = await this.host.units[
          'audit-report'
        ].persistAssignmentAuditAttempt({
          projectId,
          threadId: coordinatorThreadId,
          runId,
          attempt: 1,
          rawOutput: previousOutput
        })
        try {
          recoveredContent = await this.host.units[
            'audit-report'
          ].validatePersistedAssignmentAuditAttempt(
            projectId,
            coordinatorThreadId,
            recoveredAttempt.relativePath
          )
          const evidence = validateAssignmentAuditExecutionEvidence({
            content: recoveredContent,
            assignment,
            messages: await driver.loadMessages(projectPath, sessionId),
            auditStartedAt,
            utilitySearchRequired: false
          })
          if (evidence.issues.length > 0) {
            throw new AuditReportValidationError(evidence.issues)
          }
          recoveredContent = await this.host.units[
            'audit-report'
          ].persistAssignmentAuditCheckEvidence({
            projectId,
            threadId: coordinatorThreadId,
            runId,
            content: recoveredContent,
            checkInvocations: evidence.checkInvocations
          })
          await this.host.units['audit-report'].writeAssignmentAuditRepairManifest({
            schemaVersion: 1,
            status: 'valid',
            projectId,
            threadId: coordinatorThreadId,
            assignmentId: assignment.id,
            specId: spec?.id,
            specVersion: spec?.version,
            runId,
            attempt: 1,
            attemptPath: recoveredAttempt.artifactPath,
            errors: [],
            updatedAt: Date.now()
          })
        } catch (error) {
          const errors =
            error instanceof AuditReportValidationError ? error.issues : [rawErrorMessage(error)]
          const invalidManifest: AssignmentAuditRepairManifest = {
            schemaVersion: 1,
            status: 'invalid',
            projectId,
            threadId: coordinatorThreadId,
            assignmentId: assignment.id,
            specId: spec?.id,
            specVersion: spec?.version,
            runId,
            attempt: 1,
            attemptPath: recoveredAttempt.artifactPath,
            errors,
            updatedAt: Date.now()
          }
          await this.host.units['audit-report'].writeAssignmentAuditRepairManifest(invalidManifest)
          repairManifest = invalidManifest
        }
      }
    }

    if (recoveredContent !== null) {
      return this.host.units['audit'].completeAssignmentAudit({
        projectId,
        coordinatorThreadId,
        spec,
        assignment,
        content: recoveredContent,
        auditorThread,
        auditorSettings
      })
    }
    for (let attemptIndex = 0; ; attemptIndex += 1) {
      if (this.host.state.stoppedAssignmentAuditRuns.has(auditRunKey)) {
        terminalFailure = new Error('Assignment audit stopped by user')
        break
      }
      await this.host.threadManager.setStatus(projectId, auditorThread.id, 'executing')
      this.host.handledIdleSessions.delete(sessionId)
      this.host.units['turns-sessions'].markSessionWorking(sessionId)
      const messageId = createMessageId()
      const repairing = repairManifest !== null
      const prompt = repairManifest ? assignmentAuditRepairPrompt(repairManifest) : basePrompt
      const auditUtilityBudgetContext: UtilityTurnBudgetContext = {
        selectedModelInputTokens: this.host.units['runtime-agents'].selectedModelInputBudget(
          auditorSettings.providerId,
          auditorSettings.modelId,
          projectId
        ),
        composedTurnTokens: estimateTextTokens(prompt),
        parentTurnId: messageId
      }
      let utilityInstructions = ''
      let utilityRuntimeAvailable = false
      if (!repairing) {
        const utilityTurn = await this.host.units['audit'].prepareAuditUtilities(
          driver,
          projectId,
          auditorThread,
          sessionId,
          projectPath,
          auditorSettings,
          auditUtilityBudgetContext
        )
        utilityInstructions = utilityTurn.instructions
        utilityRuntimeAvailable = utilityTurn.runtimeAvailable
      }
      await this.host.units['messages-write'].persistOutboundMessage(
        projectId,
        auditorThread.id,
        messageId,
        `Audit ${assignment.content.title}`,
        prompt,
        [],
        [],
        [],
        attemptIndex === 0 && !repairing
          ? { action: 'Audit Assignment', body: assignment.content.title }
          : undefined,
        'internal'
      )
      const outboundIds =
        this.host.state.outboundMessageIdsBySession.get(sessionId) ?? new Set<string>()
      outboundIds.add(messageId)
      this.host.state.outboundMessageIdsBySession.set(sessionId, outboundIds)
      const completion = this.host.units['turns-sessions'].waitForSessionCompletion(
        sessionId,
        ChatEngine.AUDIT_RUN_TIMEOUT_MS,
        'Assignment audit'
      )
      try {
        const auditSystemPrompt = repairing
          ? await this.host.units['turns-dispatch'].cioPrompt('audit-repair')
          : [
              await this.host.units['turns-dispatch'].cioPrompt(
                spec ? 'audit-report' : 'independent-audit-report'
              ),
              ASSIGNMENT_AUDIT_EVIDENCE_CONTRACT,
              utilityInstructions
            ]
              .filter(Boolean)
              .join('\n\n')
        auditUtilityBudgetContext.composedTurnTokens =
          estimateTextTokens(prompt) + estimateTextTokens(auditSystemPrompt)
        await driver.sendPrompt(projectPath, {
          sessionId,
          settings: auditorSettings,
          text: prompt,
          attachments: [],
          systemPrompt: auditSystemPrompt,
          // Audits are read-only regardless of gateway availability: the
          // allowlist never opens file-mutating tools, even when the gateway
          // runtime is prepared (previously this branch was unrestricted).
          allowedTools: AUDIT_ALLOWED_TOOLS,
          userMessageId: messageId
        })
        const streamed = await completion
        if (this.host.state.stoppedAssignmentAuditRuns.has(auditRunKey)) {
          throw new Error('Assignment audit stopped by user')
        }
        let rawOutput: string
        if (streamed !== undefined) {
          rawOutput =
            typeof streamed === 'string'
              ? streamed
              : (JSON.stringify(streamed, null, 2) ?? String(streamed))
        } else {
          const messages = await driver.loadMessages(projectPath, sessionId)
          const response = [...messages].reverse().find((message) => message.role === 'assistant')
          if (!response) throw new Error('The Assignment auditor returned no response')
          if (response.error) throw new Error(response.error)
          rawOutput =
            response.structuredOutput !== undefined
              ? (JSON.stringify(response.structuredOutput, null, 2) ??
                String(response.structuredOutput))
              : response.parts
                  .filter((part) => part.type === 'text')
                  .map((part) => part.text)
                  .join('\n')
        }
        const persistedAttempt = await this.host.units[
          'audit-report'
        ].persistAssignmentAuditAttempt({
          projectId,
          threadId: coordinatorThreadId,
          runId,
          attempt: attemptIndex + 1,
          rawOutput
        })
        let content: AuditReportContent
        try {
          content = await this.host.units['audit-report'].validatePersistedAssignmentAuditAttempt(
            projectId,
            coordinatorThreadId,
            persistedAttempt.relativePath
          )
          const evidence = validateAssignmentAuditExecutionEvidence({
            content,
            assignment,
            messages: await driver.loadMessages(projectPath, sessionId),
            auditStartedAt,
            utilitySearchRequired: utilityRuntimeAvailable
          })
          if (evidence.issues.length > 0) {
            // The repair loop still gets its feedback; this content is kept as
            // the partial fallback if no later attempt validates fully.
            partialCandidate = { content, issues: evidence.issues }
            throw new AuditReportValidationError(evidence.issues)
          }
          content = await this.host.units['audit-report'].persistAssignmentAuditCheckEvidence({
            projectId,
            threadId: coordinatorThreadId,
            runId,
            content,
            checkInvocations: evidence.checkInvocations
          })
        } catch (error) {
          const errors =
            error instanceof AuditReportValidationError ? error.issues : [rawErrorMessage(error)]
          const previousManifest = repairManifest
          const unchanged = assignmentAuditErrorsUnchanged(previousManifest, errors)
          const invalidManifest: AssignmentAuditRepairManifest = {
            schemaVersion: 1,
            status: 'invalid',
            projectId,
            threadId: coordinatorThreadId,
            assignmentId: assignment.id,
            specId: spec?.id,
            specVersion: spec?.version,
            runId,
            attempt: attemptIndex + 1,
            attemptPath: persistedAttempt.artifactPath,
            errors,
            ...(previousManifest ? { previousErrors: previousManifest.errors } : {}),
            updatedAt: Date.now()
          }
          await this.host.units['audit-report'].writeAssignmentAuditRepairManifest(invalidManifest)
          if (unchanged) {
            throw new Error(
              `Assignment audit made no progress after incremental correction. Remaining validation errors:\n${errors.map((issue) => `- ${issue}`).join('\n')}`,
              { cause: error }
            )
          }
          repairManifest = invalidManifest
          continue
        }
        await this.host.units['audit-report'].writeAssignmentAuditRepairManifest({
          schemaVersion: 1,
          status: 'valid',
          projectId,
          threadId: coordinatorThreadId,
          assignmentId: assignment.id,
          specId: spec?.id,
          specVersion: spec?.version,
          runId,
          attempt: attemptIndex + 1,
          attemptPath: persistedAttempt.artifactPath,
          errors: [],
          updatedAt: Date.now()
        })
        return this.host.units['audit'].completeAssignmentAudit({
          projectId,
          coordinatorThreadId,
          spec,
          assignment,
          content,
          auditorThread,
          auditorSettings
        })
      } catch (error) {
        terminalFailure =
          error instanceof Error ? error : new Error('The Assignment auditor failed.')
        break
      } finally {
        this.host.units['runtime-connectivity'].clearCompletionWaiter(sessionId)
        await this.host.units['audit'].cleanupAuditUtilities(
          'Assignment',
          projectId,
          coordinatorThreadId,
          auditorThread.id,
          sessionId
        )
      }
    }

    const failure = terminalFailure
    const stoppedAssignment = this.host.state.assignmentEngine.getActive(
      projectId,
      coordinatorThreadId
    )
    if (
      this.host.state.stoppedAssignmentAuditRuns.has(auditRunKey) ||
      stoppedAssignment?.status === 'stopped'
    ) {
      Logger.info('Assignment audit stopped', {
        projectId,
        threadId: coordinatorThreadId,
        auditorThreadId: auditorThread.id
      })
      throw failure
    }
    // The auditor generated a shape-valid report but every repair attempt still
    // left evidence gaps. Persist it as a partial report so the card and Spec
    // Studio surface it instead of discarding the generated work.
    if (partialCandidate !== null && partialCandidate.issues.length > 0) {
      const completed = await this.host.units['audit'].completeAssignmentAudit({
        projectId,
        coordinatorThreadId,
        spec,
        assignment,
        content: partialCandidate.content,
        auditorThread,
        auditorSettings,
        evidenceValidation: 'partial',
        evidenceIssues: partialCandidate.issues
      })
      Logger.error('Assignment audit persisted with unvalidated evidence', {
        projectId,
        threadId: coordinatorThreadId,
        reportId: completed.report.id,
        version: completed.report.version,
        issues: partialCandidate.issues.length,
        error: failure.message
      })
      return completed
    }
    Logger.error('Assignment audit failed', {
      projectId,
      threadId: coordinatorThreadId,
      auditorThreadId: auditorThread.id,
      harnessId: auditorSettings.harnessId,
      providerId: auditorSettings.providerId,
      modelId: auditorSettings.modelId,
      elapsedMs: Math.max(0, Date.now() - auditStartedAt),
      error: failure.message
    })
    await this.host.state.assignmentEngine.failAuditCycle(
      projectId,
      coordinatorThreadId,
      failure.message
    )
    await this.host.threadManager.setAuditState(projectId, coordinatorThreadId, 'offered')
    await this.host.threadManager.setStatus(projectId, coordinatorThreadId, 'spec', {
      read: false
    })
    await this.host.threadManager.setStatus(projectId, auditorThread.id, 'failed', {
      read: false,
      error: failure.message,
      errorDetail: rawErrorDetail(failure)
    })
    throw failure
  }

  async runImplementationAudit(
    projectId: string,
    coordinatorThreadId: string,
    settings: ThreadSettings
  ): Promise<{ report: AuditReport; auditorThread: Thread }> {
    const spec = await this.host.units['spec'].getActiveSpec(projectId, coordinatorThreadId)
    const brainstorm = !spec
      ? await this.host.units['brainstorm'].implementationBrainstormContract(
          projectId,
          coordinatorThreadId
        )
      : null
    if ((spec && spec.status !== 'approved') || (!spec && !brainstorm)) {
      throw new Error('An approved specification or finalized Brainstorm is required before audit.')
    }
    const contractSummary = spec?.content.resolutionSummary ?? brainstorm?.content.summary ?? ''
    const auditorThread = await this.host.ensureImplementationAuditorThread(
      projectId,
      coordinatorThreadId,
      settings
    )
    const auditorSettings = auditorThread.settings ?? settings
    const driverId = auditorSettings.harnessId || DEFAULT_HARNESS
    const { driver, projectPath } = await this.host.resolve(projectId, driverId, auditorThread.id)
    const sessionId = await this.host.ensureSession(projectId, auditorThread.id, driverId)
    const contractPath = await this.host.units['media-artifacts'].artifactRef(
      projectId,
      coordinatorThreadId,
      spec
        ? join('versions', `${spec.id}-v${spec.version}.md`)
        : join('versions', `${brainstorm?.id}-v${brainstorm?.version}-brainstorm.md`)
    )
    const basePrompt = [
      spec
        ? `Independently audit the current project implementation against the approved specification at this project-relative path: ${contractPath}`
        : `Audit the current project implementation against the finalized Brainstorm at this project-relative path: ${contractPath}. No specification exists. This Brainstorm is the authoritative implementation contract. Verify its agreed direction, requirements, constraints, and prototypes against the repository. Do not require a specification or invent additional requirements.`,
      `Open annotations on the implementation contract:\n${formatOpenAnnotations(spec?.annotations ?? brainstorm?.annotations ?? [])}`
    ].join('\n\n')
    let lastError: Error | null = null

    await this.host.threadManager.setAuditState(projectId, coordinatorThreadId, 'running')
    await this.host.threadManager.setStatus(projectId, coordinatorThreadId, 'executing', {
      read: false
    })
    for (let attemptIndex = 0; attemptIndex < 3; attemptIndex += 1) {
      await this.host.threadManager.setStatus(projectId, auditorThread.id, 'executing')
      this.host.handledIdleSessions.delete(sessionId)
      this.host.units['turns-sessions'].markSessionWorking(sessionId)
      const messageId = createMessageId()
      const prompt = attemptIndex === 0 ? basePrompt : auditCorrectionPrompt(lastError)
      await this.host.units['messages-write'].persistOutboundMessage(
        projectId,
        auditorThread.id,
        messageId,
        `Audit implementation: ${contractSummary}`,
        prompt,
        [],
        [],
        [],
        attemptIndex === 0 ? { action: 'Audit implementation', body: contractSummary } : undefined,
        'internal'
      )
      const outboundIds =
        this.host.state.outboundMessageIdsBySession.get(sessionId) ?? new Set<string>()
      outboundIds.add(messageId)
      this.host.state.outboundMessageIdsBySession.set(sessionId, outboundIds)
      const completion = this.host.units['turns-sessions'].waitForSessionCompletion(
        sessionId,
        ChatEngine.AUDIT_RUN_TIMEOUT_MS,
        'Implementation audit'
      )
      try {
        const auditUtilityBudgetContext: UtilityTurnBudgetContext = {
          selectedModelInputTokens: this.host.units['runtime-agents'].selectedModelInputBudget(
            auditorSettings.providerId,
            auditorSettings.modelId,
            projectId
          ),
          composedTurnTokens: estimateTextTokens(prompt),
          parentTurnId: messageId
        }
        const utilityTurn = await this.host.units['audit'].prepareAuditUtilities(
          driver,
          projectId,
          auditorThread,
          sessionId,
          projectPath,
          auditorSettings,
          auditUtilityBudgetContext
        )
        await driver.sendPrompt(projectPath, {
          sessionId,
          settings: auditorSettings,
          text: prompt,
          attachments: [],
          systemPrompt: [
            await this.host.units['turns-dispatch'].cioPrompt('audit-report'),
            ...(!spec
              ? [
                  'For this audit, the supplied finalized Brainstorm replaces the approved specification as the implementation contract. Apply all audit checks to that document.'
                ]
              : []),
            utilityTurn.instructions
          ]
            .filter(Boolean)
            .join('\n\n'),
          allowedTools: AUDIT_ALLOWED_TOOLS,
          userMessageId: messageId
        })
        const streamed = await completion
        let content: AuditReportContent
        if (streamed !== undefined) {
          content = validateAuditReportContent(streamed)
        } else {
          const messages = await driver.loadMessages(projectPath, sessionId)
          const response = [...messages].reverse().find((message) => message.role === 'assistant')
          if (!response) throw new Error('The Auditor returned no response')
          if (response.error) throw new Error(response.error)
          content =
            response.structuredOutput !== undefined
              ? validateAuditReportContent(response.structuredOutput)
              : parseAuditReportContent(
                  response.parts
                    .filter((part) => part.type === 'text')
                    .map((part) => part.text)
                    .join('\n')
                )
        }
        const report = await this.host.state.auditEngine.create({
          projectId,
          threadId: coordinatorThreadId,
          specId: spec?.id,
          specVersion: spec?.version,
          brainstormId: brainstorm?.id,
          brainstormVersion: brainstorm?.version,
          content,
          outcome: auditRequiresRework(content) ? 'rework_required' : 'passed',
          provenance: {
            source: 'agent',
            actor: 'auditor',
            harnessId: auditorSettings.harnessId,
            providerId: auditorSettings.providerId,
            modelId: auditorSettings.modelId
          }
        })
        await this.host.threadManager.setAuditState(
          projectId,
          coordinatorThreadId,
          'report_ready',
          {
            id: report.id,
            version: report.version
          }
        )
        await this.host.threadManager.setStatus(projectId, auditorThread.id, 'completed', {
          read: false
        })
        await this.host.threadManager.setStatus(projectId, coordinatorThreadId, 'spec', {
          read: false
        })
        await this.host.loadMessages(projectId, auditorThread.id)
        return {
          report,
          auditorThread:
            (await this.host.threadManager.getThread(projectId, auditorThread.id)) ?? auditorThread
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('The Auditor failed.')
        const correctableOutput =
          lastError instanceof AuditReportValidationError ||
          lastError instanceof SyntaxError ||
          lastError.message === 'The Auditor returned no response'
        if (!correctableOutput) break
      } finally {
        this.host.units['runtime-connectivity'].clearCompletionWaiter(sessionId)
        await this.host.units['audit'].cleanupAuditUtilities(
          'Implementation',
          projectId,
          coordinatorThreadId,
          auditorThread.id,
          sessionId
        )
      }
    }

    await this.host.threadManager.setAuditState(projectId, coordinatorThreadId, 'offered')
    await this.host.threadManager.setStatus(projectId, coordinatorThreadId, 'spec', {
      read: false
    })
    await this.host.threadManager.setStatus(projectId, auditorThread.id, 'failed', {
      read: false,
      error: (lastError ?? new Error('The Auditor failed.')).message,
      errorDetail: lastError ? rawErrorDetail(lastError) : undefined
    })
    throw lastError ?? new Error('The Auditor failed.')
  }

  async runAchievementAudit(
    projectId: string,
    coordinatorThreadId: string,
    settings: ThreadSettings
  ): Promise<{ report: AuditReport; auditorThread: Thread }> {
    const spec = await this.host.units['spec'].getActiveSpec(projectId, coordinatorThreadId)
    if (!spec || spec.status !== 'approved') {
      throw new Error('An approved specification is required before Achievement audit.')
    }
    const auditorThread = await this.host.ensureAchievementAuditorThread(
      projectId,
      coordinatorThreadId,
      settings
    )
    const auditorSettings = auditorThread.settings ?? settings
    const driverId = auditorSettings.harnessId || DEFAULT_HARNESS
    const { driver, projectPath } = await this.host.resolve(projectId, driverId, auditorThread.id)
    const sessionId = await this.host.ensureSession(projectId, auditorThread.id, driverId)
    const specPath = await this.host.units['media-artifacts'].artifactRef(
      projectId,
      coordinatorThreadId,
      join('versions', `${spec.id}-v${spec.version}.md`)
    )
    const basePrompt = [
      `Independently audit the current project implementation against the approved Achievement specification at this project-relative path: ${specPath}`,
      `Open annotations on the specification:\n${formatOpenAnnotations(spec.annotations)}`
    ].join('\n\n')
    let lastError: Error | null = null

    await this.host.threadManager.setAuditState(projectId, coordinatorThreadId, 'running')
    await this.host.threadManager.setStatus(projectId, coordinatorThreadId, 'executing', {
      read: false
    })
    for (let attemptIndex = 0; ; attemptIndex += 1) {
      await this.host.threadManager.setStatus(projectId, auditorThread.id, 'executing')
      this.host.handledIdleSessions.delete(sessionId)
      this.host.units['turns-sessions'].markSessionWorking(sessionId)
      const messageId = createMessageId()
      const prompt = attemptIndex === 0 ? basePrompt : auditCorrectionPrompt(lastError)
      await this.host.units['messages-write'].persistOutboundMessage(
        projectId,
        auditorThread.id,
        messageId,
        `Audit Achievement: ${spec.content.resolutionSummary}`,
        prompt,
        [],
        [],
        [],
        attemptIndex === 0
          ? { action: 'Audit Achievement', body: spec.content.resolutionSummary }
          : undefined,
        'internal'
      )
      const outboundIds =
        this.host.state.outboundMessageIdsBySession.get(sessionId) ?? new Set<string>()
      outboundIds.add(messageId)
      this.host.state.outboundMessageIdsBySession.set(sessionId, outboundIds)
      const completion = this.host.units['turns-sessions'].waitForSessionCompletion(
        sessionId,
        ChatEngine.AUDIT_RUN_TIMEOUT_MS,
        'Achievement audit'
      )
      try {
        const auditUtilityBudgetContext: UtilityTurnBudgetContext = {
          selectedModelInputTokens: this.host.units['runtime-agents'].selectedModelInputBudget(
            auditorSettings.providerId,
            auditorSettings.modelId,
            projectId
          ),
          composedTurnTokens: estimateTextTokens(prompt),
          parentTurnId: messageId
        }
        const utilityTurn = await this.host.units['audit'].prepareAuditUtilities(
          driver,
          projectId,
          auditorThread,
          sessionId,
          projectPath,
          auditorSettings,
          auditUtilityBudgetContext
        )
        await driver.sendPrompt(projectPath, {
          sessionId,
          settings: auditorSettings,
          text: prompt,
          attachments: [],
          systemPrompt: [
            await this.host.units['turns-dispatch'].cioPrompt('audit-report'),
            utilityTurn.instructions
          ]
            .filter(Boolean)
            .join('\n\n'),
          allowedTools: AUDIT_ALLOWED_TOOLS,
          userMessageId: messageId
        })
        const streamed = await completion
        let content: AuditReportContent
        if (streamed !== undefined) {
          try {
            content = validateAuditReportContent(streamed)
          } catch (error) {
            lastError =
              error instanceof Error ? error : new Error('The Achievement audit was invalid.')
            continue
          }
        } else {
          const messages = await driver.loadMessages(projectPath, sessionId)
          const response = [...messages].reverse().find((message) => message.role === 'assistant')
          if (!response) throw new Error('The Achievement Auditor returned no response')
          if (response.error) throw new Error(response.error)
          try {
            content =
              response.structuredOutput !== undefined
                ? validateAuditReportContent(response.structuredOutput)
                : parseAuditReportContent(
                    response.parts
                      .filter((part) => part.type === 'text')
                      .map((part) => part.text)
                      .join('\n')
                  )
          } catch (error) {
            lastError =
              error instanceof Error ? error : new Error('The Achievement audit was invalid.')
            continue
          }
        }
        const report = await this.host.state.auditEngine.create({
          projectId,
          threadId: coordinatorThreadId,
          specId: spec.id,
          specVersion: spec.version,
          content,
          outcome: auditRequiresRework(content) ? 'rework_required' : 'passed',
          provenance: {
            source: 'agent',
            actor: 'auditor',
            harnessId: auditorSettings.harnessId,
            providerId: auditorSettings.providerId,
            modelId: auditorSettings.modelId
          }
        })
        await this.host.threadManager.setAuditState(
          projectId,
          coordinatorThreadId,
          'report_ready',
          {
            id: report.id,
            version: report.version
          }
        )
        await this.host.threadManager.setStatus(projectId, auditorThread.id, 'completed', {
          read: false
        })
        await this.host.threadManager.setStatus(projectId, coordinatorThreadId, 'spec', {
          read: false
        })
        await this.host.loadMessages(projectId, auditorThread.id)
        return {
          report,
          auditorThread:
            (await this.host.threadManager.getThread(projectId, auditorThread.id)) ?? auditorThread
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('The Achievement Auditor failed.')
        break
      } finally {
        this.host.units['runtime-connectivity'].clearCompletionWaiter(sessionId)
        await this.host.units['audit'].cleanupAuditUtilities(
          'Achievement',
          projectId,
          coordinatorThreadId,
          auditorThread.id,
          sessionId
        )
      }
    }

    await this.host.threadManager.setAuditState(projectId, coordinatorThreadId, 'offered')
    await this.host.threadManager.setStatus(projectId, coordinatorThreadId, 'spec', {
      read: false
    })
    await this.host.threadManager.setStatus(projectId, auditorThread.id, 'failed', {
      read: false,
      error: (lastError ?? new Error('The Achievement Auditor failed.')).message,
      errorDetail: lastError ? rawErrorDetail(lastError) : undefined
    })
    throw lastError ?? new Error('The Achievement Auditor failed.')
  }
}
