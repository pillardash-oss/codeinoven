import { join } from 'path'
import type { Database } from '../../main/database/database'
import type { StorageEngine } from '../../main/storage/storage-engine'
import type {
  AuditAnnotation,
  AuditReport,
  AuditReportContent,
  AuditSectionId,
  Project,
  SpecProvenance
} from '../types'
import { exportAuditReportMarkdown } from '../audit/audit-markdown'
import { ensureFeatureSlug, requireLocalProject } from '../project-artifacts'
import { generateId } from '../utils'

export interface CreateAuditReportInput {
  projectId: string
  threadId: string
  specId: string
  specVersion: number
  assignmentId?: string
  assignmentVersion?: number
  reworkCycle?: number
  outcome?: AuditReport['outcome']
  content: AuditReportContent
  provenance: Omit<SpecProvenance, 'createdAt' | 'parentVersion'>
}

export interface AddAuditAnnotationInput {
  section: AuditSectionId
  body: string
  author: string
  quote?: string
  startLine?: number
  endLine?: number
  startOffset?: number
  endOffset?: number
}

export class AuditEngine {
  constructor(
    private readonly storage: StorageEngine,
    private readonly db: Database,
    private readonly now: () => number = Date.now,
    private readonly idFactory: () => string = generateId
  ) {}

  async create(input: CreateAuditReportInput): Promise<AuditReport> {
    const previous = this.getActive(input.projectId, input.threadId)
    const now = this.now()
    const report: AuditReport = {
      schemaVersion: 1,
      id: previous?.id ?? this.idFactory(),
      projectId: input.projectId,
      threadId: input.threadId,
      specId: input.specId,
      specVersion: input.specVersion,
      assignmentId: input.assignmentId,
      assignmentVersion: input.assignmentVersion,
      reworkCycle: input.reworkCycle,
      version: (previous?.version ?? 0) + 1,
      outcome: input.outcome,
      content: structuredClone(input.content),
      annotations: [],
      provenance: {
        ...input.provenance,
        ...(previous ? { parentVersion: previous.version } : {}),
        createdAt: now
      },
      createdAt: now,
      updatedAt: now
    }
    await this.write(report)
    return report
  }

  getActive(projectId: string, threadId: string): AuditReport | null {
    const row = this.db.get<{ data: string }>(
      'SELECT data FROM audit_reports WHERE project_id=? AND thread_id=? ORDER BY version DESC LIMIT 1',
      projectId,
      threadId
    )
    return row ? (JSON.parse(row.data) as AuditReport) : null
  }

  /** Fetch one persisted audit report version, or null when it does not exist. */
  getVersion(
    projectId: string,
    threadId: string,
    reportId: string,
    version: number
  ): AuditReport | null {
    const row = this.db.get<{ data: string }>(
      'SELECT data FROM audit_reports WHERE report_id=? AND version=? AND project_id=? AND thread_id=?',
      reportId,
      version,
      projectId,
      threadId
    )
    return row ? (JSON.parse(row.data) as AuditReport) : null
  }

  /** Resolve the materialized markdown artifact for an audit report version. */
  async markdownPath(
    projectId: string,
    threadId: string,
    reportId: string,
    version: number
  ): Promise<string> {
    const featureSlug = await ensureFeatureSlug(this.db, projectId, threadId)
    return this.storage.resolveProjectSpecArtifact(
      projectId,
      featureSlug,
      join('versions', `${reportId}-audit-v${version}.md`),
      requireLocalProject(this.db, projectId)
    )
  }

  listVersions(projectId: string, threadId: string, reportId: string): AuditReport[] {
    const rows = this.db.all<{ data: string }>(
      'SELECT data FROM audit_reports WHERE report_id=? ORDER BY version',
      reportId
    )
    return rows.map((r) => JSON.parse(r.data) as AuditReport)
  }

  async save(report: AuditReport): Promise<AuditReport> {
    const updated = { ...report, updatedAt: this.now() }
    await this.write(updated)
    return updated
  }

  async addAnnotation(
    projectId: string,
    threadId: string,
    reportId: string,
    version: number,
    input: AddAuditAnnotationInput
  ): Promise<AuditReport> {
    const report = this.requireVersion(projectId, threadId, reportId, version)
    const annotation: AuditAnnotation = {
      id: this.idFactory(),
      ...input,
      status: 'open',
      createdAt: this.now()
    }
    return this.save({ ...report, annotations: [...report.annotations, annotation] })
  }

  async updateAnnotation(
    projectId: string,
    threadId: string,
    reportId: string,
    version: number,
    annotationId: string,
    body: string
  ): Promise<AuditReport> {
    const report = this.requireVersion(projectId, threadId, reportId, version)
    return this.save({
      ...report,
      annotations: report.annotations.map((annotation) =>
        annotation.id === annotationId ? { ...annotation, body } : annotation
      )
    })
  }

  async resolveAnnotation(
    projectId: string,
    threadId: string,
    reportId: string,
    version: number,
    annotationId: string
  ): Promise<AuditReport> {
    const report = this.requireVersion(projectId, threadId, reportId, version)
    const now = this.now()
    return this.save({
      ...report,
      annotations: report.annotations.map((annotation) =>
        annotation.id === annotationId
          ? { ...annotation, status: 'resolved' as const, resolvedAt: now }
          : annotation
      )
    })
  }

  private requireVersion(
    projectId: string,
    threadId: string,
    reportId: string,
    version: number
  ): AuditReport {
    const row = this.db.get<{ data: string }>(
      'SELECT data FROM audit_reports WHERE report_id=? AND version=?',
      reportId,
      version
    )
    if (!row) throw new Error(`Audit report not found: ${reportId} v${version}`)
    return JSON.parse(row.data) as AuditReport
  }

  private writeStored(report: AuditReport): void {
    this.db.run(
      'INSERT OR REPLACE INTO audit_reports(report_id, version, project_id, thread_id, spec_id, spec_version, data, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      report.id,
      report.version,
      report.projectId,
      report.threadId,
      report.specId,
      report.specVersion,
      JSON.stringify(report),
      report.createdAt,
      report.updatedAt
    )
  }

  private async write(report: AuditReport): Promise<void> {
    this.writeStored(report)
    // Remote projects have no local filesystem root to materialize into; the DB
    // remains the source of truth there. Local projects always get the markdown
    // artifacts so agents and the file system can read the report.
    let project: Project
    try {
      project = requireLocalProject(this.db, report.projectId)
    } catch {
      return
    }
    const featureSlug = await ensureFeatureSlug(this.db, report.projectId, report.threadId)
    const currentMarkdown = exportAuditReportMarkdown(report, { evidenceLinkPrefix: '' })
    const versionMarkdown = exportAuditReportMarkdown(report, { evidenceLinkPrefix: '../' })
    await Promise.all([
      this.storage.writeProjectSpecRaw(
        report.projectId,
        featureSlug,
        'audit.md',
        currentMarkdown,
        project
      ),
      this.storage.writeProjectSpecRaw(
        report.projectId,
        featureSlug,
        join('versions', `${report.id}-audit-v${report.version}.md`),
        versionMarkdown,
        project
      )
    ])
  }
}
