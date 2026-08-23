import { createHash } from 'crypto'
import { join } from 'path'
import type { Database } from '../../main/database/database'
import type { StorageEngine } from '../../main/storage/storage-engine'
import { exportBrainstormMarkdown } from '../brainstorm/brainstorm-markdown'
import { parseGeneratedBrainstormContent } from '../brainstorm/brainstorm-validation'
import { ensureFeatureSlug, requireLocalProject } from '../project-artifacts'
import type {
  BrainstormAnnotation,
  BrainstormContent,
  BrainstormDecisionAction,
  BrainstormDecisionComment,
  BrainstormDocument,
  BrainstormEntryChoice,
  BrainstormProvenance,
  BrainstormSectionId,
  BrainstormWorkflowState
} from '../types'
import { generateId } from '../utils'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u

export type BrainstormEngineErrorCode =
  'invalid_id' | 'invalid_version' | 'not_found' | 'invalid_transition' | 'immutable'

export class BrainstormEngineError extends Error {
  constructor(
    readonly code: BrainstormEngineErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'BrainstormEngineError'
  }
}

export type NewBrainstormProvenance = Omit<BrainstormProvenance, 'createdAt' | 'parentVersion'>

export interface CreateBrainstormDraftInput {
  projectId: string
  threadId: string
  content: BrainstormContent
  provenance: NewBrainstormProvenance
}

export interface CreateBrainstormVersionInput extends CreateBrainstormDraftInput {
  brainstormId: string
  baseVersion?: number
}

export interface AddBrainstormAnnotationInput {
  section: BrainstormSectionId
  body: string
  author: string
  quote?: string
  startLine?: number
  endLine?: number
  startOffset?: number
  endOffset?: number
}

export interface BrainstormEngineOptions {
  now?: () => number
  generateId?: () => string
}

export class BrainstormEngine {
  private readonly now: () => number
  private readonly idFactory: () => string

  constructor(
    private readonly storage: StorageEngine,
    private readonly db: Database,
    options: BrainstormEngineOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.idFactory = options.generateId ?? generateId
  }

  ensureWorkflow(projectId: string, threadId: string): BrainstormWorkflowState {
    this.assertScope(projectId, threadId)
    const existing = this.getWorkflowState(projectId, threadId)
    if (existing) return existing
    const now = this.now()
    this.db.run(
      'INSERT INTO brainstorm_workflow(project_id, thread_id, entry_choice, stage, active_brainstorm_id, active_brainstorm_version, finalized_brainstorm_version, finalized_input_hash, updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      projectId,
      threadId,
      null,
      'choice_pending',
      null,
      null,
      null,
      null,
      now
    )
    return { projectId, threadId, stage: 'choice_pending', updatedAt: now }
  }

  chooseEntry(
    projectId: string,
    threadId: string,
    choice: BrainstormEntryChoice
  ): BrainstormWorkflowState {
    const workflow = this.ensureWorkflow(projectId, threadId)
    if (workflow.entryChoice) {
      if (workflow.entryChoice === choice) return workflow
      throw new BrainstormEngineError(
        'invalid_transition',
        `Brainstorm entry choice is already ${workflow.entryChoice}`
      )
    }
    const now = this.now()
    const stage = choice === 'brainstorm' ? 'drafting' : 'skipped'
    this.db.run(
      'UPDATE brainstorm_workflow SET entry_choice=?, stage=?, updated_at=? WHERE project_id=? AND thread_id=?',
      choice,
      stage,
      now,
      projectId,
      threadId
    )
    return { ...workflow, entryChoice: choice, stage, updatedAt: now }
  }

  /**
   * Remove the workflow row entirely, returning the thread to a state with no
   * planning choice recorded. Used to abandon a failed planning attempt (e.g.
   * the retry card's Cancel action) so reconcile no longer shows a retry prompt
   * and no skipped/finalized stage triggers automatic generation resume.
   */
  resetWorkflow(projectId: string, threadId: string): void {
    this.assertScope(projectId, threadId)
    this.db.run(
      'DELETE FROM brainstorm_workflow WHERE project_id=? AND thread_id=?',
      projectId,
      threadId
    )
  }

