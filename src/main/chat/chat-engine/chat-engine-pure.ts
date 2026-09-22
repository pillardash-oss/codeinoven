import { BrowserWindow } from 'electron'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'
import { homedir } from 'node:os'
import type { IncomingMessage, Server, ServerResponse } from 'http'
import { sendToRenderer } from '../../ipc/renderer-delivery'
import { AssignmentEngineError } from '../../../lib/engines/assignment-engine'
import { DEFAULT_HARNESS } from '../../../lib/harness-default'
import { listHarnesses } from '../../agents/harness-registry'
import { buildProcessEnvironment } from '../../drivers/cli-environment'
import { isHarnessCommandAvailable } from '../../drivers/harness-runtime'
import { validateBoundedString, validateEntityId } from '../../ipc/ipc-validation'
import type { HarnessDriver } from '../../drivers/driver.interface'
import { SHARED_GLOBAL_SKILL_PATH, harnessGlobalSkillPath } from '../../../lib/native-skill-paths'
import {
  assertReadablePartSource,
  resolveImageEntries
} from '../../providers/image-descriptor-provider'
import type {
  ImageDescriptorExecutorRequest,
  ImageDescriptorResult,
  ResolvedImageEntry
} from '../../providers/image-descriptor-provider'
import type {
  AgentEvent,
  AgentMessage,
  AgentPart,
  UsageBearingMessage,
  AgentQuestion,
  AgentQuestionResolution,
  AgentProviderIssue,
  AgentSessionStatus,
  AssignmentPlan,
  AssignmentFollowUpTaskInput,
  AssignmentTaskReport,
  AssignmentTaskReview,
  AuditReportContent,
  BrainstormContent,
  HarnessCommand,
  HarnessCommandSource,
  PromptReference,
  ProviderCatalog,
  UserMessagePresentation,
  ScopedHarnessCommand,
  Thread,
  ThreadSettings,
  ThinkingLevel,
  ModelRankingSnapshotRow
} from '../../../lib/types'
import { APP_NAME } from '../../../lib/brand'
import { truncateToTokenBudget } from '../../../lib/prompt-budget'
import { UTILITY_SEARCH_TOOL_NAME } from '../../../lib/gateway-tools'
import {
  parseGeneratedBrainstormFallbackContent,
  parseGeneratedBrainstormContent
} from '../../../lib/brainstorm/brainstorm-validation'
import { AuditReportValidationError } from '../../../lib/audit/audit-validation'
import {
  ACTIONABLE_AUDIT_SEVERITIES,
  COORDINATOR_HANDOFF_QUEUE_DIR,
  SPEC_GENERATION_MAX_ATTEMPTS
} from './chat-engine-constants'
import type {
  AssignmentAuditRepairManifest,
  AssignmentWorkerRoutingResult,
  PendingInitialSpecGeneration,
  QueuedCoordinatorHandoff,
  RankingGradeCandidate,
  SessionInfo,
  SpecGenerationLesson
} from './chat-engine-types'
import {
  AssignmentApiRequestError,
  GeneratedBrainstormOutputError,
  GeneratedSpecOutputError,
  ImageDescriptorInactivityError
} from './chat-engine-errors'
import { isRecord, requireEvidenceDrivenBrainstorm } from './chat-engine-generated-artifacts'

export function inactiveQuestionDecision(
  questions: AgentQuestion[],
  resolution: Extract<AgentQuestionResolution, 'answered' | 'dismissed'>,
  answers?: string[][]
): { prompt: string; presentation: UserMessagePresentation } {
  if (resolution === 'dismissed') {
    return {
      prompt: [
        'Your previous turn ended while waiting for the user to answer a question.',
        'The user dismissed that question. Continue the original task without an answer, using the persisted conversation context. Do not ask the same question again unless continuing is genuinely impossible.'
      ].join('\n\n'),
      presentation: { action: 'Dismissed agent question' }
    }
  }

  const decisions = questions.map((question, index) => ({
    question: question.prompt,
    answers: answers?.[index] ?? []
  }))
  const body = decisions
    .map((decision) => `${decision.question}: ${decision.answers.join(', ')}`)
    .join('\n')
  return {
    prompt: [
      'Your previous turn ended while waiting for the user to answer a question.',
      'Continue the original task using the persisted conversation context and the user decisions below.',
      JSON.stringify(decisions)
    ].join('\n\n'),
    presentation: { action: 'Answered agent question', body }
  }
}

export function auditCorrectionPrompt(error: Error | null): string {
  const issues = error instanceof AuditReportValidationError ? error.issues : []
  const evidenceGaps = issues.filter(
    (issue) =>
      issue.includes(`no ${UTILITY_SEARCH_TOOL_NAME} call`) ||
      issue.includes('no matching completed command') ||
      issue.includes('no matching invocation') ||
      issue.includes('no matched invocation to persist') ||
      issue.includes('did not explicitly target audited file')
  )
  if (evidenceGaps.length === 0) {
    return [
      'Your previous audit response was not valid JSON.',
      'Correct only the reported contract violation in your previous audit response, preserving its findings and evidence. Return exactly one corrected audit-report JSON object with no Markdown fences or commentary.',
      `Previous validation error: ${error?.message ?? 'unknown format error'}`
    ].join('\n\n')
  }
  return [
    'Your previous audit report was rejected because its verification claims do not match the executed evidence in this session:',
    ...evidenceGaps.map((issue) => `- ${issue}`),
    `This session is still open, so the app utility gateway (search with ${UTILITY_SEARCH_TOOL_NAME}, activate, invoke) and the read-only tools remain available for this turn: perform the missing work now.`,
    `Call ${UTILITY_SEARCH_TOOL_NAME} for every framework, MCP, or skill utility the report mentions, activate and invoke the relevant result in non-writing mode, and execute the commands the report claims, then return exactly one corrected audit-report JSON object that reflects only evidence you actually observed in this session.`,
    'Preserve the findings that remain accurate, update the verification evidence for what you just executed, and never invent execution evidence. Return the corrected JSON object with no Markdown fences or commentary.'
  ].join('\n')
}

export function providerCatalogPath(): string {
  return 'provider-catalog/catalog.json'
}

