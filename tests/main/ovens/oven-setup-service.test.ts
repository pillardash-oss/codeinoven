import { describe, expect, it, vi } from 'vitest'
import { OvenSetupService } from '../../../src/main/ovens/oven-setup-service'
import type { OvenSetupPorts } from '../../../src/main/ovens/oven-setup-service'
import type { StorageEngine } from '../../../src/main/storage/storage-engine'
import type { OvenPreflightReport } from '../../../src/lib/ovens'

const healthyReport: OvenPreflightReport = {
  ovenId: 'oven-test',
  checkedAt: 123,
  platform: 'linux',
  architecture: 'x64',
  osName: 'Ubuntu',
  osVersion: '24.04',
  packageManager: 'apt',
  privilege: 'passwordless-sudo',
  git: { installed: true, version: '2.43.0', path: '/usr/bin/git' },
  curl: { installed: true, version: '8.5.0', path: '/usr/bin/curl' },
  node: { installed: true, version: 'v22.13.1', path: '/usr/bin/node' },
  npm: { installed: true, version: '10.5.0', path: '/usr/bin/npm' },
  timezone: { current: 'Africa/Lagos', method: 'timedatectl' },
  harnesses: [],
  osUpdateRequired: false,
  rebootRequired: false,
  durationMs: 12
}

function createService() {
  const execute = vi.fn(async () => '')
  const storage = {
    listDirectories: vi.fn(async () => []),
    read: vi.fn(async () => null),
    write: vi.fn(async () => undefined)
  } as unknown as StorageEngine
  const ports: OvenSetupPorts = {
    ssh: { execute } as unknown as OvenSetupPorts['ssh'],
    preflight: vi.fn(async () => healthyReport),
    installService: vi.fn(async () => undefined),
    syncAccounts: vi.fn(async () => []),
    configureGit: vi.fn(async () => []),
    syncTimezone: vi.fn(async () => ({
      status: 'current' as const,
      zone: 'Africa/Lagos',
      message: 'The Oven already runs on Africa/Lagos.'
    }))
  }
  return { service: new OvenSetupService(storage, ports), ports, execute }
}

describe('oven setup service', () => {
  it('returns read-only preflight assessment without touching the oven', async () => {
    const { service, ports, execute } = createService()
    const result = await service.preflight('oven-test')
    expect(result.report.ovenId).toBe('oven-test')
    expect(result.assessment.prerequisitesSatisfied).toBe(true)
    expect(ports.preflight).toHaveBeenCalledOnce()
    expect(execute).not.toHaveBeenCalled()
  })

  it('reports no operation before setup starts', async () => {
    const { service } = createService()
    await expect(service.getOperationForOven('oven-test')).resolves.toBeNull()
  })

  it('keeps setup completion sticky when a later setup update fails', async () => {
    const { service, ports } = createService()
    vi.mocked(ports.installService)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('service refresh failed'))
    const configuration = {
      selectedHarnesses: [],
      synchronizeAccounts: false,
      synchronizeConfiguration: false,
      git: { enabled: false as const, host: 'github' as const },
      packageUpgrades: false
    }

    const first = await service.startSetup('oven-test', configuration)
    expect(first.setupComplete).toBe(false)
    await waitForStatus(service, 'succeeded')

    const second = await service.startSetup('oven-test', configuration)
    expect(second.setupComplete).toBe(true)
    const failed = await waitForStatus(service, 'failed')
    expect(failed.setupComplete).toBe(true)
  })
})

async function waitForStatus(service: OvenSetupService, status: 'succeeded' | 'failed') {
  for (let attempt = 0; attempt < 100; attempt++) {
    const operation = await service.getOperationForOven('oven-test')
    if (operation?.status === status) return operation
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Setup did not reach ${status}.`)
}
