import { describe, expect, it } from 'vitest'
import { normalizeBundleDefinitions } from '../../../src/main/utilities/utility-orchestration/utility-bundle-input'

/**
 * These shapes are lifted verbatim from a real turn (thread
 * 796d841e09276fa78bcd48e0) where an agent called install_bundle three times
 * with three different plausible layouts and was rejected every time. The
 * canonical layout is the first test; the rest are the variants the tolerant
 * parser now accepts.
 */
describe('normalizeBundleDefinitions', () => {
  it('accepts the canonical wrapped definition', () => {
    const definitions = normalizeBundleDefinitions({
      name: 'Slack MCP',
      utilities: [
        {
          definition: {
            kind: 'mcp',
            name: 'Slack MCP',
            description: 'Read and search Slack conversations.',
            config: { transport: 'http', url: 'https://mcp.slack.com/mcp' }
          }
        }
      ]
    })
    expect(definitions).toHaveLength(1)
    expect(definitions[0]).toMatchObject({
      kind: 'mcp',
      name: 'Slack MCP',
      config: { transport: 'http', url: 'https://mcp.slack.com/mcp' },
      credentials: []
    })
  })

  it('accepts the entry list named "entries" (real attempt 1)', () => {
    const definitions = normalizeBundleDefinitions({
      name: 'Slack MCP',
      description: 'Read and search Slack conversations for scheduled digests.',
      entries: [
        {
          id: 'slack-mcp',
          kind: 'mcp',
          name: 'Slack MCP',
          description: 'Slack MCP server.',
          transport: 'http',
          url: 'https://mcp.slack.com/mcp'
        }
      ]
    })
    expect(definitions).toHaveLength(1)
    expect(definitions[0]['kind']).toBe('mcp')
  })

  it('accepts a flat entry with kind on the entry (real attempt 2)', () => {
    const definitions = normalizeBundleDefinitions({
      name: 'Slack MCP',
      utilities: [
        {
          id: 'slack-mcp',
          kind: 'mcp',
          name: 'Slack MCP',
          description: 'Slack MCP server.',
          transport: 'http',
          url: 'https://mcp.slack.com/mcp'
        }
      ]
    })
    expect(definitions).toHaveLength(1)
    expect(definitions[0]['kind']).toBe('mcp')
  })

  it('accepts "type" as an alias for "kind" (real attempt 3)', () => {
    const definitions = normalizeBundleDefinitions({
      name: 'Slack MCP',
      utilities: [
        {
          id: 'slack-mcp',
          type: 'mcp',
          name: 'Slack MCP',
          description: 'Slack MCP server.',
          config: { transport: 'http', url: 'https://mcp.slack.com/mcp' }
        }
      ]
    })
    expect(definitions).toHaveLength(1)
    expect(definitions[0]['kind']).toBe('mcp')
  })

  it('drops a caller-supplied id, which the registry generates', () => {
    const definitions = normalizeBundleDefinitions({
      name: 'Bundle',
      utilities: [{ definition: { id: 'custom', kind: 'skill', name: 'S' } }]
    })
    expect(definitions[0]).not.toHaveProperty('id')
  })

  it('never accepts credentials in the bundle', () => {
    expect(() =>
      normalizeBundleDefinitions({
        name: 'Bundle',
        utilities: [
          { definition: { kind: 'mcp', name: 'S' }, credentials: [{ id: 'a', value: 'secret' }] }
        ]
      })
    ).toThrow(/cannot contain credentials/)
    expect(() =>
      normalizeBundleDefinitions({
        name: 'Bundle',
        utilities: [{ definition: { kind: 'mcp', name: 'S', credentials: [{ id: 'a' }] } }]
      })
    ).toThrow(/cannot contain credentials/)
  })

  describe('rejections name the shape the caller must send', () => {
    it('names the expected bundle object when the bundle is not an object', () => {
      let message = ''
      try {
        normalizeBundleDefinitions('nope')
      } catch (error) {
        message = error instanceof Error ? error.message : ''
      }
      expect(message).toContain('Utility bundle must be an object shaped')
      expect(message).toContain('"utilities"')
    })

    it('names the required keys when the entry list is missing', () => {
      let message = ''
      try {
        normalizeBundleDefinitions({ name: 'Bundle', servers: [] })
      } catch (error) {
        message = error instanceof Error ? error.message : ''
      }
      // The message has to carry both the shape and what was actually sent, or
      // the caller repeats the same guess.
      expect(message).toContain('"utilities" array')
      expect(message).toContain('Received keys: name, servers')
    })

    it('explains the definition wrapper when the discriminator is missing', () => {
      let message = ''
      try {
        normalizeBundleDefinitions({ name: 'Bundle', utilities: [{ name: 'Slack' }] })
      } catch (error) {
        message = error instanceof Error ? error.message : ''
      }
      expect(message).toContain('inside "definition"')
      expect(message).toContain('"config":{"transport":"http","url"')
    })

    it('rejects an empty entry list and an oversized one', () => {
      expect(() => normalizeBundleDefinitions({ name: 'Bundle', utilities: [] })).toThrow(
        /1 to 20 entries/
      )
      expect(() =>
        normalizeBundleDefinitions({
          name: 'Bundle',
          utilities: Array.from({ length: 21 }, () => ({ definition: { kind: 'skill', name: 'S' } }))
        })
      ).toThrow(/1 to 20 entries/)
    })

    it('rejects a non-object entry', () => {
      expect(() => normalizeBundleDefinitions({ name: 'Bundle', utilities: ['nope'] })).toThrow(
        /entry 0 must be an object/
      )
    })

    it('rejects a definition that is not an object', () => {
      expect(() =>
        normalizeBundleDefinitions({ name: 'Bundle', utilities: [{ definition: 'nope' }] })
      ).toThrow(/entry 0 has a "definition" that is not an object/)
    })
  })
})
