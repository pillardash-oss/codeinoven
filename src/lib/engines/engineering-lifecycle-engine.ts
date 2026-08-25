import type { Database } from '../../main/database/database'
import {
  ENGINEERING_LIFECYCLE_STAGE_VALUES,
  type EngineeringLifecycleDecision,
  type EngineeringLifecycleGate,
  type EngineeringLifecycleSelection,
  type EngineeringLifecycleSelectionInput,
  type EngineeringLifecycleStage,
  type EngineeringLifecycleState,
  type EngineeringLifecycleTransitionResult
} from '../types'

const MAX_FAILURE_LENGTH = 4_000
const MAX_TOKEN_LENGTH = 256
const STAGES = new Set<EngineeringLifecycleStage>(ENGINEERING_LIFECYCLE_STAGE_VALUES)

/** Browser-safe random hex ID (24 chars, mirrors `src/lib/utils` `generateId`).
 *  This engine is imported by renderer code, so it must never pull the
 *  main-only `fs`-importing `utils` module into client bundles. */
function generateLifecycleId(): string {
  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(12)
    globalThis.crypto.getRandomValues(bytes)
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  return `lifecycle-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`
}
const NEXT_STAGE_AFTER_GATE: Partial<Record<EngineeringLifecycleGate, EngineeringLifecycleStage>> =
  {
    prototype_selection: 'brainstorm',
    brainstorm_finalization: 'brainstorm',
    prd_finalization: 'prd',
    spec_approval: 'spec',
    assignment_approval: 'assignment'
  }
const NEXT_STAGE: Partial<Record<EngineeringLifecycleStage, EngineeringLifecycleStage>> = {
  brainstorm: 'prd',
  prd: 'spec',
  spec: 'assignment',
  assignment: 'achievement'
}

/** A stage that must be enabled for the given dependent stage to run. Notably
 *  Assignment and Achievement both need an approved Spec before they can start. */
const STAGE_DEPENDENCIES: Partial<Record<EngineeringLifecycleStage, EngineeringLifecycleStage[]>> =
  {
    assignment: ['spec'],
    achievement: ['spec']
  }

/** True when the lifecycle runs the given stage (Auto Pilot includes every stage). */
export function hasSelectedStage(
  state: EngineeringLifecycleState | null | undefined,
  stage: EngineeringLifecycleStage
): boolean {
  if (!state) return false
  if (state.autopilot) return true
  return state.selectedStages.includes(stage)
}

/** Build the canonical, de-duplicated stage set for a client request, applying
 *  cascade dependencies so Assignment/Achievement always bring Spec along. */
export function normalizeLifecycleStages(
  input: EngineeringLifecycleStage[]
): EngineeringLifecycleStage[] {
  const included = new Set<EngineeringLifecycleStage>()
  const queue = [...input]
  while (queue.length > 0) {
    const stage = queue.shift()
    if (!stage || included.has(stage)) continue
    included.add(stage)
    for (const dependency of STAGE_DEPENDENCIES[stage] ?? []) queue.push(dependency)
  }
  return ENGINEERING_LIFECYCLE_STAGE_VALUES.filter((stage) => included.has(stage))
}

/** Back-compat single representative used by legacy lifecycle labels and settings. */
export function representativeLifecycleSelection(
  stages: EngineeringLifecycleStage[],
  autopilot: boolean
): EngineeringLifecycleSelection {
  if (autopilot) return 'run_all'
  if (stages.length === 0) return 'none'
  return stages[0]
}

export interface EngineeringLifecycleSwitchState {
  checked: boolean
  disabled: boolean
}

