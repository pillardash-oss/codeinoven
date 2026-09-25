import { describe, expect, it } from 'vitest'
import { parseOpenCodeV2Handshake } from '../../src/main/opencode-v2/opencode-v2-server'
import {
  mapOpenCodeV2Agents,
  mapOpenCodeV2Models,
  mapOpenCodeV2Providers,
  mapOpenCodeV2ServerIdentity
} from '../../src/main/opencode-v2/opencode-v2-discovery'

describe('opencode v2 handshake parsing', () => {
  it('reads the endpoint only once both announced lines have arrived', () => {
    const listening = 'server listening on http://127.0.0.1:50725'
    const password = 'server password s3cr3t-value'
    expect(parseOpenCodeV2Handshake(listening)).toBeNull()
    expect(parseOpenCodeV2Handshake(password)).toBeNull()
    expect(parseOpenCodeV2Handshake(`${listening}\n${password}\n`)).toEqual({
      baseUrl: 'http://127.0.0.1:50725',
      password: 's3cr3t-value'
    })
  })

  it('tolerates CRLF, blank lines, and interleaved diagnostics', () => {
    const output = [
      'level=INFO message="cli starting"',
      'server listening on http://127.0.0.1:61001',
      '',
      'some other log line',
      'server password p@ss:word/with+specials',
      ''
    ].join('\r\n')
    expect(parseOpenCodeV2Handshake(output)).toEqual({
      baseUrl: 'http://127.0.0.1:61001',
      password: 'p@ss:word/with+specials'
    })
  })

  it('ignores unrelated lines that merely resemble the handshake', () => {
    expect(
      parseOpenCodeV2Handshake('connected to server listening on http://elsewhere:1')
    ).toBeNull()
  })
})

describe('opencode v2 catalog mapping', () => {
  it('maps the server identity and drops a malformed payload', () => {
    expect(
      mapOpenCodeV2ServerIdentity({
        version: '2.0.14',
        pid: 1234,
        urls: ['http://127.0.0.1:50725'],
        paths: { tmp: '/tmp/opencode' }
      })
    ).toEqual({ version: '2.0.14', pid: 1234, urls: ['http://127.0.0.1:50725'] })
    expect(mapOpenCodeV2ServerIdentity({ version: '2.0.14' })).toBeNull()
    expect(mapOpenCodeV2ServerIdentity(null)).toBeNull()
  })

  it('maps providers, defaulting an unknown activation to auto', () => {
    expect(
      mapOpenCodeV2Providers({
        location: { directory: '/repo' },
        data: [
          {
            id: 'opencode',
            integrationID: 'opencode',
            name: 'OpenCode Zen',
            activation: 'enabled',
            package: '@opencode/ai/providers/openai-compatible'
          },
          { id: 'local', name: 'Local', activation: 'nonsense', package: 'x' },
          { name: 'missing id', activation: 'auto', package: 'x' }
        ]
      })
    ).toEqual([
      {
        id: 'opencode',
        name: 'OpenCode Zen',
        activation: 'enabled',
        package: '@opencode/ai/providers/openai-compatible',
        integrationId: 'opencode'
      },
      { id: 'local', name: 'Local', activation: 'auto', package: 'x' }
    ])
  })

  it('maps models with capabilities, limits, and status fallbacks', () => {
    const [model] = mapOpenCodeV2Models({
      location: { directory: '/repo' },
      data: [
        {
          id: 'mimo-v2.6-flash-free',
          modelID: 'mimo-v2.6-flash-free',
          providerID: 'opencode',
          family: 'mimo',
          name: 'MiMo-V2.6-Flash Free',
          capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
          variants: [],
          time: { released: 1790035200000 },
          cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
          status: 'unknown-status',
          enabled: false,
          limit: { context: 200000, output: 32000 }
        }
      ]
    })
    expect(model).toEqual({
      id: 'mimo-v2.6-flash-free',
      modelId: 'mimo-v2.6-flash-free',
      providerId: 'opencode',
      name: 'MiMo-V2.6-Flash Free',
      family: 'mimo',
      status: 'active',
      enabled: false,
      contextLimit: 200000,
      outputLimit: 32000,
      tools: true,
      inputs: ['text', 'image'],
      outputs: ['text']
    })
  })

  it('maps agents and keeps hidden ones in the payload', () => {
    const agents = mapOpenCodeV2Agents({
      location: { directory: '/repo' },
      data: [
        { id: 'build', name: 'Build', description: 'Default', mode: 'primary', hidden: false },
        { id: 'secret', name: 'Secret', mode: 'weird', hidden: true }
      ]
    })
    expect(agents).toEqual([
      { id: 'build', name: 'Build', description: 'Default', mode: 'primary', hidden: false },
      { id: 'secret', name: 'Secret', mode: 'all', hidden: true }
    ])
  })

  it('returns empty lists for a missing or malformed envelope', () => {
    expect(mapOpenCodeV2Providers(undefined)).toEqual([])
    expect(mapOpenCodeV2Models({})).toEqual([])
    expect(mapOpenCodeV2Agents('nope')).toEqual([])
  })
})
