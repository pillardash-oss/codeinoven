import type { AgentModelSelection, ThinkingLevel } from './common'
import type { Thread } from './thread'
import type { AssignmentAnnotation } from './spec'

export const ENGINEERING_LIFECYCLE_STAGE_VALUES = [
  'brainstorm',
  'prd',
  'spec',
  'assignment',
  'achievement'
] as const

export type EngineeringLifecycleStage = (typeof ENGINEERING_LIFECYCLE_STAGE_VALUES)[number]

export const ENGINEERING_LIFECYCLE_SELECTION_VALUES = [
  'none',
  ...ENGINEERING_LIFECYCLE_STAGE_VALUES,
  'run_all'
] as const

export type EngineeringLifecycleSelection = (typeof ENGINEERING_LIFECYCLE_SELECTION_VALUES)[number]

export type EngineeringLifecycleGate =
  | 'prototype_selection'
  | 'brainstorm_finalization'
  | 'prd_finalization'
  | 'spec_approval'
  | 'assignment_approval'
  | 'terminal_failure'

export type EngineeringLifecycleDecision = 'continue' | 'continue_without_hifi' | 'retry' | 'cancel'

export type BrainstormPrototypeIntent = 'none' | 'lofi' | 'hifi' | 'both'

/** Client → engine selection payload for the Engineering lifecycle. */
export interface EngineeringLifecycleSelectionInput {
  /** Independent stage switches that are enabled (canonical, no duplicates).
   *  Cascade dependencies (Assignment/Achievement imply Spec) are applied by the
   *  engine   the client sends the raw request and the engine normalizes it. */
  stages: EngineeringLifecycleStage[]
  /** Auto Pilot runs the full brainstorm→spec→assignment→achievement loop without
   *  human gates. When true, the per-stage set is ignored. */
  autopilot?: boolean
}

export interface EngineeringLifecycleState {
  projectId: string
  threadId: string
  /** Back-compat single representative: 'none' when no stage is selected,
   *  'run_all' when Auto Pilot is on, otherwise the earliest selected stage. */
  selection: EngineeringLifecycleSelection
  /** Enabled stage switches (canonical order, no duplicates). Empty in Auto Pilot. */
  selectedStages: EngineeringLifecycleStage[]
  /** Auto Pilot: full autonomous lifecycle loop without human gates. */
  autopilot: boolean
  activeStage?: EngineeringLifecycleStage
  completedStages: EngineeringLifecycleStage[]
  humanGate?: EngineeringLifecycleGate
  resumeToken?: string
  lastConsumedResumeToken?: string
  failure?: string
  /** Permanent history marker. It is never cleared after Engineering starts. */
  startedAt?: number
  updatedAt: number
}

export interface EngineeringLifecycleTransitionResult {
  state: EngineeringLifecycleState
  idempotent: boolean
}

export type AssignmentStatus =
  'draft' | 'approved' | 'running' | 'attention' | 'completed' | 'failed' | 'stopped'

export type AssignmentTaskStatus =
  | 'planned'
  | 'blocked'
  | 'ready'
  | 'running'
  | 'reported'
  | 'auditing'
  | 'rework'
  | 'attention'
  | 'completed'
  | 'failed'
  | 'stopped'

export type AssignmentTaskOwner = 'senior' | 'worker'

export type AssignmentTaskWorkKind = 'initial' | 'rework'

export interface AssignmentModelSelection extends AgentModelSelection {
  thinkingLevel: ThinkingLevel
}

export interface AssignmentPhase {
  id: string
  title: string
  description: string
  info?: string
  defaultModel?: AssignmentModelSelection
}

export interface AssignmentTaskReport {
  status: 'ready_for_audit' | 'blocked' | 'failed'
  summary: string
  evidence: string[]
  commitHash?: string
  reportedAt: number
}

export interface AssignmentTaskReview {
  decision: 'pass' | 'rework' | 'fail'
  checklistResults: Array<{
    item: string
    passed: boolean
    evidence: string
  }>
  notes: string
  reviewedAt: number
}

