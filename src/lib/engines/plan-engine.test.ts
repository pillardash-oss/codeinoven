import { access, mkdir, mkdtemp, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { StorageEngine } from '../../main/storage-engine'
import type { Database } from '../../main/database/database'
import { createTestDb, destroyTestDb } from '../../main/database/test-helper'
import { ProjectRepo } from '../../main/database/repositories/project-repo'
import { ThreadRepo } from '../../main/database/repositories/thread-repo'
import { PlanEngine } from './plan-engine'

const testDatabases: Database[] = []

afterEach(() => {
  for (const database of testDatabases.splice(0)) destroyTestDb(database)
})

describe('PlanEngine storage boundary', () => {
  it('mirrors concise agent context locally while keeping mutable state in the database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeinoven-plan-engine-'))
    const configRoot = join(root, 'config')
    const projectRoot = join(root, 'project')
    await mkdir(projectRoot)
    const storage = new StorageEngine(configRoot)
    await storage.initialize()
    await storage.write('projects/project-1/project.json', {
      id: 'project-1',
      source: 'local',
      path: projectRoot
    })
    await storage.write('projects/project-1/threads/thread-1/thread.json', {
      id: 'thread-1',
      projectId: 'project-1',
      title: 'Durable Plans',
      updatedAt: Date.now()
    })

    const database = await createTestDb()
    testDatabases.push(database)
    const now = Date.now()
    new ProjectRepo(database).upsert({
      id: 'project-1',
      name: 'Durable Plans project',
      path: projectRoot,
      source: 'local',
      providerId: 'opencode',
      workflowId: 'default',
      threadLimit: 70,
      changeTrackingMode: 'manual',
      createdAt: now,
      updatedAt: now
    })
    new ThreadRepo(database).upsert({
      id: 'thread-1',
      projectId: 'project-1',
      providerId: 'opencode',
      title: 'Durable Plans',
      titleSource: 'manual',
      status: 'created',
      pinned: false,
      archived: false,
      read: true,
      createdAt: now,
      updatedAt: now,
      lastActivity: now,
      workingDirectory: projectRoot
    })

    const engine = new PlanEngine(storage, database)
    await engine.savePlan('project-1', 'thread-1', '# Plan\n\n- Implement storage\n')
    const checklist = await engine.generateChecklist('project-1', 'thread-1', '- Implement storage')
    await engine.updateChecklistItem(
      'project-1',
      'thread-1',
      checklist.items[0].id,
      'complete',
      'Tests passed'
    )

    const featureRoot = join(projectRoot, '.cio', 'specs', 'durable-plans')
    await expect(readFile(join(featureRoot, 'plan.md'), 'utf8')).resolves.toContain(
      'Implement storage'
    )
    await expect(readFile(join(featureRoot, 'progress.md'), 'utf8')).resolves.toContain(
      '- [x] Implement storage'
    )
    await expect(
      access(join(configRoot, 'projects', 'project-1', 'threads', 'thread-1', 'plan.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      access(join(configRoot, 'projects', 'project-1', 'threads', 'thread-1', 'checklist.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
