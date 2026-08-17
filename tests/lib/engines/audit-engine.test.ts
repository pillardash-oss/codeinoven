import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createTestDb, destroyTestDb } from '../../main/database/test-helper'
import { ProjectRepo } from '../../../src/main/database/repositories/project-repo'
import { ThreadManager } from '../../../src/lib/engines/thread-manager'
import { StorageEngine } from '../../../src/main/storage/storage-engine'
import { AuditEngine } from '../../../src/lib/engines/audit-engine'
import type { Database } from '../../../src/main/database/database'

const CONTENT = {
  executiveSummary: 'The implementation passes.',
  findings: [
    {
      id: 'f1',
      title: 'Category A verified',
      severity: 'low' as const,
      description: 'All checks pass.',
      evidence: 'tests pass'
    }
  ],
  resolutionRecommendation: 'Proceed to close-out.',
  conclusion: 'Complete.'
}

describe('AuditEngine', () => {
  let db: Database
  let root: string
  let projectPath: string
  let storage: StorageEngine
  let threadId: string

  beforeEach(async () => {
    db = await createTestDb()
    root = await mkdtemp(join(tmpdir(), 'cio-audit-'))
    projectPath = join(root, 'project')
    storage = new StorageEngine(join(root, 'config'))
    await storage.initialize()
    new ProjectRepo(db).upsert({
      id: 'project-1',
      name: 'Website',
      path: projectPath,
      source: 'local',
      providerId: 'opencode',
      workflowId: 'default',
      threadLimit: 70,
      changeTrackingMode: 'manual',
      createdAt: 1,
      updatedAt: 1
    })
    const thread = await new ThreadManager(db).createThread({
      projectId: 'project-1',
      providerId: 'opencode',
      title: 'Audited work',
      workingDirectory: projectPath
    })
    threadId = thread.id
  })

  afterEach(async () => {
    destroyTestDb(db)
    await rm(root, { recursive: true, force: true })
  })

  it('materializes the audit report markdown when created for a local project', async () => {
    const engine = new AuditEngine(storage, db)
    const report = await engine.create({
      projectId: 'project-1',
      threadId,
      specId: 'spec-1',
      specVersion: 1,
      content: CONTENT,
      provenance: { source: 'agent', actor: 'auditor' }
    })

    const featureSlug = 'audited-work'
    const auditPath = join(
      projectPath,
      '.cio/specs',
      featureSlug,
      'versions',
      `${report.id}-audit-v${report.version}.md`
    )
    const markdown = await readFile(auditPath, 'utf-8')
    expect(markdown).toContain('The implementation passes.')

    const canonical = join(projectPath, '.cio/specs', featureSlug, 'audit.md')
    expect(await readFile(canonical, 'utf-8')).toContain('The implementation passes.')
  })

  it('keeps the DB row authoritative for projects without a local root', async () => {
    new ProjectRepo(db).upsert({
      id: 'remote-1',
      name: 'Remote',
      path: '',
      source: 'ssh',
      providerId: 'opencode',
      workflowId: 'default',
      threadLimit: 70,
      changeTrackingMode: 'manual',
      createdAt: 1,
      updatedAt: 1
    })
    const engine = new AuditEngine(storage, db)
    const report = await engine.create({
      projectId: 'remote-1',
      threadId,
      specId: 'spec-1',
      specVersion: 1,
      content: CONTENT,
      provenance: { source: 'agent', actor: 'auditor' }
    })
    expect(report.id).toBeTruthy()
    expect(engine.getActive('remote-1', threadId)?.content.conclusion).toBe('Complete.')
  })
})
