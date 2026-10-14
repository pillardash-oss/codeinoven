import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { StorageEngine } from '../../../src/main/storage/storage-engine'
import { UtilityRegistryService } from '../../../src/main/utilities/utility-registry-service'
import {
  parseMcpOAuthAuthorizeRequest,
  parseMcpOAuthConfig
} from '../../../src/main/utilities/mcp-oauth/mcp-oauth-config'
import { resolveMcpHeaders } from '../../../src/main/utilities/mcp-connection'

const { safeStorage } = vi.hoisted(() => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`, 'utf-8')),
    decryptString: vi.fn((buffer: Buffer) => buffer.toString('utf-8').replace(/^enc:/u, ''))
  }
}))

vi.mock('electron', () => ({ safeStorage }))

let root: string
let registry: UtilityRegistryService

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codeinoven-mcp-oauth-config-'))
  const configRoot = join(root, 'config')
  await mkdir(configRoot, { recursive: true })
  registry = new UtilityRegistryService(new StorageEngine(configRoot))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('MCP OAuth configuration', () => {
  it('normalizes the block a flow writes back', () => {
    expect(parseMcpOAuthConfig({ clientId: 'client-1', confidentialClient: false })).toEqual({
      enabled: true,
      clientId: 'client-1',
      confidentialClient: false
    })
    expect(
      parseMcpOAuthConfig({
        enabled: false,
        issuer: 'https://auth.example',
        scope: 'tools:read',
        resource: 'https://mcp.example/mcp',
        expiresAt: 1_700_000_000_500.9,
        authorizedAt: 1_700_000_000_000
      })
    ).toEqual({
      enabled: false,
      issuer: 'https://auth.example',
      scope: 'tools:read',
      resource: 'https://mcp.example/mcp',
      expiresAt: 1_700_000_000_500,
      authorizedAt: 1_700_000_000_000
    })
  })

  it('refuses a field name that reads as a secret, so no config can carry a grant', () => {
    expect(() => parseMcpOAuthConfig({ clientSecret: 'shh' })).toThrow(/not supported/iu)
    expect(() => parseMcpOAuthConfig({ accessToken: 'shh' })).toThrow(/not supported/iu)
    expect(() => parseMcpOAuthConfig({ enabled: 'yes' })).toThrow(/boolean/iu)
    expect(() => parseMcpOAuthConfig({ expiresAt: Number.NaN })).toThrow(/timestamp/iu)
  })

  it('validates a transient authorize request without persisting anything', () => {
    expect(parseMcpOAuthAuthorizeRequest(undefined)).toEqual({})
    expect(
      parseMcpOAuthAuthorizeRequest({ clientId: 'client-1', clientSecret: 'shh', scope: ' a b ' })
    ).toEqual({ clientId: 'client-1', clientSecret: 'shh', scope: 'a b' })
    expect(() => parseMcpOAuthAuthorizeRequest({ authorizationServer: 'https://x' })).toThrow(
      /not supported/iu
    )
    expect(() => parseMcpOAuthAuthorizeRequest({ clientSecret: 42 })).toThrow(/string/iu)
  })

  it('round-trips an authorized server through the registry, and still refuses an inline secret', async () => {
    const created = await registry.create({
      kind: 'mcp',
      name: 'OAuth MCP',
      description: 'A remote server authorized with OAuth',
      config: { transport: 'http', url: 'https://mcp.example/mcp' }
    })
    const stored = await registry.update(created.id, {
      config: {
        transport: 'http',
        url: 'https://mcp.example/mcp',
        oauth: {
          enabled: true,
          issuer: 'https://auth.example',
          clientId: 'client-1',
          confidentialClient: false,
          scope: 'tools:read',
          authorizedAt: 1_700_000_000_000
        }
      }
    })

    expect(await registry.get(created.id)).toMatchObject({
      config: { oauth: { enabled: true, clientId: 'client-1' } }
    })
    expect(stored.config.oauth?.issuer).toBe('https://auth.example')

    await expect(
      registry.update(created.id, {
        config: {
          transport: 'http',
          url: 'https://mcp.example/mcp',
          oauth: { clientSecret: 'shh' }
        }
      })
      // The registry refuses a secret-shaped config field before any parser sees
      // it, which is the guard that keeps a grant out of a utility definition.
    ).rejects.toThrow(/opaque credential reference/iu)
  })
})

describe('remote MCP request headers', () => {
  const config = { transport: 'http' as const, url: 'https://mcp.example/mcp' }

  it('sends the OAuth grant in place of any configured authorization value', () => {
    const headers = resolveMcpHeaders(
      { ...config, headers: { authorization: 'Bearer stale-api-key', 'X-Extra': 'kept' } },
      {},
      [],
      'grant-token'
    )

    expect(headers).toEqual({ 'X-Extra': 'kept', Authorization: 'Bearer grant-token' })
  })

  it('leaves a configured authorization value alone when there is no grant', () => {
    const headers = resolveMcpHeaders(
      { ...config, headers: { Authorization: 'Bearer api-key' } },
      {},
      []
    )

    expect(headers).toEqual({ Authorization: 'Bearer api-key' })
  })
})
