import { isAbsolute, join, win32 } from 'path'
import type { Database } from '../../main/database/database'
import type { StorageEngine } from '../../main/storage-engine'
import type {
  EngineeringSpec,
  EngineeringSpecContent,
  EngineeringWorkflowState,
  SpecAnnotation,
  SpecContextReference,
  SpecDecisionAction,
  SpecDecisionComment,
  SpecProvenance,
  SpecSectionId,
  SpecValidationDismissal,
  SpecValidationIssue,
  SpecValidationResult
} from '../types'
import { generateId } from '../utils'
import { ensureFeatureSlug, featureSlugFromTitle, requireLocalProject } from '../project-artifacts'
import { exportEngineeringSpecMarkdown } from '../spec/spec-markdown'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u

export type SpecEngineErrorCode =
  | 'invalid_id'
  | 'invalid_version'
  | 'not_found'
  | 'invalid_transition'
  | 'immutable'
  | 'validation_failed'
  | 'validator_missing'
  | 'duplicate_id'
  | 'invalid_context_path'

export class SpecEngineError extends Error {
  constructor(
    readonly code: SpecEngineErrorCode,
    message: string,
    readonly validation?: SpecValidationResult
  ) {
    super(message)
    this.name = 'SpecEngineError'
  }
}

export type SpecApprovalValidator = (
  spec: Readonly<EngineeringSpec>
) => SpecValidationResult | Promise<SpecValidationResult>

export interface SpecEngineOptions {
  validateForApproval?: SpecApprovalValidator
  now?: () => number
  generateId?: () => string
}

export type NewSpecProvenance = Omit<SpecProvenance, 'createdAt' | 'parentVersion'>

export interface CreateSpecDraftInput {
  projectId: string
  threadId: string
  content: EngineeringSpecContent
  provenance: NewSpecProvenance
  context?: SpecContextReference[]
}

export interface CreateSpecVersionInput {
  projectId: string
  threadId: string
  specId: string
  content: EngineeringSpecContent
  provenance: NewSpecProvenance
  context?: SpecContextReference[]
}

export interface AddSpecAnnotationInput {
  section: SpecSectionId
  body: string
  author: string
  quote?: string
  startLine?: number
  endLine?: number
  startOffset?: number
  endOffset?: number
}

export class SpecEngine {
  private readonly validateForApproval?: SpecApprovalValidator
  private readonly now: () => number
  private readonly idFactory: () => string

  constructor(
    private readonly storage: StorageEngine,
    private readonly db: Database,
    options: SpecEngineOptions = {}
  ) {
    this.validateForApproval = options.validateForApproval
    this.now = options.now ?? Date.now
    this.idFactory = options.generateId ?? generateId
  }

  async createDraft(input: CreateSpecDraftInput): Promise<EngineeringSpec> {
    this.assertScope(input.projectId, input.threadId)
    this.assertContext(input.context ?? [])
    const id = this.idFactory()
    this.assertId('specification', id)
    const now = this.now()
    const spec: EngineeringSpec = {
      schemaVersion: 1,
      id,
      projectId: input.projectId,
      threadId: input.threadId,
      version: 1,
      status: 'draft',
      content: input.content,
      annotations: [],
      dismissedValidationIssues: [],
      decisionComments: [],
      context: structuredClone(input.context ?? []),
      provenance: { ...input.provenance, createdAt: now },
      createdAt: now,
      updatedAt: now
    }

    await this.writeNewVersion(spec)
    this.db.run(
      'INSERT OR REPLACE INTO spec_workflow(project_id, thread_id, stage, active_spec_id, active_spec_version, approved_spec_version, updated_at) VALUES(?,?,?,?,?,?,?)',
      input.projectId,
      input.threadId,
      'spec_drafting',
      id,
      1,
      null,
      now
    )
    return spec
  }

