import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Database } from '../../main/database/database'
import type { StorageEngine } from '../../main/storage/storage-engine'
import { exportPrdMarkdown } from '../prd/prd-markdown'
import { parseGeneratedPrdContent } from '../prd/prd-validation'
import { ensureFeatureSlug, requireLocalProject } from '../project-artifacts'
import type {
  PrdAnnotation,
  PrdContent,
  PrdDocument,
  PrdEntryChoice,
  PrdProvenance,
  PrdSectionId,
  PrdWorkflowState
} from '../types'
import { generateId } from '../utils'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u

export class PrdEngineError extends Error {
  constructor(
    readonly code:
      'invalid_id' | 'invalid_version' | 'not_found' | 'invalid_transition' | 'immutable',
    message: string
  ) {
    super(message)
    this.name = 'PrdEngineError'
  }
}

export type NewPrdProvenance = Omit<PrdProvenance, 'createdAt' | 'parentVersion'>

export interface AddPrdAnnotationInput {
  section: PrdSectionId
  body: string
  author: string
  quote?: string
  startLine?: number
  endLine?: number
  startOffset?: number
  endOffset?: number
}

export interface PrdEngineOptions {
  now?: () => number
  generateId?: () => string
}

export class PrdEngine {
  private readonly now: () => number
  private readonly idFactory: () => string

  constructor(
    private readonly storage: StorageEngine,
    private readonly db: Database,
    options: PrdEngineOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.idFactory = options.generateId ?? generateId
  }

  ensureWorkflow(projectId: string, threadId: string): PrdWorkflowState {
    this.assertScope(projectId, threadId)
    const existing = this.getWorkflowState(projectId, threadId)
    if (existing) return existing
    const brainstorm = this.db.get<{ finalized_brainstorm_version: number | null }>(
      'SELECT finalized_brainstorm_version FROM brainstorm_workflow WHERE project_id=? AND thread_id=?',
      projectId,
      threadId
    )
    const hasBrainstorm = Boolean(brainstorm?.finalized_brainstorm_version)
    const now = this.now()
    const stage = hasBrainstorm ? 'drafting' : 'choice_pending'
    this.db.run(
      'INSERT INTO prd_workflow(project_id, thread_id, entry_choice, stage, updated_at) VALUES(?,?,?,?,?)',
      projectId,
      threadId,
      hasBrainstorm ? 'start_prd' : null,
      stage,
      now
    )
    return {
      projectId,
      threadId,
      ...(hasBrainstorm ? { entryChoice: 'start_prd' as const } : {}),
      stage,
      updatedAt: now
    }
  }

  chooseEntry(projectId: string, threadId: string, choice: PrdEntryChoice): PrdWorkflowState {
    const workflow = this.ensureWorkflow(projectId, threadId)
    if (workflow.stage !== 'choice_pending') {
      if (workflow.entryChoice === choice) return workflow
      throw new PrdEngineError('invalid_transition', 'PRD entry choice is already resolved')
    }
    const stage = choice === 'brainstorm_first' ? 'brainstorming' : 'drafting'
    const now = this.now()
    this.db.run(
      'UPDATE prd_workflow SET entry_choice=?, stage=?, updated_at=? WHERE project_id=? AND thread_id=?',
      choice,
      stage,
      now,
      projectId,
      threadId
    )
    return { ...workflow, entryChoice: choice, stage, updatedAt: now }
  }

  beginDrafting(projectId: string, threadId: string): PrdWorkflowState {
    const workflow = this.ensureWorkflow(projectId, threadId)
    if (workflow.stage === 'drafting') return workflow
    if (workflow.stage !== 'brainstorming') {
      throw new PrdEngineError('invalid_transition', 'PRD workflow is not awaiting Brainstorm')
    }
    const brainstorm = this.db.get<{ finalized_brainstorm_version: number | null }>(
      'SELECT finalized_brainstorm_version FROM brainstorm_workflow WHERE project_id=? AND thread_id=?',
      projectId,
      threadId
    )
    if (!brainstorm?.finalized_brainstorm_version) {
      throw new PrdEngineError('invalid_transition', 'Finalize Brainstorm before starting the PRD')
    }
    const now = this.now()
    this.db.run(
      "UPDATE prd_workflow SET stage='drafting', updated_at=? WHERE project_id=? AND thread_id=?",
      now,
      projectId,
      threadId
    )
    return { ...workflow, stage: 'drafting', updatedAt: now }
  }

