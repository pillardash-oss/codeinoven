import type { Database } from '../../main/database/database'
import {
  ENGINEERING_LIFECYCLE_STAGE_VALUES,
  type EngineeringLifecycleDecision,
  type EngineeringLifecycleGate,
  type EngineeringLifecycleSelection,
  type EngineeringLifecycleStage,
  type EngineeringLifecycleState,
  type EngineeringLifecycleTransitionResult
} from '../types'
import { generateId } from '../utils'

const MAX_FAILURE_LENGTH = 4_000
const MAX_TOKEN_LENGTH = 256
const STAGES = new Set<EngineeringLifecycleStage>(ENGINEERING_LIFECYCLE_STAGE_VALUES)
const NEXT_STAGE_AFTER_GATE: Partial<Record<EngineeringLifecycleGate, EngineeringLifecycleStage>> =
  {
    brainstorm_finalization: 'prd',
    prd_finalization: 'spec',
    spec_approval: 'assignment',
    assignment_approval: 'achievement'
  }

export interface EngineeringLifecycleSwitchState {
  checked: boolean
  disabled: boolean
}

/** Derive switch presentation from the one canonical lifecycle selection. */
export function deriveEngineeringLifecycleSwitchState(
  selection: EngineeringLifecycleSelection,
  stage: EngineeringLifecycleStage
): EngineeringLifecycleSwitchState {
  return {
    checked: selection === 'run_all' || selection === stage,
    disabled: selection === 'run_all'
  }
}

export class EngineeringLifecycleError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_transition' | 'stale_resume_token',
    message: string
  ) {
    super(message)
    this.name = 'EngineeringLifecycleError'
  }
}

export interface EngineeringLifecycleEngineOptions {
  now?: () => number
  generateToken?: () => string
}

export interface EngineeringLifecycleAdvanceInput {
  completedStage?: EngineeringLifecycleStage
  nextStage?: EngineeringLifecycleStage
  gate?: EngineeringLifecycleGate
  failure?: string
  terminal?: boolean
}

export class EngineeringLifecycleEngine {
  private readonly now: () => number
  private readonly tokenFactory: () => string

  constructor(
    private readonly db: Database,
    options: EngineeringLifecycleEngineOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.tokenFactory = options.generateToken ?? generateId
  }

  get(projectId: string, threadId: string): EngineeringLifecycleState | null {
    this.assertScope(projectId, threadId)
    const row = this.db.get<{
      project_id: string
      thread_id: string
      selection: EngineeringLifecycleSelection
      active_stage: EngineeringLifecycleStage | null
      completed_stages_json: string
      human_gate: EngineeringLifecycleGate | null
      resume_token: string | null
      last_consumed_resume_token: string | null
      failure: string | null
      started_at: number | null
      updated_at: number
    }>(
      'SELECT project_id, thread_id, selection, active_stage, completed_stages_json, human_gate, resume_token, last_consumed_resume_token, failure, started_at, updated_at FROM engineering_lifecycle WHERE project_id=? AND thread_id=?',
      projectId,
      threadId
    )
    if (!row) return null
    const parsed = JSON.parse(row.completed_stages_json) as unknown
    const completedStages = Array.isArray(parsed)
      ? parsed.filter(
          (stage): stage is EngineeringLifecycleStage =>
            typeof stage === 'string' && STAGES.has(stage as EngineeringLifecycleStage)
        )
      : []
    return {
      projectId: row.project_id,
      threadId: row.thread_id,
      selection: row.selection,
      completedStages,
      ...(row.active_stage ? { activeStage: row.active_stage } : {}),
      ...(row.human_gate ? { humanGate: row.human_gate } : {}),
      ...(row.resume_token ? { resumeToken: row.resume_token } : {}),
      ...(row.last_consumed_resume_token
        ? { lastConsumedResumeToken: row.last_consumed_resume_token }
        : {}),
      ...(row.failure ? { failure: row.failure } : {}),
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      updatedAt: row.updated_at
    }
  }

  ensure(projectId: string, threadId: string): EngineeringLifecycleState {
    const existing = this.get(projectId, threadId)
    if (existing) return existing
    const now = this.now()
    this.db.run(
      'INSERT INTO engineering_lifecycle(project_id, thread_id, selection, completed_stages_json, updated_at) VALUES(?,?,?,?,?)',
      projectId,
      threadId,
      'none',
      '[]',
      now
    )
    return { projectId, threadId, selection: 'none', completedStages: [], updatedAt: now }
  }

  select(
    projectId: string,
    threadId: string,
    selection: EngineeringLifecycleSelection
  ): EngineeringLifecycleState {
    const current = this.ensure(projectId, threadId)
    if (current.activeStage || current.humanGate) {
      throw new EngineeringLifecycleError(
        'invalid_transition',
        'Confirm cancellation before replacing active Engineering work'
      )
    }
    if (current.selection === selection) return current
    const now = this.now()
    this.db.run(
      'UPDATE engineering_lifecycle SET selection=?, completed_stages_json=?, resume_token=NULL, last_consumed_resume_token=NULL, failure=NULL, updated_at=? WHERE project_id=? AND thread_id=?',
      selection,
      '[]',
      now,
      projectId,
      threadId
    )
    return { ...current, selection, completedStages: [], failure: undefined, updatedAt: now }
  }