export function filterInstalledProviderCatalogs(catalogs: ProviderCatalog[]): ProviderCatalog[] {
  const env = buildProcessEnvironment()
  const installed = new Set(
    listHarnesses()
      .filter((harness) => isHarnessCommandAvailable(harness.command, env))
      .map((harness) => harness.id)
  )
  return catalogs.filter((catalog) => installed.has(catalog.harnessId))
}

export function issueMatchesAssignmentFailure(
  issue: AgentProviderIssue,
  failureSummary: string
): boolean {
  const issueText = (issue.rawError ?? issue.message).trim()
  const summary = failureSummary.trim()
  return (
    issueText === summary ||
    issue.message.trim() === summary ||
    (issueText.length > 0 && summary.includes(issueText)) ||
    (summary.length > 0 && issueText.includes(summary))
  )
}

export function coordinatorHandoffQueueKey(projectId: string, threadId: string): string {
  return `${projectId}:${threadId}`
}

export function coordinatorHandoffQueuePath(projectId: string, threadId: string): string {
  return join(COORDINATOR_HANDOFF_QUEUE_DIR, projectId, `${threadId}.json`)
}

export function isCoordinatorThread(thread: Thread | null): boolean {
  return thread?.assignmentRole === 'coordinator' || thread?.achievementRole === 'coordinator'
}

export function queuedCoordinatorHandoffMessage(item: QueuedCoordinatorHandoff): AgentMessage {
  const visible = item.presentation !== undefined
  return {
    id: item.id,
    role: 'user',
    origin: visible ? 'user' : 'orchestrator',
    visibility: visible ? 'conversation' : 'hidden',
    parts: item.presentation
      ? [
          {
            type: 'user-presentation',
            id: `${item.id}-presentation`,
            messageID: item.id,
            presentation: item.presentation
          }
        ]
      : [
          {
            type: 'text',
            id: `${item.id}-text`,
            messageID: item.id,
            text: item.text
          }
        ],
    createdAt: item.createdAt,
    completedAt: item.createdAt
  }
}

export function imageDescriptorFailureResults(
  request: ImageDescriptorExecutorRequest,
  error: string
): ImageDescriptorResult[] {
  const message = `${error} Continue without the image description.`
  return request.images.map((entry) => ({
    id: entry.id,
    source: entry.source,
    type: entry.type,
    description: '',
    error: message
  }))
}

export function formatTimeoutWindow(timeoutMs: number): string {
  const minutes = Math.ceil(timeoutMs / 60_000)
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

export function validateUserMessagePresentation(
  presentation: UserMessagePresentation | undefined
): UserMessagePresentation | undefined {
  if (presentation === undefined) return undefined
  if (typeof presentation !== 'object' || presentation === null || Array.isArray(presentation)) {
    throw new TypeError('User message presentation must be an object')
  }
  const action = validateBoundedString(presentation.action, 'Presentation action', 1, 120)
  if (presentation.body !== undefined && typeof presentation.body !== 'string') {
    throw new TypeError('Presentation body must be a string')
  }
  const body = presentation.body?.trim()
  return {
    action,
    ...(body ? { body: validateBoundedString(body, 'Presentation body', 1, 20_000) } : {})
  }
}

export function validatePromptReferences(
  references: PromptReference[] | undefined
): PromptReference[] {
  if (references === undefined) return []
  if (!Array.isArray(references) || references.length > 20) {
    throw new TypeError('Prompt references must be an array of at most 20 selections')
  }
  let totalTextLength = 0
  return references.map((reference, index) => {
    if (typeof reference !== 'object' || reference === null || Array.isArray(reference)) {
      throw new TypeError(`Prompt reference ${index + 1} must be an object`)
    }
    const id = validateEntityId(reference.id, `Prompt reference ${index + 1} ID`, 256)
    const label = validateBoundedString(
      reference.label,
      `Prompt reference ${index + 1} label`,
      1,
      100
    )
    const text = validateBoundedString(
      reference.text,
      `Prompt reference ${index + 1} text`,
      1,
      100_000
    )
    totalTextLength += text.length
    if (totalTextLength > 100_000) {
      throw new TypeError('Prompt reference text cannot exceed 100,000 characters in total')
    }
    const comment = reference.comment
      ? validateBoundedString(reference.comment, `Prompt reference ${index + 1} comment`, 1, 2_000)
      : undefined
    return { id, label, text, ...(comment ? { comment } : {}) }
  })
}

export function budgetHiddenContext(context: string, availableInputTokens: number): string {
  return truncateToTokenBudget(context, availableInputTokens)
}

export async function buildImageDescriptorReplacement(
  imageId: string,
  imagePath: string | undefined
): Promise<ResolvedImageEntry> {
  if (!imagePath || !imagePath.trim()) {
    throw new TypeError('A replacement image path is required')
  }
  const source = imagePath.startsWith('file://') ? fileURLToPath(imagePath) : imagePath.trim()
  const [entry] = resolveImageEntries({
    images: [{ id: imageId, source, type: 'path' }]
  })
  await assertReadablePartSource(entry)
  return entry
}

export function coordinatorDirectWorkRequested(text: string, taskId: string): boolean {
  const token = `@task:${taskId}`
  const tokenIndex = text.indexOf(token)
  if (tokenIndex < 0) return false
  const before = text.slice(0, tokenIndex)
  const boundary = Math.max(
    before.lastIndexOf('\n'),
    before.lastIndexOf('.'),
    before.lastIndexOf('!'),
    before.lastIndexOf('?'),
    before.lastIndexOf(';')
  )
  const remaining = text.slice(tokenIndex + token.length)
  const nextBoundary = remaining.search(/[\n.!?;]/u)
  const clause = text.slice(
    boundary + 1,
    nextBoundary < 0 ? text.length : tokenIndex + token.length + nextBoundary
  )
  const coordinator = /\b(?:sr\.?\s*engineer|senior\s+engineer|coordinator)\b/iu
  const direct = String.raw`(?:yourself|personally|in\s+the\s+coordinator\s+thread)`
  const work = String.raw`(?:do|handle|implement|perform|take\s+over|work\s+on)`
  return (
    (coordinator.test(clause) && new RegExp(String.raw`\b${work}\b`, 'iu').test(clause)) ||
    new RegExp(String.raw`\b${direct}\b`, 'iu').test(clause)
  )
}

export function assignmentWorkerRoutingReceipt(result: AssignmentWorkerRoutingResult): string {
  const decisions: string[] = []
  if (result.directCoordinatorTasks.length > 0) {
    decisions.push(
      [
        'Application routing decision: the user explicitly assigned these tagged tasks to the Sr. Engineer/coordinator, so their workers were not automatically steered:',
        JSON.stringify(
          result.directCoordinatorTasks.map((task) => ({
            taskId: task.id,
            taskTitle: task.title
          })),
          null,
          2
        )
      ].join('\n\n')
    )
  }
  if (result.routed.length > 0) {
    decisions.push(
      [
        'Application routing receipt: the application already forwarded this user instruction to the linked workers below. Do not send it again.',
        'Acknowledge the update by naming each worker and task, and tell the user that live progress and the clickable worker thread are available in the Assignment coordinator panel.',
        JSON.stringify(
          result.routed.map(({ task, worker }) => ({
            taskId: task.id,
            taskTitle: task.title,
            workerName: task.workerName ?? worker.title,
            workerThreadId: worker.id,
            workerThreadTitle: worker.title
          })),
          null,
          2
        )
      ].join('\n\n')
    )
  }
  return decisions.join('\n\n')
}

export function listenAssignmentApi(server: Server, port: number): Promise<number> {
  return new Promise<number>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        rejectListen(new Error('Assignment API could not bind a local port'))
        return
      }
      resolveListen(address.port)
    })
  })
}

