import type { AuditFindingSeverity, AuditReportContent } from '../types'

const SEVERITIES = new Set<AuditFindingSeverity>(['critical', 'high', 'medium', 'low', 'info'])

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

export function validateAuditReportContent(value: unknown): AuditReportContent {
  const input = record(value, 'Audit report')
  if (!Array.isArray(input.findings)) throw new TypeError('Audit findings must be an array')
  return {
    executiveSummary: text(input.executiveSummary, 'Executive summary'),
    findings: input.findings.map((value, index) => {
      const finding = record(value, `Finding ${index + 1}`)
      const severity = text(finding.severity, `Finding ${index + 1} severity`)
      if (!SEVERITIES.has(severity as AuditFindingSeverity)) {
        throw new TypeError(`Finding ${index + 1} severity is invalid`)
      }
      return {
        id: text(finding.id, `Finding ${index + 1} ID`),
        title: text(finding.title, `Finding ${index + 1} title`),
        severity: severity as AuditFindingSeverity,
        description: text(finding.description, `Finding ${index + 1} description`),
        evidence: markdownText(finding.evidence, `Finding ${index + 1} evidence`)
      }
    }),
    resolutionRecommendation: markdownText(
      input.resolutionRecommendation ?? input.requiredRemediation,
      'Resolution and recommendation'
    ),
    conclusion: text(input.conclusion, 'Conclusion')
  }
}

export function parseAuditReportContent(value: string): AuditReportContent {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(value)?.[1]
  return validateAuditReportContent(JSON.parse(fenced ?? value))
}
