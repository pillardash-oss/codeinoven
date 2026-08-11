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
        try {
          finding = record(value, `Finding ${index + 1}`)
        } catch (error) {
          issues.push(error instanceof Error ? error.message : `Finding ${index + 1} is invalid`)
          return []
        }
        const severity = collectText(finding.severity, `Finding ${index + 1} severity`, issues)
        if (severity && !SEVERITIES.has(severity as AuditFindingSeverity)) {
          issues.push(`Finding ${index + 1} severity is invalid`)
        }
        return [
          {
            id: collectText(finding.id, `Finding ${index + 1} ID`, issues),
            title: collectText(finding.title, `Finding ${index + 1} title`, issues),
            severity: severity as AuditFindingSeverity,
            description: collectText(
              finding.description,
              `Finding ${index + 1} description`,
              issues
            ),
            evidence: collectMarkdownText(finding.evidence, `Finding ${index + 1} evidence`, issues)
          }
        ]
      })
    : (issues.push('Audit findings must be an array'), [])
  const content: AuditReportContent = {
    executiveSummary: collectText(input.executiveSummary, 'Executive summary', issues),
    findings,
    resolutionRecommendation: collectMarkdownText(
      input.resolutionRecommendation ?? input.requiredRemediation,
      'Resolution and recommendation',
      issues
    ),
    conclusion: collectText(input.conclusion, 'Conclusion', issues)
  }
  if (issues.length > 0) throw new AuditReportValidationError(issues)
  return content
}

export function parseAuditReportContent(value: string): AuditReportContent {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(value)?.[1]
  return validateAuditReportContent(JSON.parse(fenced ?? value))
}