export interface AssignmentTask {
  id: string
  phaseId: string
  title: string
  description: string
  info?: string
  prompt: string
  owner: AssignmentTaskOwner
  dependsOn: string[]
  expectedFiles: string[]
  auditChecklist: string[]
  model?: AssignmentModelSelection
  /** Durable identity of the implementation pass this task belongs to. */
  workKind?: AssignmentTaskWorkKind
  /** One-based post-audit rework cycle; absent for initial implementation. */
  reworkCycle?: number
  /** Assignment version whose implementation pass produced this task execution. */
  workAssignmentVersion?: number
  status: AssignmentTaskStatus
  statusBeforeStop?: Exclude<AssignmentTaskStatus, 'stopped'>
  workerName?: string
  threadId?: string
  report?: AssignmentTaskReport
  review?: AssignmentTaskReview
  startedAt?: number
  completedAt?: number
}

export interface AssignmentPlanContent {
  title: string
  summary: string
  phases: AssignmentPhase[]
  tasks: AssignmentTask[]
}

export type AssignmentAuditCycleStatus =
  | 'available'
  | 'running'
  | 'failed'
  | 'report_ready'
  | 'planning_rework'
  | 'awaiting_rework_approval'
  | 'reworking'
  | 'completed'
  | 'stopped'

/** Persisted hand-off between Assignment implementation and its independent audit. */
export interface AssignmentAuditCycle {
  status: AssignmentAuditCycleStatus
  /** True when the reviewable rework version repairs an unfinished Assignment's signed scope. */
  scopeRepair?: boolean
  statusBeforeStop?: Exclude<AssignmentAuditCycleStatus, 'stopped'>
  availableAt?: number
  startedAt?: number
  failedAt?: number
  failure?: string
  reportId?: string
  reportVersion?: number
  reportedAt?: number
  reworkStartedAt?: number
  /** One-based count of post-audit correction cycles. */
  reworkCycle?: number
  /** Reviewable Assignment version proposed by the Sr. Engineer for this audit report. */
  reworkAssignmentVersion?: number
  completedAt?: number
}

/** A post-audit workload appended to an approved Assignment. */
export interface AssignmentFollowUpTaskInput {
  id: string
  phaseId: string
  title: string
  description: string
  info?: string
  prompt: string
  owner: AssignmentTaskOwner
  dependsOn: string[]
  expectedFiles: string[]
  auditChecklist: string[]
  model?: AssignmentModelSelection
}

export interface AssignmentProvenance {
  source: 'agent' | 'manual'
  actor: string
  harnessId?: string
  providerId?: string
  modelId?: string
  parentVersion?: number
  createdAt: number
}

export interface AssignmentPlan {
  schemaVersion: 1
  id: string
  projectId: string
  coordinatorThreadId: string
  /** Linked approved specification. Absent when the Assignment was decomposed
   *  directly from the thread conversation because no specification exists. */
  specId?: string
  specVersion?: number
  version: number
  status: AssignmentStatus
  statusBeforeStop?: Exclude<AssignmentStatus, 'stopped'>
  loopModeBeforeStop?: boolean
  scopeBucketId?: string
  /** Durable auditor thread created after this Assignment completes. */
  auditorThreadId?: string
  /** Independent audit and rework lifecycle after implementation completes. */
  auditCycle?: AssignmentAuditCycle
  content: AssignmentPlanContent
  /** Optional for compatibility with assignments persisted before annotations existed. */
  annotations?: AssignmentAnnotation[]
  provenance: AssignmentProvenance
  createdAt: number
  updatedAt: number
  approvedAt?: number
  completedAt?: number
  stoppedAt?: number
}

export type AssignmentValidationCode =
  | 'required'
  | 'duplicate_id'
  | 'missing_reference'
  | 'cycle'
  | 'parallel_file_overlap'
  | 'invalid_path'
  | 'invalid_model'

export interface AssignmentValidationIssue {
  code: AssignmentValidationCode
  path: string
  message: string
}

export interface AssignmentValidationResult {
  valid: boolean
  issues: AssignmentValidationIssue[]
}

export interface AssignmentToolResult {
  assignment: AssignmentPlan
  task?: AssignmentTask
  thread?: Thread
  idempotent: boolean
}