export function readAssignmentApiBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > 1_000_000) {
        rejectBody(new AssignmentApiRequestError(413, 'Assignment API payload is too large'))
        request.destroy()
        return
      }
      chunks.push(buffer)
    })
    request.on('end', () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
        if (!isRecord(parsed)) {
          throw new AssignmentApiRequestError(400, 'Assignment API body must be an object')
        }
        resolveBody(parsed)
      } catch (error) {
        rejectBody(error)
      }
    })
    request.on('error', rejectBody)
  })
}

export function writeAssignmentApiResponse(
  response: ServerResponse,
  status: number,
  body: unknown
): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

export function assignmentApiErrorStatus(error: unknown): number {
  if (error instanceof AssignmentApiRequestError) return error.statusCode
  if (error instanceof AssignmentEngineError) {
    if (error.code === 'unauthorized') return 403
    if (error.code === 'not_found') return 404
    if (error.code === 'invalid_transition' || error.code === 'immutable') return 409
    return 422
  }
  if (error instanceof TypeError) return 422
  if (error instanceof SyntaxError) return 400
  return 500
}

export function apiString(value: unknown, label: string): string {
  return validateEntityId(value, label, 256)
}

export function apiTestEvidenceKind(value: unknown): 'baseline' | 'check' {
  if (value !== 'baseline' && value !== 'check') {
    throw new Error('kind must be baseline or check')
  }
  return value
}

export function apiTestEvidenceContent(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 750_000 ||
    value.includes('\0')
  ) {
    throw new Error('content must contain between 1 and 750000 characters')
  }
  return value
}

export function parseBrainstormGeneratedOutput(
  value: unknown,
  useStructuredOutput: boolean
): BrainstormContent {
  try {
    return requireEvidenceDrivenBrainstorm(
      useStructuredOutput
        ? parseGeneratedBrainstormContent(value)
        : parseGeneratedBrainstormFallbackContent(value)
    )
  } catch (error) {
    throw new GeneratedBrainstormOutputError(
      error instanceof Error ? error.message : 'Invalid Brainstorm output',
      typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    )
  }
}

export function assignmentAuditRepairPrompt(manifest: AssignmentAuditRepairManifest): string {
  const previousErrors = new Set(manifest.previousErrors ?? [])
  const resolvedErrors = [...previousErrors].filter((error) => !manifest.errors.includes(error))
  const needsExecutedEvidence = manifest.errors.some((error) =>
    error.includes('requires at least one executed verification check')
  )
  return [
    `The persisted audit report at ${manifest.attemptPath} failed deterministic validation.`,
    `This is incremental correction attempt ${manifest.attempt}. Continue from that persisted report; do not restart the audit.`,
    'Correct only these validation errors:',
    ...manifest.errors.map((error) => `- ${error}`),
    ...(resolvedErrors.length > 0
      ? [
          'The previous correction resolved these errors; do not reintroduce them:',
          ...resolvedErrors.map((error) => `- ${error}`)
        ]
      : []),
    'Read that file, preserve its audit findings and evidence, and return exactly one complete corrected audit-report JSON object with no Markdown fences or commentary.',
    ...(needsExecutedEvidence
      ? [
          'This attempt contains no executed verification evidence and is not a usable audit. Do not pad it with expected filenames or describe the failed artifact as the audited implementation. Resume only the missing implementation inspection and verification work, then report evidence actually observed in this auditor session. Never invent execution evidence.'
        ]
      : [
          'For a missing auditedFiles entry, add the exact named file only when the persisted report contains evidence that it was inspected, and retain the existing inventory. For an unmatched verification claim, correct it to match an observed command or utility; when no matching invocation exists, use not_applicable with the concrete limitation. Never invent execution evidence.',
          'Do not repeat the audit, specification, Assignment, or project inspection.'
        ])
  ].join('\n')
}