  getWorkflowState(projectId: string, threadId: string): PrdWorkflowState | null {
    this.assertScope(projectId, threadId)
    const row = this.db.get<{
      entry_choice: PrdEntryChoice | null
      stage: PrdWorkflowState['stage']
      active_prd_id: string | null
      active_prd_version: number | null
      finalized_prd_version: number | null
      finalized_input_hash: string | null
      updated_at: number
    }>(
      'SELECT entry_choice, stage, active_prd_id, active_prd_version, finalized_prd_version, finalized_input_hash, updated_at FROM prd_workflow WHERE project_id=? AND thread_id=?',
      projectId,
      threadId
    )
    if (!row) return null
    return {
      projectId,
      threadId,
      ...(row.entry_choice ? { entryChoice: row.entry_choice } : {}),
      stage: row.stage,
      ...(row.active_prd_id ? { activePrdId: row.active_prd_id } : {}),
      ...(row.active_prd_version ? { activePrdVersion: row.active_prd_version } : {}),
      ...(row.finalized_prd_version ? { finalizedPrdVersion: row.finalized_prd_version } : {}),
      ...(row.finalized_input_hash ? { finalizedInputHash: row.finalized_input_hash } : {}),
      updatedAt: row.updated_at
    }
  }

  getActive(projectId: string, threadId: string): PrdDocument | null {
    const workflow = this.getWorkflowState(projectId, threadId)
    if (!workflow?.activePrdId || !workflow.activePrdVersion) return null
    return this.getVersion(projectId, threadId, workflow.activePrdId, workflow.activePrdVersion)
  }

  getVersion(
    projectId: string,
    threadId: string,
    prdId: string,
    version: number
  ): PrdDocument | null {
    this.assertScope(projectId, threadId)
    this.assertId('PRD', prdId)
    this.assertVersion(version)
    const row = this.db.get<{ data: string }>(
      'SELECT data FROM prd_versions WHERE prd_id=? AND version=? AND project_id=? AND thread_id=?',
      prdId,
      version,
      projectId,
      threadId
    )
    return row ? (JSON.parse(row.data) as PrdDocument) : null
  }

  listVersions(projectId: string, threadId: string, prdId: string): PrdDocument[] {
    this.assertScope(projectId, threadId)
    this.assertId('PRD', prdId)
    return this.db
      .all<{ data: string }>(
        'SELECT data FROM prd_versions WHERE prd_id=? AND project_id=? AND thread_id=? ORDER BY version',
        prdId,
        projectId,
        threadId
      )
      .map((row) => JSON.parse(row.data) as PrdDocument)
  }

  async createDraft(
    projectId: string,
    threadId: string,
    content: PrdContent,
    provenance: NewPrdProvenance
  ): Promise<PrdDocument> {
    const workflow = this.ensureWorkflow(projectId, threadId)
    if (workflow.stage !== 'drafting' || workflow.activePrdId) {
      throw new PrdEngineError('invalid_transition', 'PRD workflow is not ready for a new draft')
    }
    const now = this.now()
    const generatedContent = parseGeneratedPrdContent(content)
    const document: PrdDocument = {
      schemaVersion: 1,
      id: this.newId('PRD'),
      projectId,
      threadId,
      version: 1,
      status: 'draft',
      content: structuredClone(generatedContent),
      generatedContent,
      annotations: [],
      provenance: { ...provenance, createdAt: now },
      createdAt: now,
      updatedAt: now
    }
    await this.writeVersion(document)
    this.setActive(document, 'drafting')
    return document
  }

  async saveDraft(
    projectId: string,
    threadId: string,
    prdId: string,
    version: number,
    content: PrdContent
  ): Promise<PrdDocument> {
    const document = this.requireMutable(projectId, threadId, prdId, version)
    const updated = {
      ...document,
      content: parseGeneratedPrdContent(content),
      updatedAt: this.now()
    }
    await this.writeVersion(updated)
    return updated
  }

