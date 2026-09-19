export type BrainstormSectionId =
  | 'context'
  | 'goals'
  | 'decisions'
  | 'open_questions'
  | 'constraints'
  | 'proposed_direction'
  | 'additional_info'

export interface BrainstormSection {
  id: BrainstormSectionId
  title: string
  markdown: string
}

export interface BrainstormContent {
  title: string
  summary: string
  sections: BrainstormSection[]
  /** Present only when prototype work was explicitly requested. */
  prototypes?: BrainstormPrototype[]
}

export type BrainstormPrototypeFidelity = 'lofi' | 'hifi'

export interface BrainstormPrototype {
  id: string
  fidelity: BrainstormPrototypeFidelity
  title: string
  parentPrototypeId?: string
  entryFile: string
  artifactPath: string
  previewPath: string
  contentHash: string
  createdAt: number
}

export type BrainstormReviewField = 'title' | 'summary' | BrainstormSectionId

export interface BrainstormReviewEdit {
  field: BrainstormReviewField
  startOffset: number
  endOffset: number
  before: string
  after: string
  contextBefore: string
  contextAfter: string
  truncated: boolean
}

export interface BrainstormReviewChanges {
  baselineAvailable: boolean
  edits: BrainstormReviewEdit[]
}

export type BrainstormStatus = 'draft' | 'finalized' | 'superseded'

export type BrainstormDecisionAction = 'review' | 'finalize'

export type BrainstormEntryChoice = 'brainstorm' | 'spec'

export type BrainstormWorkflowStage = 'choice_pending' | 'drafting' | 'finalized' | 'skipped'

export interface BrainstormProvenance {
  source: 'agent' | 'manual'
  actor: string
  harnessId?: string
  providerId?: string
  modelId?: string
  parentVersion?: number
  createdAt: number
}

export interface BrainstormAnnotation {
  id: string
  section: BrainstormSectionId
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

export interface BrainstormDecisionComment {
  id: string
  action: BrainstormDecisionAction
  body: string
  createdAt: number
}

export interface BrainstormDocument {
  schemaVersion: 1
  id: string
  projectId: string
  threadId: string
  version: number
  status: BrainstormStatus
  content: BrainstormContent
  /** Agent-generated content retained so manual review edits can be sent as compact diffs. */
  generatedContent?: BrainstormContent
  annotations: BrainstormAnnotation[]
  decisionComments: BrainstormDecisionComment[]
  provenance: BrainstormProvenance
  createdAt: number
  updatedAt: number
  finalizedAt?: number
  finalizedInputHash?: string
}

export interface BrainstormWorkflowState {
  projectId: string
  threadId: string
  entryChoice?: BrainstormEntryChoice
  stage: BrainstormWorkflowStage
  activeBrainstormId?: string
  activeBrainstormVersion?: number
  finalizedBrainstormVersion?: number
  finalizedInputHash?: string
  updatedAt: number
}
