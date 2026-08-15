import { access, mkdir, mkdtemp, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it } from 'vitest'
import type { CloudDeploymentAccountRegistry, CloudDeploymentConfig } from '../../src/lib/types'
import { StorageEngine } from '../../src/main/storage/storage-engine'

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

  it('persists and reads a per-project cloud deployment config under the config dir', async () => {
    const { storage, configRoot, projectRoot } = await setup()
    const config: CloudDeploymentConfig = {
      version: 3,
      projectId: 'project-1',
      project: {
        providers: ['vercel'],
        containers: [{ id: 'app-1', label: 'My App', providerKind: 'vercel', status: 'success' }],
        providerAccounts: {
          vercel: { attachedAccountIds: ['account-vercel'], activeAccountId: 'account-vercel' }
        }
      },
      updatedAt: 1_700_000_000_000
    }

    await storage.saveCloudDeploymentConfig('project-1', config)
    await expect(storage.getCloudDeploymentConfig('project-1')).resolves.toEqual(config)
    await expect(storage.hasCloudDeployments('project-1')).resolves.toBe(true)

    await expect(
      access(join(configRoot, 'projects', 'project-1', 'cloud-deployment.json'))
    ).resolves.toBeUndefined()
    await expect(access(join(projectRoot, 'cloud-deployment.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('flags a project without configured providers as having no deployments', async () => {
    const { storage } = await setup()
    await expect(storage.hasCloudDeployments('project-1')).resolves.toBe(false)

    await storage.saveCloudDeploymentConfig('project-1', {
      version: 3,
      projectId: 'project-1',
      project: { providers: [], containers: [] },
      updatedAt: 1_700_000_000_000
    })
    await expect(storage.hasCloudDeployments('project-1')).resolves.toBe(false)

    await storage.clearCloudDeploymentConfig('project-1')
    await expect(storage.getCloudDeploymentConfig('project-1')).resolves.toBeNull()
    await expect(storage.hasCloudDeployments('project-1')).resolves.toBe(false)
  })

  it('persists a global cloud deployment account registry under the config dir', async () => {
    const { storage, configRoot, projectRoot } = await setup()
    const registry: CloudDeploymentAccountRegistry = {
      accounts: [
        {
          id: 'account-1',
          label: 'Coolify — Personal',
          providerKind: 'coolify',
          secretRef: 'vault:account-1',
          configured: true,
          enabled: true,
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000
        }
      ]
    }

    await storage.saveCloudDeploymentAccounts(registry)
    await expect(storage.getCloudDeploymentAccounts()).resolves.toEqual(registry)

    // The registry is global — never inside a project directory.
    await expect(
      access(join(configRoot, 'cloud-deployments', 'accounts.json'))
    ).resolves.toBeUndefined()
    await expect(access(join(projectRoot, 'cloud-deployments'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})
