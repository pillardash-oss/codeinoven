import type { ThreadSettings } from './agent'
import type { SpecProvenance } from './spec'

export type AuditSectionId =
  'executive_summary' | 'findings' | 'resolution_recommendation' | 'conclusion'

export type AuditFindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export interface AuditFinding {
  id: string
  title: string
  severity: AuditFindingSeverity
  description: string
  evidence: string
}

export type AuditVerificationCheckKind =
  'format' | 'lint' | 'typecheck' | 'test' | 'build' | 'other'

export type AuditVerificationStatus = 'passed' | 'failed' | 'not_applicable'

export interface AuditVerificationCheck {
  id: string
  kind: AuditVerificationCheckKind
  command: string
  files: string[]
  status: AuditVerificationStatus
  exitCode?: number
  evidence: string
  /** Project-relative, platform-written full command output for this check. */
  evidencePath?: string
  /** Auditor-written reason a check was not executed (status `not_applicable`)
   *  or why the exact reported command does not exist in this repository. A
   *  substantive justification exempts the check from transcript matching: the
   *  report records the declared reason instead of failing validation. */
  justification?: string
  findingIds: string[]
}

export interface AuditVerificationUtility {
  name: string
  status: 'used' | 'unavailable' | 'not_applicable'
  evidence: string
}

export interface AuditVerificationEvidence {
  repositoryRevision: string
  scope: string
  checks: AuditVerificationCheck[]
  utilities: AuditVerificationUtility[]
  limitations: string[]
}

export interface AuditedFileEvidence {
  path: string
  reason: string
}

export interface AuditReportContent {
  executiveSummary: string
  findings: AuditFinding[]
  resolutionRecommendation: string
  conclusion: string
  /** Required for Assignment audits; omitted when file evidence is unavailable. */
  auditedFiles?: AuditedFileEvidence[]
  /** Required for Assignment audits; omitted when verification evidence is unavailable. */
  verification?: AuditVerificationEvidence
}

export interface AuditAnnotation {
  id: string
  section: AuditSectionId
  body: string
  quote?: string
  startLine?: number
  endLine?: number
  /** Character offsets within the rendered audit section for deterministic anchor restoration. */
  startOffset?: number
  endOffset?: number
  status: 'open' | 'resolved'
  author: string
  createdAt: number
  resolvedAt?: number
}

export interface AuditReport {
  schemaVersion: 1
  id: string
  projectId: string
  threadId: string
  /** Audited specification; absent on independent (spec-less) audits. */
  specId?: string
  specVersion?: number
  /** True when this report was produced by an independent spec-less audit. */
  independent?: boolean
  /** Exact Assignment implementation graph audited, when this is an Assignment audit. */
  assignmentId?: string
  assignmentVersion?: number
  reworkCycle?: number
  version: number
  /** Auditor verdict stamped at generation time; absent on legacy reports. */
  outcome?: 'rework_required' | 'passed'
  /** Whether the platform could match every executed verification claim to tool
   *  evidence in the auditor transcript. `partial` means the report is usable
   *  but some claims could not be validated; absent on legacy/fully-validated
   *  reports. */
  evidenceValidation?: 'verified' | 'partial'
  /** The unmatched verification claims, when `evidenceValidation` is `partial`. */
  evidenceIssues?: string[]
  content: AuditReportContent
  annotations: AuditAnnotation[]
  provenance: SpecProvenance
  createdAt: number
  updatedAt: number
}

export interface AuditGenerationRequest {
  settings: ThreadSettings
}