export function assignmentAuditErrorsUnchanged(
  previous: AssignmentAuditRepairManifest | null,
  errors: string[]
): boolean {
  if (!previous || previous.status !== 'invalid') return false
  const normalize = (values: string[]): string[] =>
    [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort()
  const prior = normalize(previous.errors)
  const current = normalize(errors)
  return prior.length === current.length && prior.every((error, index) => error === current[index])
}

export function validateAssignmentAuditExecutionEvidence(input: {
  content: AuditReportContent
  /** Assignment scope to enforce; omitted for independent (spec-less) audits. */
  assignment?: AssignmentPlan
  messages: AgentMessage[]
  auditStartedAt: number
  utilitySearchRequired: boolean
}): Map<string, Extract<AgentPart, { type: 'tool' }>> {
  const issues: string[] = []
  const checkInvocations = new Map<string, Extract<AgentPart, { type: 'tool' }>>()
  const auditedFiles = new Set(input.content.auditedFiles?.map((file) => file.path) ?? [])
  for (const expectedFile of new Set(
    input.assignment?.content.tasks.flatMap((task) => task.expectedFiles) ?? []
  )) {
    if (!auditedFiles.has(expectedFile)) {
      issues.push(`auditedFiles is missing Assignment expected file ${expectedFile}`)
    }
  }

  const observedTools = input.messages
    .filter(
      (message) => message.role === 'assistant' && message.createdAt >= input.auditStartedAt - 1_000
    )
    .flatMap((message) => message.parts)
    .filter(
      (part): part is Extract<AgentPart, { type: 'tool' }> =>
        part.type === 'tool' && ['completed', 'error'].includes(part.state.status)
    )
  const normalizeCommandEvidence = (value: string): string =>
    value
      .normalize('NFKC')
      .replace(/\\(["'$`])/gu, '$1')
      .replace(/\\+/gu, '\\')
      .replace(/["']/gu, '')
      .replace(/\s+/gu, ' ')
      .trim()
  const normalizeInvocationEvidence = (value: string): string =>
    value
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
  const observedInvocations = observedTools.map((part) => {
    const invocation = [part.tool, part.state.title, JSON.stringify(part.state.input)]
      .filter((value): value is string => Boolean(value))
      .join('\n')
    return {
      part,
      invocation,
      normalizedInvocation: normalizeInvocationEvidence(invocation)
    }
  })
  /** The shell text an auditor actually executed, when the harness exposes it. */
  const toolCommandText = (part: Extract<AgentPart, { type: 'tool' }>): string => {
    const command = part.state.input.command
    if (typeof command === 'string' && command.trim()) return command
    return part.state.title ?? ''
  }
  const sourceFileTokenPattern =
    /(?:^|\/)[\w.@+-]+\.(?:[cm]?[jt]sx?|svelte|json|jsonc|css|scss|html|vue|py|go|rs|java|kt|kts|swift|yml|yaml|toml|sh|sql)$/u
  const isPathToken = (token: string): boolean =>
    token.includes('/') || sourceFileTokenPattern.test(token)
  /** Compare two path-ish tokens while tolerating the workspace-relative vs
   *  package-relative prefixes an auditor mixes (`src/lib/x.ts` against
   *  `apps/application/src/lib/x.ts`). */
  const pathTokensMatch = (left: string, right: string): boolean =>
    left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`)
  /** Reduce a shell command to its logical body: drop the `cd <dir> &&`
   *  wrapper, exit-code echoes, and output tailing an auditor wraps around the
   *  command it reports, because the report records the intent rather than the
   *  exact shell line. */
  const commandBody = (value: string): string =>
    normalizeCommandEvidence(value)
      .replace(/2>&1/gu, ' ')
      .replace(/\|\s*(?:tail|head)\s+-\d+/gu, ' ')
      .replace(/;\s*(?:echo|printf)\s+[^;|]*/gu, ' ')
      .replace(/\|\|\s*true/gu, ' ')
      .replace(/(?:^|[;&|]\s*)cd\s+\S+\s*&&\s*/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
  const commandDirectories = (value: string): string[] =>
    [...value.matchAll(/(?:^|[;&|]\s*)cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)/gu)]
      .map((match) => match[1].replace(/["']/gu, '').replace(/\/+$/u, '').trim())
      .filter((directory) => /[\p{L}\p{N}]/u.test(directory))
  const observedCommands = observedTools
    .filter(
      (part) => part.state.status === 'completed' && /bash|command|shell|exec/iu.test(part.tool)
    )
    .map((part) => {
      const invocation = [part.tool, part.state.title, JSON.stringify(part.state.input)]
        .filter((value): value is string => Boolean(value))
        .join('\n')
      const rawCommand = toolCommandText(part)
      return {
        part,
        invocation,
        /** Every token the harness saw, command body plus raw invocation, so a
         *  harness that only exposes `state.title` still matches. */
        observedTokens: [
          ...commandBody(rawCommand).split(' '),
          ...normalizeCommandEvidence(invocation).split(' ')
        ].filter(Boolean),
        observedDirectories: commandDirectories(rawCommand)
      }
    })
  /** Tool calls the harness exposes directly instead of through a shell
   *  (`cio_util_use`, `read`, `grep`, `lsp`). A non-shell analysis such as the
   *  Svelte autofixer can only ever be evidenced by one of these, never by a
   *  shell command, so a command-only matcher rejects work the auditor did. */
  const isShellTool = (tool: string): boolean => /bash|command|shell|exec/iu.test(tool)
  const observedToolCalls = observedInvocations.map((observed) => ({
    ...observed,
    toolName: observed.part.tool.toLowerCase(),
    normalizedTokens: new Set(observed.normalizedInvocation.split(' ').filter(Boolean))
  }))
  /** Names an auditor can use to reference a tool call, including the short
   *  MCP-qualified suffix (`cio_util_use` for `mcp__gateway__cio_util_use`). */
  const observableToolNames = new Set<string>()
  for (const call of observedToolCalls) {
    if (isShellTool(call.toolName)) continue
    observableToolNames.add(call.toolName)
    const suffix = call.toolName.split('__').pop()
    if (suffix) observableToolNames.add(suffix)
  }
  const callMatchesToolName = (call: (typeof observedToolCalls)[number], named: string): boolean =>
    call.toolName === named || call.toolName.endsWith(`__${named}`)
  /** Auditors annotate the tool line with prose (`(non-writing)`) that is not
   *  part of the call; drop it, but keep identifier-shaped parentheticals so a
   *  gateway id still has to match. */
  const stripIncidentalParentheticals = (value: string): string =>
    value.replace(/\((?![0-9a-f]{6,}\))[^()]*\)/gu, ' ')
  /** Identifier-shaped tokens carry evidence (`svelte-autofixer`, a gateway
   *  id, a version); plain prose such as a utility's display name carries none
   *  and must not be treated as an unverifiable claim. */
  const isIdentifierToken = (token: string): boolean =>
    /\d/u.test(token) || (token.length > 1 && /[^a-z0-9]/iu.test(token) && /[a-z0-9]/iu.test(token))
  /** Match a check whose command names a tool call rather than a shell line.
   *  Returns the closest observed call with the identifier tokens it is
   *  missing, so a fabrication still fails with actionable detail. */
  const matchToolInvocation = (
    rawCommand: string,
    files: readonly string[]
  ): { call: (typeof observedToolCalls)[number]; missing: string[] } | null => {
    const reportTokens = commandBody(stripIncidentalParentheticals(rawCommand))
      .split(' ')
      .filter(Boolean)
    const namedTool = reportTokens.find((token) => observableToolNames.has(token.toLowerCase()))
    if (!namedTool) return null
    const calls = observedToolCalls.filter(
      (call) =>
        callMatchesToolName(call, namedTool.toLowerCase()) && call.part.state.status === 'completed'
    )
    if (calls.length === 0) return null
    const requiredTokens = [
      ...new Set(
        reportTokens
          .filter(
            (token) => !isPathToken(token) && !token.startsWith('-') && isIdentifierToken(token)
          )
          .flatMap((token) => normalizeInvocationEvidence(token).split(' '))
          .filter(Boolean)
      )
    ]
    const requiredPaths = [...new Set([...files, ...reportTokens.filter(isPathToken)])]
    const missingFor = (call: (typeof observedToolCalls)[number]): string[] => [
      ...requiredTokens.filter((token) => !call.normalizedTokens.has(token)),
      ...requiredPaths.filter(
        (path) => !call.normalizedInvocation.includes(normalizeInvocationEvidence(path))
      )
    ]
    return (
      calls
        .map((call) => ({ call, missing: missingFor(call) }))
        .sort((left, right) => left.missing.length - right.missing.length)[0] ?? null
    )
  }
  const verification = input.content.verification
  for (const check of verification?.checks ?? []) {
    if (check.status === 'not_applicable') continue
    const rawCommand = check.command.replace(/^\$\s*/u, '').trim()
    const tokens = commandBody(rawCommand).split(' ').filter(Boolean)
    const pathTokens = tokens.filter(isPathToken)
    const requiredTokens = tokens.filter((token) => token !== '--' && !isPathToken(token))
    const requiredDirectories = commandDirectories(rawCommand)
    const declaredTokenCount = requiredTokens.length + pathTokens.length
    /** Tokens of this check's command that a given observed command never
     *  contains. Empty means the auditor really executed this check. */
    const missingTokens = (observed: (typeof observedCommands)[number]): string[] => [
      ...requiredTokens.filter((token) => !observed.observedTokens.includes(token)),
      ...pathTokens.filter(
        (token) => !observed.observedTokens.some((candidate) => pathTokensMatch(candidate, token))
      )
    ]
    const observedCommand = observedCommands.find(
      (observed) =>
        missingTokens(observed).length === 0 &&
        requiredDirectories.every((directory) =>
          observed.observedDirectories.some((candidate) => pathTokensMatch(candidate, directory))
        )
    )
    if (observedCommand) {
      checkInvocations.set(check.id, observedCommand.part)
      if (check.kind === 'format' || check.kind === 'lint') {
        for (const file of check.files) {
          if (
            !observedCommand.invocation.includes(file) &&
            !observedCommand.observedTokens.some((token) => pathTokensMatch(token, file))
          ) {
            issues.push(
              `verification.checks ${check.id} did not explicitly target audited file ${file}`
            )
          }
        }
      }
      continue
    }
    const toolMatch = matchToolInvocation(rawCommand, check.files)
    if (toolMatch && toolMatch.missing.length === 0) {
      checkInvocations.set(check.id, toolMatch.call.part)
      continue
    }
    const closest = toolMatch
      ? toolMatch.missing
      : observedCommands
          .map((observed) => missingTokens(observed))
          .filter((missing) => missing.length > 0 && missing.length < declaredTokenCount)
          .sort((left, right) => left.length - right.length)[0]
    issues.push(
      `verification.checks ${check.id} has no matching completed command in the auditor transcript${
        closest ? ` (never observed: ${closest.slice(0, 6).join(', ')})` : ''
      }`
    )
    continue
  }

  const observedToolNames = observedTools.map((part) => part.tool.toLowerCase())
  if (
    input.utilitySearchRequired &&
    !observedToolNames.some((name) => name.includes(UTILITY_SEARCH_TOOL_NAME))
  ) {
    issues.push(
      `verification.utilities has no ${UTILITY_SEARCH_TOOL_NAME} call in the auditor transcript`
    )
  }
  for (const utility of verification?.utilities ?? []) {
    if (utility.status !== 'used') continue
    const normalizedUtilityName = normalizeInvocationEvidence(utility.name)
    const tokens = normalizedUtilityName
      .split(' ')
      .filter((token) => token.length > 3 && token !== 'utility')
    const invoked = observedInvocations.some(
      ({ part, normalizedInvocation }) =>
        part.state.status === 'completed' &&
        (normalizedInvocation.includes(normalizedUtilityName) ||
          (tokens.length > 0 && tokens.every((token) => normalizedInvocation.includes(token))))
    )
    if (!invoked) {
      issues.push(
        `verification.utilities ${utility.name} has no matching invocation in the auditor transcript`
      )
    }
  }
  if (issues.length > 0) throw new AuditReportValidationError(issues)
  return checkInvocations
}

export function latestAssignmentAuditOutput(messages: AgentMessage[]): string | null {
  for (const message of [...messages].reverse()) {
    if (message.role !== 'assistant' || message.error) continue
    const rawOutput =
      message.structuredOutput !== undefined
        ? (JSON.stringify(message.structuredOutput, null, 2) ?? String(message.structuredOutput))
        : message.parts
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n')
            .trim()
    if (rawOutput.startsWith('{') || rawOutput.startsWith('```json')) return rawOutput
  }
  return null
}

export function auditRequiresRework(content: AuditReportContent): boolean {
  return content.findings.some((finding) => ACTIONABLE_AUDIT_SEVERITIES.has(finding.severity))
}

export function initialSpecPath(projectId: string, threadId: string): string {
  return `projects/${projectId}/threads/${threadId}/spec-generation.json`
}

export function specMemorySegment(value: string): string {
  const readable =
    value
      .trim()
      .replace(/[^A-Za-z0-9._-]+/gu, '-')
      .replace(/^[._-]+|[._-]+$/gu, '')
      .slice(0, 48) || 'unknown'
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 10)
  return `${readable}-${digest}`
}

export function knownSpecGenerationLessonInstruction(code: string): string | null {
  switch (code) {
    case 'valid-json-object':
      return 'Return one syntactically valid JSON object with no Markdown fence, prose prefix, prose suffix, comments, or trailing commas.'
    case 'assignment-graph-required':
      return 'When Assignment mode is enabled, include the complete required assignment graph in the same specification object.'
    case 'required-spec-fields':
      return 'Before submission, verify that every required specification field and every required non-empty nested field is present.'
    case 'spec-schema-conformance':
      return 'Before submission, verify the complete output against the supplied specification schema, including nested object, array, enum, and dependency rules.'
    default:
      return null
  }
}

export function specRepairInstruction(error: GeneratedSpecOutputError): string {
  return [
    'The previous specification output failed deterministic validation.',
    `Exact validator diagnostic: ${error.diagnostic}`,
    error.repairArtifactPath
      ? `Read the rejected output and diagnostic at ${error.repairArtifactPath}. Correct that output and return one complete replacement JSON object matching the required schema.`
      : 'Correct the reported contract violation and return one complete replacement JSON object matching the required schema.',
    'Do not explain the correction and do not return a partial patch.'
  ].join('\n')
}

export function brainstormRepairInstruction(error: GeneratedBrainstormOutputError): string {
  return [
    'The previous Brainstorm output failed deterministic validation.',
    `Exact validator diagnostic: ${error.diagnostic}`,
    error.repairArtifactPath
      ? `Read the rejected output and diagnostic at ${error.repairArtifactPath}. Correct that output and return one complete replacement Brainstorm JSON object matching the required schema.`
      : 'Correct the reported contract violation and return one complete replacement Brainstorm JSON object matching the required schema.',
    'Do not explain the correction and do not return a partial patch.'
  ].join('\n')
}

export function initialSpecWorkingStatus(
  pending: PendingInitialSpecGeneration,
  label?: string
): AgentSessionStatus {
  const attempt = Math.max(1, pending.attempts)
  return {
    state: 'working',
    startedAt: pending.createdAt,
    activity: {
      kind: 'spec_generation',
      label:
        label ?? `Formulating specification · attempt ${attempt}/${SPEC_GENERATION_MAX_ATTEMPTS}`,
      attempt,
      maxAttempts: SPEC_GENERATION_MAX_ATTEMPTS,
      updatedAt: pending.updatedAt
    }
  }
}

export function pendingSpecRevisionPath(projectId: string, threadId: string): string {
  return `projects/${projectId}/threads/${threadId}/spec-revision.json`
}

export function pendingPrdTurnPath(projectId: string, threadId: string): string {
  return `projects/${projectId}/threads/${threadId}/prd-turn.json`
}

export function pendingAssignmentTurnPath(projectId: string, threadId: string): string {
  return `projects/${projectId}/threads/${threadId}/assignment-turn.json`
}

export function scopeHarnessCommands(
  harnessId: string,
  commands: HarnessCommand[]
): ScopedHarnessCommand[] {
  const scoped = new Map<string, ScopedHarnessCommand>()
  for (const command of commands) {
    const name = typeof command.name === 'string' ? command.name.trim() : ''
    if (!name || name.length > 256 || /[\s/]/u.test(name)) continue
    const source: HarnessCommandSource =
      command.source === 'mcp' || command.source === 'skill' ? command.source : 'command'
    const description =
      typeof command.description === 'string'
        ? command.description.trim().slice(0, 2_048)
        : undefined
    const id = `${harnessId}:${source}:${name}`
    if (scoped.has(id)) continue
    scoped.set(id, {
      id,
      harnessId,
      name,
      source,
      ...(description ? { description } : {})
    })
  }
  return [...scoped.values()]
}

export function validateQuestionAnswers(answers: unknown, questions: AgentQuestion[]): string[][] {
  if (!Array.isArray(answers) || answers.length !== questions.length) {
    throw new TypeError(
      `Question answers must contain exactly ${questions.length} ordered entr${questions.length === 1 ? 'y' : 'ies'}`
    )
  }
  return answers.map((answer, index) => {
    if (!Array.isArray(answer) || answer.length === 0) {
      throw new TypeError(`Question answer ${index + 1} must not be empty`)
    }
    if (!questions[index]?.multiple && answer.length !== 1) {
      throw new TypeError(`Question answer ${index + 1} allows exactly one selection`)
    }
    return answer.map((value) =>
      validateBoundedString(value, `Question answer ${index + 1}`, 1, 10_000)
    )
  })
}

/** One secret question never carries options and never auto-answers. */
export function isSecretQuestion(question: AgentQuestion): boolean {
  return question.secretRequest === true && typeof question.secretId === 'string'
}

/** Placeholder recorded for a secret request so nothing sensitive is persisted. */
export const SECRET_ANSWER_PLACEHOLDER = '[secret set]'

/**
 * Validate a `cio_ask_secret` submission against its pending request. Every
 * secret question must be answered exactly once with a non-empty value, and no
 * submission may name an unknown secret. Returns the values in question order.
 */
export function validateSecretSubmissions(
  submissions: unknown,
  questions: AgentQuestion[]
): Array<{ secretId: string; value: string }> {
  const expected: string[] = []
  for (const question of questions) {
    if (question.secretRequest !== true) continue
    const secretId = question.secretId
    if (typeof secretId === 'string' && secretId) expected.push(secretId)
  }
  if (expected.length === 0) throw new TypeError('This request is not a secret request')
  if (!Array.isArray(submissions)) throw new TypeError('Secret submissions must be an array')
  const values = new Map<string, string>()
  for (const entry of submissions) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new TypeError('Secret submission must be an object')
    }
    const record = entry as Record<string, unknown>
    const secretId = record['secretId']
    const value = record['value']
    if (typeof secretId !== 'string' || !expected.includes(secretId)) {
      throw new TypeError(`Secret submission names an unknown secret: ${String(secretId)}`)
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError('Secret value must not be empty')
    }
    if (values.has(secretId)) throw new TypeError(`Duplicate secret submission: ${secretId}`)
    values.set(secretId, value)
  }
  return expected.map((secretId) => {
    const value = values.get(secretId)
    if (value === undefined) throw new TypeError(`Secret value missing for: ${secretId}`)
    return { secretId, value }
  })
}

export function assertQuestionIndex(index: number, questionCount: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= questionCount) {
    throw new TypeError('Question index is out of range')
  }
}

export function recommendedQuestionAnswer(question: AgentQuestion): string {
  return (
    question.richOptions?.find((option) => option.recommended)?.label ??
    question.richOptions?.[0]?.label ??
    question.options?.[0] ??
    'Use your recommended approach'
  )
}

export function turnStreamPath(projectId: string, threadId: string): string {
  return `projects/${projectId}/threads/${threadId}/stream.jsonl`
}

export function deliverBroadcast(event: AgentEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'agent:event', event)
  }
}

