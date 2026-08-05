import type { AuditReport } from '../types'

export function exportAuditReportMarkdown(report: AuditReport): string {
  const findings =
    report.content.findings.length > 0
      ? report.content.findings
          .map(
            (finding) =>
              `### ${finding.title}\n\n` +
              `**Severity:** ${finding.severity}\n\n` +
              `${finding.description}\n\n` +
              `**Evidence:** ${finding.evidence}`
          )
          .join('\n\n')
      : 'No findings.'

  return [
    '# Audit Report',
    '',
    `Audit-Version: ${report.version}`,
    `Specification: ${report.specId} v${report.specVersion}`,
    '',
    '## Executive Summary',
    '',
    report.content.executiveSummary,
    '',
    '## Findings',
    '',
    findings,
    '',
    '## Resolution & Recommendation',
    '',
    report.content.resolutionRecommendation,
    '',
    '## Conclusion',
    '',
    report.content.conclusion,
    ''
  ].join('\n')
}
