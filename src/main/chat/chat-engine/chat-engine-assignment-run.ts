import { join, resolve } from 'path'
import { createHash, randomBytes } from 'crypto'
import { createServer } from 'http'
import type { IncomingMessage, ServerResponse } from 'http'
import { Logger } from '../../system/logger'
import { AssignmentEngineError } from '../../../lib/engines/assignment-engine'
import { validateBoundedString, validateEntityId } from '../../ipc/ipc-validation'
import {
  type DesignAssignmentRunRequest,
  type DesignAssignmentRunResult
} from '../../design/design-assignment-executor'
import type { AgentMessage, AssignmentPlan, AuditReport, ThreadSettings } from '../../../lib/types'
import { parseGeneratedAssignmentContent } from '../../../lib/assignment/assignment-validation'
import type { AssignmentApiCapability } from './chat-engine-types'
import { AssignmentApiRequestError, rawErrorMessage } from './chat-engine-errors'
import {
  apiFollowUpTask,
  apiString,
  apiTaskReport,
  apiTaskReview,
  apiTestEvidenceContent,
  apiTestEvidenceKind,
  assignmentApiErrorStatus,
  coordinatorHandoffQueuePath,
  listenAssignmentApi,
  readAssignmentApiBody,
  writeAssignmentApiResponse
} from './chat-engine-pure'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine assignment-run: one concern, moved verbatim from the composition root. */
export class ChatEngineAssignmentRun {
  constructor(private readonly host: ChatEngine) {}

  async completeCoordinatorHandoff(
    projectId: string,
    threadId: string,
    messageId: string
  ): Promise<void> {
    await this.host.units['assignment'].withCoordinatorHandoffQueueLock(
      projectId,
      threadId,
      async () => {
        const queue = await this.host.units['assignment'].readCoordinatorHandoffQueue(
          projectId,
          threadId
        )
        const items = queue.items.filter((item) => item.id !== messageId)
        if (items.length === queue.items.length) return
        const path = coordinatorHandoffQueuePath(projectId, threadId)
        if (items.length === 0) {
          await this.host.storage.remove(path)
          return
        }
        await this.host.storage.write(path, { ...queue, items })
      }
    )
  }

  /**
   * Run one delegated prompt on the model the user assigned to a named piece of
   * design work.
   *
   * This is the same disposable one-shot lane the auxiliary roles use: the
   * assigned harness, a session that carries only the assigned model as its
   * candidate, no tools, and minimal reasoning unless the user chose a level.
   * The assignment is never overridden, never upgraded to a stronger model and
   * never failed over to another provider: a design assignment is a model the
   * user picked, so a model that fails is reported as a failure rather than
   * quietly replaced.
   */
  async runDesignAssignment(
    request: DesignAssignmentRunRequest
  ): Promise<DesignAssignmentRunResult> {
    const selection = request.selection
    const account = await this.host.state.accountRegistry.resolveForProvider(
      selection.harnessId,
      selection.providerId,
      selection.accountId
    )
    const { driver, projectPath } = await this.host.resolve(
      request.projectId,
      selection.harnessId,
      request.threadId,
      account.id
    )
    const result = await driver.provideCheapModel(projectPath, {
      settings: {
        harnessId: selection.harnessId,
        accountId: account.id,
        providerId: selection.providerId,
        modelId: selection.modelId,
        inferenceMode: selection.inferenceMode,
        contextWindow: selection.contextWindow,
        thinkingLevel: selection.thinkingLevel ?? 'minimal',
        permissionLevel: 'auto_review',
        assignmentMode: false,
        loopMode: false
      },
      purpose: `Design assignment: ${request.label}`,
      prompt: request.prompt,
      candidates: [{ providerId: selection.providerId, modelId: selection.modelId }]
    })
    const text = result.text?.trim()
    if (!text) {
      const failure = result.attempts.at(-1)?.failure
      throw new Error(
        `The model assigned to "${request.label}" (${selection.harnessId}/${selection.providerId}/${selection.modelId}) returned nothing.${failure ? ` ${failure}` : ' Check that the assigned model is available on that account, or assign a different model in Settings, Design.'}`
      )
    }
    return {
      text,
      harnessId: selection.harnessId,
      providerId: selection.providerId,
      modelId: selection.modelId
    }
  }

