import { describe, it, expect } from 'vitest'
import { OvenHarnessService } from '../../../src/main/ovens/oven-harness-service'

describe('oven harness service', () => {
  it('gets inventory', async () => {
    const service = new OvenHarnessService()
    const inv = await service.getInventory('oven1')
    expect(inv).toBeInstanceOf(Array)
  })

  it('updates harness', async () => {
    const service = new OvenHarnessService()
    const result = await service.updateHarness('oven1', 'codex')
    expect(result.harnessId).toBe('codex')
    expect(result.checkedAt).toBeDefined()
  })

  it('uninstalls harness', async () => {
    const service = new OvenHarnessService()
    const result = await service.uninstallHarness('oven1', 'codex')
    expect(result.harnessId).toBe('codex')
    expect(result.health).toBeDefined()
  })
})