  async getVersion(
    projectId: string,
    threadId: string,
    specId: string,
    version: number
  ): Promise<EngineeringSpec | null> {
    this.assertScope(projectId, threadId)
    this.assertId('specification', specId)
    this.assertVersion(version)
    const row = this.db.get<{ data: string }>(
      'SELECT data FROM spec_versions WHERE spec_id=? AND version=?',
      specId,
      version
    )
    if (row) {
      const spec = JSON.parse(row.data) as EngineeringSpec
      return this.withDecisionComments(spec)
    }
    const legacy = await this.storage.read<EngineeringSpec>(
      await this.legacyBrainstormVersionPath(projectId, threadId, specId, version)
    )
    return legacy ? this.withDecisionComments(legacy) : null
  }

  async getLatest(
    projectId: string,
    threadId: string,
    specId: string
  ): Promise<EngineeringSpec | null> {
    const versions = await this.listVersions(projectId, threadId, specId)
    return versions.at(-1) ?? null
  }

  async listVersions(
    projectId: string,
    threadId: string,
    specId: string
  ): Promise<EngineeringSpec[]> {
    this.assertScope(projectId, threadId)
    this.assertId('specification', specId)
    const dbVersionNumbers = this.db
      .all<{ version: number }>(
        'SELECT version FROM spec_versions WHERE spec_id=? ORDER BY version',
        specId
      )
      .map((r) => r.version)

    const legacyEntries = await this.storage.list(
      await this.legacyBrainstormVersionsDir(projectId, threadId, specId)
    )
    const legacyVersionNumbers = legacyEntries
      .map((entry) => /^v([1-9]\d*)\.json$/u.exec(entry))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1]))

    const allVersions = [...new Set([...dbVersionNumbers, ...legacyVersionNumbers])].sort(
      (left, right) => left - right
    )

    const specs: EngineeringSpec[] = []
    for (const version of allVersions) {
      const spec = await this.getVersion(projectId, threadId, specId, version)
      if (spec) specs.push(spec)
    }
    return specs
  }

  async markdownPath(
    projectId: string,
    threadId: string,
    specId: string,
    version: number
  ): Promise<string> {
    this.assertScope(projectId, threadId)
    this.assertId('specification', specId)
    this.assertVersion(version)
    const featureSlug = await ensureFeatureSlug(this.db, projectId, threadId)
    const project = requireLocalProject(this.db, projectId)
    return this.storage.resolveProjectSpecArtifact(
      projectId,
      featureSlug,
      join('versions', `${specId}-v${version}.md`),
      project
    )
  }

  async saveDraft(
    projectId: string,
    threadId: string,
    specId: string,
    version: number,
    content: EngineeringSpecContent
  ): Promise<EngineeringSpec> {
    const spec = await this.requireVersion(projectId, threadId, specId, version)
    this.assertMutable(spec)
    if (spec.status !== 'draft') {
      throw new SpecEngineError(
        'invalid_transition',
        `Specification ${specId} v${version} is ${spec.status}; only drafts can be edited`
      )
    }

    const updated = { ...spec, content, updatedAt: this.now() }
    await this.writeVersion(updated)
    await this.setWorkflowStage(updated, 'spec_drafting')
    return updated
  }

  async createVersion(input: CreateSpecVersionInput): Promise<EngineeringSpec> {
    this.assertScope(input.projectId, input.threadId)
    this.assertId('specification', input.specId)
    this.assertContext(input.context ?? [])
    const latest = await this.getLatest(input.projectId, input.threadId, input.specId)
    if (!latest) {
      throw new SpecEngineError('not_found', `Specification not found: ${input.specId}`)
    }

    const now = this.now()
    const next: EngineeringSpec = {
      ...latest,
      version: latest.version + 1,
      status: 'draft',
      content: input.content,
      annotations: [],
      dismissedValidationIssues: [],
      decisionComments: [],
      context: structuredClone(input.context ?? latest.context),
      provenance: {
        ...input.provenance,
        parentVersion: latest.version,
        createdAt: now
      },
      createdAt: now,
      updatedAt: now,
      approvedAt: undefined
    }
    await this.writeNewVersion(next)
    await this.setWorkflowStage(next, 'spec_drafting')
    return next
  }

  async setReview(
    projectId: string,
    threadId: string,
    specId: string,
    version: number
  ): Promise<EngineeringSpec> {
    const spec = await this.requireVersion(projectId, threadId, specId, version)
    this.assertMutable(spec)
    if (spec.status !== 'draft') {
      throw new SpecEngineError(
        'invalid_transition',
        `Specification ${specId} v${version} must be a draft before review`
      )
    }

    const updated: EngineeringSpec = { ...spec, status: 'in_review', updatedAt: this.now() }
    await this.writeVersion(updated)
    await this.setWorkflowStage(updated, 'spec_review')
    return updated
  }

  async approve(
    projectId: string,
    threadId: string,
    specId: string,
    version: number
  ): Promise<EngineeringSpec> {
    const spec = await this.requireVersion(projectId, threadId, specId, version)
    this.assertMutable(spec)
    if (spec.status !== 'in_review') {
      throw new SpecEngineError(
        'invalid_transition',
        `Specification ${specId} v${version} must be in review before approval`
      )
    }
    if (!this.validateForApproval) {
      throw new SpecEngineError(
        'validator_missing',
        'Specification approval requires a validation callback'
      )
    }

    const validation = await this.validateForApproval(spec)
    if (!validation.valid || validation.issues.length > 0) {
      throw new SpecEngineError(
        'validation_failed',
        `Specification ${specId} v${version} failed approval validation`,
        validation
      )
    }

    const now = this.now()
    const approved: EngineeringSpec = {
      ...spec,
      status: 'approved',
      updatedAt: now,
      approvedAt: now
    }
    await this.writeVersion(approved)
    this.db.run(
      'INSERT OR REPLACE INTO spec_workflow(project_id, thread_id, stage, active_spec_id, active_spec_version, approved_spec_version, updated_at) VALUES(?,?,?,?,?,?,?)',
      projectId,
      threadId,
      'spec_approved',
      specId,
      version,
      version,
      now
    )
    return approved
  }

  async addAnnotation(
    projectId: string,
    threadId: string,
    specId: string,
    version: number,
    input: AddSpecAnnotationInput
  ): Promise<EngineeringSpec> {
    const spec = await this.requireMutableVersion(projectId, threadId, specId, version)
    const now = this.now()
    const annotation: SpecAnnotation = {
      id: this.newEntityId('annotation'),
      ...input,
      status: 'open',
      createdAt: now
    }
    return this.updateVersion(spec, { annotations: [...spec.annotations, annotation] }, now)
  }

  async addDecisionComment(
    projectId: string,
    threadId: string,
    specId: string,
    version: number,
    action: SpecDecisionAction,
    body: string
  ): Promise<EngineeringSpec> {
    const trimmedBody = body.trim()
    if (!trimmedBody) {
      throw new SpecEngineError('invalid_transition', 'Decision comment body cannot be empty')
    }
    const spec = await this.requireVersion(projectId, threadId, specId, version)
    const now = this.now()
    const comment: SpecDecisionComment = {
      id: this.newEntityId('decision comment'),
      action,
      body: trimmedBody,
      createdAt: now
    }
    const workflow = await this.getWorkflowState(projectId, threadId)
    const isActiveVersion =
      workflow?.activeSpecId === specId && workflow.activeSpecVersion === version
    return this.updateVersion(
      spec,
      { decisionComments: [...spec.decisionComments, comment] },
      now,
      isActiveVersion
    )
  }

  async resolveAnnotation(
    projectId: string,
    threadId: string,
    specId: string,
    version: number,
    annotationId: string
  ): Promise<EngineeringSpec> {
    this.assertId('annotation', annotationId)
    const spec = await this.requireMutableVersion(projectId, threadId, specId, version)
    const annotation = spec.annotations.find((item) => item.id === annotationId)
    if (!annotation) {
      throw new SpecEngineError('not_found', `Annotation not found: ${annotationId}`)
    }
    if (annotation.status === 'resolved') return spec

    const now = this.now()
    const annotations = spec.annotations.map((item) =>
      item.id === annotationId ? { ...item, status: 'resolved' as const, resolvedAt: now } : item
    )
    return this.updateVersion(spec, { annotations }, now)
  }

  async dismissValidationIssue(
    projectId: string,
    threadId: string,
    specId: string,
    version: number,
    issue: SpecValidationIssue
  ): Promise<EngineeringSpec> {
    const spec = await this.requireMutableVersion(projectId, threadId, specId, version)
    const dismissals = spec.dismissedValidationIssues ?? []
    const alreadyDismissed = dismissals.some(
      (candidate) =>
        candidate.code === issue.code &&
        candidate.section === issue.section &&
        candidate.path === issue.path &&
        candidate.message === issue.message
    )
    if (alreadyDismissed) return spec

    if (!this.validateForApproval) {
      throw new SpecEngineError(
        'validator_missing',
        'Dismissing a validation issue requires a validation callback'
      )
    }
    const validation = await this.validateForApproval(spec)
    const isActiveIssue = validation.issues.some(
      (candidate) =>
        candidate.code === issue.code &&
        candidate.section === issue.section &&
        candidate.path === issue.path &&
        candidate.message === issue.message
    )
    if (!isActiveIssue) {
      throw new SpecEngineError('not_found', 'Validation issue is no longer active')
    }

    const now = this.now()
    const dismissal: SpecValidationDismissal = { ...issue, dismissedAt: now }
    return this.updateVersion(spec, { dismissedValidationIssues: [...dismissals, dismissal] }, now)
  }

  async updateAnnotation(
    projectId: string,
    threadId: string,
    specId: string,
    version: number,
    annotationId: string,
    body: string
  ): Promise<EngineeringSpec> {
    this.assertId('annotation', annotationId)
    const trimmedBody = body.trim()
    if (!trimmedBody) {
      throw new SpecEngineError('invalid_transition', 'Annotation body cannot be empty')
    }
    const spec = await this.requireMutableVersion(projectId, threadId, specId, version)
    if (!spec.annotations.some((item) => item.id === annotationId)) {
      throw new SpecEngineError('not_found', `Annotation not found: ${annotationId}`)
    }
    const now = this.now()
    const annotations = spec.annotations.map((item) =>
      item.id === annotationId ? { ...item, body: trimmedBody } : item
    )
    return this.updateVersion(spec, { annotations }, now)
  }

  async setContext(
    projectId: string,
    threadId: string,
    specId: string,
    version: number,
    context: SpecContextReference[]
  ): Promise<EngineeringSpec> {
    const spec = await this.requireMutableVersion(projectId, threadId, specId, version)
    this.assertContext(context)
    return this.updateVersion(spec, { context }, this.now())
  }

  async getWorkflowState(
    projectId: string,
    threadId: string
  ): Promise<EngineeringWorkflowState | null> {
    this.assertScope(projectId, threadId)
    const row = this.db.get<{
      project_id: string
      thread_id: string
      stage: string
      active_spec_id: string | null
      active_spec_version: number | null
      approved_spec_version: number | null
      updated_at: number
    }>(
      'SELECT project_id, thread_id, stage, active_spec_id, active_spec_version, approved_spec_version, updated_at FROM spec_workflow WHERE project_id=? AND thread_id=?',
      projectId,
      threadId
    )
    if (!row) return null
    return {
      projectId: row.project_id,
      threadId: row.thread_id,
      stage: row.stage as EngineeringWorkflowState['stage'],
      activeSpecId: row.active_spec_id ?? undefined,
      activeSpecVersion: row.active_spec_version ?? undefined,
      approvedSpecVersion: row.approved_spec_version ?? undefined,
      updatedAt: row.updated_at
    }
  }

  private async updateVersion(
    spec: EngineeringSpec,
    changes: Partial<
      Pick<
        EngineeringSpec,
        'annotations' | 'dismissedValidationIssues' | 'decisionComments' | 'context'
      >
    >,
    updatedAt: number,
    updateCurrentMirror = true
  ): Promise<EngineeringSpec> {
    const updated = { ...spec, ...changes, updatedAt }
    await this.writeVersion(updated, updateCurrentMirror)
    return updated
  }

  private async requireMutableVersion(
    projectId: string,
    threadId: string,
    specId: string,
    version: number
  ): Promise<EngineeringSpec> {
    const spec = await this.requireVersion(projectId, threadId, specId, version)
    this.assertMutable(spec)
    return spec
  }

  private async requireVersion(
    projectId: string,
    threadId: string,
    specId: string,
    version: number
  ): Promise<EngineeringSpec> {
    const spec = await this.getVersion(projectId, threadId, specId, version)
    if (!spec) {
      throw new SpecEngineError('not_found', `Specification not found: ${specId} v${version}`)
    }
    return spec
  }

  private withDecisionComments(spec: EngineeringSpec): EngineeringSpec {
    return {
      ...spec,
      decisionComments: Array.isArray(spec.decisionComments) ? spec.decisionComments : [],
      dismissedValidationIssues: Array.isArray(spec.dismissedValidationIssues)
        ? spec.dismissedValidationIssues
        : []
    }
  }

  private assertMutable(spec: EngineeringSpec): void {
    if (spec.status === 'approved' || spec.status === 'superseded') {
      throw new SpecEngineError(
        'immutable',
        `Specification ${spec.id} v${spec.version} is immutable; create a new version`
      )
    }
  }

  private async writeNewVersion(spec: EngineeringSpec): Promise<void> {
    const existing = await this.getVersion(spec.projectId, spec.threadId, spec.id, spec.version)
    if (existing) {
      throw new SpecEngineError(
        'invalid_transition',
        `Specification ${spec.id} v${spec.version} already exists`
      )
    }
    await this.writeVersion(spec)
  }

  private async writeVersion(spec: EngineeringSpec, updateCurrentMirror = true): Promise<void> {
    this.db.run(
      'INSERT OR REPLACE INTO spec_versions(spec_id, version, project_id, thread_id, data, created_at) VALUES(?,?,?,?,?,?)',
      spec.id,
      spec.version,
      spec.projectId,
      spec.threadId,
      JSON.stringify(spec),
      spec.createdAt
    )
    const featureSlug = await ensureFeatureSlug(this.db, spec.projectId, spec.threadId)
    const project = requireLocalProject(this.db, spec.projectId)
    const markdown = exportEngineeringSpecMarkdown(spec)
    const writes = [
      this.storage.writeProjectSpecRaw(
        spec.projectId,
        featureSlug,
        join('versions', `${spec.id}-v${spec.version}.md`),
        markdown,
        project
      )
    ]
    if (updateCurrentMirror) {
      writes.push(
        this.storage.writeProjectSpecRaw(spec.projectId, featureSlug, 'spec.md', markdown, project)
      )
    }
    await Promise.all(writes)
  }

  private async setWorkflowStage(
    spec: EngineeringSpec,
    stage: EngineeringWorkflowState['stage']
  ): Promise<void> {
    const existing = await this.getWorkflowState(spec.projectId, spec.threadId)
    this.db.run(
      'INSERT OR REPLACE INTO spec_workflow(project_id, thread_id, stage, active_spec_id, active_spec_version, approved_spec_version, updated_at) VALUES(?,?,?,?,?,?,?)',
      spec.projectId,
      spec.threadId,
      stage,
      spec.id,
      spec.version,
      existing?.approvedSpecVersion ?? null,
      this.now()
    )
  }

  private newEntityId(label: string): string {
    const id = this.idFactory()
    this.assertId(label, id)
    return id
  }

  private assertScope(projectId: string, threadId: string): void {
    this.assertId('project', projectId)
    this.assertId('thread', threadId)
  }

  private assertId(label: string, id: string): void {
    if (!SAFE_ID.test(id)) {
      throw new SpecEngineError('invalid_id', `Invalid ${label} ID: "${id}"`)
    }
  }

  private assertVersion(version: number): void {
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new SpecEngineError('invalid_version', `Invalid specification version: ${version}`)
    }
  }

  private assertContextPath(path: string): void {
    if (
      isAbsolute(path) ||
      win32.isAbsolute(path) ||
      path.split(/[\\/]+/u).some((segment) => segment === '..')
    ) {
      throw new SpecEngineError(
        'invalid_context_path',
        `Context path must be project-relative: "${path}"`
      )
    }
  }

  private assertContext(context: SpecContextReference[]): void {
    const ids = new Set<string>()
    for (const reference of context) {
      this.assertId('context reference', reference.id)
      if (ids.has(reference.id)) {
        throw new SpecEngineError('duplicate_id', `Duplicate context reference: ${reference.id}`)
      }
      ids.add(reference.id)
    }
    for (const reference of context) {
      if (!reference.label.trim()) {
        throw new SpecEngineError('invalid_transition', 'Context references require a label')
      }
      if (reference.path) this.assertContextPath(reference.path)
      if (reference.content !== undefined && reference.type !== 'memory') {
        throw new SpecEngineError(
          'invalid_transition',
          'Inline context content is permitted only for memory snapshots'
        )
      }
      if (
        reference.type === 'memory' &&
        (!reference.content?.trim() || !/^[a-f0-9]{64}$/u.test(reference.contentHash ?? ''))
      ) {
        throw new SpecEngineError(
          'invalid_transition',
          'Memory context requires immutable content and a SHA-256 hash'
        )
      }
    }
  }

  private legacyThreadSpecsDir(projectId: string, threadId: string): string {
    return join('projects', projectId, 'threads', threadId, 'specs')
  }

  private async legacyBrainstormDirectory(projectId: string, threadId: string): Promise<string> {
    const brainstormDirectory = join('projects', projectId, '.cio', 'brainstorm')
    const threadSuffix = `--${threadId}`
    const existingDirectory = (await this.storage.list(brainstormDirectory)).find((entry) =>
      entry.endsWith(threadSuffix)
    )
    if (existingDirectory) return join(brainstormDirectory, existingDirectory)

    const thread = await this.storage.read<{ title?: unknown }>(
      join('projects', projectId, 'threads', threadId, 'thread.json')
    )
    const title = typeof thread?.title === 'string' ? thread.title : 'feature'
    const slug = featureSlugFromTitle(title)
    return join(brainstormDirectory, `${slug}${threadSuffix}`)
  }

  private versionsDir(projectId: string, threadId: string, specId: string): string {
    return join(this.legacyThreadSpecsDir(projectId, threadId), specId, 'versions')
  }

  private async legacyBrainstormVersionsDir(
    projectId: string,
    threadId: string,
    specId: string
  ): Promise<string> {
    return join(await this.legacyBrainstormDirectory(projectId, threadId), specId, 'versions')
  }

  private versionPath(
    projectId: string,
    threadId: string,
    specId: string,
    version: number
  ): string {
    return join(this.versionsDir(projectId, threadId, specId), `v${version}.json`)
  }

  private workflowPath(projectId: string, threadId: string): string {
    return join(this.legacyThreadSpecsDir(projectId, threadId), 'workflow.json')
  }

  private async legacyBrainstormVersionPath(
    projectId: string,
    threadId: string,
    specId: string,
    version: number
  ): Promise<string> {
    return join(
      await this.legacyBrainstormVersionsDir(projectId, threadId, specId),
      `v${version}.json`
    )
  }
}
