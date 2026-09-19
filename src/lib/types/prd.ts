export const PRD_SECTION_IDS = [
  'problem',
  'goals',
  'non_goals',
  'users_and_use_cases',
  'product_requirements',
  'experience_flow',
  'acceptance_criteria',
  'dependencies',
  'risks',
  'open_questions'
] as const

export type PrdSectionId = (typeof PRD_SECTION_IDS)[number]

export interface PrdSection {
  id: PrdSectionId
  title: string
  markdown: string
}

export interface PrdContent {
  title: string
  summary: string
  sections: PrdSection[]
}

export type PrdStatus = 'draft' | 'finalized' | 'superseded'

export type PrdEntryChoice = 'brainstorm_first' | 'start_prd'

export type PrdWorkflowStage = 'choice_pending' | 'brainstorming' | 'drafting' | 'finalized'

export interface PrdProvenance {
  source: 'agent' | 'manual'
  actor: string
  harnessId?: string
  providerId?: string
  modelId?: string
  brainstormId?: string
  brainstormVersion?: number
  brainstormInputHash?: string
  parentVersion?: number
  createdAt: number
}

export interface PrdAnnotation {
  id: string
  section: PrdSectionId
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

export interface PrdDocument {
  schemaVersion: 1
  id: string
  projectId: string
  threadId: string
  version: number
  status: PrdStatus
  content: PrdContent
  generatedContent?: PrdContent
  annotations: PrdAnnotation[]
  provenance: PrdProvenance
  createdAt: number
  updatedAt: number
  finalizedAt?: number
  finalizedInputHash?: string
}

export interface PrdWorkflowState {
  projectId: string
  threadId: string
  entryChoice?: PrdEntryChoice
  stage: PrdWorkflowStage
  activePrdId?: string
  activePrdVersion?: number
  finalizedPrdVersion?: number
  finalizedInputHash?: string
  updatedAt: number
}
