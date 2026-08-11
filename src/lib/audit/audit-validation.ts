import type {
  AuditedFileEvidence,
  AuditFindingSeverity,
  AuditReportContent,
  AuditVerificationCheck,
  AuditVerificationCheckKind,
  AuditVerificationEvidence,
  AuditVerificationUtility
} from '../types'

const SEVERITIES = new Set<AuditFindingSeverity>(['critical', 'high', 'medium', 'low', 'info'])
const CHECK_KINDS = new Set<AuditVerificationCheckKind>([
  'format',
  'lint',
  'typecheck',
  'test',
  'build',
  'other'
])
const REQUIRED_CHECK_KINDS = ['format', 'lint', 'typecheck', 'test'] as const
const CHECK_STATUSES = new Set(['passed', 'failed', 'not_applicable'])
const UTILITY_STATUSES = new Set(['used', 'unavailable', 'not_applicable'])

export interface AuditReportValidationOptions {
  requireVerification?: boolean
}

export class AuditReportValidationError extends TypeError {
  constructor(readonly issues: string[]) {
    super(`Audit report validation failed:\n${issues.map((issue) => `- ${issue}`).join('\n')}`)
    this.name = 'AuditReportValidationError'
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`)
  return value.trim()
}

function markdownText(value: unknown, label: string): string {
  if (typeof value === 'string') return text(value, label)
  if (Array.isArray(value)) {
    const entries = value.map((entry, index) => text(entry, `${label} item ${index + 1}`))
    if (entries.length > 0) return entries.map((entry) => `- ${entry}`).join('\n')
  }
  throw new TypeError(`${label} is required`)
}

function collectText(value: unknown, label: string, issues: string[]): string {
  try {
    return text(value, label)
  } catch (error) {
    issues.push(error instanceof Error ? error.message : `${label} is invalid`)
    return ''
  }
}

function collectMarkdownText(value: unknown, label: string, issues: string[]): string {
  try {
    return markdownText(value, label)
  } catch (error) {
    issues.push(error instanceof Error ? error.message : `${label} is invalid`)
    return ''
  }
}

function collectStringArray(value: unknown, label: string, issues: string[]): string[] {
  if (!Array.isArray(value)) {
    issues.push(`${label} must be an array`)
    return []
  }
  return value.flatMap((entry, index) => {
    try {
      return [text(entry, `${label}[${index}]`)]
    } catch (error) {
      issues.push(error instanceof Error ? error.message : `${label}[${index}] is invalid`)
      return []
    }
  })
}

function collectAuditedFiles(value: unknown, issues: string[]): AuditedFileEvidence[] {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push('auditedFiles must be a non-empty array')
    return []
  }
  const paths = new Set<string>()
  return value.flatMap((entry, index) => {
    const label = `auditedFiles[${index}]`
    let input: Record<string, unknown>
    try {
      input = record(entry, label)
    } catch (error) {
      issues.push(error instanceof Error ? error.message : `${label} is invalid`)
      return []
    }
    const path = collectText(input.path, `${label}.path`, issues)
    if (path && paths.has(path)) issues.push(`${label}.path duplicates ${path}`)
    paths.add(path)
    return [{ path, reason: collectText(input.reason, `${label}.reason`, issues) }]
  })
}

function collectVerificationCheck(
  value: unknown,
  index: number,
  issues: string[]
): AuditVerificationCheck | null {
  const label = `verification.checks[${index}]`
  let input: Record<string, unknown>
  try {
    input = record(value, label)
  } catch (error) {
    issues.push(error instanceof Error ? error.message : `${label} is invalid`)
    return null
  }
  const kind = collectText(input.kind, `${label}.kind`, issues) as AuditVerificationCheckKind
  if (kind && !CHECK_KINDS.has(kind)) issues.push(`${label}.kind is invalid`)
  const status = collectText(
    input.status,
    `${label}.status`,
    issues
  ) as AuditVerificationCheck['status']
  if (status && !CHECK_STATUSES.has(status)) issues.push(`${label}.status is invalid`)
  const command = typeof input.command === 'string' ? input.command.trim() : ''
  const files = collectStringArray(input.files, `${label}.files`, issues)
  const findingIds = collectStringArray(input.findingIds, `${label}.findingIds`, issues)
  const exitCode = typeof input.exitCode === 'number' ? input.exitCode : undefined
  if (status === 'passed' || status === 'failed') {
    if (!command) issues.push(`${label}.command is required when the check ran`)
    if (files.length === 0) issues.push(`${label}.files must identify the scoped check targets`)
    if (!Number.isInteger(exitCode)) issues.push(`${label}.exitCode is required when the check ran`)
    if (status === 'passed' && exitCode !== 0)
      issues.push(`${label}.exitCode must be 0 when passed`)
    if (status === 'failed' && exitCode === 0)
      issues.push(`${label}.exitCode must be non-zero when failed`)
    if (status === 'failed' && findingIds.length === 0) {
      issues.push(`${label}.findingIds must link a failed check to an audit finding`)
    }
  } else if (status === 'not_applicable' && exitCode !== undefined) {
    issues.push(`${label}.exitCode must be omitted when the check did not run`)
  }
  return {
    id: collectText(input.id, `${label}.id`, issues),
    kind,
    command,
    files,
    status,
    ...(exitCode === undefined ? {} : { exitCode }),
    evidence: collectMarkdownText(input.evidence, `${label}.evidence`, issues),
    findingIds
  }
}

function collectVerificationUtility(
  value: unknown,
  index: number,
  issues: string[]
): AuditVerificationUtility | null {
  const label = `verification.utilities[${index}]`
  let input: Record<string, unknown>
  try {
    input = record(value, label)
  } catch (error) {
    issues.push(error instanceof Error ? error.message : `${label} is invalid`)
    return null
  }
  const status = collectText(
    input.status,
    `${label}.status`,
    issues
  ) as AuditVerificationUtility['status']
  if (status && !UTILITY_STATUSES.has(status)) issues.push(`${label}.status is invalid`)
  return {
    name: collectText(input.name, `${label}.name`, issues),
    status,
    evidence: collectMarkdownText(input.evidence, `${label}.evidence`, issues)
  }
}

function collectVerification(
  value: unknown,
  auditedFiles: AuditedFileEvidence[],
  findingIds: Set<string>,
  issues: string[]
): AuditVerificationEvidence | undefined {
  if (value === undefined) return undefined
  let input: Record<string, unknown>
  try {
    input = record(value, 'verification')
  } catch (error) {
    issues.push(error instanceof Error ? error.message : 'verification is invalid')
    return undefined
  }
  const checks = Array.isArray(input.checks)
    ? input.checks.flatMap((entry, index) => {
        const check = collectVerificationCheck(entry, index, issues)
        return check ? [check] : []
      })
    : (issues.push('verification.checks must be an array'), [])
  const utilities = Array.isArray(input.utilities)
    ? input.utilities.flatMap((entry, index) => {
        const utility = collectVerificationUtility(entry, index, issues)
        return utility ? [utility] : []
      })
    : (issues.push('verification.utilities must be an array'), [])
  const checkIds = new Set<string>()
  for (const check of checks) {
    if (checkIds.has(check.id)) issues.push(`verification.checks duplicates id ${check.id}`)
    checkIds.add(check.id)
  }
  const utilityNames = new Set<string>()
  for (const utility of utilities) {
    if (utilityNames.has(utility.name)) {
      issues.push(`verification.utilities duplicates name ${utility.name}`)
    }
    utilityNames.add(utility.name)
  }
  for (const kind of REQUIRED_CHECK_KINDS) {
    if (!checks.some((check) => check.kind === kind)) {
      issues.push(`verification.checks must include a ${kind} result`)
    }
  }
  for (const check of checks) {
    for (const findingId of check.findingIds) {
      if (!findingIds.has(findingId)) {
        issues.push(`verification check ${check.id} references unknown finding ${findingId}`)
      }
    }
  }
  for (const auditedFile of auditedFiles) {
    for (const kind of ['format', 'lint'] as const) {
      if (!checks.some((check) => check.kind === kind && check.files.includes(auditedFile.path))) {
        issues.push(`${auditedFile.path} is missing from ${kind} verification scope`)
      }
    }
  }
  if (utilities.length === 0) {
    issues.push('verification.utilities must record utility/MCP discovery or its unavailability')
  }
  const limitations = collectStringArray(input.limitations, 'verification.limitations', issues)
  if (new Set(limitations).size !== limitations.length) {
    issues.push('verification.limitations must not contain duplicates')
  }
  return {
    repositoryRevision: collectText(
      input.repositoryRevision,
      'verification.repositoryRevision',
      issues
    ),
    scope: collectMarkdownText(input.scope, 'verification.scope', issues),
    checks,
    utilities,
    limitations
  }
}

export function validateAuditReportContent(
  value: unknown,
  options: AuditReportValidationOptions = {}
): AuditReportContent {
  const input = record(value, 'Audit report')
  const issues: string[] = []
  const findings = Array.isArray(input.findings)
    ? input.findings.flatMap((value, index) => {
        let finding: Record<string, unknown>
        const path = `findings[${index}]`
        try {
          finding = record(value, path)
        } catch (error) {
          issues.push(error instanceof Error ? error.message : `${path} is invalid`)
          return []
        }
        const severity = collectText(finding.severity, `${path}.severity`, issues)
        if (severity && !SEVERITIES.has(severity as AuditFindingSeverity)) {
          issues.push(`${path}.severity is invalid`)
        }
        return [
          {
            id: collectText(finding.id, `${path}.id`, issues),
            title: collectText(finding.title, `${path}.title`, issues),
            severity: severity as AuditFindingSeverity,
            description: collectText(finding.description, `${path}.description`, issues),
            evidence: collectMarkdownText(finding.evidence, `${path}.evidence`, issues)
          }
        ]
      })
    : (issues.push('findings must be an array'), [])
  const content: AuditReportContent = {
    executiveSummary: collectText(input.executiveSummary, 'executiveSummary', issues),
    findings,
    resolutionRecommendation: collectMarkdownText(
      input.resolutionRecommendation ?? input.requiredRemediation,
      'resolutionRecommendation',
      issues
    ),
    conclusion: collectText(input.conclusion, 'conclusion', issues)
  }
  const auditedFiles =
    input.auditedFiles === undefined ? undefined : collectAuditedFiles(input.auditedFiles, issues)
  const verification = collectVerification(
    input.verification,
    auditedFiles ?? [],
    new Set(content.findings.map((finding) => finding.id)),
    issues
  )
  if (options.requireVerification) {
    if (!auditedFiles || auditedFiles.length === 0) {
      issues.push('auditedFiles is required for an Assignment audit')
    }
    if (!verification) issues.push('verification is required for an Assignment audit')
  }
  if (auditedFiles) content.auditedFiles = auditedFiles
  if (verification) content.verification = verification
  if (issues.length > 0) throw new AuditReportValidationError(issues)
  return content
}

export function parseAuditReportContent(
  value: string,
  options: AuditReportValidationOptions = {}
): AuditReportContent {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(value)?.[1]
  return validateAuditReportContent(JSON.parse(fenced ?? value), options)
}
