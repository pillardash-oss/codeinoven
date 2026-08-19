import { describe, expect, it } from 'vitest'
import { LatestRequestGuard } from '../../../src/renderer/lib/refresh-guard'

describe('LatestRequestGuard', () => {
  it('invalidates an older async result when a newer request begins', () => {
    const guard = new LatestRequestGuard()
    const firstRequest = guard.begin()
    const latestRequest = guard.begin()

    expect(guard.isCurrent(firstRequest)).toBe(false)
    expect(guard.isCurrent(latestRequest)).toBe(true)
  })
})
