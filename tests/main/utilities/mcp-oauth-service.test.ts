import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SecretVault } from '../../../src/main/storage/secret-vault'
import { StorageEngine } from '../../../src/main/storage/storage-engine'
import { UtilityRegistryService } from '../../../src/main/utilities/utility-registry-service'
import { McpOAuthService } from '../../../src/main/utilities/mcp-oauth/mcp-oauth-service'
import { VaultMcpOAuthStateStore } from '../../../src/main/utilities/mcp-oauth/mcp-oauth-state-store'
import {
  connectMcpServer,
  mcpOAuthChallengeHeader
} from '../../../src/main/utilities/mcp-connection'
import type {
  McpOAuthEventPayload,
  UtilityDefinition,
  UtilityDefinitionFor
} from '../../../src/lib/types'

const { safeStorage } = vi.hoisted(() => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`, 'utf-8')),
    decryptString: vi.fn((buffer: Buffer) => buffer.toString('utf-8').replace(/^enc:/u, ''))
  }
}))

vi.mock('electron', () => ({ safeStorage }))

/**
 * A local stand-in for one OAuth-only MCP server.
 *
 * It serves the four documents the MCP authorization spec needs   protected
 * resource metadata, authorization server metadata, dynamic client
 * registration, and the token endpoint   plus an MCP endpoint that refuses
 * anything but the access token it issued. The flow under test therefore runs
 * its real HTTP, PKCE, and redirect work against a server that behaves like the
 * real ones, with no network involved.
 */
interface FakeOAuthServer {
  origin: string
  mcpUrl: string
  registrations: number
  tokenGrants: string[]
  accessToken: string
  close: () => Promise<void>
}

async function startFakeOAuthServer(): Promise<FakeOAuthServer> {
  const state = {
    registrations: 0,
    grants: [] as string[],
    issued: 0,
    /** PKCE challenge captured when the authorization URL was built. */
    challenge: '',
    redirectUri: '',
    clientId: ''
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'test_server_error', detail: String(error) }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const origin = `http://127.0.0.1:${port}`
  const mcpUrl = `${origin}/mcp`
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', origin)
    if (request.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return json(response, {
        resource: mcpUrl,
        authorization_servers: [origin],
        scopes_supported: ['tools:read']
      })
    }
    if (request.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      return json(response, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256']
      })
    }
    if (request.method === 'POST' && url.pathname === '/register') {
      const body = await readJson(request)
      state.registrations += 1
      state.redirectUri = firstString(body['redirect_uris'])
      return json(response, {
        client_id: 'codeinoven-test-client',
        token_endpoint_auth_method: 'none',
        redirect_uris: [state.redirectUri]
      })
    }
    if (request.method === 'GET' && url.pathname === '/authorize') {
      state.challenge = url.searchParams.get('code_challenge') ?? ''
      state.clientId = url.searchParams.get('client_id') ?? ''
      const redirect = url.searchParams.get('redirect_uri') ?? ''
      const target = new URL(redirect)
      target.searchParams.set('code', 'test-authorization-code')
      target.searchParams.set('state', url.searchParams.get('state') ?? '')
      response.writeHead(302, { location: target.href })
      response.end()
      return
    }
    if (request.method === 'POST' && url.pathname === '/token') {
      const form = new URLSearchParams(await readText(request))
      const grant = form.get('grant_type') ?? ''
      state.grants.push(grant)
      if (grant === 'authorization_code') {
        const verifier = form.get('code_verifier') ?? ''
        if (!state.challenge || pkceChallenge(verifier) !== state.challenge) {
          return json(response, { error: 'invalid_grant' }, 400)
        }
      }
      state.issued += 1
      return json(response, {
        access_token: `access-${state.issued}`,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'refresh-token',
        scope: 'tools:read',
        id_token: `header.${base64UrlJson({ email: 'operator@example.com' })}.signature`
      })
    }
    if (url.pathname === '/mcp') {
      const authorization = request.headers.authorization ?? ''
      if (authorization !== `Bearer access-${state.issued}`) {
        response.writeHead(401, {
          'content-type': 'application/json',
          'www-authenticate': `Bearer resource_metadata="${metadataUrl}"`
        })
        response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -31001 } }))
        return
      }
      const payload = await readJson(request)
      if (payload['id'] === undefined) {
        // A JSON-RPC notification, which the client does not expect an answer to.
        response.writeHead(202).end()
        return
      }
      if (payload['method'] === 'initialize') {
        return json(response, {
          jsonrpc: '2.0',
          id: payload['id'],
          result: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            serverInfo: { name: 'fake-oauth-mcp', version: '1' }
          }
        })
      }
      return json(response, {
        jsonrpc: '2.0',
        id: payload['id'],
        result: { tools: [{ name: 'noop', description: 'Does nothing' }] }
      })
    }
    response.writeHead(404).end()
  }

  return {
    origin,
    mcpUrl,
    get registrations(): number {
      return state.registrations
    },
    get tokenGrants(): string[] {
      return [...state.grants]
    },
    /** The access token the server considers live, so a test can prove which one it got. */
    get accessToken(): string {
      return `access-${state.issued}`
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

async function readText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks).toString('utf-8')
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readText(request)
  if (!text) return {}
  const parsed: unknown = JSON.parse(text)
  return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
}