export function broadcastToast(message: string, type: 'error' | 'info' = 'error'): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'app:toast', { message, type })
  }
}

export function chatSkillPaths(driverId: string): string[] {
  const paths = new Set([SHARED_GLOBAL_SKILL_PATH, harnessGlobalSkillPath(driverId)])
  return [...paths]
    .filter((path): path is string => path !== undefined)
    .map((path) =>
      path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
    )
}

export function assistantTurnCostAccounting(message: UsageBearingMessage): {
  costUsd: number | null
  costStatus: 'known' | 'estimated' | 'unavailable'
} {
  const stepCosts = (message.parts ?? []).filter(
    (part): part is Extract<AgentPart, { type: 'step-finish' }> =>
      part.type === 'step-finish' && typeof part.cost === 'number'
  )
  const costUsd =
    typeof message.cost === 'number'
      ? message.cost
      : stepCosts.length > 0
        ? stepCosts.reduce((sum, part) => sum + (part.cost ?? 0), 0)
        : null
  if (costUsd === null) return { costUsd: null, costStatus: 'unavailable' }
  const estimated =
    message.costProvenance !== undefined && message.costProvenance.source !== 'provider'
  return { costUsd, costStatus: estimated ? 'estimated' : 'known' }
}

export function toRankingCandidate(row: ModelRankingSnapshotRow): RankingGradeCandidate {
  return {
    id: row.id,
    harnessId: row.harness_id,
    providerId: row.provider_id,
    modelId: row.model_id,
    thinkingLevel: (row.thinking_level || 'minimal') as ThinkingLevel,
    userMessage: row.user_message_text,
    assistantOutput: row.assistant_output_text,
    followUp: row.follow_up_text
  }
}

