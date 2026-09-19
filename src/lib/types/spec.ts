import type { ThreadSettings } from './agent'
import type { AssignmentPlanContent } from './assignment'

export type EngineeringSpecStatus = 'draft' | 'in_review' | 'approved' | 'superseded'

export type SpecSectionId =
  | 'problem'
  | 'resolution'
  | 'success_criteria'
  | 'test_strategy'
  | 'documentation'
  | 'additional_info'
  | 'commit_pattern'
  | 'constraints_risks'

export type SpecProvenanceSource = 'manual' | 'agent' | 'brainstorm' | 'prd' | 'markdown_import'

export interface SpecProvenance {
  source: SpecProvenanceSource
  actor: string
  harnessId?: string
  providerId?: string
  modelId?: string
  parentVersion?: number
  importedFilename?: string
  brainstormId?: string
  brainstormVersion?: number
  brainstormInputHash?: string
  prdId?: string
  prdVersion?: number
  prdInputHash?: string
  createdAt: number
}

export interface SpecCheckpoint {
  id: string
  description: string
  evidence: string
}

export interface SpecFileOperation {
  path: string
  operation: 'create' | 'edit' | 'delete'
  reason: string
}

export interface SpecPhase {
  id: string
  title: string
  objective: string
  checkpoints: SpecCheckpoint[]
  fileOperations: SpecFileOperation[]
  commit: string
}

export interface EngineeringSpecContent {
  problem: string
  resolutionSummary: string
  phases: SpecPhase[]
  successCriteria: string[]
  testStrategy: string
  documentationRequirements: string[]
  /** Free-form Markdown for recommendations, findings, phases, or other useful context. */
  additionalInfo?: string
  commitPattern: string
  constraints: string[]
  risks: string[]
  /** Optional multi-agent execution graph generated when Assignment mode is enabled. */
  assignment?: AssignmentPlanContent
}

export interface SpecGenerationRequest {
  mode: 'problem' | 'conversation'
  instructions: string
  settings: ThreadSettings
}

export type SpecActionIntent = 'request' | 'review' | 'implement'

export type SpecDecisionAction = Exclude<SpecActionIntent, 'request'>

export interface SpecDecisionComment {
  id: string
  action: SpecDecisionAction
  body: string
  createdAt: number
}

export interface SpecAnnotation {
  id: string
  section: SpecSectionId
  body: string
  quote?: string
  startLine?: number
  endLine?: number
  startOffset?: number
  endOffset?: number
  status: 'open' | 'resolved'
  author: string
  createdAt: number
  resolvedAt?: number
}

export interface AssignmentAnnotation {
  id: string
  /** overview, graph, phase:<phase-id>, or task:<task-id>. */
  section: string
  body: string
  quote?: string
  startLine?: number
  endLine?: number
  startOffset?: number
  endOffset?: number
  status: 'open' | 'resolved'
  author: string
  createdAt: number
  resolvedAt?: number
}

export type SpecContextType = 'project_file' | 'attachment' | 'project_rule' | 'memory'

/** Context types a user can capture from disk; memory is attached separately. */
export type CapturableSpecContextType = Exclude<SpecContextType, 'memory'>

export interface SpecContextReference {
  id: string
  type: SpecContextType
  label: string
  /** Project-relative path for repository files; never an arbitrary absolute path. */
  path?: string
  contentHash?: string
  /** Immutable inline snapshot; currently permitted only for explicit memory context. */
  content?: string
  selectedAt: number
}

export interface EngineeringSpec {
  schemaVersion: 1
  id: string
  projectId: string
  threadId: string
  version: number
  status: EngineeringSpecStatus
  content: EngineeringSpecContent
  annotations: SpecAnnotation[]
  /** User-confirmed validation false positives ignored for this version. */
  dismissedValidationIssues?: SpecValidationDismissal[]
  /** Append-only user comments submitted with Review or Implement for this version. */
  decisionComments: SpecDecisionComment[]
  context: SpecContextReference[]
  provenance: SpecProvenance
  createdAt: number
  updatedAt: number
  approvedAt?: number
}

export type SpecValidationCode = 'required' | 'invalid_path' | 'missing_evidence' | 'duplicate_id'

export interface SpecValidationIssue {
  code: SpecValidationCode
  section: SpecSectionId
  message: string
  path: string
}

export interface SpecValidationDismissal extends SpecValidationIssue {
  dismissedAt: number
}

export interface SpecValidationResult {
  valid: boolean
  issues: SpecValidationIssue[]
}

export type EngineeringWorkflowStage = 'spec_drafting' | 'spec_review' | 'spec_approved'

export interface EngineeringWorkflowState {
  projectId: string
  threadId: string
  stage: EngineeringWorkflowStage
  activeSpecId?: string
  activeSpecVersion?: number
  approvedSpecVersion?: number
  updatedAt: number
}