  getWorkflowState(projectId: string, threadId: string): BrainstormWorkflowState | null {
    this.assertScope(projectId, threadId)
    const row = this.db.get<{
      project_id: string
      thread_id: string
      entry_choice: BrainstormEntryChoice | null
      stage: BrainstormWorkflowState['stage']
      active_brainstorm_id: string | null
      active_brainstorm_version: number | null
      finalized_brainstorm_version: number | null
      finalized_input_hash: string | null
      updated_at: number
    }>(
      'SELECT project_id, thread_id, entry_choice, stage, active_brainstorm_id, active_brainstorm_version, finalized_brainstorm_version, finalized_input_hash, updated_at FROM brainstorm_workflow WHERE project_id=? AND thread_id=?',
      projectId,
      threadId
    )
    if (!row) return null
    return {
      projectId: row.project_id,
      threadId: row.thread_id,
      entryChoice: row.entry_choice ?? undefined,
      stage: row.stage,
      activeBrainstormId: row.active_brainstorm_id ?? undefined,
      activeBrainstormVersion: row.active_brainstorm_version ?? undefined,
      finalizedBrainstormVersion: row.finalized_brainstorm_version ?? undefined,
      finalizedInputHash: row.finalized_input_hash ?? undefined,
      updatedAt: row.updated_at
    }
  }

  async getActive(projectId: string, threadId: string): Promise<BrainstormDocument | null> {
    const workflow = this.getWorkflowState(projectId, threadId)
    if (!workflow?.activeBrainstormId || !workflow.activeBrainstormVersion) return null
    return this.getVersion(
      projectId,
      threadId,
      workflow.activeBrainstormId,
      workflow.activeBrainstormVersion
    )
  }

  getVersion(
    projectId: string,
    threadId: string,
    brainstormId: string,
    version: number
  ): BrainstormDocument | null {
    this.assertScope(projectId, threadId)
    this.assertId('brainstorm', brainstormId)
    this.assertVersion(version)
    const row = this.db.get<{ data: string }>(
      'SELECT data FROM brainstorm_versions WHERE brainstorm_id=? AND version=? AND project_id=? AND thread_id=?',
      brainstormId,
      version,
      projectId,
      threadId
    )
    return row ? (JSON.parse(row.data) as BrainstormDocument) : null
  }

  listVersions(projectId: string, threadId: string, brainstormId: string): BrainstormDocument[] {
    this.assertScope(projectId, threadId)
    this.assertId('brainstorm', brainstormId)
    return this.db
      .all<{ data: string }>(
        'SELECT data FROM brainstorm_versions WHERE brainstorm_id=? AND project_id=? AND thread_id=? ORDER BY version',
        brainstormId,
        projectId,
        threadId
      )
      .map((row) => JSON.parse(row.data) as BrainstormDocument)
  }

  async createDraft(input: CreateBrainstormDraftInput): Promise<BrainstormDocument> {
    this.assertScope(input.projectId, input.threadId)
    const workflow = this.ensureWorkflow(input.projectId, input.threadId)
    if (workflow.entryChoice !== 'brainstorm' || workflow.stage !== 'drafting') {
      throw new BrainstormEngineError(
        'invalid_transition',
        'A brainstorm draft requires the brainstorm entry choice'
      )
    }
    if (workflow.activeBrainstormId) {
      throw new BrainstormEngineError('invalid_transition', 'A brainstorm document already exists')
    }
    const now = this.now()
    const id = this.newId('brainstorm')
    const generatedContent = parseGeneratedBrainstormContent(input.content)
    const document: BrainstormDocument = {
      schemaVersion: 1,
      id,
      projectId: input.projectId,
      threadId: input.threadId,
      version: 1,
      status: 'draft',
      content: structuredClone(generatedContent),
      generatedContent,
      annotations: [],
      decisionComments: [],
      provenance: { ...input.provenance, createdAt: now },
      createdAt: now,
      updatedAt: now
    }
    await this.writeVersion(document)
    this.setWorkflowDocument(document, 'drafting')
    return document
  }

  async saveDraft(
    projectId: string,
    threadId: string,
    brainstormId: string,
    version: number,
    content: BrainstormContent
  ): Promise<BrainstormDocument> {
    const document = this.requireMutableActive(projectId, threadId, brainstormId, version)
    const updated = {
      ...document,
      content: parseGeneratedBrainstormContent(content),
      updatedAt: this.now()
    }
    await this.writeVersion(updated)
    this.setWorkflowDocument(updated, 'drafting')
    return updated
  }

