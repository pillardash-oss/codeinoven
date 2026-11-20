import { once } from 'node:events'
import { request as httpRequest, createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  OvenUtilityJson,
  OvenUtilityMcpServer,
  OvenUtilityTurnInput,
  OvenUtilityTurnUtility
} from '../../../src/lib/oven-utility-host'
import {
  startOvenUtilityHost,
  type OvenUtilityHostHandle
} from '../../../src/main/ovens/remote/oven-utility-host'
import { createOvenUtilityLocalHost } from '../../../src/main/ovens/remote/oven-utility-host/oven-utility-local'
import { readOvenUtilityHostState } from '../../../src/main/ovens/remote/oven-utility-host/oven-utility-host-state'
import { Logger } from '../../../src/main/system/logger'

/**
 * The utilities a turn carries are the Oven's only catalogue, so these tests
 * hand the host a snapshot and ask what it can answer from it: search and docs
 * locally, activation and invocation against a server that really runs on this
 * machine, and a plain forward for everything the app owns.
 */

const REVISION = 'test-revision'
const PID_FILE = 'fake-mcp.pid'
const STARTS_FILE = 'fake-mcp.starts'

/**
 * A minimal stdio MCP server: newline-delimited JSON-RPC, answering the three
 * methods a client needs and nothing else. Written to the test's own scratch
 * directory and started with the test runner's own executable.
 */
const FAKE_STDIO_MCP = `const fs = require('node:fs')
const pidFile = process.env.OVEN_TEST_PID_FILE
if (pidFile) fs.writeFileSync(pidFile, String(process.pid))
const startsFile = process.env.OVEN_TEST_STARTS_FILE
if (startsFile) fs.appendFileSync(startsFile, process.pid + '\\n')
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let end = buffer.indexOf('\\n')
  while (end >= 0) {
    const line = buffer.slice(0, end).trim()
    buffer = buffer.slice(end + 1)
    if (line) handle(line)
    end = buffer.indexOf('\\n')
  }
})
process.stdin.on('end', () => process.exit(0))
function write(value) {
  process.stdout.write(JSON.stringify(value) + '\\n')
}
function handle(line) {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  if (request.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        serverInfo: { name: 'fake-oven-mcp', version: '1' }
      }
    })
    return
  }
  if (request.method === 'tools/list') {
    write({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echo the arguments back',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } } }
          },
          { name: 'fail', description: 'Refuse the call', inputSchema: { type: 'object' } }
        ]
      }
    })
    return
  }
  if (request.method === 'tools/call') {
    const name = request.params && request.params.name
    if (name === 'fail') {
      write({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'The fake server refused' } })
      return
    }
    const args = (request.params && request.params.arguments) || {}
    write({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ tool: name, args }) }],
        structuredContent: { tool: name, args }
      }
    })
    return
  }
  if (request.id !== undefined) write({ jsonrpc: '2.0', id: request.id, result: {} })
}
`

interface CallResult {
  status: number
  body: OvenUtilityJson | undefined
}

/** One HTTP call the way a harness makes it. */
function call(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<CallResult> {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  return new Promise<CallResult>((resolveCall, rejectCall) => {
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': payload.byteLength }
            : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {})
        }
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8').trim()
          resolveCall({
            status: response.statusCode ?? 0,
            body: text ? (JSON.parse(text) as OvenUtilityJson) : undefined
          })
        })
      }
    )
    request.on('error', rejectCall)
    request.end(payload)
  })
}

function record(value: OvenUtilityJson | undefined, what: string): Record<string, OvenUtilityJson> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`Expected ${what} to be an object, got ${JSON.stringify(value)}`)
  return value
}

/** The value inside a successful envelope. */
function valueOf(result: CallResult): Record<string, OvenUtilityJson> {
  const body = record(result.body, 'an answer')
  if (body['ok'] !== true)
    throw new Error(`Expected a successful answer, got ${JSON.stringify(body)}`)
  return record(body['value'], 'an answer value')
}

/** The structured payload of a local answer, which is what a script reads. */
function structured(result: CallResult): Record<string, OvenUtilityJson> {
  return record(valueOf(result)['structuredContent'], 'a structured payload')
}