/**
 * The visible instruction text of one persisted user record, for ranking.
 *
 * A user dispatch carries either typed text (with attachments) or a workflow
 * card: `persistOutboundMessage` stores the card in place of the text it
 * displayed, exactly as the transcript renders it, so the card's action and
 * body ARE the instruction the user gave ("Implement spec" plus the notes they
 * added). Without this, a card-bearing implementation turn would be queued for
 * grading with an empty prompt.
 */
export function userInstructionText(message: AgentMessage): string {
  const text = message.parts
    .filter((part): part is Extract<AgentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim()
  if (text) return text
  const presentation = message.parts.find(
    (part): part is Extract<AgentPart, { type: 'user-presentation' }> =>
      part.type === 'user-presentation'
  )?.presentation
  if (!presentation) return ''
  return [presentation.action, presentation.body].filter(Boolean).join('\n\n').trim()
}

export function preserveMirrorReasoningStamps(
  mirror: AgentMessage[],
  incoming: AgentMessage[]
): void {
  if (mirror.length === 0) return
  for (const incomingMsg of incoming) {
    const mirrorMsg = mirror.find((m) => m.id === incomingMsg.id)
    if (!mirrorMsg) continue
    for (const incomingPart of incomingMsg.parts) {
      if (incomingPart.type === 'reasoning' && !incomingPart.time?.start) {
        const mirrorPart = mirrorMsg.parts.find(
          (p): p is Extract<AgentPart, { type: 'reasoning' }> =>
            p.type === 'reasoning' && p.id === incomingPart.id
        )
        if (mirrorPart?.time?.start) {
          incomingPart.time = {
            start: mirrorPart.time.start,
            end: mirrorPart.time.end
          }
        }
      }
    }
  }
}

export function preserveMirrorToolStamps(mirror: AgentMessage[], incoming: AgentMessage[]): void {
  if (mirror.length === 0) return
  for (const incomingMsg of incoming) {
    const mirrorMsg = mirror.find((m) => m.id === incomingMsg.id)
    if (!mirrorMsg) continue
    for (const incomingPart of incomingMsg.parts) {
      if (incomingPart.type === 'tool' && !incomingPart.state.time?.start) {
        const mirrorPart = mirrorMsg.parts.find(
          (p): p is Extract<AgentPart, { type: 'tool' }> =>
            p.type === 'tool' && p.id === incomingPart.id
        )
        if (mirrorPart?.state.time?.start) {
          incomingPart.state.time = {
            start: mirrorPart.state.time.start,
            end: mirrorPart.state.time.end
          }
        }
      }
    }
  }
}

export function preserveMirrorGenerationDurations(
  mirror: AgentMessage[],
  incoming: AgentMessage[]
): void {
  if (mirror.length === 0) return
  for (const incomingMsg of incoming) {
    if (incomingMsg.generationMs !== undefined) continue
    const mirrorMsg = mirror.find((m) => m.id === incomingMsg.id)
    if (mirrorMsg?.generationMs !== undefined) {
      incomingMsg.generationMs = mirrorMsg.generationMs
    }
  }
}

export async function probeSessionLiveness(
  driver: HarnessDriver,
  info: SessionInfo,
  sessionId: string
): Promise<'busy' | 'idle' | 'wedged'> {
  const PROBE_TIMEOUT_MS = 15_000
  try {
    const busy = await Promise.race([
      driver.isSessionBusy!(info.projectPath, sessionId),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('liveness probe timed out')), PROBE_TIMEOUT_MS)
      )
    ])
    return busy ? 'busy' : 'idle'
  } catch {
    return 'wedged'
  }
}