  async createVersion(input: CreateBrainstormVersionInput): Promise<BrainstormDocument> {
    const workflow = this.getWorkflowState(input.projectId, input.threadId)
    if (
      workflow?.stage !== 'drafting' ||
      workflow.activeBrainstormId !== input.brainstormId ||
      !workflow.activeBrainstormVersion
    ) {
      throw new BrainstormEngineError('invalid_transition', 'Brainstorm workflow is not drafting')
    }
    if (input.baseVersion !== undefined && workflow.activeBrainstormVersion !== input.baseVersion) {
      throw new BrainstormEngineError(
        'invalid_transition',
        `Brainstorm v${input.baseVersion} is no longer active`
      )
    }
    const previous = this.requireDocument(
      input.projectId,
      input.threadId,
      input.brainstormId,
      workflow.activeBrainstormVersion
    )
    if (previous.status !== 'draft') {
      throw new BrainstormEngineError('immutable', 'Only a draft can produce a revised brainstorm')
    }
    const now = this.now()
    const generatedContent = parseGeneratedBrainstormContent(input.content)
    const superseded: BrainstormDocument = { ...previous, status: 'superseded', updatedAt: now }
    const next: BrainstormDocument = {
      ...previous,
      version: previous.version + 1,
      status: 'draft',
      content: structuredClone(generatedContent),
      generatedContent,
      annotations: [],
      decisionComments: [],
      provenance: {
        ...input.provenance,
        parentVersion: previous.version,
        createdAt: now
      },
      createdAt: now,
      updatedAt: now,
      finalizedAt: undefined,
      finalizedInputHash: undefined
    }
    await this.writeVersion(superseded, false)
    await this.writeVersion(next)
    this.setWorkflowDocument(next, 'drafting')
    return next
  }

  async addAnnotation(
    projectId: string,
    threadId: string,
    brainstormId: string,
    version: number,
    input: AddBrainstormAnnotationInput
  ): Promise<BrainstormDocument> {
    const document = this.requireMutableActive(projectId, threadId, brainstormId, version)
    if (!document.content.sections.some((section) => section.id === input.section)) {
      throw new BrainstormEngineError('invalid_transition', `Section ${input.section} is absent`)
    }
    const trimmedBody = input.body.trim()
    if (!trimmedBody) throw new BrainstormEngineError('invalid_transition', 'Annotation is empty')
    const now = this.now()
    const annotation: BrainstormAnnotation = {
      id: this.newId('annotation'),
      ...input,
      body: trimmedBody,
      status: 'open',
      createdAt: now
    }
    return this.updateDocument(
      document,
      { annotations: [...document.annotations, annotation] },
      now
    )
  }

  async updateAnnotation(
    projectId: string,
    threadId: string,
    brainstormId: string,
    version: number,
    annotationId: string,
    body: string
  ): Promise<BrainstormDocument> {
    this.assertId('annotation', annotationId)
    const document = this.requireMutableActive(projectId, threadId, brainstormId, version)
    if (!document.annotations.some((annotation) => annotation.id === annotationId)) {
      throw new BrainstormEngineError('not_found', `Annotation not found: ${annotationId}`)
    }
    const trimmedBody = body.trim()
    if (!trimmedBody) throw new BrainstormEngineError('invalid_transition', 'Annotation is empty')
    const now = this.now()
    return this.updateDocument(
      document,
      {
        annotations: document.annotations.map((annotation) =>
          annotation.id === annotationId ? { ...annotation, body: trimmedBody } : annotation
        )
      },
      now
    )
  }

  async resolveAnnotation(
    projectId: string,
    threadId: string,
    brainstormId: string,
    version: number,
    annotationId: string
  ): Promise<BrainstormDocument> {
    this.assertId('annotation', annotationId)
    const document = this.requireMutableActive(projectId, threadId, brainstormId, version)
    const existing = document.annotations.find((annotation) => annotation.id === annotationId)
    if (!existing)
      throw new BrainstormEngineError('not_found', `Annotation not found: ${annotationId}`)
    if (existing.status === 'resolved') return document
    const now = this.now()
    return this.updateDocument(
      document,
      {
        annotations: document.annotations.map((annotation) =>
          annotation.id === annotationId
            ? { ...annotation, status: 'resolved' as const, resolvedAt: now }
            : annotation
        )
      },
      now
    )
  }

  async addDecisionComment(
    projectId: string,
    threadId: string,
    brainstormId: string,
    version: number,
    action: BrainstormDecisionAction,
    body: string
  ): Promise<BrainstormDocument> {
    const document = this.requireMutableActive(projectId, threadId, brainstormId, version)
    const trimmedBody = body.trim()
    if (!trimmedBody) return document
    const now = this.now()
    const comment: BrainstormDecisionComment = {
      id: this.newId('decision-comment'),
      action,
      body: trimmedBody,
      createdAt: now
    }
    return this.updateDocument(
      document,
      { decisionComments: [...document.decisionComments, comment] },
      now
    )
  }