  async createVersion(
    projectId: string,
    threadId: string,
    prdId: string,
    content: PrdContent,
    provenance: NewPrdProvenance
  ): Promise<PrdDocument> {
    const workflow = this.getWorkflowState(projectId, threadId)
    if (
      workflow?.stage !== 'drafting' ||
      workflow.activePrdId !== prdId ||
      !workflow.activePrdVersion
    ) {
      throw new PrdEngineError('invalid_transition', 'PRD workflow is not drafting')
    }
    const previous = this.requireMutable(projectId, threadId, prdId, workflow.activePrdVersion)
    const now = this.now()
    await this.writeVersion({ ...previous, status: 'superseded', updatedAt: now }, false)
    const generatedContent = parseGeneratedPrdContent(content)
    const next: PrdDocument = {
      ...previous,
      version: previous.version + 1,
      status: 'draft',
      content: structuredClone(generatedContent),
      generatedContent,
      annotations: [],
      provenance: { ...provenance, parentVersion: previous.version, createdAt: now },
      createdAt: now,
      updatedAt: now,
      finalizedAt: undefined,
      finalizedInputHash: undefined
    }
    await this.writeVersion(next)
    this.setActive(next, 'drafting')
    return next
  }

  async addAnnotation(
    projectId: string,
    threadId: string,
    prdId: string,
    version: number,
    input: AddPrdAnnotationInput
  ): Promise<PrdDocument> {
    const document = this.requireMutable(projectId, threadId, prdId, version)
    if (!document.content.sections.some((section) => section.id === input.section)) {
      throw new PrdEngineError('invalid_transition', `PRD section ${input.section} is absent`)
    }
    const body = input.body.trim()
    if (!body) throw new PrdEngineError('invalid_transition', 'PRD annotation is empty')
    const now = this.now()
    const annotation: PrdAnnotation = {
      id: this.newId('annotation'),
      ...input,
      body,
      status: 'open',
      createdAt: now
    }
    const updated = {
      ...document,
      annotations: [...document.annotations, annotation],
      updatedAt: now
    }
    await this.writeVersion(updated)
    return updated
  }

  async resolveAnnotation(
    projectId: string,
    threadId: string,
    prdId: string,
    version: number,
    annotationId: string
  ): Promise<PrdDocument> {
    const document = this.requireMutable(projectId, threadId, prdId, version)
    const existing = document.annotations.find((annotation) => annotation.id === annotationId)
    if (!existing) throw new PrdEngineError('not_found', 'PRD annotation not found')
    if (existing.status === 'resolved') return document
    const now = this.now()
    const updated = {
      ...document,
      annotations: document.annotations.map((annotation) =>
        annotation.id === annotationId
          ? { ...annotation, status: 'resolved' as const, resolvedAt: now }
          : annotation
      ),
      updatedAt: now
    }
    await this.writeVersion(updated)
    return updated
  }

  async updateAnnotation(
    projectId: string,
    threadId: string,
    prdId: string,
    version: number,
    annotationId: string,
    body: string
  ): Promise<PrdDocument> {
    const document = this.requireMutable(projectId, threadId, prdId, version)
    if (!document.annotations.some((annotation) => annotation.id === annotationId)) {
      throw new PrdEngineError('not_found', 'PRD annotation not found')
    }
    const trimmed = body.trim()
    if (!trimmed) throw new PrdEngineError('invalid_transition', 'PRD annotation is empty')
    const updated = {
      ...document,
      annotations: document.annotations.map((annotation) =>
        annotation.id === annotationId ? { ...annotation, body: trimmed } : annotation
      ),
      updatedAt: this.now()
    }
    await this.writeVersion(updated)
    return updated
  }

  async finalize(
    projectId: string,
    threadId: string,
    prdId: string,
    version: number
  ): Promise<PrdDocument> {
    const existing = this.requireDocument(projectId, threadId, prdId, version)
    if (existing.status === 'finalized') return existing
    const document = this.requireMutable(projectId, threadId, prdId, version)
    const finalizedInputHash = createHash('sha256')
      .update(JSON.stringify({ content: document.content, annotations: document.annotations }))
      .digest('hex')
    const now = this.now()
    const finalized: PrdDocument = {
      ...document,
      status: 'finalized',
      finalizedAt: now,
      finalizedInputHash,
      updatedAt: now
    }
    await this.writeVersion(finalized)
    this.db.run(
      "UPDATE prd_workflow SET stage='finalized', finalized_prd_version=?, finalized_input_hash=?, updated_at=? WHERE project_id=? AND thread_id=?",
      version,
      finalizedInputHash,
      now,
      projectId,
      threadId
    )
    return finalized
  }