  async startAssignment(
    projectId: string,
    coordinatorThreadId: string,
    origin: 'user' | 'internal' = 'user'
  ): Promise<AssignmentPlan> {
    projectId = validateEntityId(projectId, 'Project ID')
    coordinatorThreadId = validateEntityId(coordinatorThreadId, 'Coordinator thread ID')
    await this.ensureAssignmentApi()
    const coordinator = await this.host.threadManager.getThread(projectId, coordinatorThreadId)
    if (!coordinator?.settings) throw new Error('Sr. Engineer settings are missing')

    // Engineering planning deliberately restricts the harness session to
    // read-only research tools. OpenCode persists that policy on the session,
    // so omitting an allowed-tools override on the first implementation prompt
    // does not restore shell/edit access. Retire the planning session before
    // approval is persisted: every signed Assignment must start execution in a
    // fresh harness session, while the durable thread mirror carries its full
    // conversation into the replacement session.
    if (coordinator.sessionId) {
      const planningSessionId = coordinator.sessionId
      this.host.units['turns-sessions'].retireSessionState(planningSessionId)
      await this.host.threadManager.clearSessionId(projectId, coordinatorThreadId)
      Logger.info('Retired the planning session before Assignment execution', {
        projectId,
        threadId: coordinatorThreadId,
        sessionId: planningSessionId
      })
    }
    const assignment = await this.host.state.assignmentEngine.approve(
      projectId,
      coordinatorThreadId,
      this.host.state.specEngine
    )
    if (assignment.status === 'stopped') {
      throw new AssignmentEngineError('invalid_transition', 'The Assignment has been stopped')
    }
    const achievementMode = coordinator.settings.loopMode === true
    const coordinatorSettings: ThreadSettings = {
      ...coordinator.settings,
      assignmentMode: false,
      loopMode: achievementMode
    }
    await this.host.threadManager.updateSettings(
      projectId,
      coordinatorThreadId,
      coordinatorSettings
    )
    await this.host.units['assignment'].sendAssignmentCoordinatorPrompt(
      assignment,
      coordinatorSettings,
      this.host.units['assignment'].coordinatorAssignmentPrompt(assignment),
      origin === 'user' ? { action: 'Sign off & assign' } : undefined
    )
    return assignment
  }

  assignmentApiInstructions(token: string, role: 'coordinator' | 'worker' = 'coordinator'): string {
    const shared = [
      `API base URL: ${this.host.state.assignmentApiBaseUrl}`,
      `Authorization header: Bearer ${token}`,
      'Allowed POST JSON endpoints:'
    ]
    const workerEndpoints = [
      '- /v1/assignments/submit-test-evidence   { "assignmentId": "...", "taskId": "...", "workerThreadId": "...", "operationId": "unique-id", "kind": "baseline|check", "content": "complete focused test output" }. Worker capabilities submit for their own task; the coordinator submits for a running senior-owned task using the coordinator thread ID.',
      '- /v1/assignments/report-task   { "assignmentId": "...", "taskId": "...", "workerThreadId": "...", "operationId": "unique-id", "report": { "status": "ready_for_audit|blocked|failed", "summary": "...", "evidence": ["..."], "commitHash": "..." } }'
    ]
    const coordinatorEndpoints = [
      '- /v1/assignments/get   { "assignmentId": "..." }',
      '- /v1/assignments/assign-task   { "assignmentId": "...", "taskId": "...", "operationId": "unique-id" }. Assigns ready/rework/failed tasks and retries stopped attention tasks that have no report.',
      ...workerEndpoints,
      '- /v1/assignments/review-task   { "assignmentId": "...", "taskId": "...", "coordinatorThreadId": "...", "operationId": "unique-id", "review": { "decision": "pass|rework|fail", "checklistResults": [{ "item": "...", "passed": true, "evidence": "..." }], "notes": "..." } }. A rework decision automatically reassigns the approved task and sends these findings to its worker; do not call assign-task or propose-rework-assignment afterward.',
      '- /v1/assignments/reopen-task   { "assignmentId": "...", "taskId": "..." }',
      '- /v1/assignments/add-followup-task   { "assignmentId": "...", "task": { "id": "...", "phaseId": "...", "title": "...", "description": "...", "prompt": "...", "owner": "senior|worker", "dependsOn": [], "expectedFiles": [], "auditChecklist": [] } }',
      '- /v1/assignments/propose-rework-assignment (coordinator only)   { "assignmentId": "...", "assignment": { "title": "...", "summary": "...", "phases": [], "tasks": [] } }. Reserved for genuinely new product scope outside the signed Assignment; never use it for task corrections, review findings, or audit rework.',
      '- /v1/assignments/request-reaudit (coordinator only, after direct Sr. Engineer corrections are checked)   { "assignmentId": "..." }',
      '- /v1/assignments/steer-worker   { "assignmentId": "...", "workerThreadId": "...", "instruction": "1-20000 characters of user instruction" }',
      '- /v1/assignments/stop-worker   { "assignmentId": "...", "workerThreadId": "..." }. Reassign the resulting attention task with assign-task when a fresh worker should retry it.'
    ]
    return [
      ...shared,
      ...(role === 'worker' ? workerEndpoints : coordinatorEndpoints),
      'Use Content-Type: application/json. Reusing an operationId safely returns the original result.'
    ].join('\n')
  }

