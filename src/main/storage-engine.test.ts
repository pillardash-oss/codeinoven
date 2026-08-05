import { access, mkdir, mkdtemp, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it } from 'vitest'
import { StorageEngine } from './storage-engine'
import { ProjectManager } from '../lib/engines/project-manager'

async function setup(): Promise<{
  storage: StorageEngine
  configRoot: string
  projectRoot: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'codeinoven-storage-boundary-'))
  const configRoot = join(root, 'config')
  const projectRoot = join(root, 'project')
  await mkdir(projectRoot, { recursive: true })
  const storage = new StorageEngine(configRoot)
  await storage.initialize()
  await storage.write('projects/project-1/project.json', {
    id: 'project-1',
    source: 'local',
    path: projectRoot
  })
  return { storage, configRoot, projectRoot }
}

describe('StorageEngine project boundary', () => {
  it('writes only explicit agent context into the project .cio directory', async () => {
    const { storage, configRoot, projectRoot } = await setup()

    await storage.writeProjectSpecRaw(
      'project-1',
      'markdown-rendering',
      'spec.md',
      '# Specification\n'
    )
    await storage.writeProjectSpecRaw('project-1', 'markdown-rendering', 'plan.md', '# Plan\n')

    expect(
      await readFile(join(projectRoot, '.cio', 'specs', 'markdown-rendering', 'spec.md'), 'utf8')
    ).toBe('# Specification\n')
    expect(
      await readFile(join(projectRoot, '.cio', 'specs', 'markdown-rendering', 'plan.md'), 'utf8')
    ).toBe('# Plan\n')
    await expect(
      access(join(projectRoot, '.cio', 'specs', 'markdown-rendering--thread-1'))
    ).rejects.toMatchObject({ code: 'ENOENT' })

    await storage.write('projects/project-1/threads/thread-1/checkpoints/turn-1.json', {
      status: 'completed'
    })
    await storage.write('projects/project-1/threads/thread-1/specs/workflow.json', {
      stage: 'spec_drafting'
    })
    await storage.appendRaw(
      'projects/project-1/threads/thread-1/history/chunk-000000.jsonl',
      '{}\n'
    )

    for (const relativePath of [
      'threads/thread-1/checkpoints/turn-1.json',
      'threads/thread-1/specs/workflow.json',
      'threads/thread-1/history/chunk-000000.jsonl'
    ]) {
      await expect(
        access(join(configRoot, 'projects', 'project-1', relativePath))
      ).resolves.toBeUndefined()
    }
  })

  it('rejects unsafe feature slugs', async () => {
    const { storage } = await setup()
    await expect(
      storage.writeProjectSpecRaw('project-1', '../escape', 'spec.md', 'unsafe')
    ).rejects.toThrow('Invalid feature slug')
  })

  it('removes app runtime state but leaves repository-owned specs on project deletion', async () => {
    const { storage, configRoot, projectRoot } = await setup()
    await storage.write('projects/project-1/threads/thread-1/checkpoints/turn-1.json', {
      status: 'completed'
    })
    await storage.writeProjectSpecRaw(
      'project-1',
      'durable-feature',
      'spec.md',
      '# Durable feature\n'
    )

    await new ProjectManager(storage).deleteProject('project-1')

    await expect(access(join(configRoot, 'projects', 'project-1'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(
      access(join(projectRoot, '.cio', 'specs', 'durable-feature', 'spec.md'))
    ).resolves.toBeUndefined()
  })
})