/** Derive a stage switch's presentation from the canonical lifecycle state. */
export function deriveEngineeringLifecycleSwitchState(
  state: EngineeringLifecycleState | null,
  stage: EngineeringLifecycleStage
): EngineeringLifecycleSwitchState {
  const disabled = state?.autopilot === true
  return { checked: hasSelectedStage(state, stage), disabled }
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

interface LifecycleRow {
  project_id: string
  thread_id: string
  selection: EngineeringLifecycleSelection
  selected_stages_json: string
  autopilot: number
  active_stage: EngineeringLifecycleStage | null
  completed_stages_json: string
  human_gate: EngineeringLifecycleGate | null
  resume_token: string | null
  last_consumed_resume_token: string | null
  failure: string | null
  started_at: number | null
  updated_at: number
}

export class EngineeringLifecycleEngine {
  private readonly now: () => number
  private readonly tokenFactory: () => string

  constructor(
    private readonly db: Database,
    options: EngineeringLifecycleEngineOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.tokenFactory = options.generateToken ?? generateLifecycleId
  }

  get(projectId: string, threadId: string): EngineeringLifecycleState | null {
    this.assertScope(projectId, threadId)
    const row = this.db.get<LifecycleRow>(
      'SELECT project_id, thread_id, selection, selected_stages_json, autopilot, active_stage, completed_stages_json, human_gate, resume_token, last_consumed_resume_token, failure, started_at, updated_at FROM engineering_lifecycle WHERE project_id=? AND thread_id=?',
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
    let selectedStages = this.parseStages(row.selected_stages_json)
    // Legacy migration: a single-stage or run_all selection predates the multi-select
    // columns. Derive the set so previously selected stages survive the upgrade.
    let autopilot = row.autopilot === 1
    if (row.selection === 'run_all') {
      autopilot = true
      selectedStages = []
    } else if (!autopilot && selectedStages.length === 0 && row.selection !== 'none') {
      selectedStages = [row.selection]
    }
    return {
      projectId: row.project_id,
      threadId: row.thread_id,
      selection: row.selection,
      selectedStages,
      autopilot,
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
      'INSERT INTO engineering_lifecycle(project_id, thread_id, selection, selected_stages_json, autopilot, completed_stages_json, updated_at) VALUES(?,?,?,?,?,?,?)',
      projectId,
      threadId,
      'none',
      '[]',
      0,
      '[]',
      now
    )
    return {
      projectId,
      threadId,
      selection: 'none',
      selectedStages: [],
      autopilot: false,
      completedStages: [],
      updatedAt: now
    }
  }

  select(
    projectId: string,
    threadId: string,
    input: EngineeringLifecycleSelectionInput
  ): EngineeringLifecycleState {
    const current = this.ensure(projectId, threadId)
    if (current.activeStage || current.humanGate) {
      throw new EngineeringLifecycleError(
        'invalid_transition',
        'Confirm cancellation before replacing active Engineering work'
      )
    }
    const autopilot = input.autopilot === true
    const selectedStages = autopilot ? [] : normalizeLifecycleStages(input.stages)
    const selection = representativeLifecycleSelection(selectedStages, autopilot)
    if (
      current.selection === selection &&
      current.autopilot === autopilot &&
      this.sameStages(current.selectedStages, selectedStages)
    ) {
      return current
    }
    const now = this.now()
    // A new selection starts a fresh run: clear the permanent started marker so
    // send-time auto-start only applies to a brand-new selection and a parked
    // (circle-completed) lifecycle stays in implementation mode until a
    // designated button re-enters it.
    this.db.run(
      'UPDATE engineering_lifecycle SET selection=?, selected_stages_json=?, autopilot=?, completed_stages_json=?, started_at=NULL, resume_token=NULL, last_consumed_resume_token=NULL, failure=NULL, updated_at=? WHERE project_id=? AND thread_id=?',
      selection,
      JSON.stringify(selectedStages),
      autopilot ? 1 : 0,
      '[]',
      now,
      projectId,
      threadId
    )
    return {
      ...current,
      selection,
      selectedStages,
      autopilot,
      completedStages: [],
      failure: undefined,
      updatedAt: now
    }
  }

  start(
    projectId: string,
    threadId: string,
    stage?: EngineeringLifecycleStage
  ): EngineeringLifecycleTransitionResult {
    const current = this.ensure(projectId, threadId)
    if (!current.autopilot && current.selectedStages.length === 0) {
      throw new EngineeringLifecycleError('invalid_transition', 'Select an Engineering stage first')
    }
    if (current.activeStage || current.humanGate) return { state: current, idempotent: true }
    if (stage && !STAGES.has(stage)) {
      throw new EngineeringLifecycleError(
        'invalid_transition',
        `Unknown Engineering stage ${stage}`
      )
    }
    const stageToStart = stage ?? (current.autopilot ? 'brainstorm' : current.selectedStages[0])
    const now = this.now()
    this.db.run(
      'UPDATE engineering_lifecycle SET active_stage=?, started_at=COALESCE(started_at, ?), failure=NULL, updated_at=? WHERE project_id=? AND thread_id=?',
      stageToStart,
      now,
      now,
      projectId,
      threadId
    )
    return {
      state: {
        ...current,
        activeStage: stageToStart,
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
    const activeStage =
      terminal || (gate && gate !== 'terminal_failure')
        ? undefined
        : (input.nextStage ?? current.activeStage)
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

  completeStage(
    projectId: string,
    threadId: string,
    stage: EngineeringLifecycleStage
  ): EngineeringLifecycleState {
    const current = this.require(projectId, threadId)
    if (current.activeStage !== stage) {
      throw new EngineeringLifecycleError(
        'invalid_transition',
        `Cannot complete ${stage} while ${current.activeStage ?? 'no stage'} is active`
      )
    }
    if (current.autopilot) {
      if (stage === 'achievement') {
        return this.advance(projectId, threadId, { completedStage: stage, terminal: true })
      }
      const nextStage = NEXT_STAGE[stage]
      if (!nextStage) {
        throw new EngineeringLifecycleError('invalid_transition', `No stage follows ${stage}`)
      }
      return this.advance(projectId, threadId, { completedStage: stage, nextStage })
    }
    // Manual mode: a completed circle turns its switch OFF and drops the thread to
    // implementation mode. Selected stages remaining (e.g. PRD after Brainstorm) do NOT
    // auto-advance — the user continues by pressing the designated Next-step/Review/
    // Implement/Approve buttons. Achievement keeps the chained loop behavior: its audit/
    // rework cycle is what drives the pipeline forward.
    if (current.selectedStages.includes('achievement')) {
      const nextStage = this.nextSelectedStage(current.selectedStages, stage)
      if (!nextStage) {
        return this.advance(projectId, threadId, { completedStage: stage, terminal: true })
      }
      return this.advance(projectId, threadId, { completedStage: stage, nextStage })
    }
    const selectedStages = current.selectedStages.filter((candidate) => candidate !== stage)
    const selection = representativeLifecycleSelection(selectedStages, false)
    const completedStages = [...new Set([...current.completedStages, stage])]
    const terminal = selectedStages.length === 0
    const now = this.now()
    this.db.run(
      'UPDATE engineering_lifecycle SET selection=?, selected_stages_json=?, active_stage=?, completed_stages_json=?, started_at=COALESCE(started_at, ?), human_gate=NULL, resume_token=NULL, failure=NULL, updated_at=? WHERE project_id=? AND thread_id=?',
      terminal ? 'none' : selection,
      JSON.stringify(selectedStages),
      null,
      JSON.stringify(completedStages),
      now,
      now,
      projectId,
      threadId
    )
    return {
      ...current,
      selection: terminal ? 'none' : selection,
      selectedStages,
      completedStages,
      activeStage: undefined,
      humanGate: undefined,
      resumeToken: undefined,
      failure: undefined,
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
      (decision === 'continue' ? NEXT_STAGE_AFTER_GATE[current.humanGate] : undefined) ??
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

  fail(projectId: string, threadId: string, failure: string): EngineeringLifecycleState {
    const current = this.require(projectId, threadId)
    if (!current.activeStage || (!current.autopilot && current.selectedStages.length === 0)) {
      return current
    }
    if (current.humanGate === 'terminal_failure') return current
    return this.advance(projectId, threadId, {
      gate: 'terminal_failure',
      failure
    })
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
      "UPDATE engineering_lifecycle SET selection='none', active_stage=NULL, selected_stages_json='[]', autopilot=0, completed_stages_json='[]', human_gate=NULL, resume_token=NULL, last_consumed_resume_token=?, failure=NULL, updated_at=? WHERE project_id=? AND thread_id=?",
      resumeToken ?? current.lastConsumedResumeToken ?? null,
      now,
      projectId,
      threadId
    )
    return {
      ...current,
      selection: 'none',
      selectedStages: [],
      autopilot: false,
      activeStage: undefined,
      completedStages: [],
      humanGate: undefined,
      resumeToken: undefined,
      lastConsumedResumeToken: resumeToken ?? current.lastConsumedResumeToken,
      failure: undefined,
      updatedAt: now
    }
  }

  private nextSelectedStage(
    stages: EngineeringLifecycleStage[],
    current: EngineeringLifecycleStage
  ): EngineeringLifecycleStage | undefined {
    const currentOrder = ENGINEERING_LIFECYCLE_STAGE_VALUES.indexOf(current)
    return stages.find((stage) => ENGINEERING_LIFECYCLE_STAGE_VALUES.indexOf(stage) > currentOrder)
  }

  private parseStages(json: string): EngineeringLifecycleStage[] {
    const parsed = JSON.parse(json) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (stage): stage is EngineeringLifecycleStage =>
        typeof stage === 'string' && STAGES.has(stage as EngineeringLifecycleStage)
    )
  }

  private sameStages(
    left: EngineeringLifecycleStage[],
    right: EngineeringLifecycleStage[]
  ): boolean {
    if (left.length !== right.length) return false
    return left.every((stage, index) => stage === right[index])
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
