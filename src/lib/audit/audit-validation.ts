import type { AuditFindingSeverity, AuditReportContent } from '../types'

const SEVERITIES = new Set<AuditFindingSeverity>(['critical', 'high', 'medium', 'low', 'info'])

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

export function validateAuditReportContent(value: unknown): AuditReportContent {
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
  if (issues.length > 0) throw new AuditReportValidationError(issues)
  return content
}

export function parseAuditReportContent(value: string): AuditReportContent {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(value)?.[1]
  return validateAuditReportContent(JSON.parse(fenced ?? value))
}
