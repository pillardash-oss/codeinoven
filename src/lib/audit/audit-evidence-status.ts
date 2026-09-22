import type { AuditReport } from '../types'

/** Facts that failed evidence validation, attributed to the report surface
 *  that states them.
 *
 *  The platform only validates verification claims (executed commands and
 *  utility invocations) against the auditor transcript, so an unvalidated fact
 *  always lands in the Verification evidence block. When that fact is the
 *  backing check of a finding, the finding's statement is unvalidated too,
 *  which is why findings are attributed here as well. */
export interface AuditEvidenceAttribution {
  /** Unvalidated messages keyed by verification check id (`format-current-files`). */
  checkIssues: ReadonlyMap<string, readonly string[]>
  /** Unvalidated messages keyed by verification utility name. */
  utilityIssues: ReadonlyMap<string, readonly string[]>
  /** Unvalidated messages that name no single check or utility. */
  generalIssues: readonly string[]
  /** Findings whose backing verification check failed evidence validation. */
  findingIds: ReadonlySet<string>
  /** The Verification evidence block states unvalidated facts. */
  verification: boolean
  /** The Findings section states unvalidated facts. */
  findings: boolean
}

const CHECK_ISSUE_PREFIX = 'verification.checks '
const UTILITY_ISSUE_PREFIX = 'verification.utilities '
/** `verification.utilities has no … call …` names no single utility. */
const UNADDRESSED_SUBJECT = 'has'
const ISSUE_ADDRESS = /^verification\.(?:checks|utilities)\s+(\S+)\s+/u

/** The subject a verification issue is addressed to, or null when the issue
 *  speaks about the whole block instead of one check or utility. */
function issueSubject(issue: string, prefix: string): string | null {
  if (!issue.startsWith(prefix)) return null
  const [subject] = issue.slice(prefix.length).split(' ')
  return subject && subject !== UNADDRESSED_SUBJECT ? subject : null
}

/** An evidence issue without its `verification.checks <id>` address, for
 *  surfaces that already show which check or utility the fact belongs to. */
export function auditEvidenceIssueDetail(issue: string): string {
  const match = ISSUE_ADDRESS.exec(issue)
  if (!match || match[1] === UNADDRESSED_SUBJECT) return issue.trim()
  return issue.slice(match[0].length).trim()
}

function append(target: Map<string, string[]>, subject: string, issue: string): void {
  const existing = target.get(subject)
  if (existing) existing.push(issue)
  else target.set(subject, [issue])
}

export function auditEvidenceAttribution(report: AuditReport): AuditEvidenceAttribution {
  const checkIssues = new Map<string, string[]>()
  const utilityIssues = new Map<string, string[]>()
  const generalIssues: string[] = []
  for (const issue of report.evidenceIssues ?? []) {
    const checkId = issueSubject(issue, CHECK_ISSUE_PREFIX)
    if (checkId) {
      append(checkIssues, checkId, issue)
      continue
    }
    const utilityName = issueSubject(issue, UTILITY_ISSUE_PREFIX)
    if (utilityName) {
      append(utilityIssues, utilityName, issue)
      continue
    }
    generalIssues.push(issue)
  }
  const checks = report.content.verification?.checks ?? []
  const findingIds = new Set<string>()
  for (const checkId of checkIssues.keys()) {
    const check = checks.find((candidate) => candidate.id === checkId)
    for (const findingId of check?.findingIds ?? []) findingIds.add(findingId)
  }
  return {
    checkIssues,
    utilityIssues,
    generalIssues,
    findingIds,
    verification: checkIssues.size > 0 || utilityIssues.size > 0 || generalIssues.length > 0,
    findings: findingIds.size > 0
  }
}
