import type {
  AssignmentModelSelection,
  AssignmentPlan,
  AssignmentPlanContent,
  AssignmentValidationResult,
  AuditReport,
  AuditReportContent,
  AuditSectionId,
  BrainstormContent,
  BrainstormDecisionAction,
  BrainstormDocument,
  BrainstormEntryChoice,
  BrainstormSectionId,
  BrainstormWorkflowState,
  CapturableSpecContextType,
  EngineeringLifecycleDecision,
  EngineeringLifecycleState,
  EngineeringLifecycleTransitionResult,
  EngineeringSpec,
  EngineeringSpecContent,
  PrdContent,
  PrdDocument,
  PrdEntryChoice,
  PrdSectionId,
  PrdWorkflowState,
  PromptAttachment,
  ScopeChoice,
  SpecContextReference,
  SpecDecisionAction,
  SpecSectionId,
  SpecValidationIssue,
  SpecValidationResult,
  Thread
} from '../types'
import type {
  Contract,
  NewAssignmentProvenance,
  NewBrainstormProvenance,
  NewPrdProvenance,
  NewSpecProvenance
} from './contract-helpers'

export const invokeEngineeringContract = {
  'engineeringLifecycle:get': {} as Contract<
    [projectId: string, threadId: string],
    EngineeringLifecycleState | null
  >,
  'engineeringLifecycle:select': {} as Contract<
    [
      projectId: string,
      threadId: string,
      input: import('../types').EngineeringLifecycleSelectionInput
    ],
    EngineeringLifecycleState
  >,
  'engineeringLifecycle:start': {} as Contract<
    [projectId: string, threadId: string, stage?: import('../types').EngineeringLifecycleStage],
    EngineeringLifecycleTransitionResult
  >,
  'engineeringLifecycle:complete': {} as Contract<
    [projectId: string, threadId: string, stage: import('../types').EngineeringLifecycleStage],
    EngineeringLifecycleState
  >,
  'engineeringLifecycle:resume': {} as Contract<
    [
      projectId: string,
      threadId: string,
      resumeToken: string,
      decision: EngineeringLifecycleDecision
    ],
    EngineeringLifecycleTransitionResult
  >,
  'engineeringLifecycle:retry': {} as Contract<
    [projectId: string, threadId: string, resumeToken: string],
    EngineeringLifecycleState
  >,
  'engineeringLifecycle:cancel': {} as Contract<
    [projectId: string, threadId: string, confirmed: true],
    EngineeringLifecycleState
  >,
  'prd:ensureWorkflow': {} as Contract<[projectId: string, threadId: string], PrdWorkflowState>,
  'prd:getWorkflow': {} as Contract<[projectId: string, threadId: string], PrdWorkflowState | null>,
  'prd:chooseEntry': {} as Contract<
    [projectId: string, threadId: string, choice: PrdEntryChoice],
    PrdWorkflowState
  >,
  'prd:beginDrafting': {} as Contract<[projectId: string, threadId: string], PrdWorkflowState>,
  'prd:getActive': {} as Contract<[projectId: string, threadId: string], PrdDocument | null>,
  'prd:listVersions': {} as Contract<
    [projectId: string, threadId: string, prdId: string],
    PrdDocument[]
  >,
  'prd:createDraft': {} as Contract<
    [projectId: string, threadId: string, content: PrdContent, provenance: NewPrdProvenance],
    PrdDocument
  >,
  'prd:saveDraft': {} as Contract<
    [projectId: string, threadId: string, prdId: string, version: number, content: PrdContent],
    PrdDocument
  >,
  'prd:createVersion': {} as Contract<
    [
      projectId: string,
      threadId: string,
      prdId: string,
      content: PrdContent,
      provenance: NewPrdProvenance
    ],
    PrdDocument
  >,
  'prd:addAnnotation': {} as Contract<
    [
      projectId: string,
      threadId: string,
      prdId: string,
      version: number,
      input: {
        section: PrdSectionId
        body: string
        author: string
        quote?: string
        startLine?: number
        endLine?: number
        startOffset?: number
        endOffset?: number
      }
    ],
    PrdDocument
  >,
  'prd:updateAnnotation': {} as Contract<
    [
      projectId: string,
      threadId: string,
      prdId: string,
      version: number,
      annotationId: string,
      body: string
    ],
    PrdDocument
  >,
  'prd:resolveAnnotation': {} as Contract<
    [projectId: string, threadId: string, prdId: string, version: number, annotationId: string],
    PrdDocument
  >,
  'prd:finalize': {} as Contract<
    [projectId: string, threadId: string, prdId: string, version: number],
    PrdDocument
  >,
  'prd:openInEditor': {} as Contract<
    [projectId: string, threadId: string, prdId: string, version: number],
    string
  >,
  'prd:revealInFiles': {} as Contract<
    [projectId: string, threadId: string, prdId: string, version: number],
    string
  >,
  'prototypePreview:getOrigin': {} as Contract<[], string | null>,
  'prototypePreview:readChunk': {} as Contract<
    [projectId: string, threadId: string, previewPath: string, offset: number],
    { base64: string; nextOffset: number; size: number; mime: string }
  >,
  'brainstorm:ensureWorkflow': {} as Contract<
    [projectId: string, threadId: string],
    BrainstormWorkflowState
  >,
  'brainstorm:getWorkflow': {} as Contract<
    [projectId: string, threadId: string],
    BrainstormWorkflowState | null
  >,
  'brainstorm:chooseEntry': {} as Contract<
    [projectId: string, threadId: string, choice: BrainstormEntryChoice],
    BrainstormWorkflowState
  >,
  'brainstorm:resetWorkflow': {} as Contract<[projectId: string, threadId: string], void>,
  'brainstorm:getActive': {} as Contract<
    [projectId: string, threadId: string],
    BrainstormDocument | null
  >,
  'brainstorm:listVersions': {} as Contract<
    [projectId: string, threadId: string, brainstormId: string],
    BrainstormDocument[]
  >,
  'brainstorm:createDraft': {} as Contract<
    [
      projectId: string,
      threadId: string,
      content: BrainstormContent,
      provenance: NewBrainstormProvenance
    ],
    BrainstormDocument
  >,
  'brainstorm:saveDraft': {} as Contract<
    [
      projectId: string,
      threadId: string,
      brainstormId: string,
      version: number,
      content: BrainstormContent
    ],
    BrainstormDocument
  >,
  'brainstorm:createVersion': {} as Contract<
    [
      projectId: string,
      threadId: string,
      brainstormId: string,
      content: BrainstormContent,
      provenance: NewBrainstormProvenance
    ],
    BrainstormDocument
  >,
  'brainstorm:addAnnotation': {} as Contract<
    [
      projectId: string,
      threadId: string,
      brainstormId: string,
      version: number,
      input: {
        section: BrainstormSectionId
        body: string
        author: string
        quote?: string
        startLine?: number
        endLine?: number
        startOffset?: number
        endOffset?: number
      }
    ],
    BrainstormDocument
  >,
  'brainstorm:updateAnnotation': {} as Contract<
    [
      projectId: string,
      threadId: string,
      brainstormId: string,
      version: number,
      annotationId: string,
      body: string
    ],
    BrainstormDocument
  >,
  'brainstorm:resolveAnnotation': {} as Contract<
    [
      projectId: string,
      threadId: string,
      brainstormId: string,
      version: number,
      annotationId: string
    ],
    BrainstormDocument
  >,
  'brainstorm:addDecisionComment': {} as Contract<
    [
      projectId: string,
      threadId: string,
      brainstormId: string,
      version: number,
      action: BrainstormDecisionAction,
      body: string
    ],
    BrainstormDocument
  >,
  'brainstorm:finalize': {} as Contract<
    [projectId: string, threadId: string, brainstormId: string, version: number, note?: string],
    BrainstormDocument
  >,
  'assignment:getActive': {} as Contract<
    [projectId: string, coordinatorThreadId: string],
    AssignmentPlan | null
  >,
  'assignment:listVersions': {} as Contract<
    [projectId: string, coordinatorThreadId: string, assignmentId: string],
    AssignmentPlan[]
  >,
  'assignment:saveDraft': {} as Contract<
    [
      projectId: string,
      coordinatorThreadId: string,
      content: AssignmentPlanContent,
      provenance: NewAssignmentProvenance
    ],
    AssignmentPlan
  >,
  'assignment:addAnnotation': {} as Contract<
    [
      projectId: string,
      coordinatorThreadId: string,
      assignmentId: string,
      version: number,
      input: {
        section: string
        body: string
        author: string
        quote?: string
        startLine?: number
        endLine?: number
        startOffset?: number
        endOffset?: number
      }
    ],
    AssignmentPlan
  >,
  'assignment:updateAnnotation': {} as Contract<
    [
      projectId: string,
      coordinatorThreadId: string,
      assignmentId: string,
      version: number,
      annotationId: string,
      body: string
    ],
    AssignmentPlan
  >,
  'assignment:resolveAnnotation': {} as Contract<
    [
      projectId: string,
      coordinatorThreadId: string,
      assignmentId: string,
      version: number,
      annotationId: string
    ],
    AssignmentPlan
  >,
  'assignment:updateUnlinkedWorkerModel': {} as Contract<
    [
      projectId: string,
      coordinatorThreadId: string,
      taskId: string,
      model: AssignmentModelSelection
    ],
    AssignmentPlan
  >,
  'assignment:updateUnlinkedWorkerScope': {} as Contract<
    [projectId: string, coordinatorThreadId: string, taskId: string, scope: ScopeChoice],
    AssignmentPlan
  >,
  'assignment:validate': {} as Contract<
    [content: AssignmentPlanContent],
    AssignmentValidationResult
  >,
  'assignment:openInEditor': {} as Contract<
    [projectId: string, coordinatorThreadId: string, content: AssignmentPlanContent],
    string
  >,
  'assignment:revealInFiles': {} as Contract<
    [projectId: string, coordinatorThreadId: string, content: AssignmentPlanContent],
    string
  >,
  'spec:addAnnotation': {} as Contract<
    [
      projectId: string,
      threadId: string,
      specId: string,
      version: number,
      input: {
        section: SpecSectionId
        body: string
        author: string
        quote?: string
        startLine?: number
        endLine?: number
        startOffset?: number
        endOffset?: number
      }
    ],
    EngineeringSpec
  >,
  'spec:addDecisionComment': {} as Contract<
    [
      projectId: string,
      threadId: string,
      specId: string,
      version: number,
      action: SpecDecisionAction,
      body: string
    ],
    EngineeringSpec
  >,
  'spec:approve': {} as Contract<
    [projectId: string, threadId: string, specId: string, version: number],
    EngineeringSpec
  >,
  'spec:captureContext': {} as Contract<
    [
      projectId: string,
      threadId: string,
      specId: string,
      version: number,
      type: CapturableSpecContextType,
      selectedPath?: string
    ],
    EngineeringSpec | null
  >,
  'spec:createDraft': {} as Contract<
    [
      projectId: string,
      threadId: string,
      content: EngineeringSpecContent,
      provenance: NewSpecProvenance
    ],
    EngineeringSpec
  >,
  'spec:createVersion': {} as Contract<
    [
      projectId: string,
      threadId: string,
      specId: string,
      content: EngineeringSpecContent,
      provenance: NewSpecProvenance
    ],
    EngineeringSpec
  >,
  'spec:dismissValidationIssue': {} as Contract<
    [
      projectId: string,
      threadId: string,
      specId: string,
      version: number,
      issue: SpecValidationIssue
    ],
    EngineeringSpec
  >,
  'spec:exportMarkdown': {} as Contract<[spec: EngineeringSpec], string | null>,
  'spec:getActive': {} as Contract<[projectId: string, threadId: string], EngineeringSpec | null>,
  'spec:getContextAttachments': {} as Contract<
    [projectId: string, threadId: string, specId: string, version: number],
    PromptAttachment[]
  >,
  'spec:importMarkdown': {} as Contract<
    [projectId: string, threadId: string, specId?: string],
    EngineeringSpec | null
  >,
  'spec:listVersions': {} as Contract<
    [projectId: string, threadId: string, specId: string],
    EngineeringSpec[]
  >,
  'spec:openInEditor': {} as Contract<[spec: EngineeringSpec], string>,
  'spec:revealInFiles': {} as Contract<[spec: EngineeringSpec], string>,
  'spec:resolveAnnotation': {} as Contract<
    [projectId: string, threadId: string, specId: string, version: number, annotationId: string],
    EngineeringSpec
  >,
  'spec:updateAnnotation': {} as Contract<
    [
      projectId: string,
      threadId: string,
      specId: string,
      version: number,
      annotationId: string,
      body: string
    ],
    EngineeringSpec
  >,
  'spec:saveDraft': {} as Contract<
    [
      projectId: string,
      threadId: string,
      specId: string,
      version: number,
      content: EngineeringSpecContent
    ],
    EngineeringSpec
  >,
  'spec:setContext': {} as Contract<
    [
      projectId: string,
      threadId: string,
      specId: string,
      version: number,
      context: SpecContextReference[]
    ],
    EngineeringSpec
  >,
  'spec:setReview': {} as Contract<
    [projectId: string, threadId: string, specId: string, version: number],
    EngineeringSpec
  >,
  'spec:validate': {} as Contract<[spec: EngineeringSpec], SpecValidationResult>,
  'audit:getActive': {} as Contract<[projectId: string, threadId: string], AuditReport | null>,
  'audit:listVersions': {} as Contract<
    [projectId: string, threadId: string, reportId: string],
    AuditReport[]
  >,
  'audit:save': {} as Contract<[report: AuditReport, content: AuditReportContent], AuditReport>,
  'audit:addAnnotation': {} as Contract<
    [
      projectId: string,
      threadId: string,
      reportId: string,
      version: number,
      input: {
        section: AuditSectionId
        body: string
        author: string
        quote?: string
        startLine?: number
        endLine?: number
        startOffset?: number
        endOffset?: number
      }
    ],
    AuditReport
  >,
  'audit:updateAnnotation': {} as Contract<
    [
      projectId: string,
      threadId: string,
      reportId: string,
      version: number,
      annotationId: string,
      body: string
    ],
    AuditReport
  >,
  'audit:resolveAnnotation': {} as Contract<
    [projectId: string, threadId: string, reportId: string, version: number, annotationId: string],
    AuditReport
  >,
  'audit:complete': {} as Contract<[projectId: string, threadId: string], Thread>,
  'audit:dismiss': {} as Contract<[projectId: string, threadId: string], Thread>,
  'audit:restoreOffer': {} as Contract<[projectId: string, threadId: string], AssignmentPlan>,
  'audit:beginRework': {} as Contract<[projectId: string, threadId: string], Thread>,
  'audit:returnToOffer': {} as Contract<[projectId: string, threadId: string], AssignmentPlan>,
  'audit:openInEditor': {} as Contract<
    [projectId: string, threadId: string, reportId: string, version: number],
    string
  >,
  'audit:revealInFiles': {} as Contract<
    [projectId: string, threadId: string, reportId: string, version: number],
    string
  >,
  'brainstorm:openInEditor': {} as Contract<
    [projectId: string, threadId: string, brainstormId: string, version: number],
    string
  >,
  'brainstorm:revealInFiles': {} as Contract<
    [projectId: string, threadId: string, brainstormId: string, version: number],
    string
  >
}
