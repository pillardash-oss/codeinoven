import type { AuditReport } from '../types'

interface AuditMarkdownOptions {
  /** Link prefix from the emitted Markdown file to its feature artifact root. */
  evidenceLinkPrefix?: string
}

function evidenceLinkTarget(path: string, prefix: string | undefined): string {
  if (prefix === undefined) return path
  const featureRelativePath = path.replace(/^\.cio\/specs\/[^/]+\//u, '')
  return `${prefix}${featureRelativePath}`
}

export function exportAuditReportMarkdown(
  report: AuditReport,
  options: AuditMarkdownOptions = {}
): string {
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

  const auditedFiles = report.content.auditedFiles?.length
    ? report.content.auditedFiles.map((file) => `- \`${file.path}\` — ${file.reason}`).join('\n')
    : 'Not recorded.'
  const checks = report.content.verification?.checks.length
    ? report.content.verification.checks
        .map((check) => {
          const command = check.command ? `\n  - Command: \`${check.command}\`` : ''
          const exitCode = check.exitCode === undefined ? '' : `\n  - Exit code: ${check.exitCode}`
          const files = check.files.length ? `\n  - Files: ${check.files.join(', ')}` : ''
          const findingIds = check.findingIds.length
            ? `\n  - Findings: ${check.findingIds.join(', ')}`
            : ''
          const evidencePath = check.evidencePath
            ? `\n  - Full output: [\`${check.evidencePath}\`](${evidenceLinkTarget(check.evidencePath, options.evidenceLinkPrefix)})`
            : ''
          return `### ${check.kind}: ${check.status}\n\n${check.evidence}${command}${exitCode}${files}${findingIds}${evidencePath}`
        })
        .join('\n\n')
    : 'Not recorded.'
  const utilities = report.content.verification?.utilities.length
    ? report.content.verification.utilities
        .map((utility) => `- **${utility.name} (${utility.status})** — ${utility.evidence}`)
        .join('\n')
    : 'Not recorded.'
  const limitations = report.content.verification?.limitations.length
    ? report.content.verification.limitations.map((limitation) => `- ${limitation}`).join('\n')
    : 'None recorded.'

  return [
    '# Audit Report',
    '',
    `Audit-Version: ${report.version}`,
    ...(report.specId !== undefined && report.specVersion !== undefined
      ? [`Specification: ${report.specId} v${report.specVersion}`]
      : report.independent === true
        ? ['Audit-Scope: Independent (no specification)']
        : []),
    ...(report.assignmentId && report.assignmentVersion !== undefined
      ? [
          `Assignment: ${report.assignmentId} v${report.assignmentVersion}`,
          `Work-Cycle: ${report.reworkCycle ? `Rework ${report.reworkCycle}` : 'Initial'}`
        ]
      : []),
    '',
    '## Executive Summary',
    '',
    report.content.executiveSummary,
    '',
    '## Findings',
    '',
    findings,
    '',
    '## Audited Files',
    '',
    auditedFiles,
    '',
    '## Verification',
    '',
    ...(report.content.verification
      ? [
          `Repository revision: ${report.content.verification.repositoryRevision}`,
          '',
          report.content.verification.scope,
          ''
        ]
      : []),
    checks,
    '',
    '### Utilities and MCPs',
    '',
    utilities,
    '',
    '### Limitations',
    '',
    limitations,
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