export function broadcastMemoryProposal(projectId: string, threadId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'app:toast', {
      message: `${APP_NAME} found a preference worth remembering. Review it before saving.`,
      type: 'info',
      action: { label: 'Review Memory', projectId, threadId }
    })
  }
}

export function imageDescriptorFailureMessage(error: unknown): string {
  if (!(error instanceof ImageDescriptorInactivityError)) {
    return error instanceof Error ? error.message : 'Image description failed'
  }
  const currentWindow = formatTimeoutWindow(error.timeoutMs)
  if (error.attempt === 0 && error.nextTimeoutMs !== undefined) {
    return `No image-upload or vision-model activity was received for ${currentWindow}. A slow or unstable network may have stalled the file upload. Retry will use a longer ${formatTimeoutWindow(error.nextTimeoutMs)} inactivity window, which resets whenever the provider reports progress.`
  }
  return `No image-upload or vision-model activity was received for ${currentWindow}, even with the extended retry window. Check the network connection and retry; the file upload or provider response may have stalled.`
}

export function apiTaskReport(value: unknown): AssignmentTaskReport {
  if (!isRecord(value)) throw new Error('report must be an object')
  const status = apiString(value.status, 'report.status')
  if (status !== 'ready_for_audit' && status !== 'blocked' && status !== 'failed') {
    throw new Error('report.status is invalid')
  }
  if (!Array.isArray(value.evidence)) throw new Error('report.evidence must be an array')
  return {
    status,
    summary: validateBoundedString(value.summary, 'report.summary', 1, 20_000),
    evidence: value.evidence.map((item) =>
      validateBoundedString(item, 'report.evidence item', 1, 20_000)
    ),
    ...(typeof value.commitHash === 'string' ? { commitHash: value.commitHash } : {}),
    reportedAt: Date.now()
  }
}

