import { createHash } from 'crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { APP_SLUG, ORG_SLUG } from '../../src/lib/brand'
import type { Project } from '../../src/lib/types'
import { ProjectManager } from '../../src/lib/engines/project-manager'
import type { Database } from '../../src/main/database/database'
import { createTestDb, destroyTestDb } from './database/test-helper'
import { SpecContextService } from '../../src/main/chat/spec-context-service'

const temporaryPaths: string[] = []
const testDatabases: Database[] = []
const originalHome = process.env.HOME

async function setup(source: Project['source'] = 'local'): Promise<{
  configRoot: string
  projectRoot: string
  projectId: string
  service: SpecContextService
}> {
  const root = await mkdtemp(join(tmpdir(), 'codeinoven-spec-context-'))
  temporaryPaths.push(root)
  process.env.HOME = root
  const configRoot = join(root, '.config', ORG_SLUG, APP_SLUG)
  const projectRoot = join(root, 'project')
  await mkdir(projectRoot)

  const database = await createTestDb()
  testDatabases.push(database)
  const projects = new ProjectManager(database)
  await projects.createProject({
    name: 'Test',
    path: projectRoot,
    source
  })
  const [project] = await projects.listProjects()
  if (!project) throw new Error('Test project was not created')

  return {
    configRoot,
    projectRoot,
    projectId: project.id,
    service: new SpecContextService(database, {
      getProject: (projectId) => projects.getProject(projectId)
    })
  }
}

afterEach(async () => {
  process.env.HOME = originalHome
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
  for (const database of testDatabases.splice(0)) destroyTestDb(database)
})

describe('SpecContextService', () => {
  it('captures a project file with a POSIX-relative path and sha256 hash', async () => {
    const { projectRoot, projectId, service } = await setup()
    const source = join(projectRoot, 'src', 'rule.md')
    await mkdir(join(projectRoot, 'src'))
    await writeFile(source, 'explicit context')

    const reference = await service.capture(projectId, source, 'project_rule')

    expect(reference.type).toBe('project_rule')
    expect(reference.path).toBe('src/rule.md')
    expect(reference.label).toBe('rule.md')
    expect(reference.contentHash).toBe(
      createHash('sha256').update('explicit context').digest('hex')
    )
  })

  it('rejects files outside the project and symlinks that escape it', async () => {
    const { projectRoot, projectId, service } = await setup()
    const outside = join(projectRoot, '..', 'outside.txt')
    const escape = join(projectRoot, 'escape.txt')
    await writeFile(outside, 'outside')
    await symlink(outside, escape)

    await expect(service.capture(projectId, outside, 'project_file')).rejects.toThrow(
      'outside the project root'
    )
    await expect(service.capture(projectId, escape, 'project_file')).rejects.toThrow(
      'outside the project root'
    )
  })

  it('copies an external attachment under a generated name without exposing its path', async () => {
    const { configRoot, projectRoot, projectId, service } = await setup()
    const source = join(projectRoot, '..', 'design.txt')
    await writeFile(source, 'attachment body')

    const reference = await service.capture(projectId, source, 'attachment')
    const stored = join(
      configRoot,
      'projects',
      projectId,
      'spec-context',
      'attachments',
      reference.id
    )

    expect(reference.path).toBeUndefined()
    expect(reference.label).toBe('design.txt')
    expect(stored).not.toContain('design.txt')
    expect(await readFile(stored, 'utf8')).toBe('attachment body')
  })

  it('rejects missing files, directories, oversized attachments, and SSH projects', async () => {
    const { projectRoot, projectId, service } = await setup()
    const oversized = join(projectRoot, '..', 'oversized.bin')
    await writeFile(oversized, Buffer.alloc(16 * 1024 * 1024 + 1))

    await expect(
      service.capture(projectId, join(projectRoot, 'missing'), 'project_file')
    ).rejects.toThrow('does not exist')
    await expect(service.capture(projectId, projectRoot, 'project_file')).rejects.toThrow(
      'must be a file'
    )
    await expect(service.capture(projectId, oversized, 'attachment')).rejects.toThrow('16 MiB')

    const sshSetup = await setup('ssh')
    await expect(
      sshSetup.service.capture(sshSetup.projectId, oversized, 'attachment')
    ).rejects.toThrow('SSH projects')
  })
})
