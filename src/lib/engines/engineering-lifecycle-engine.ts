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

/** A stage that must be enabled for the given dependent stage to run. No stage
 *  requires another today: Assignment decomposes the approved Spec when one exists
 *  and the thread conversation otherwise, and Achievement judges the work against
 *  an approved Spec when one exists and the goal captured from the request or the
 *  conversation otherwise. Neither forces a Spec the user never approved. A stage
 *  that genuinely needs a predecessor belongs here so its switch brings it too. */
const STAGE_DEPENDENCIES: Partial<Record<EngineeringLifecycleStage, EngineeringLifecycleStage[]>> =
  {}

/** True when the lifecycle runs the given stage. */
export function hasSelectedStage(
  state: EngineeringLifecycleState | null | undefined,
  stage: EngineeringLifecycleStage
): boolean {
  if (!state) return false
  return state.selectedStages.includes(stage)
}

/** Build the canonical, de-duplicated stage set for a client request, applying
 *  cascade dependencies so a stage that needs another always brings it along. */
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
  stages: EngineeringLifecycleStage[]
): EngineeringLifecycleSelection {
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
  return { checked: hasSelectedStage(state, stage), disabled: false }
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

/** The switches a sibling thread inherits, plus the source's highlight marker. */
export interface EngineeringLifecycleInheritInput {
  stages: EngineeringLifecycleStage[]
  /** The source's permanent `started_at`; carried only when nothing is selected. */
  startedAt?: number
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
    // Legacy migration: a single-stage selection, or the retired run_all value
    // that used to mean Auto Pilot, predates the multi-select columns. Auto Pilot
    // is gone, so a run_all row becomes every stage switched on instead.
    if (row.selection === 'run_all' || row.autopilot === 1) {
      selectedStages = [...ENGINEERING_LIFECYCLE_STAGE_VALUES]
    } else if (selectedStages.length === 0 && row.selection !== 'none') {
      selectedStages = [row.selection]
    }
    // The stored selection stays authoritative: a terminal advance clears it to
    // 'none' while the completed stage set remains until cancellation.
    const selection =
      row.selection === 'run_all' || row.autopilot === 1
        ? representativeLifecycleSelection(selectedStages)
        : row.selection
    return {
      projectId: row.project_id,
      threadId: row.thread_id,
      selection,
      selectedStages,
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
    const selectedStages = normalizeLifecycleStages(input.stages)
    const selection = representativeLifecycleSelection(selectedStages)
    if (
      current.selection === selection &&
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
      0,
      '[]',
      now,
      projectId,
      threadId
    )
    return {
      ...current,
      selection,
      selectedStages,
      completedStages: [],
      failure: undefined,
      updatedAt: now
    }
  }

  /**
   * Seed a sibling thread from a source Engineering thread.
   *
   * The source's switches travel as a fresh run: a brand-new
   * selection with no started marker, so a send on the sibling starts the stage
   * it is showing. The exception is a source with no switch on   a parked,
   * completed or cancelled run   whose Toolbox stays filled through its
   * permanent `started_at`. There the marker travels too, so the sibling mirrors
   * the source's highlight instead of arriving neutral. A manually turned-off
   * source has no marker, so the sibling arrives neutral exactly as it does.
   *
   * Transient run state (active stage, human gate, resume token, failure) is
   * never copied: the sibling is a fresh run, not a resumed one.
   */
  inherit(
    destinationProjectId: string,
    destinationThreadId: string,
    input: EngineeringLifecycleInheritInput
  ): EngineeringLifecycleState {
    const selectedStages = normalizeLifecycleStages(input.stages)
    const selection = representativeLifecycleSelection(selectedStages)
    const carryStartedAt = selectedStages.length === 0 && input.startedAt !== undefined
    const current = this.ensure(destinationProjectId, destinationThreadId)
    const now = this.now()
    this.db.run(
      'UPDATE engineering_lifecycle SET selection=?, selected_stages_json=?, autopilot=?, completed_stages_json=?, active_stage=NULL, human_gate=NULL, started_at=?, resume_token=NULL, last_consumed_resume_token=NULL, failure=NULL, updated_at=? WHERE project_id=? AND thread_id=?',
      selection,
      JSON.stringify(selectedStages),
      0,
      '[]',
      carryStartedAt ? input.startedAt : null,
      now,
      destinationProjectId,
      destinationThreadId
    )
    return {
      ...current,
      selection,
      selectedStages,
      completedStages: [],
      activeStage: undefined,
      humanGate: undefined,
      startedAt: carryStartedAt ? input.startedAt : undefined,
      resumeToken: undefined,
      lastConsumedResumeToken: undefined,
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
    if (current.selectedStages.length === 0) {
      throw new EngineeringLifecycleError('invalid_transition', 'Select an Engineering stage first')
    }
    if (current.activeStage || current.humanGate) return { state: current, idempotent: true }
    if (stage && !STAGES.has(stage)) {
      throw new EngineeringLifecycleError(
        'invalid_transition',
        `Unknown Engineering stage ${stage}`
      )
    }
    const stageToStart = stage ?? current.selectedStages[0]
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
    // A completed circle turns its switch OFF and drops the thread to
    // implementation mode. Selected stages remaining (e.g. PRD after Brainstorm) do NOT
    // auto-advance   the user continues by pressing the designated Next-step/Review/
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
    const selection = representativeLifecycleSelection(selectedStages)
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
    if (!current.activeStage || current.selectedStages.length === 0) {
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
    // Distinguish a missing row (failed/evicted creation) from a genuine
    // cross-project mismatch so the error names the real problem.
    if (!row) {
      throw new EngineeringLifecycleError('not_found', `Thread not found: ${threadId}`)
    }
    if (row.project_id !== projectId) {
      throw new EngineeringLifecycleError(
        'not_found',
        `Thread ${threadId} does not belong to the requested project`
      )
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
