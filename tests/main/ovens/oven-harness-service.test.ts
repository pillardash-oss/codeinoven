import { describe, expect, it, vi } from 'vitest'
import { OvenHarnessService } from '../../../src/main/ovens/oven-harness-service'
import type { OvenService } from '../../../src/main/ovens/oven-service'
import type { OvenProbe } from '../../../src/lib/ovens'
import type { StorageEngine } from '../../../src/main/storage/storage-engine'

const probe: OvenProbe = {
  protocolVersion: 1,
  serviceRevision: 'test',
  platform: 'linux',
  architecture: 'x64',
  home: '/home/test',
  nodeVersion: 'v22.13.1',
  specs: {
    hostname: 'oven-test',
    platform: 'linux',
    architecture: 'x64',
    cpuCount: 4,
    memoryBytes: 8 * 1024 ** 3,
    diskBytes: 50 * 1024 ** 3,
    diskAvailableBytes: 25 * 1024 ** 3,
    nodeVersion: 'v22.13.1'
  },
  harnesses: [
    { command: 'codex', path: '/home/test/.npm/bin/codex' },
    { command: 'claude', path: null }
  ],
  activeRuns: 0
}

function harnessService() {
  const execute = vi.fn(
    async (_ovenId: string, _command: string, _input: string, _timeout?: number) => 'done'
  )
  const oven = {
    probe: vi.fn(async () => probe),
    runs: vi.fn(async () => []),
    ssh: { execute }
  } as unknown as OvenService
  const storage = {
    read: vi.fn(async () => null),
    // The service now keeps a persisted copy of each Oven's inventory, so a
    // stub without a write sink no longer satisfies its storage dependency.
    write: vi.fn(async () => undefined)
  } as unknown as StorageEngine
  return { service: new OvenHarnessService(oven, storage), oven, execute }
}

describe('oven harness service', () => {
  it('maps probe paths into installed and missing inventory rows', async () => {
    const { service } = harnessService()
    const inventory = await service.getInventory('oven-test')
    expect(inventory.find((item) => item.command === 'codex')?.executablePath).toBe(
      '/home/test/.npm/bin/codex'
    )
    expect(inventory.find((item) => item.command === 'claude')?.health).toBe('missing')
  })

  it('waits for an active harness run before updating it', async () => {
    const { service, oven, execute } = harnessService()
    vi.mocked(oven.runs).mockResolvedValue([
      { id: 'run-1', command: 'codex', status: 'running' } as Awaited<
        ReturnType<OvenService['runs']>
      >[number]
    ])
    const update = service.updateHarness('oven-test', 'codex')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(execute).not.toHaveBeenCalled()
    vi.mocked(oven.runs).mockResolvedValue([])
    await update
    expect(execute).toHaveBeenCalledOnce()
  })

  it('runs only the selected harness update command', async () => {
    const { service, execute } = harnessService()
    await service.updateHarness('oven-test', 'codex')
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]?.[1]).toContain('codex')
    expect(execute.mock.calls[0]?.[1]).toContain('update')
  })
})
