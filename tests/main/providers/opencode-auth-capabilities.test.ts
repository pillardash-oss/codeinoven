import { beforeEach, describe, expect, it, vi } from 'vitest'

/** The install the orchestrator's version-aware definition resolver sees. */
const state = vi.hoisted(() => ({
  installation: null as null | { command: string; version: string; major: number }
}))

vi.mock('../../../src/main/agents/opencode-installation', () => ({
  cachedOpenCodeInstallation: () => state.installation,
  detectOpenCodeInstallation: async () => state.installation
}))

import { ProviderAccountOrchestrator } from '../../../src/main/providers/provider-account-orchestrator'

/**
 * OpenCode declares native multi-account in its harness manifest. The auth
 * capability is derived from that declaration, and account activation follows
 * only when the installed line actually has a switch command: V2's
 * `opencode auth switch`, which V1 does not have.
 */
describe('opencode auth capabilities', () => {
  beforeEach(() => {
    state.installation = null
  })

  it('advertises multi-account, but activation only on the V2 line', async () => {
    const auth = new ProviderAccountOrchestrator()

    state.installation = { command: 'opencode', version: '1.18.30', major: 1 }
    const v1 = await auth.capabilities('opencode')
    expect(v1?.multipleAccounts).toBe(true)
    expect(v1?.accountActivation).toBe(false)

    state.installation = { command: 'opencode', version: '2.0.14', major: 2 }
    const v2 = await auth.capabilities('opencode')
    expect(v2?.multipleAccounts).toBe(true)
    expect(v2?.accountActivation).toBe(true)
  })

  it('never claims native multi-account for a harness without a native store', async () => {
    const auth = new ProviderAccountOrchestrator()
    const pi = await auth.capabilities('pi')
    expect(pi?.multipleAccounts).toBe(false)
    expect(pi?.accountActivation).toBe(false)
  })

  it('returns null for a harness with no auth definition', async () => {
    const auth = new ProviderAccountOrchestrator()
    expect(await auth.capabilities('not-a-harness')).toBeNull()
  })
})
