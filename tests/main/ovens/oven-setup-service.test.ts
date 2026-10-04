import { describe, it, expect } from 'vitest'
import { OvenSetupService } from '../../../src/main/ovens/oven-setup-service'

const defaultConfig = {
  selectedHarnesses: [],
  synchronizeAccounts: false,
  synchronizeConfiguration: false,
  git: { enabled: false, host: 'github' as const },
  packageUpgrades: false
}

describe('oven setup service', () => {
  it('starts a setup operation', () => {
    const service = new OvenSetupService()
    const op = service.startSetup('oven1', defaultConfig)
    expect(op.id).toBeDefined()
    expect(op.status).toBeDefined()
    expect(op.ovenId).toBe('oven1')
  })

  it('cancels setup', () => {
    const service = new OvenSetupService()
    const op = service.startSetup('oven1', defaultConfig)
    const cancelled = service.cancelSetup(op.id)
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.finishedAt).toBeDefined()
  })

  it('retries setup', () => {
    const service = new OvenSetupService()
    const op = service.startSetup('oven1', defaultConfig)
    service.cancelSetup(op.id)
    const retried = service.retrySetup(op.id)
    expect(retried.status).toBe('preparing')
  })

  it('gets operation for oven', () => {
    const service = new OvenSetupService()
    const op = service.startSetup('oven1', defaultConfig)
    const found = service.getOperationForOven('oven1')
    expect(found?.id).toBe(op.id)
  })
})