export function apiTaskReview(value: unknown): AssignmentTaskReview {
  if (!isRecord(value)) throw new Error('review must be an object')
  const decision = apiString(value.decision, 'review.decision')
  if (decision !== 'pass' && decision !== 'rework' && decision !== 'fail') {
    throw new Error('review.decision is invalid')
  }
  if (!Array.isArray(value.checklistResults)) {
    throw new Error('review.checklistResults must be an array')
  }
  return {
    decision,
    checklistResults: value.checklistResults.map((entry) => {
      if (!isRecord(entry)) throw new Error('review checklist result must be an object')
      if (typeof entry.passed !== 'boolean') {
        throw new Error('review checklist passed must be a boolean')
      }
      return {
        item: validateBoundedString(entry.item, 'review checklist item', 1, 2_000),
        passed: entry.passed,
        evidence: validateBoundedString(entry.evidence, 'review checklist evidence', 0, 20_000)
      }
    }),
    notes: validateBoundedString(value.notes ?? '', 'review.notes', 0, 20_000),
    reviewedAt: Date.now()
  }
}

export function apiFollowUpTask(value: unknown): AssignmentFollowUpTaskInput {
  if (!isRecord(value)) throw new Error('task must be an object')
  const owner = apiString(value.owner, 'task.owner')
  if (owner !== 'senior' && owner !== 'worker') {
    throw new Error('task.owner must be senior or worker')
  }
  const stringArray = (candidate: unknown, label: string): string[] => {
    if (!Array.isArray(candidate)) throw new Error(`${label} must be an array`)
    return candidate.map((item) => validateBoundedString(item, `${label} item`, 1, 20_000))
  }
  let model: AssignmentFollowUpTaskInput['model']
  if (value.model !== undefined) {
    if (!isRecord(value.model)) throw new Error('task.model must be an object')
    const thinkingLevel = apiString(value.model.thinkingLevel, 'task.model.thinkingLevel')
    if (!['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(thinkingLevel)) {
      throw new Error('task.model.thinkingLevel is invalid')
    }
    model = {
      harnessId: apiString(value.model.harnessId, 'task.model.harnessId'),
      providerId: apiString(value.model.providerId, 'task.model.providerId'),
      modelId: apiString(value.model.modelId, 'task.model.modelId'),
      ...(value.model.accountId === undefined
        ? {}
        : { accountId: apiString(value.model.accountId, 'task.model.accountId') }),
      thinkingLevel: thinkingLevel as NonNullable<
        AssignmentFollowUpTaskInput['model']
      >['thinkingLevel']
    }
  }
  return {
    id: apiString(value.id, 'task.id'),
    phaseId: apiString(value.phaseId, 'task.phaseId'),
    title: validateBoundedString(value.title, 'task.title', 1, 500),
    description: validateBoundedString(value.description, 'task.description', 1, 20_000),
    ...(typeof value.info === 'string'
      ? { info: validateBoundedString(value.info, 'task.info', 1, 20_000) }
      : {}),
    prompt: validateBoundedString(value.prompt, 'task.prompt', 1, 40_000),
    owner,
    dependsOn: stringArray(value.dependsOn, 'task.dependsOn'),
    expectedFiles: stringArray(value.expectedFiles, 'task.expectedFiles'),
    auditChecklist: stringArray(value.auditChecklist, 'task.auditChecklist'),
    ...(model ? { model } : {})
  }
}

export function specMemoryPath(projectId: string, settings: ThreadSettings): string {
  return join(
    'projects',
    projectId,
    'spec-memory',
    specMemorySegment(settings.harnessId || DEFAULT_HARNESS),
    specMemorySegment(settings.providerId),
    specMemorySegment(settings.modelId),
    'lessons.json'
  )
}

export function specGenerationLesson(
  error: GeneratedSpecOutputError
): Pick<SpecGenerationLesson, 'code' | 'instruction'> {
  const diagnostic = error.diagnostic.toLowerCase()
  if (diagnostic.includes('invalid json')) {
    return {
      code: 'valid-json-object',
      instruction: knownSpecGenerationLessonInstruction('valid-json-object') ?? ''
    }
  }
  if (diagnostic.includes('assignment graph')) {
    return {
      code: 'assignment-graph-required',
      instruction: knownSpecGenerationLessonInstruction('assignment-graph-required') ?? ''
    }
  }
  if (diagnostic.includes('missing')) {
    return {
      code: 'required-spec-fields',
      instruction: knownSpecGenerationLessonInstruction('required-spec-fields') ?? ''
    }
  }
  return {
    code: 'spec-schema-conformance',
    instruction: knownSpecGenerationLessonInstruction('spec-schema-conformance') ?? ''
  }
}
