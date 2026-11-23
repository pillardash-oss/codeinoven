import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectEnvFile } from '../../src/lib/project-env'

const invoke = vi.fn()

vi.mock('$lib/ipc.svelte', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

type Store = typeof import('../../src/renderer/lib/stores/project-secrets.svelte')
type Presence = Store['projectSecretsPresence']

/** One stored manifest: a group, a file name, and the keys it holds. */
function manifest(group: string, fileName: string, names: string[]): ProjectEnvFile {
  return {
    group,
    fileName,
    entries: names.map((name, index) => ({
      name,
      secretRef: `ref-${group}-${name}-${index}`,
      updatedAt: 1
    })),
    updatedAt: 1
  }
}

/** A fresh module instance, because the presence is one map per window. */
async function freshPresence(): Promise<Presence> {
  vi.resetModules()
  const loaded = await import('../../src/renderer/lib/stores/project-secrets.svelte')
  return loaded.projectSecretsPresence
}

describe('project secrets presence', () => {
  beforeEach(() => {
    invoke.mockReset()
  })

  it('reads a project manifest once and answers for its root', async () => {
    invoke.mockResolvedValue([manifest('', '.env', ['OPENAI_KEY'])])
    const presence = await freshPresence()

    await presence.ensure('project-1')
    await presence.ensure('project-1')

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('secrets:envList', 'project-1')
    expect(presence.hasKeys('project-1', '')).toBe(true)
  })

  it('shares one read between two mounts of the same project', async () => {
    invoke.mockResolvedValue([manifest('', '.env', ['A'])])
    const presence = await freshPresence()

    await Promise.all([presence.ensure('project-1'), presence.ensure('project-1')])

    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('answers a subfolder only for its own keys', async () => {
    invoke.mockResolvedValue([
      manifest('packages/api', '.env', ['API_KEY']),
      manifest('packages/web', '.env.deploy', [])
    ])
    const presence = await freshPresence()

    await presence.ensure('project-1')

    expect(presence.hasKeys('project-1', 'packages/api')).toBe(true)
    expect(presence.hasKeys('project-1', 'packages/web')).toBe(false)
    // The root stands for the whole project, so keys anywhere light the button.
    expect(presence.hasKeys('project-1', '')).toBe(true)
  })

  it('has no keys for a project it never read, or for an empty manifest', async () => {
    invoke.mockResolvedValue([manifest('', '.env', [])])
    const presence = await freshPresence()

    expect(presence.hasKeys('project-1', '')).toBe(false)

    await presence.ensure('project-1')
    expect(presence.hasKeys('project-1', '')).toBe(false)
  })

  it('takes the manifest the panel publishes, so an edit lands without a re-read', async () => {
    invoke.mockResolvedValue([])
    const presence = await freshPresence()

    await presence.ensure('project-1')
    expect(presence.hasKeys('project-1', '')).toBe(false)

    presence.publish('project-1', [manifest('', '.env', ['NEW_KEY'])])
    expect(presence.hasKeys('project-1', '')).toBe(true)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('leaves the dot off when the manifest cannot be read, and retries later', async () => {
    invoke.mockRejectedValueOnce(new Error('vault locked'))
    invoke.mockResolvedValueOnce([manifest('', '.env', ['A'])])
    const presence = await freshPresence()

    await presence.ensure('project-1')
    expect(presence.hasKeys('project-1', '')).toBe(false)

    await presence.ensure('project-1')
    expect(presence.hasKeys('project-1', '')).toBe(true)
    expect(invoke).toHaveBeenCalledTimes(2)
  })
})