function firstString(value: unknown): string {
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : ''
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf-8').toString('base64url')
}

function asMcpUtility(utility: UtilityDefinition | null): UtilityDefinitionFor<'mcp'> {
  if (!utility || utility.kind !== 'mcp') throw new Error('Expected an MCP utility')
  return utility
}

let root: string
let configRoot: string
let storage: StorageEngine
let vault: SecretVault
let registry: UtilityRegistryService
let fake: FakeOAuthServer
const services: McpOAuthService[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codeinoven-mcp-oauth-'))
  configRoot = join(root, 'config')
  await mkdir(configRoot, { recursive: true })
  storage = new StorageEngine(configRoot)
  vault = new SecretVault(storage)
  registry = new UtilityRegistryService(storage)
  fake = await startFakeOAuthServer()
})

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await fake.close()
  await rm(root, { recursive: true, force: true })
})

/** The service under test, with the browser replaced by a fetch to the auth URL. */
function serviceUnderTest(): { service: McpOAuthService; events: McpOAuthEventPayload[] } {
  const events: McpOAuthEventPayload[] = []
  const service = new McpOAuthService({
    registry,
    vault,
    broadcast: (payload) => {
      events.push(payload)
      // The renderer's job in production: open the URL the flow asks for. Here a
      // fetch follows the redirect back into the app's own loopback listener,
      // which is exactly what a browser would do.
      if (payload.kind === 'authorize') void fetch(payload.authUrl).catch(() => undefined)
    }
  })
  services.push(service)
  return { service, events }
}

async function installRemoteUtility(
  config: UtilityDefinitionFor<'mcp'>['config']
): Promise<UtilityDefinitionFor<'mcp'>> {
  const created = await registry.create({
    kind: 'mcp',
    name: 'OAuth-only MCP',
    description: 'A remote server that refuses anonymous access',
    config
  })
  return asMcpUtility(created)
}