  async ensureAssignmentApi(): Promise<void> {
    if (this.host.state.assignmentApiServer && this.host.state.assignmentApiBaseUrl) return
    const server = createServer((request, response) => {
      void this.handleAssignmentApiRequest(request, response)
    })
    const persistedPort = this.host.state.assignmentEngine.loadApiPort()
    let boundPort: number | null = null
    if (persistedPort !== null) {
      try {
        boundPort = await listenAssignmentApi(server, persistedPort)
      } catch {
        Logger.info('Assignment API port is unavailable; binding a fresh port', {
          persistedPort
        })
      }
    }
    boundPort ??= await listenAssignmentApi(server, 0)
    this.host.state.assignmentApiServer = server
    this.host.state.assignmentApiBaseUrl = `http://127.0.0.1:${boundPort}`
    this.host.state.assignmentEngine.saveApiPort(boundPort)
    for (const [token, capability] of this.host.state.assignmentEngine.loadApiCapabilities()) {
      if (
        capability.role === 'worker' &&
        !this.host.units['assignment-workers'].assignmentWorkerCapabilityIsCurrent(capability)
      ) {
        this.host.state.assignmentEngine.removeApiCapability(token)
        void this.host.units['assignment-workers']
          .retireOrphanedAssignmentWorker(capability)
          .catch((error: unknown) => {
            Logger.info('Stale Assignment worker cleanup was incomplete', {
              assignmentId: capability.assignmentId,
              threadId: capability.threadId,
              error: error instanceof Error ? error.message : String(error)
            })
          })
        continue
      }
      this.host.state.assignmentApiCapabilities.set(token, capability)
    }
    Logger.info('Assignment API listening', { baseUrl: this.host.state.assignmentApiBaseUrl })
  }