  async finalize(
    projectId: string,
    threadId: string,
    brainstormId: string,
    version: number,
    note = ''
  ): Promise<BrainstormDocument> {
    const existing = this.requireDocument(projectId, threadId, brainstormId, version)
    if (existing.status === 'finalized') {
      await this.writeVersion(existing)
      this.db.run(
        'UPDATE brainstorm_workflow SET stage=?, active_brainstorm_id=?, active_brainstorm_version=?, finalized_brainstorm_version=?, finalized_input_hash=?, updated_at=? WHERE project_id=? AND thread_id=?',
        'finalized',
        existing.id,
        existing.version,
        existing.version,
        existing.finalizedInputHash ?? null,
        this.now(),
        projectId,
        threadId
      )
      return existing
    }
    let document = this.requireMutableActive(projectId, threadId, brainstormId, version)
    const trimmedNote = note.trim()
    if (trimmedNote) {
      document = await this.addDecisionComment(
        projectId,
        threadId,
        brainstormId,
        version,
        'finalize',
        trimmedNote
      )
    }
    const finalizedInputHash = createHash('sha256')
      .update(
        JSON.stringify({
          content: document.content,
          openAnnotations: document.annotations.filter(
            (annotation) => annotation.status === 'open'
          ),
          note: trimmedNote
        })
      )
      .digest('hex')
    const now = this.now()
    const finalized: BrainstormDocument = {
      ...document,
      status: 'finalized',
      finalizedAt: now,
      finalizedInputHash,
      updatedAt: now
    }
    await this.writeVersion(finalized)
    this.db.run(
      'UPDATE brainstorm_workflow SET stage=?, finalized_brainstorm_version=?, finalized_input_hash=?, updated_at=? WHERE project_id=? AND thread_id=?',
      'finalized',
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
    brainstormId: string,
    version: number
  ): Promise<string> {
    this.assertScope(projectId, threadId)
    this.assertId('brainstorm', brainstormId)
    this.assertVersion(version)
    const featureSlug = await ensureFeatureSlug(this.db, projectId, threadId)
    return this.storage.resolveProjectSpecArtifact(
      projectId,
      featureSlug,
      join('versions', `${brainstormId}-v${version}-brainstorm.md`),
      requireLocalProject(this.db, projectId)
    )
  }

  private requireMutableActive(
    projectId: string,
    threadId: string,
    brainstormId: string,
    version: number
  ): BrainstormDocument {
    const workflow = this.getWorkflowState(projectId, threadId)
    if (
      workflow?.stage !== 'drafting' ||
      workflow.activeBrainstormId !== brainstormId ||
      workflow.activeBrainstormVersion !== version
    ) {
      throw new BrainstormEngineError('immutable', 'Only the active brainstorm draft is mutable')
    }
    const document = this.requireDocument(projectId, threadId, brainstormId, version)
    if (document.status !== 'draft') {
      throw new BrainstormEngineError('immutable', 'Finalized brainstorm documents are immutable')
    }
    return document
  }

  private requireDocument(
    projectId: string,
    threadId: string,
    brainstormId: string,
    version: number
  ): BrainstormDocument {
    const document = this.getVersion(projectId, threadId, brainstormId, version)
    if (!document) {
      throw new BrainstormEngineError(
        'not_found',
        `Brainstorm not found: ${brainstormId} v${version}`
      )
    }
    return document
  }

  private async updateDocument(
    document: BrainstormDocument,
    changes: Pick<Partial<BrainstormDocument>, 'annotations' | 'decisionComments'>,
    updatedAt: number
  ): Promise<BrainstormDocument> {
    const updated = { ...document, ...changes, updatedAt }
    await this.writeVersion(updated)
    return updated
  }

  private async writeVersion(
    document: BrainstormDocument,
    updateCurrentMirror = true
  ): Promise<void> {
    this.db.run(
      'INSERT OR REPLACE INTO brainstorm_versions(brainstorm_id, version, project_id, thread_id, status, data, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)',
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
    const markdown = exportBrainstormMarkdown(document)
    const writes = [
      this.storage.writeProjectSpecRaw(
        document.projectId,
        featureSlug,
        join('versions', `${document.id}-v${document.version}-brainstorm.md`),
        markdown,
        project
      )
    ]
    if (updateCurrentMirror) {
      writes.push(
        this.storage.writeProjectSpecRaw(
          document.projectId,
          featureSlug,
          'brainstorm.md',
          markdown,
          project
        )
      )
    }
    await Promise.all(writes)
  }

  private setWorkflowDocument(
    document: BrainstormDocument,
    stage: BrainstormWorkflowState['stage']
  ): void {
    this.db.run(
      'UPDATE brainstorm_workflow SET stage=?, active_brainstorm_id=?, active_brainstorm_version=?, updated_at=? WHERE project_id=? AND thread_id=?',
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
  }

  private assertId(label: string, id: string): void {
    if (!SAFE_ID.test(id))
      throw new BrainstormEngineError('invalid_id', `Invalid ${label} ID: ${id}`)
  }

  private assertVersion(version: number): void {
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new BrainstormEngineError('invalid_version', `Invalid brainstorm version: ${version}`)
    }
  }
}
