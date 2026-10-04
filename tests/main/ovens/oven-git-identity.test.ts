import { describe, expect, it, vi } from 'vitest'
import { OvenGitIdentityService } from '../../../src/main/ovens/oven-git-identity'
import type { OvenPreflightReport } from '../../../src/lib/ovens'
import type { OvenSsh } from '../../../src/main/ovens/oven-ssh'
import type { SecretVault } from '../../../src/main/storage/secret-vault'

const report: OvenPreflightReport = {
  ovenId: 'oven-test', checkedAt: 1, platform: 'linux', architecture: 'x64', osName: 'Linux',
  osVersion: null, packageManager: 'apt', privilege: 'none',
  git: { installed: true, version: '2.43.0', path: '/usr/bin/git' },
  curl: { installed: true, version: '8.5.0', path: '/usr/bin/curl' },
  node: { installed: true, version: 'v22.13.1', path: '/usr/bin/node' },
  npm: { installed: true, version: '10.5.0', path: '/usr/bin/npm' },
  harnesses: [], osUpdateRequired: false, rebootRequired: false, durationMs: 1
}

describe('oven Git identity', () => {
  it('reports an untrusted GitHub host key instead of accepting it', async () => {
    const execute = vi.fn(async (_id: string, command: string) =>
      command.startsWith('test -f') ? 'present' : 'Host key verification failed'
    )
    const ssh = { execute } as unknown as OvenSsh
    const service = new OvenGitIdentityService({ ssh, vault: {} as SecretVault })
    const result = await service.verify('oven-test', report)
    expect(result.status).toBe('host-key-untrusted')
    expect(result.expectedHostKeyFingerprints.length).toBeGreaterThan(0)
    expect(result.message).toContain(result.expectedHostKeyFingerprints[0] ?? 'unreachable')
    expect(execute.mock.calls[1]?.[1]).toContain('StrictHostKeyChecking=yes')
  })

  it('does not contact SSH when Git is missing', async () => {
    const execute = vi.fn(async () => '')
    const service = new OvenGitIdentityService({ ssh: { execute } as unknown as OvenSsh, vault: {} as SecretVault })
    const result = await service.verify('oven-test', {
      ...report,
      git: { installed: false, version: null, path: null }
    })
    expect(result.status).toBe('git-missing')
    expect(execute).not.toHaveBeenCalled()
  })
})
