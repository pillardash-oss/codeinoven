import { describe, expect, it } from 'vitest'
import { CIO_UTILITY_SETUP_PROMPT, isCioUtilityRequest } from '../../../src/main/utilities/cio-utility-prompt'
import { GATEWAY_TOOLS, UTILITY_DIAGNOSTICS_TOOL_NAME, UTILITY_MANAGE_TOOL_NAME } from '../../../src/lib/gateway-tools'

describe('cio-utility contract', () => {
  it('activates on an unquoted @cio-utility tag', () => {
    expect(isCioUtilityRequest('cio please @cio-utility add a skill')).toBe(true)
    expect(isCioUtilityRequest('@cio-utility the app crashed on checkout')).toBe(true)
    expect(isCioUtilityRequest('@cio-utility. It crashed')).toBe(true)
  })

  it('never activates when the tag appears inside a quote', () => {
    expect(isCioUtilityRequest('remember to write "@cio-utility" in the docs')).toBe(false)
    expect(isCioUtilityRequest('the guide says use “@cio-utility” for setup')).toBe(false)
    expect(isCioUtilityRequest('> try tagging @cio-utility next time')).toBe(false)
  })

  it('documents the diagnostics actions and read-only guarantee in the prompt', () => {
    expect(CIO_UTILITY_SETUP_PROMPT).toContain('utility_diagnostics')
    for (const action of ['lookup_thread', 'search_threads', 'read_messages', 'read_log']) {
      expect(CIO_UTILITY_SETUP_PROMPT).toContain(action)
    }
    expect(CIO_UTILITY_SETUP_PROMPT).toContain('logs/error.log')
    expect(CIO_UTILITY_SETUP_PROMPT).toContain('read-only')
    expect(CIO_UTILITY_SETUP_PROMPT).toContain('install_bundle')
  })

  it('exposes diagnostics and manage with explicit-turn routing in the gateway catalog', () => {
    const diagnostics = GATEWAY_TOOLS.find((tool) => tool.name === UTILITY_DIAGNOSTICS_TOOL_NAME)
    expect(diagnostics).toBeDefined()
    expect(diagnostics?.route).toBe('/diagnostics')
    expect(diagnostics?.inputSchema).toMatchObject({ required: ['action'] })
    const manage = GATEWAY_TOOLS.find((tool) => tool.name === UTILITY_MANAGE_TOOL_NAME)
    expect(manage?.route).toBe('/manage')
  })
})