  async handleAssignmentApiRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    try {
      const token = request.headers.authorization?.replace(/^Bearer\s+/u, '') ?? ''
      const capability = this.host.state.assignmentApiCapabilities.get(token)
      if (!capability) {
        writeAssignmentApiResponse(response, 401, { error: 'Unauthorized' })
        return
      }
      if (request.method !== 'POST') {
        writeAssignmentApiResponse(response, 405, { error: 'Method not allowed' })
        return
      }
      const body = await readAssignmentApiBody(request)
      const path = new URL(request.url ?? '/', this.host.state.assignmentApiBaseUrl).pathname
      this.assertAssignmentApiCapability(token, capability, path, body)
      const requestAssignmentId = apiString(body.assignmentId, 'assignmentId')
      await this.withAssignmentApiLock(requestAssignmentId, async () => {
        if (path === '/v1/assignments/get') {
          const assignmentId = apiString(body.assignmentId, 'assignmentId')
          const assignment = this.host.state.assignmentEngine.listVersions(assignmentId).at(-1)
          let auditReport: AuditReport | null = null
          if (
            assignment?.auditCycle?.reportId &&
            assignment.auditCycle.reportVersion !== undefined
          ) {
            try {
              auditReport =
                this.host.state.auditEngine.getVersion(
                  assignment.projectId,
                  assignment.coordinatorThreadId,
                  assignment.auditCycle.reportId,
                  assignment.auditCycle.reportVersion
                ) ?? null
            } catch {
              auditReport = null
            }
          }
          writeAssignmentApiResponse(response, assignment ? 200 : 404, {
            assignment: assignment ?? null,
            auditReport
          })
          return
        }
        if (path === '/v1/assignments/assign-task') {
          const previousTask = this.host.state.assignmentEngine
            .listVersions(requestAssignmentId)
            .at(-1)
            ?.content.tasks.find((task) => task.id === body.taskId)
          const result = await this.host.state.assignmentEngine.assignTask(
            requestAssignmentId,
            apiString(body.taskId, 'taskId'),
            apiString(body.operationId, 'operationId')
          )
          if (previousTask?.threadId && previousTask.threadId !== result.task?.threadId) {
            this.host.units['assignment-workers'].revokeAssignmentWorkerCapabilities(
              requestAssignmentId,
              previousTask.threadId
            )
          }
          writeAssignmentApiResponse(response, 200, result)
          void this.host.units['assignment-workers']
            .dispatchAssignmentWorker(result)
            .catch((error: unknown) => {
              Logger.error('Assignment worker dispatch failed', {
                assignmentId: result.assignment.id,
                taskId: result.task?.id,
                threadId: result.thread?.id,
                error: error instanceof Error ? error.message : String(error)
              })
            })
          return
        }
        if (path === '/v1/assignments/report-task') {
          const report = apiTaskReport(body.report)
          const result = await this.host.state.assignmentEngine.reportTask(
            apiString(body.assignmentId, 'assignmentId'),
            apiString(body.taskId, 'taskId'),
            apiString(body.workerThreadId, 'workerThreadId'),
            report,
            apiString(body.operationId, 'operationId')
          )
          if (!result.idempotent && result.task?.owner === 'worker') {
            await this.host.units['audit'].promptCoordinatorForAudit(
              result.assignment,
              result.task.id,
              report
            )
          }
          writeAssignmentApiResponse(response, 200, result)
          return
        }
        if (path === '/v1/assignments/submit-test-evidence') {
          const kind = apiTestEvidenceKind(body.kind)
          const content = apiTestEvidenceContent(body.content)
          const result = await this.host.state.assignmentEngine.submitTaskTestEvidence(
            apiString(body.assignmentId, 'assignmentId'),
            apiString(body.taskId, 'taskId'),
            apiString(body.workerThreadId, 'workerThreadId'),
            kind,
            content,
            apiString(body.operationId, 'operationId')
          )
          writeAssignmentApiResponse(response, 200, {
            status: 'stored',
            kind,
            bytes: Buffer.byteLength(content),
            ...result
          })
          return
        }
        if (path === '/v1/assignments/review-task') {
          const review = apiTaskReview(body.review)
          const operationId = apiString(body.operationId, 'operationId')
          let result = await this.host.state.assignmentEngine.reviewTask(
            apiString(body.assignmentId, 'assignmentId'),
            apiString(body.taskId, 'taskId'),
            apiString(body.coordinatorThreadId, 'coordinatorThreadId'),
            review,
            operationId
          )
          let automaticReworkDispatch = false
          if (!result.idempotent && review.decision === 'rework' && result.task) {
            result = await this.host.state.assignmentEngine.assignTask(
              result.assignment.id,
              result.task.id,
              `review-rework-${createHash('sha256').update(operationId).digest('hex').slice(0, 24)}`
            )
            automaticReworkDispatch = true
            if (result.task?.owner === 'worker') {
              void this.host.units['assignment-workers']
                .dispatchAssignmentWorker(result, review)
                .catch((error: unknown) => {
                  Logger.error('Assignment task rework dispatch failed', {
                    assignmentId: result.assignment.id,
                    taskId: result.task?.id,
                    threadId: result.thread?.id,
                    error: error instanceof Error ? error.message : String(error)
                  })
                })
            }
          }
          let automaticReaudit = false
          if (
            result.assignment.status === 'completed' &&
            result.assignment.auditCycle?.status === 'available'
          ) {
            const coordinator = await this.host.threadManager.getThread(
              result.assignment.projectId,
              result.assignment.coordinatorThreadId
            )
            await this.host.threadManager.setAuditState(
              result.assignment.projectId,
              result.assignment.coordinatorThreadId,
              'offered'
            )
            await this.host.threadManager.setStatus(
              result.assignment.projectId,
              result.assignment.coordinatorThreadId,
              'spec',
              { read: false }
            )
            automaticReaudit = Boolean(result.assignment.auditCycle.reworkCycle)
            if (coordinator?.settings?.loopMode === true) {
              void this.host.units['misc'].continueLoop(
                result.assignment.projectId,
                result.assignment.coordinatorThreadId
              )
            } else if (result.assignment.auditCycle.reworkCycle) {
              void this.host.units['audit']
                .startAssignmentReaudit(result.assignment, coordinator?.settings)
                .catch((error) => {
                  Logger.error('Automatic Assignment reaudit failed', {
                    assignmentId: result.assignment.id,
                    reworkCycle: result.assignment.auditCycle?.reworkCycle,
                    error: rawErrorMessage(error)
                  })
                })
            }
            this.host.units['assignment-workers'].revokeAllAssignmentWorkerCapabilities(
              result.assignment.id
            )
          }
          writeAssignmentApiResponse(response, 200, {
            ...result,
            ...(automaticReworkDispatch
              ? {
                  nextAction: {
                    status:
                      result.task?.owner === 'worker' ? 'rework_dispatched' : 'senior_rework_ready',
                    message:
                      result.task?.owner === 'worker'
                        ? 'The approved task and review findings were returned directly to its worker. No user sign-off is required.'
                        : 'The approved task was returned directly to the Sr. Engineer. Continue the correction without requesting user sign-off.'
                  }
                }
              : {}),
            ...(automaticReaudit
              ? {
                  nextAction: {
                    status: 'reaudit_started_automatically',
                    message:
                      'All rework tasks passed. The independent re-audit started automatically; do not call request-reaudit.'
                  }
                }
              : {})
          })
          return
        }
        if (path === '/v1/assignments/reopen-task') {
          const current = this.host.state.assignmentEngine
            .listVersions(apiString(body.assignmentId, 'assignmentId'))
            .at(-1)
          if (!current) throw new AssignmentApiRequestError(404, 'Assignment not found')
          const assignment = await this.host.state.assignmentEngine.reopenCompletedTask(
            current.projectId,
            capability.threadId,
            apiString(body.taskId, 'taskId')
          )
          writeAssignmentApiResponse(response, 200, { assignment })
          return
        }
        if (path === '/v1/assignments/add-followup-task') {
          const current = this.host.state.assignmentEngine
            .listVersions(apiString(body.assignmentId, 'assignmentId'))
            .at(-1)
          if (!current) throw new AssignmentApiRequestError(404, 'Assignment not found')
          const assignment = await this.host.state.assignmentEngine.appendFollowUpTask(
            current.projectId,
            capability.threadId,
            apiFollowUpTask(body.task)
          )
          writeAssignmentApiResponse(response, 200, { assignment })
          return
        }
        if (path === '/v1/assignments/propose-rework-assignment') {
          const current = this.host.state.assignmentEngine
            .listVersions(apiString(body.assignmentId, 'assignmentId'))
            .at(-1)
          if (!current) throw new AssignmentApiRequestError(404, 'Assignment not found')
          const coordinator = await this.host.threadManager.getThread(
            current.projectId,
            capability.threadId
          )
          if (!coordinator?.settings) {
            throw new AssignmentApiRequestError(409, 'Sr. Engineer settings are missing')
          }
          const assignment = await this.host.state.assignmentEngine.proposeAuditReworkDraft(
            current.projectId,
            capability.threadId,
            parseGeneratedAssignmentContent(body.assignment),
            {
              source: 'agent',
              actor: 'Sr. Engineer',
              harnessId: coordinator.settings.harnessId,
              providerId: coordinator.settings.providerId,
              modelId: coordinator.settings.modelId
            }
          )
          await this.host.threadManager.setStatus(current.projectId, capability.threadId, 'spec', {
            read: false
          })
          writeAssignmentApiResponse(response, 200, {
            assignment,
            status: 'awaiting_user_review'
          })
          return
        }
        if (path === '/v1/assignments/request-reaudit') {
          const current = this.host.state.assignmentEngine
            .listVersions(apiString(body.assignmentId, 'assignmentId'))
            .at(-1)
          if (!current) throw new AssignmentApiRequestError(404, 'Assignment not found')
          if (
            current.auditCycle?.status === 'running' ||
            current.auditCycle?.status === 'report_ready'
          ) {
            writeAssignmentApiResponse(response, 200, {
              assignment: current,
              status:
                current.auditCycle.status === 'running' ? 'audit_running' : 'audit_report_ready',
              message:
                current.auditCycle.status === 'running'
                  ? 'The independent re-audit is already running.'
                  : 'The independent re-audit is complete and its report is ready for rework decisions.'
            })
            return
          }
          const assignment =
            current.auditCycle?.status === 'available'
              ? current
              : await this.host.state.assignmentEngine.makeAuditAvailable(
                  current.projectId,
                  capability.threadId
                )
          await this.host.threadManager.setAuditState(
            current.projectId,
            capability.threadId,
            'offered'
          )
          await this.host.threadManager.setStatus(current.projectId, capability.threadId, 'spec', {
            read: false
          })
          writeAssignmentApiResponse(response, 200, { assignment, status: 'audit_available' })
          void this.host.units['audit'].startAssignmentReaudit(assignment).catch((error) => {
            Logger.error('Requested Assignment reaudit failed', {
              assignmentId: assignment.id,
              reworkCycle: assignment.auditCycle?.reworkCycle,
              error: rawErrorMessage(error)
            })
          })
          return
        }
        if (path === '/v1/assignments/steer-worker') {
          const { assignment, task, worker } = await this.host.units[
            'assignment-workers'
          ].requireAssignmentWorker(
            apiString(body.assignmentId, 'assignmentId'),
            apiString(body.workerThreadId, 'workerThreadId')
          )
          const updatedAssignment = await this.host.units[
            'assignment-workers'
          ].steerAssignmentWorker(
            { assignment, task, worker },
            validateBoundedString(body.instruction, 'instruction', 1, 20_000)
          )
          writeAssignmentApiResponse(response, 200, {
            status: 'steered',
            assignmentId: assignment.id,
            taskId: task.id,
            taskTitle: task.title,
            workerName: task.workerName ?? worker.title,
            workerThreadId: worker.id,
            workerThreadTitle: worker.title,
            assignment: updatedAssignment
          })
          return
        }
        if (path === '/v1/assignments/stop-worker') {
          const { worker } = await this.host.units['assignment-workers'].requireAssignmentWorker(
            apiString(body.assignmentId, 'assignmentId'),
            apiString(body.workerThreadId, 'workerThreadId')
          )
          await this.host.abort(worker.projectId, worker.id)
          const assignment = await this.host.state.assignmentEngine.stopWorker(
            apiString(body.assignmentId, 'assignmentId'),
            worker.id
          )
          writeAssignmentApiResponse(response, 200, {
            status: 'stopped',
            workerThreadId: worker.id,
            assignment
          })
          return
        }
        writeAssignmentApiResponse(response, 404, { error: 'Endpoint not found' })
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Assignment API request failed'
      const statusCode = assignmentApiErrorStatus(error)
      if (statusCode >= 500) {
        Logger.error('Assignment API request failed', { error: message })
      } else {
        Logger.info('Assignment API request rejected', { statusCode, error: message })
      }
      writeAssignmentApiResponse(response, statusCode, { error: message })
    }
  }

  async withAssignmentApiLock<T>(assignmentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.host.state.assignmentApiQueues.get(assignmentId) ?? Promise.resolve()
    let release = (): void => undefined
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate
    })
    const tail = previous.catch(() => undefined).then(() => gate)
    this.host.state.assignmentApiQueues.set(assignmentId, tail)
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
      if (this.host.state.assignmentApiQueues.get(assignmentId) === tail) {
        this.host.state.assignmentApiQueues.delete(assignmentId)
      }
    }
  }

  assignmentApiCapability(capability: AssignmentApiCapability): string {
    const existing = [...this.host.state.assignmentApiCapabilities.entries()].find(
      ([, candidate]) =>
        candidate.role === capability.role &&
        candidate.assignmentId === capability.assignmentId &&
        candidate.threadId === capability.threadId &&
        candidate.taskId === capability.taskId
    )
    if (existing) return existing[0]
    const token = randomBytes(32).toString('hex')
    this.host.state.assignmentApiCapabilities.set(token, capability)
    this.host.state.assignmentEngine.saveApiCapability(token, capability)
    return token
  }

  assertAssignmentApiCapability(
    token: string,
    capability: AssignmentApiCapability,
    path: string,
    body: Record<string, unknown>
  ): void {
    const assignmentId = apiString(body.assignmentId, 'assignmentId')
    if (assignmentId !== capability.assignmentId) {
      throw new AssignmentApiRequestError(
        403,
        'Capability does not grant access to this Assignment'
      )
    }
    if (capability.role === 'worker') {
      if (!this.host.units['assignment-workers'].assignmentWorkerCapabilityIsCurrent(capability)) {
        this.host.state.assignmentApiCapabilities.delete(token)
        this.host.state.assignmentEngine.removeApiCapability(token)
        throw new AssignmentApiRequestError(401, 'Worker capability has expired')
      }
      if (
        (path !== '/v1/assignments/report-task' &&
          path !== '/v1/assignments/submit-test-evidence') ||
        body.taskId !== capability.taskId ||
        body.workerThreadId !== capability.threadId
      ) {
        throw new AssignmentApiRequestError(
          403,
          'Worker capability permits only its own task report'
        )
      }
      return
    }
    if (
      path !== '/v1/assignments/get' &&
      path !== '/v1/assignments/assign-task' &&
      path !== '/v1/assignments/submit-test-evidence' &&
      path !== '/v1/assignments/report-task' &&
      path !== '/v1/assignments/review-task' &&
      path !== '/v1/assignments/reopen-task' &&
      path !== '/v1/assignments/add-followup-task' &&
      path !== '/v1/assignments/propose-rework-assignment' &&
      path !== '/v1/assignments/request-reaudit' &&
      path !== '/v1/assignments/steer-worker' &&
      path !== '/v1/assignments/stop-worker'
    ) {
      throw new AssignmentApiRequestError(403, 'Coordinator capability cannot call this endpoint')
    }
    if (
      (path === '/v1/assignments/review-task' ||
        path === '/v1/assignments/report-task' ||
        path === '/v1/assignments/submit-test-evidence') &&
      (path === '/v1/assignments/review-task' ? body.coordinatorThreadId : body.workerThreadId) !==
        capability.threadId
    ) {
      throw new AssignmentApiRequestError(403, 'Coordinator capability does not match the thread')
    }
  }

  runPendingAssignmentTurn(
    sessionId: string,
    messages?: AgentMessage[],
    scope?: { projectId: string; threadId: string }
  ): Promise<AssignmentPlan | null> {
    const existing = this.host.state.assignmentTurnTasks.get(sessionId)
    if (existing) return existing
    const task = this.host.units['assignment'].persistPendingAssignmentTurn(
      sessionId,
      messages,
      scope
    )
    this.host.state.assignmentTurnTasks.set(sessionId, task)
    void task.then(
      () => {
        if (this.host.state.assignmentTurnTasks.get(sessionId) === task) {
          this.host.state.assignmentTurnTasks.delete(sessionId)
        }
      },
      () => {
        if (this.host.state.assignmentTurnTasks.get(sessionId) === task) {
          this.host.state.assignmentTurnTasks.delete(sessionId)
        }
      }
    )
    return task
  }
}