  async markdownPath(
    projectId: string,
    threadId: string,
    prdId: string,
    version: number
  ): Promise<string> {
    this.assertScope(projectId, threadId)
    this.assertId('PRD', prdId)
    this.assertVersion(version)
    const featureSlug = await ensureFeatureSlug(this.db, projectId, threadId)
    return this.storage.resolveProjectSpecArtifact(
      projectId,
      featureSlug,
      join('versions', `${prdId}-v${version}-prd.md`),
      requireLocalProject(this.db, projectId)
    )
  }

  private requireMutable(
    projectId: string,
    threadId: string,
    prdId: string,
    version: number
  ): PrdDocument {
    const workflow = this.getWorkflowState(projectId, threadId)
    if (
      workflow?.stage !== 'drafting' ||
      workflow.activePrdId !== prdId ||
      workflow.activePrdVersion !== version
    ) {
      throw new PrdEngineError('immutable', 'Only the active PRD draft is mutable')
    }
    const document = this.requireDocument(projectId, threadId, prdId, version)
    if (document.status !== 'draft')
      throw new PrdEngineError('immutable', 'Finalized PRDs are immutable')
    return document
  }

  private requireDocument(
    projectId: string,
    threadId: string,
    prdId: string,
    version: number
  ): PrdDocument {
    const document = this.getVersion(projectId, threadId, prdId, version)
    if (!document) throw new PrdEngineError('not_found', `PRD not found: ${prdId} v${version}`)
    return document
  }

  private async writeVersion(document: PrdDocument, updateCurrent = true): Promise<void> {
    this.db.run(
      'INSERT OR REPLACE INTO prd_versions(prd_id, version, project_id, thread_id, status, data, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)',
      document.id,
      document.version,
      document.projectId,
      document.threadId,
      document.status,
      JSON.stringify(document),
      document.createdAt,
      document.updatedAt
    )
    const featureSlug = await ensureFeatureSlug(this.db, document.projectId, document.threadId)
    const project = requireLocalProject(this.db, document.projectId)
    const writes = [
      this.storage.writeProjectSpecRaw(
        document.projectId,
        featureSlug,
        join('versions', `${document.id}-v${document.version}-prd.md`),
        exportPrdMarkdown(document),
        project
      )
    ]
    if (updateCurrent) {
      writes.push(
        this.storage.writeProjectSpecRaw(
          document.projectId,
          featureSlug,
          'prd.md',
          exportPrdMarkdown(document),
          project
        )
      )
    }
    await Promise.all(writes)
  }

  private setActive(document: PrdDocument, stage: PrdWorkflowState['stage']): void {
    this.db.run(
      'UPDATE prd_workflow SET stage=?, active_prd_id=?, active_prd_version=?, updated_at=? WHERE project_id=? AND thread_id=?',
      stage,
      document.id,
      document.version,
      this.now(),
      document.projectId,
      document.threadId
    )
  }

  private newId(label: string): string {
    const id = this.idFactory()
    this.assertId(label, id)
    return id
  }

  private assertScope(projectId: string, threadId: string): void {
    this.assertId('project', projectId)
    this.assertId('thread', threadId)
    const row = this.db.get<{ project_id: string }>(
      'SELECT project_id FROM threads WHERE id=?',
      threadId
    )
    if (!row || row.project_id !== projectId) {
      throw new PrdEngineError('not_found', 'Thread does not belong to the project')
    }
  }

  private assertId(label: string, value: string): void {
    if (!SAFE_ID.test(value)) throw new PrdEngineError('invalid_id', `Invalid ${label} ID`)
  }

  private assertVersion(version: number): void {
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new PrdEngineError('invalid_version', 'PRD version must be a positive integer')
    }
  }
}
