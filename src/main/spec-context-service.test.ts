import { createHash } from 'crypto'
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it } from 'vitest'
import type { Project } from '../lib/types'
import { ProjectManager } from '../lib/engines/project-manager'
import { StorageEngine } from './storage-engine'
import { SpecContextService } from './spec-context-service'

async function setup(source: Project['source'] = 'local'): Promise<{
  configRoot: string
  projectRoot: string
  service: SpecContextService
}> {
  const root = await mkdtemp(join(tmpdir(), 'codeinoven-spec-context-'))
  const configRoot = join(root, 'config')
  const projectRoot = join(root, 'project')
  await mkdir(projectRoot)

  const storage = new StorageEngine(configRoot)
  await storage.initialize()
  const projects = new ProjectManager(storage)
  await projects.createProject({
    name: 'Test',
    path: projectRoot,
    source
  })
  const [project] = await projects.listProjects()

  return {
    configRoot,
    projectRoot,
    service: new SpecContextService(storage, {
      getProject: (projectId) => projects.getProject(projectId)
    })
  }
}

describe('SpecContextService', () => {
  it('captures a project file with a POSIX-relative path and sha256 hash', async () => {
    const { projectRoot, service } = await setup()
    const source = join(projectRoot, 'src', 'rule.md')
    await mkdir(join(projectRoot, 'src'))
    await writeFile(source, 'explicit context')

    const [projectId] = await new StorageEngine(
      join(projectRoot, '..', 'config')
    ).list('projects')
    const reference = await service.capture(projectId, source, 'project_rule')

    expect(reference.type).toBe('project_rule')
    expect(reference.path).toBe('src/rule.md')
    expect(reference.label).toBe('rule.md')
    expect(reference.contentHash).toBe(
      createHash('sha256').update('explicit context').digest('hex')
    )
  })

  it('rejects files outside the project and symlinks that escape it', async () => {
    const { configRoot, projectRoot, service } = await setup()
    const outside = join(projectRoot, '..', 'outside.txt')
    const escape = join(projectRoot, 'escape.txt')
    await writeFile(outside, 'outside')
    await symlink(outside, escape)
    const [projectId] = await new StorageEngine(configRoot).list('projects')

    await expect(service.capture(projectId, outside, 'project_file')).rejects.toThrow(
      'outside the project root'
    )
    await expect(service.capture(projectId, escape, 'project_file')).rejects.toThrow(
      'outside the project root'
    )
  })

  it('copies an external attachment under a generated name without exposing its path', async () => {
    const { configRoot, projectRoot, service } = await setup()
    const source = join(projectRoot, '..', 'design.txt')
    await writeFile(source, 'attachment body')
    const [projectId] = await new StorageEngine(configRoot).list('projects')

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
    const { configRoot, projectRoot, service } = await setup()
    const [projectId] = await new StorageEngine(configRoot).list('projects')
    const oversized = join(projectRoot, '..', 'oversized.bin')
    await writeFile(oversized, Buffer.alloc(16 * 1024 * 1024 + 1))

    await expect(
      service.capture(projectId, join(projectRoot, 'missing'), 'project_file')
    ).rejects.toThrow('does not exist')
    await expect(service.capture(projectId, projectRoot, 'project_file')).rejects.toThrow(
      'must be a file'
    )
    await expect(service.capture(projectId, oversized, 'attachment')).rejects.toThrow(
      '16 MiB'
    )

    const sshSetup = await setup('ssh')
    const [sshProjectId] = await new StorageEngine(sshSetup.configRoot).list('projects')
    await expect(
      sshSetup.service.capture(sshProjectId, oversized, 'attachment')
    ).rejects.toThrow('SSH projects')
  })
})
