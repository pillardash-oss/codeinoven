import { access, mkdir, mkdtemp, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it } from 'vitest'
import { StorageEngine } from '../../main/storage-engine'
import { PlanEngine } from './plan-engine'

describe('PlanEngine storage boundary', () => {
  it('mirrors concise agent context locally while keeping mutable state in config', async () => {
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

    const engine = new PlanEngine(storage)
    await engine.savePlan('project-1', 'thread-1', '# Plan\n\n- Implement storage\n')
    const checklist = await engine.generateChecklist(
      'project-1',
      'thread-1',
      '- Implement storage'
    )
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
    ).resolves.toBeUndefined()
    await expect(
      access(
        join(configRoot, 'projects', 'project-1', 'threads', 'thread-1', 'checklist.json')
      )
    ).resolves.toBeUndefined()
  })
})