function errorOf(result: CallResult): string {
  const body = record(result.body, 'an answer')
  if (body['ok'] !== false) throw new Error(`Expected a failed answer, got ${JSON.stringify(body)}`)
  return typeof body['error'] === 'string' ? body['error'] : ''
}

function entries(list: OvenUtilityJson | undefined): Record<string, OvenUtilityJson>[] {
  if (!Array.isArray(list)) throw new Error(`Expected a list, got ${JSON.stringify(list)}`)
  return list.map((entry) => record(entry, 'a list entry'))
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the Oven.')
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25))
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose) => {
    server.close(() => resolveClose())
    server.closeAllConnections()
  })
}

describe('Oven-local utility execution', () => {
  const hosts: OvenUtilityHostHandle[] = []
  const servers: Server[] = []
  let root = ''

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const server of servers.splice(0)) await closeServer(server)
    for (const host of hosts.splice(0)) await host.close()
    if (root) await rm(root, { recursive: true, force: true })
    root = ''
  })

  /** The scratch checkout, the host's data root, and the fake server's script. */
  async function scratch(): Promise<{ home: string; code: string; script: string }> {
    root = await mkdtemp(join(resolve('.cio/tmp'), 'oven-utility-local-'))
    const home = join(root, 'home')
    const code = join(root, 'code')
    await mkdir(home, { recursive: true })
    await mkdir(code, { recursive: true })
    const script = join(root, 'fake-mcp.cjs')
    await writeFile(script, FAKE_STDIO_MCP, 'utf8')
    await writeFile(
      join(code, 'package.json'),
      JSON.stringify({ name: 'svelte-app', dependencies: { svelte: '^5.0.0' } }),
      'utf8'
    )
    return { home, code, script }
  }

  async function startHost(): Promise<{
    host: OvenUtilityHostHandle
    code: string
    token: string
  }> {
    const { home, code } = await scratch()
    const host = await startOvenUtilityHost({
      home,
      revision: REVISION,
      local: createOvenUtilityLocalHost({ contextPath: code })
    })
    hosts.push(host)
    const state = await readOvenUtilityHostState(home)
    if (!state) throw new Error('The host published no state file.')
    return { host, code, token: state.hostToken }
  }

  /** One stdio MCP server this turn may run on this machine. */
  function stdioServer(
    script: string,
    overrides: Partial<OvenUtilityMcpServer> = {}
  ): OvenUtilityMcpServer {
    return {
      utilityId: 'cio:kitchen',
      name: 'Kitchen sink',
      transport: 'stdio',
      command: process.execPath,
      args: [script],
      env: {
        OVEN_TEST_PID_FILE: join(root, PID_FILE),
        OVEN_TEST_STARTS_FILE: join(root, STARTS_FILE)
      },
      ...overrides
    }
  }

  function snapshot(server?: OvenUtilityMcpServer): OvenUtilityTurnUtility[] {
    return [
      {
        id: 'cio:svelte',
        kind: 'skill',
        name: 'Svelte 5 patterns',
        description: 'Svelte runes, state and effects for a SvelteKit app',
        docs: '# Svelte\nUse runes.'
      },
      {
        id: 'cio:postgres',
        kind: 'mcp',
        name: 'Postgres',
        description: 'Run SQL against a database',
        ...(server ? { server } : {})
      },
      {
        id: 'cio:web',
        kind: 'web_search',
        name: 'Web search',
        description: 'Search the internet for sources'
      }
    ]
  }

  const GRANTS = [
    '/search',
    '/docs-lookup',
    '/activate',
    '/invoke',
    '/manage',
    '/diagnostics',
    '/ask-secret',
    '/suggest-utility'
  ]

  async function openTurn(
    port: number,
    token: string,
    options: { utilities?: OvenUtilityTurnUtility[]; relayUrl?: string; grants?: string[] } = {}
  ): Promise<void> {
    const input: OvenUtilityTurnInput = {
      turnId: 'turn-1',
      token: 'turn-token-1',
      grants: options.grants ?? GRANTS,
      utilities: options.utilities ?? snapshot(),
      client: 'test-client',
      ...(options.relayUrl ? { relayUrl: options.relayUrl } : {})
    }
    const registered = await call(port, 'POST', '/host/turn', input, token)
    expect(registered.status).toBe(200)
  }

  /** A stand-in for a turn's relay: it answers every forwarded call the same way. */
  async function fakeRelay(): Promise<{
    url: string
    asks: Record<string, OvenUtilityJson>[]
  }> {
    const asks: Record<string, OvenUtilityJson>[] = []
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        asks.push(
          record(JSON.parse(Buffer.concat(chunks).toString('utf8')) as OvenUtilityJson, 'an ask')
        )
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true, value: { answered: 'by-the-app' } }))
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    servers.push(server)
    const address = server.address() as AddressInfo
    return { url: `http://127.0.0.1:${address.port}`, asks }
  }

  /** A remote MCP server: JSON-RPC over POST, or over `text/event-stream`. */
  async function fakeHttpMcp(): Promise<{ url: string; sseUrl: string; tokens: string[] }> {
    const tokens: string[] = []
    const server = createServer((request, response) => {
      tokens.push(String(request.headers.authorization ?? ''))
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const sse = (request.url ?? '').startsWith('/sse')
        const answer = (value: Record<string, unknown>): void => {
          const body = JSON.stringify(value)
          response.writeHead(200, {
            'content-type': sse ? 'text/event-stream' : 'application/json'
          })
          response.end(sse ? `event: message\ndata: ${body}\n\n` : body)
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
          string,
          unknown
        >
        if (payload['method'] === 'initialize') {
          answer({
            jsonrpc: '2.0',
            id: payload['id'],
            result: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              serverInfo: { name: 'fake-http' }
            }
          })
          return
        }
        if (payload['method'] === 'tools/list') {
          answer({
            jsonrpc: '2.0',
            id: payload['id'],
            result: { tools: [{ name: 'lookup', description: 'Look one thing up' }] }
          })
          return
        }
        if (payload['method'] === 'tools/call') {
          const params = record((payload['params'] ?? null) as OvenUtilityJson, 'tools/call params')
          answer({
            jsonrpc: '2.0',
            id: payload['id'],
            result: {
              content: [{ type: 'text', text: 'from the http server' }],
              structuredContent: { ran: 'http', args: params['arguments'] ?? null }
            }
          })
          return
        }
        response.writeHead(202)
        response.end()
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    servers.push(server)
    const address = server.address() as AddressInfo
    const base = `http://127.0.0.1:${address.port}`
    return { url: base, sseUrl: `${base}/sse`, tokens }
  }

  it('ranks the snapshot for a search, and filters it by kind', async () => {
    const { host, token } = await startHost()
    await openTurn(host.port, token)

    const found = await call(host.port, 'POST', '/search', { query: 'svelte' }, 'turn-token-1')
    expect(found.status).toBe(200)
    const payload = structured(found)
    expect(payload['notFound']).toBe(false)
    expect(payload['matchType']).toBe('direct')
    expect(payload['fallback']).toBe(false)
    const results = entries(payload['utilities'])
    expect(results[0]).toMatchObject({ id: 'cio:svelte', kind: 'skill', active: false })

    const sql = await call(host.port, 'POST', '/search', { query: 'sql database' }, 'turn-token-1')
    expect(entries(structured(sql)['utilities'])[0]).toMatchObject({ id: 'cio:postgres' })

    const onlyMcp = await call(
      host.port,
      'POST',
      '/search',
      { query: '', kinds: ['mcp'] },
      'turn-token-1'
    )
    expect(entries(structured(onlyMcp)['utilities'])).toHaveLength(1)
    expect(entries(structured(onlyMcp)['utilities'])[0]).toMatchObject({ id: 'cio:postgres' })

    // A lexical mismatch answers with candidates, because only an empty
    // catalogue proves a capability is absent.
    const miss = await call(
      host.port,
      'POST',
      '/search',
      { query: 'quantum compiler' },
      'turn-token-1'
    )
    expect(structured(miss)['fallback']).toBe(true)
    expect(structured(miss)['notFound']).toBe(false)
    expect(entries(structured(miss)['utilities']).length).toBeGreaterThan(0)

    // The answer is shaped the way the app's gateway shapes one.
    expect(Object.keys(valueOf(found)).sort()).toEqual(['content', 'structuredContent'])
  })

  it('answers docs from the snapshot by id and refuses an unknown id', async () => {
    const { host, token } = await startHost()
    await openTurn(host.port, token)

    const known = await call(
      host.port,
      'POST',
      '/docs-lookup',
      { utility_id: 'cio:svelte' },
      'turn-token-1'
    )
    expect(known.status).toBe(200)
    const payload = structured(known)
    expect(payload['utility']).toMatchObject({ id: 'cio:svelte', kind: 'skill' })
    expect(payload['capability']).toMatchObject({ instructions: '# Svelte\nUse runes.' })

    const unknown = await call(
      host.port,
      'POST',
      '/docs-lookup',
      { utility_id: 'cio:absent' },
      'turn-token-1'
    )
    expect(unknown.status).toBe(404)
    expect(errorOf(unknown)).toContain('No utility with id `cio:absent`')
  })

  it('activates once per turn, idempotently, opening one server', async () => {
    const { host, token } = await startHost()
    const script = join(root, 'fake-mcp.cjs')
    await openTurn(host.port, token, { utilities: snapshot(stdioServer(script)) })

    const first = await call(
      host.port,
      'POST',
      '/activate',
      { utility_id: 'cio:postgres' },
      'turn-token-1'
    )
    expect(first.status).toBe(200)
    const capability = record(structured(first)['capability'], 'a capability')
    const tools = entries(capability['tools'])
    expect(tools.map((tool) => tool['name'])).toEqual(['echo', 'fail'])

    const again = await call(
      host.port,
      'POST',
      '/activate',
      { utility_id: 'cio:postgres' },
      'turn-token-1'
    )
    expect(again.status).toBe(200)
    const repeated = record(structured(again)['capability'], 'a repeated capability')
    expect(typeof repeated['note']).toBe('string')
    expect(repeated['tools']).toBeUndefined()

    // One activation, one child: a repeat must not start a second server.
    const starts = await readFile(join(root, STARTS_FILE), 'utf8')
    expect(starts.trim().split('\n')).toHaveLength(1)

    const search = await call(host.port, 'POST', '/search', { query: '' }, 'turn-token-1')
    const postgres = entries(structured(search)['utilities']).find(
      (entry) => entry['id'] === 'cio:postgres'
    )
    expect(postgres?.['active']).toBe(true)
  })

  it('runs an activated operation on a real stdio server, and reports its refusals', async () => {
    const { host, token } = await startHost()
    const script = join(root, 'fake-mcp.cjs')
    await openTurn(host.port, token, { utilities: snapshot(stdioServer(script)) })
    await call(host.port, 'POST', '/activate', { utility_id: 'cio:postgres' }, 'turn-token-1')

    const invoked = await call(
      host.port,
      'POST',
      '/invoke',
      { utility_id: 'cio:postgres', operation: 'echo', input: { text: 'hi' } },
      'turn-token-1'
    )
    expect(invoked.status).toBe(200)
    const payload = structured(invoked)
    expect(payload).toEqual({ tool: 'echo', args: { text: 'hi' } })
    const content = entries(valueOf(invoked)['content'])
    expect(content[0]?.['type']).toBe('text')
    expect(JSON.parse(String(content[0]?.['text']))).toEqual(payload)

    // A refusal the server itself sent is the tool's answer, not a forward:
    // there is no relay on this turn, so forwarding would have answered 503.
    const refused = await call(
      host.port,
      'POST',
      '/invoke',
      { utility_id: 'cio:postgres', operation: 'fail' },
      'turn-token-1'
    )
    expect(refused.status).toBe(400)
    expect(errorOf(refused)).toContain('The fake server refused')
  })

  it('answers a skill invocation with its instructions', async () => {
    const { host, token } = await startHost()
    await openTurn(host.port, token)
    await call(host.port, 'POST', '/activate', { utility_id: 'cio:svelte' }, 'turn-token-1')

    const invoked = await call(
      host.port,
      'POST',
      '/invoke',
      { utility_id: 'cio:svelte', operation: 'anything' },
      'turn-token-1'
    )
    expect(invoked.status).toBe(200)
    const capability = record(structured(invoked)['capability'], 'a capability')
    expect(capability['instructions']).toBe('# Svelte\nUse runes.')
  })

  it('runs an operation on a remote MCP server, over http and over sse', async () => {
    const { host, token } = await startHost()
    const mcp = await fakeHttpMcp()
    const remote = (
      utilityId: string,
      transport: 'http' | 'sse',
      url: string
    ): OvenUtilityMcpServer => ({
      utilityId,
      name: utilityId,
      transport,
      url,
      // The client resolves a remote server's credential into headers before the
      // turn leaves the app, so the Oven has to send them.
      headers: { Authorization: `Bearer ${utilityId}-token` }
    })
    await openTurn(host.port, token, {
      utilities: [
        {
          id: 'cio:remote',
          kind: 'mcp',
          name: 'Remote MCP',
          description: 'Remote tools',
          server: remote('cio:remote', 'http', mcp.url)
        },
        {
          id: 'cio:remote-sse',
          kind: 'mcp',
          name: 'Remote sse MCP',
          description: 'Remote tools over sse',
          server: remote('cio:remote-sse', 'sse', mcp.sseUrl)
        }
      ]
    })

    for (const utilityId of ['cio:remote', 'cio:remote-sse']) {
      const activated = await call(
        host.port,
        'POST',
        '/activate',
        { utility_id: utilityId },
        'turn-token-1'
      )
      expect(activated.status).toBe(200)
      expect(
        entries(record(structured(activated)['capability'], 'a capability')['tools'])
      ).toHaveLength(1)
      const invoked = await call(
        host.port,
        'POST',
        '/invoke',
        { utility_id: utilityId, operation: 'lookup', input: { id: 'a' } },
        'turn-token-1'
      )
      expect(invoked.status).toBe(200)
      expect(structured(invoked)).toMatchObject({ ran: 'http', args: { id: 'a' } })
    }
    expect(new Set(mcp.tokens)).toEqual(
      new Set(['Bearer cio:remote-token', 'Bearer cio:remote-sse-token'])
    )
  })

  it('runs one operation over a batch of inputs, one entry per item', async () => {
    const { host, token } = await startHost()
    const script = join(root, 'fake-mcp.cjs')
    await openTurn(host.port, token, { utilities: snapshot(stdioServer(script)) })
    await call(host.port, 'POST', '/activate', { utility_id: 'cio:postgres' }, 'turn-token-1')

    const batch = await call(
      host.port,
      'POST',
      '/invoke',
      {
        utility_id: 'cio:postgres',
        operation: 'echo',
        input: {},
        inputs: [{ text: 'a' }, { text: 'b' }]
      },
      'turn-token-1'
    )
    expect(batch.status).toBe(200)
    const results = entries(structured(batch)['results'])
    expect(results).toHaveLength(2)
    // A batch item carries the server's own result, exactly as the app's
    // gateway hands one back, and the whole batch is shaped once on the way out.
    expect(results[0]).toMatchObject({
      ok: true,
      result: { structuredContent: { tool: 'echo', args: { text: 'a' } } }
    })
    expect(results[1]).toMatchObject({
      ok: true,
      result: { structuredContent: { tool: 'echo', args: { text: 'b' } } }
    })

    const conflict = await call(
      host.port,
      'POST',
      '/invoke',
      {
        utility_id: 'cio:postgres',
        operation: 'echo',
        input: { text: 'x' },
        inputs: [{ text: 'a' }]
      },
      'turn-token-1'
    )
    expect(conflict.status).toBe(400)
    expect(errorOf(conflict)).toBe('Pass either input or inputs, not both')
  })

  it('forwards a call the snapshot cannot run, and logs the reason once per utility', async () => {
    const log = vi.spyOn(Logger, 'info').mockImplementation(() => undefined)
    const { host, token } = await startHost()
    const relay = await fakeRelay()
    await openTurn(host.port, token, {
      relayUrl: relay.url,
      utilities: snapshot(
        stdioServer(join(root, 'unused.cjs'), { command: 'codeinoven-no-such-mcp-command' })
      )
    })

    // A spawn the Oven cannot perform is not a failed tool call: the app's own
    // answer comes back instead, and the activation is remembered.
    const activated = await call(
      host.port,
      'POST',
      '/activate',
      { utility_id: 'cio:postgres' },
      'turn-token-1'
    )
    expect(activated.status).toBe(200)
    expect(valueOf(activated)).toEqual({ answered: 'by-the-app' })

    // The docs re-dump has nothing local to describe either, so every call for
    // this utility goes to the app, and the reason is logged only once.
    for (const attempt of [1, 2]) {
      const forwarded = await call(
        host.port,
        'POST',
        '/docs-lookup',
        { utility_id: 'cio:postgres' },
        'turn-token-1'
      )
      expect(forwarded.status).toBe(200)
      expect(valueOf(forwarded)).toEqual({ answered: 'by-the-app' })
      expect(relay.asks).toHaveLength(attempt + 1)
    }
    expect(relay.asks[0]).toMatchObject({
      route: '/activate',
      turnId: 'turn-1',
      input: { utility_id: 'cio:postgres' }
    })

    const logged = log.mock.calls.filter((line) => String(line[0]).includes('cio:postgres'))
    expect(logged).toHaveLength(1)
  })

  it('forwards app-owned routes and app-owned capabilities unchanged', async () => {
    const { host, token } = await startHost()
    const relay = await fakeRelay()
    await openTurn(host.port, token, { relayUrl: relay.url })

    for (const [route, body] of [
      ['/manage', { action: 'install_bundle', bundle: {} }],
      ['/diagnostics', { action: 'threads' }],
      ['/ask-secret', { secrets: [{ title: 'Key' }] }],
      ['/suggest-utility', { name: 'thing' }]
    ] as const) {
      const answered = await call(host.port, 'POST', route, body, 'turn-token-1')
      expect(answered.status).toBe(200)
      expect(valueOf(answered)).toEqual({ answered: 'by-the-app' })
    }

    // `cio:gateway` and a web capability both belong to the app's own executors.
    for (const utilityId of ['cio:gateway', 'cio:web']) {
      const invoked = await call(
        host.port,
        'POST',
        '/invoke',
        { utility_id: utilityId, operation: 'catalog' },
        'turn-token-1'
      )
      expect(invoked.status).toBe(200)
      expect(valueOf(invoked)).toEqual({ answered: 'by-the-app' })
    }

    expect(relay.asks.map((ask) => ask['route'])).toEqual([
      '/manage',
      '/diagnostics',
      '/ask-secret',
      '/suggest-utility',
      '/invoke',
      '/invoke'
    ])
  })

  it('kills the servers a turn started when that turn is retired', async () => {
    const { host, token } = await startHost()
    const script = join(root, 'fake-mcp.cjs')
    await openTurn(host.port, token, { utilities: snapshot(stdioServer(script)) })
    const activated = await call(
      host.port,
      'POST',
      '/activate',
      { utility_id: 'cio:postgres' },
      'turn-token-1'
    )
    expect(activated.status).toBe(200)
    const pid = Number((await readFile(join(root, PID_FILE), 'utf8')).trim())
    expect(alive(pid)).toBe(true)

    const retired = await call(host.port, 'POST', '/host/turn/retire', { turnId: 'turn-1' }, token)
    expect(retired.status).toBe(200)
    await until(() => !alive(pid))
  })

  it('kills the servers a turn started when the host itself closes', async () => {
    const { host, token } = await startHost()
    const script = join(root, 'fake-mcp.cjs')
    await openTurn(host.port, token, { utilities: snapshot(stdioServer(script)) })
    await call(host.port, 'POST', '/activate', { utility_id: 'cio:postgres' }, 'turn-token-1')
    const pid = Number((await readFile(join(root, PID_FILE), 'utf8')).trim())
    expect(alive(pid)).toBe(true)

    await host.close()
    await until(() => !alive(pid))
  })
})
