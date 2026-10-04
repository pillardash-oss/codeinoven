import { describe, it, expect } from 'vitest'
import { detectCapabilities } from '../../../src/main/ovens/oven-setup-capabilities'

describe('oven setup contracts', () => {
  it('detects capabilities', async () => {
    const caps = await detectCapabilities()
    expect(caps).toBeDefined()
    expect(caps.platform).toBeDefined()
    expect(caps.harnesses).toBeInstanceOf(Array)
  })

  it('identifies supported platforms', async () => {
    const caps = await detectCapabilities()
    expect(['linux', 'darwin', 'win32']).toContain(caps.platform)
  })
})