describe('McpOAuthService', () => {
  it('authorizes an OAuth-only server through the browser flow and connects with the grant', async () => {
    // A stale configured Authorization value is exactly the state a user is left
    // in when a server only accepts OAuth: the grant has to win over it. A
    // literal header value is refused by the registry (secrets live in the
    // vault), so the stale one is written the way a real utility writes it.
    const utility = await installRemoteUtility({
      transport: 'http',
      url: fake.mcpUrl,
      headers: { Authorization: '{env:STALE_API_KEY}' }
    })
    const { service } = serviceUnderTest()

    expect(await service.accessToken(utility)).toBeNull()
    expect((await service.status(utility.id)).state).toBe('not_connected')

    const status = await service.authorize(utility.id)

    expect(status.state).toBe('connected')
    expect(status.issuer).toBe(fake.origin)
    expect(status.clientId).toBe('codeinoven-test-client')
    expect(status.scope).toBe('tools:read')
    expect(status.resource).toBe(fake.mcpUrl)
    // The account is read from the id token for display only.
    expect(status.accountLabel).toBe('operator@example.com')
    expect(status.authorizedAt).toBeTypeOf('number')
    expect(fake.registrations).toBe(1)
    expect(fake.tokenGrants).toEqual(['authorization_code'])

    // The non-secret half is visible in the utility's own configuration.
    const stored = asMcpUtility(await registry.get(utility.id))
    expect(stored.config.oauth).toMatchObject({
      enabled: true,
      clientId: 'codeinoven-test-client',
      resource: fake.mcpUrl
    })

    // The connection a turn makes now reaches the server: the grant has to beat
    // the stale value the configured header still resolves to.
    const token = await service.accessToken(stored)
    expect(token).toBe(fake.accessToken)
    const client = await connectMcpServer({
      config: stored.config,
      environment: { STALE_API_KEY: 'stale-key' },
      credentials: [],
      authorization: token,
      owner: { name: stored.name, credentials: [] }
    })
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(['noop'])
    await client.close()
  })

  it('renews an expired access token from its refresh token without a browser', async () => {
    const utility = await installRemoteUtility({ transport: 'http', url: fake.mcpUrl })
    const { service, events } = serviceUnderTest()
    await service.authorize(utility.id)

    // Age the grant: the access token is past its life, the refresh token is not.
    const store = new VaultMcpOAuthStateStore(vault, utility.id)
    const state = await store.load()
    expect(state?.tokens?.refresh_token).toBe('refresh-token')
    if (!state) throw new Error('Expected a stored OAuth grant')
    await store.save({ ...state, tokensExpireAt: Date.now() - 1_000 })

    const renewed = await service.accessToken(asMcpUtility(await registry.get(utility.id)))

    expect(renewed).toBe(fake.accessToken)
    expect(fake.tokenGrants).toEqual(['authorization_code', 'refresh_token'])
    // A renewal is silent: no second browser authorization was asked for.
    expect(events.filter((event) => event.kind === 'authorize')).toHaveLength(1)
    expect((await service.status(utility.id)).state).toBe('connected')
  })

  it('forgets the grant, the client, and the config block on disconnect', async () => {
    const utility = await installRemoteUtility({ transport: 'http', url: fake.mcpUrl })
    const { service } = serviceUnderTest()
    await service.authorize(utility.id)

    const status = await service.disconnect(utility.id)

    expect(status.state).toBe('not_connected')
    expect(status.clientId).toBeUndefined()
    expect(await vault.resolveMcpOAuthState(utility.id)).toBeNull()
    const stored = asMcpUtility(await registry.get(utility.id))
    expect(stored.config.oauth).toBeUndefined()
    expect(await service.accessToken(stored)).toBeNull()
  })

  it('explains a refusal that asks for authorization instead of reporting a bare 401', async () => {
    const utility = await installRemoteUtility({ transport: 'http', url: fake.mcpUrl })

    const failure = await connectMcpServer({
      config: utility.config,
      environment: {},
      credentials: [],
      owner: { name: utility.name, credentials: [] }
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    const message = failure instanceof Error ? failure.message : ''
    expect(message).toContain('OAuth authorization')
    expect(message).toContain('Utilities')
    // The challenge itself is available for the UI that offers the flow.
    expect(mcpOAuthChallengeHeader(failure)).toContain('resource_metadata')
  })

  it('reports the server as demanding authorization once a challenge has been seen', async () => {
    const utility = await installRemoteUtility({ transport: 'http', url: fake.mcpUrl })
    const { service } = serviceUnderTest()

    await service.noteChallenge(
      utility.id,
      `Bearer resource_metadata="${fake.origin}/.well-known/oauth-protected-resource/mcp"`
    )

    const status = await service.status(utility.id)
    expect(status.required).toBe(true)
    expect(status.state).toBe('not_connected')
  })
})
