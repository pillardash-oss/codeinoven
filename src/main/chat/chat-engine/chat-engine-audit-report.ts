import { join } from 'path'
import type {
  AgentPart,
  AuditReportContent,
  AuditVerificationCheck,
  AuditVerificationCheckKind
} from '../../../lib/types'
import {
  ensureFeatureSlug,
  featureArtifactDirectory,
  requireLocalProject
} from '../../../lib/project-artifacts'
import {
  AuditReportValidationError,
  parseAuditReportContent
} from '../../../lib/audit/audit-validation'
import type { AssignmentAuditRepairManifest, PersistedAuditAttempt } from './chat-engine-types'
import { auditCheckIsExempt } from './chat-engine-pure'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine audit-report: one concern, moved verbatim from the composition root. */
export class ChatEngineAuditReport {
  constructor(private readonly host: ChatEngine) {}

  async persistAssignmentAuditAttempt(input: {
    projectId: string
    threadId: string
    runId: string
    attempt: number
    rawOutput: string
  }): Promise<PersistedAuditAttempt> {
    const featureSlug = await ensureFeatureSlug(this.host.database, input.projectId, input.threadId)
    const relativePath = join(
      'audit',
      'runs',
      input.runId,
      `attempt-${Math.max(1, input.attempt)}.json`
    )
    const artifactPath = join(featureArtifactDirectory(featureSlug), relativePath).replace(
      /\\/gu,
      '/'
    )
    await this.host.storage.writeProjectSpecRaw(
      input.projectId,
      featureSlug,
      relativePath,
      `${input.rawOutput.trimEnd()}\n`,
      requireLocalProject(this.host.database, input.projectId)
    )
    return { relativePath, artifactPath }
  }

  async validatePersistedAssignmentAuditAttempt(
    projectId: string,
    threadId: string,
    relativePath: string
  ): Promise<AuditReportContent> {
    const featureSlug = await ensureFeatureSlug(this.host.database, projectId, threadId)
    const rawOutput = await this.host.storage.readProjectSpecRaw(
      projectId,
      featureSlug,
      relativePath,
      requireLocalProject(this.host.database, projectId)
    )
    if (rawOutput === null) throw new Error('Persisted Assignment audit attempt was not found')
    return parseAuditReportContent(rawOutput, { requireVerification: true })
  }

  async writeAssignmentAuditRepairManifest(manifest: AssignmentAuditRepairManifest): Promise<void> {
    const featureSlug = await ensureFeatureSlug(
      this.host.database,
      manifest.projectId,
      manifest.threadId
    )
    const project = requireLocalProject(this.host.database, manifest.projectId)
    const diagnosticPath = join(
      'audit',
      'runs',
      manifest.runId,
      `attempt-${manifest.attempt}.errors.json`
    )
    await Promise.all([
      this.host.storage.writeProjectSpecRaw(
        manifest.projectId,
        featureSlug,
        diagnosticPath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            attemptPath: manifest.attemptPath,
            errors: manifest.errors,
            status: manifest.status,
            updatedAt: manifest.updatedAt
          },
          null,
          2
        )}\n`,
        project
      ),
      this.host.storage.writeProjectSpecRaw(
        manifest.projectId,
        featureSlug,
        join('audit', 'latest-repair.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        project
      )
    ])
  }

  async persistAssignmentAuditCheckEvidence(input: {
    projectId: string
    threadId: string
    runId: string
    content: AuditReportContent
    checkInvocations: Map<string, Extract<AgentPart, { type: 'tool' }>>
    /** False when persisting a partial (evidence-unvalidated) report: executed
     *  checks without a matched invocation keep their model-written evidence and
     *  no evidencePath instead of aborting. */
    requireInvocations?: boolean
  }): Promise<AuditReportContent> {
    const verification = input.content.verification
    if (!verification) return input.content
    const featureSlug = await ensureFeatureSlug(this.host.database, input.projectId, input.threadId)
    const project = requireLocalProject(this.host.database, input.projectId)
    const versions = new Map<AuditVerificationCheckKind, number>()
    const checks: AuditVerificationCheck[] = []
    for (const check of verification.checks) {
      // A check that did not run (or that the auditor justified in writing)
      // keeps its model-written evidence and never needs an evidence file.
      if (auditCheckIsExempt(check)) {
        checks.push({
          ...check,
          evidence: check.evidence.replace(/\s+/gu, ' ').trim().slice(0, 320)
        })
        continue
      }
      const invocation = input.checkInvocations.get(check.id)
      if (!invocation) {
        if (input.requireInvocations === false) {
          checks.push({
            ...check,
            evidence: check.evidence.replace(/\s+/gu, ' ').trim().slice(0, 320)
          })
          continue
        }
        throw new AuditReportValidationError([
          `verification.checks ${check.id} has no matched invocation to persist`
        ])
      }
      const version = (versions.get(check.kind) ?? 0) + 1
      versions.set(check.kind, version)
      const relativePath = join(
        'audit',
        'runs',
        input.runId,
        'evidence',
        `${check.kind}-${version}.txt`
      )
      const evidencePath = join(featureArtifactDirectory(featureSlug), relativePath).replace(
        /\\/gu,
        '/'
      )
      const output = invocation.state.output?.trimEnd() || '(No textual output was returned.)'
      const error = invocation.state.error?.trimEnd()
      await this.host.storage.writeProjectSpecRaw(
        input.projectId,
        featureSlug,
        relativePath,
        [
          `Check: ${check.id}`,
          `Kind: ${check.kind}`,
          `Status: ${check.status}`,
          `Exit code: ${check.exitCode ?? 'not reported'}`,
          `Files: ${check.files.join(', ')}`,
          '',
          'Command:',
          check.command,
          '',
          'Output:',
          output,
          ...(error ? ['', 'Tool error:', error] : []),
          ''
        ].join('\n'),
        project
      )
      checks.push({
        ...check,
        evidence:
          check.status === 'passed'
            ? `Passed with exit code ${check.exitCode}.`
            : `Failed with exit code ${check.exitCode}; see linked findings.`,
        evidencePath
      })
    }
    return {
      ...input.content,
      verification: {
        ...verification,
        checks
      }
    }
  }
}