  start(projectId: string, threadId: string): EngineeringLifecycleTransitionResult {
    const current = this.ensure(projectId, threadId)
    if (current.selection === 'none') {
      throw new EngineeringLifecycleError('invalid_transition', 'Select an Engineering stage first')
    }
    if (current.activeStage || current.humanGate) return { state: current, idempotent: true }
    const stage = current.selection === 'run_all' ? 'brainstorm' : current.selection
    const now = this.now()
    this.db.run(
      'UPDATE engineering_lifecycle SET active_stage=?, started_at=COALESCE(started_at, ?), failure=NULL, updated_at=? WHERE project_id=? AND thread_id=?',
      stage,
      now,
      now,
      projectId,
      threadId
    )
    return {
      state: {
        ...current,
        activeStage: stage,
        startedAt: current.startedAt ?? now,
        updatedAt: now
      },
      idempotent: false
    }
  }

  advance(
    projectId: string,
    threadId: string,
    input: EngineeringLifecycleAdvanceInput
  ): EngineeringLifecycleState {
    const current = this.require(projectId, threadId)
    if (input.completedStage && current.activeStage !== input.completedStage) {
      throw new EngineeringLifecycleError(
        'invalid_transition',
        `Cannot complete ${input.completedStage} while ${current.activeStage ?? 'no stage'} is active`
      )
    }
    const completedStages = input.completedStage
      ? [...new Set([...current.completedStages, input.completedStage])]
      : current.completedStages
    const failure = input.failure?.trim().slice(0, MAX_FAILURE_LENGTH)
    const gate = input.gate
    const terminal = input.terminal === true
    const selection = terminal ? 'none' : current.selection
    const activeStage = terminal || gate ? undefined : input.nextStage
    const token = gate ? this.newToken() : undefined
    const now = this.now()
    this.db.run(
      'UPDATE engineering_lifecycle SET selection=?, active_stage=?, completed_stages_json=?, human_gate=?, resume_token=?, failure=?, updated_at=? WHERE project_id=? AND thread_id=?',
      selection,
      activeStage ?? null,
      JSON.stringify(completedStages),
      gate ?? null,
      token ?? null,
      failure ?? null,
      now,
      projectId,
      threadId
    )
    return {
      ...current,
      selection,
      completedStages,
      activeStage,
      humanGate: gate,
      resumeToken: token,
      failure,
      updatedAt: now
    }
  }

  resume(
    projectId: string,
    threadId: string,
    resumeToken: string,
    decision: EngineeringLifecycleDecision,
    nextStage?: EngineeringLifecycleStage
  ): EngineeringLifecycleTransitionResult {
    this.assertToken(resumeToken)
    const current = this.require(projectId, threadId)
    if (current.lastConsumedResumeToken === resumeToken) {
      return { state: current, idempotent: true }
    }
    if (!current.humanGate || current.resumeToken !== resumeToken) {
      throw new EngineeringLifecycleError('stale_resume_token', 'The Engineering decision is stale')
    }
    if (decision === 'cancel') {
      return { state: this.cancel(projectId, threadId, resumeToken), idempotent: false }
    }
    const resumedStage =
      nextStage ??
      (current.selection === 'run_all' && decision === 'continue'
        ? NEXT_STAGE_AFTER_GATE[current.humanGate]
        : undefined) ??
      current.activeStage
    const now = this.now()
    this.db.run(
      'UPDATE engineering_lifecycle SET active_stage=?, human_gate=NULL, resume_token=NULL, last_consumed_resume_token=?, failure=NULL, updated_at=? WHERE project_id=? AND thread_id=?',
      resumedStage ?? null,
      resumeToken,
      now,
      projectId,
      threadId
    )
    return {
      state: {
        ...current,
        activeStage: resumedStage,
        humanGate: undefined,
        resumeToken: undefined,
        lastConsumedResumeToken: resumeToken,
        failure: undefined,
        updatedAt: now
      },
      idempotent: false
    }
  }

  retry(projectId: string, threadId: string, resumeToken: string): EngineeringLifecycleState {
    return this.resume(projectId, threadId, resumeToken, 'retry').state
  }

  cancel(projectId: string, threadId: string, resumeToken?: string): EngineeringLifecycleState {
    const current = this.require(projectId, threadId)
    if (resumeToken !== undefined && current.resumeToken !== resumeToken) {
      throw new EngineeringLifecycleError(
        'stale_resume_token',
        'The Engineering cancellation is stale'
      )
    }
    const now = this.now()
    this.db.run(
      "UPDATE engineering_lifecycle SET selection='none', active_stage=NULL, completed_stages_json='[]', human_gate=NULL, resume_token=NULL, last_consumed_resume_token=?, failure=NULL, updated_at=? WHERE project_id=? AND thread_id=?",
      resumeToken ?? current.lastConsumedResumeToken ?? null,
      now,
      projectId,
      threadId
    )
    return {
      ...current,
      selection: 'none',
      activeStage: undefined,
      completedStages: [],
      humanGate: undefined,
      resumeToken: undefined,
      lastConsumedResumeToken: resumeToken ?? current.lastConsumedResumeToken,
      failure: undefined,
      updatedAt: now
    }
  }

  private require(projectId: string, threadId: string): EngineeringLifecycleState {
    const state = this.get(projectId, threadId)
    if (!state) throw new EngineeringLifecycleError('not_found', 'Engineering lifecycle not found')
    return state
  }

  private assertScope(projectId: string, threadId: string): void {
    const row = this.db.get<{ project_id: string }>(
      'SELECT project_id FROM threads WHERE id=?',
      threadId
    )
    if (!row || row.project_id !== projectId) {
      throw new EngineeringLifecycleError('not_found', 'Thread does not belong to the project')
    }
  }

  private newToken(): string {
    const token = this.tokenFactory()
    this.assertToken(token)
    return token
  }

  private assertToken(token: string): void {
    if (!token || token.length > MAX_TOKEN_LENGTH || !/^[A-Za-z0-9._-]+$/u.test(token)) {
      throw new EngineeringLifecycleError('invalid_transition', 'Invalid Engineering resume token')
    }
  }
}
