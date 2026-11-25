import { request as httpRequest } from 'node:http'
import { mkdtemp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  OvenUtilityHostState,
  OvenUtilityJson,
  OvenUtilityMcpServer,
  OvenUtilitySecretBackend,
  OvenUtilityStoredSecret,
  OvenUtilityTurn
} from '../../../src/lib/oven-utility-host'
import {
  startOvenUtilityHost,
  type OvenUtilityHostHandle
} from '../../../src/main/ovens/remote/oven-utility-host'
import {
  createOvenUtilitySecretBackend,
  type SecretBackend,
  type SecretBackendProbe,
  type SecretCommandResult,
  type SecretCommandRunner
} from '../../../src/main/ovens/remote/oven-utility-host/oven-utility-secret-backend'
import {
  OvenUtilitySecrets,
  ovenUtilitySecretsPath
} from '../../../src/main/ovens/remote/oven-utility-host/oven-utility-secrets'
import { resolveOvenUtilityTurnCredentials } from '../../../src/main/ovens/remote/oven-utility-host/oven-utility-local-credentials'
import { answerOvenUtilityAdminRequest } from '../../../src/main/ovens/remote/oven-service-utility-secrets'
import { readOvenUtilityHostState } from '../../../src/main/ovens/remote/oven-utility-host/oven-utility-host-state'
import { Logger } from '../../../src/main/system/logger'

/**
 * The credential store is opt-in and platform-backed, so these tests stand in
 * for both: a fake backend that records what reached it, and a fake runner that
 * records what a platform tool was asked to do. No test ever touches a real
 * keychain, a secret service or the user's DPAPI keys.
 */

const REVISION = 'test-revision'
const VALUE = 's3cret-kitchen-token'

/** A backend that keeps values in memory and records every write. */
class FakeSecretBackend implements SecretBackend {
  readonly id: OvenUtilitySecretBackend = 'macos-keychain'
  readonly values = new Map<string, string>()
  writes = 0
  available = true

  async probe(): Promise<SecretBackendProbe> {
    return this.available
      ? { available: true }
      : { available: false, reason: 'The test keychain is locked.' }
  }

  async read(key: string): Promise<string | null> {
    return this.values.get(key) ?? null
  }

  async write(key: string, value: string): Promise<void> {
    this.writes += 1
    this.values.set(key, value)
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key)
  }
}

interface RecordedCommand {
  argv: string[]
  stdin: string
}

/** A runner that records every command instead of starting one. */
function recordingRunner(
  answer: (argv: string[]) => SecretCommandResult = () => ({ code: 0, stdout: '', stderr: '' })
): { runner: SecretCommandRunner; calls: RecordedCommand[] } {
  const calls: RecordedCommand[] = []
  return {
    calls,
    runner: async (argv, stdin) => {
      calls.push({ argv, stdin: stdin ?? '' })
      return answer(argv)
    }
  }
}

/** One turn whose single utility carries the MCP server it was given. */
function turnWith(server: OvenUtilityMcpServer | undefined, turnId = 'turn-1'): OvenUtilityTurn {
  return {
    turnId,
    token: 'turn-token-1',
    grants: ['/invoke'],
    utilities: [
      {
        id: 'cio:kitchen',
        kind: 'mcp',
        name: 'Kitchen sink',
        description: 'Everything but the sink',
        ...(server ? { server } : {})
      }
    ],
    client: 'test-client',
    createdAt: Date.now()
  }
}

function mcpServer(overrides: Partial<OvenUtilityMcpServer> = {}): OvenUtilityMcpServer {
  return {
    utilityId: 'cio:kitchen',
    name: 'Kitchen sink',
    transport: 'stdio',
    command: process.execPath,
    args: ['kitchen.js'],
    ...overrides
  }
}

interface CallResult {
  status: number
  body: OvenUtilityJson | undefined
}

/** One HTTP call the way the daemon or a client makes it. */
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

function objectOf(
  value: OvenUtilityJson | undefined,
  what: string
): Record<string, OvenUtilityJson> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Expected ${what} to be an object, got ${JSON.stringify(value)}`)
  return value
}

/** The value inside a successful envelope answer. */
function valueOf(result: CallResult): OvenUtilityJson {
  const body = objectOf(result.body, 'an answer')
  if (body['ok'] !== true)
    throw new Error(`Expected a successful answer, got ${JSON.stringify(body)}`)
  return body['value'] ?? null
}

/** The error text of a failed envelope answer. */
function errorOf(result: CallResult): string {
  const body = objectOf(result.body, 'an answer')
  if (body['ok'] !== false) throw new Error(`Expected a failed answer, got ${JSON.stringify(body)}`)
  const error = body['error']
  return typeof error === 'string' ? error : ''
}

describe('Oven secret store', () => {
  const homes: string[] = []

  afterEach(async () => {
    for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
  })

  async function scratch(): Promise<string> {
    const root = resolve('.cio/tmp')
    await mkdir(root, { recursive: true })
    const home = await mkdtemp(join(root, 'oven-utility-secrets-'))
    homes.push(home)
    return home
  }

  it('round-trips the enabled flag and remembered ids through a 0600 index with no value', async () => {
    const home = await scratch()
    const backend = new FakeSecretBackend()
    const secrets = new OvenUtilitySecrets({ home, backend })

    expect(await secrets.status()).toEqual({
      backend: 'macos-keychain',
      available: true,
      enabled: false,
      stored: []
    })
    expect(await secrets.setEnabled(true)).toEqual({ enabled: true })
    const bundle: OvenUtilityStoredSecret = {
      utilityId: 'cio:kitchen',
      env: { KITCHEN_TOKEN: VALUE },
      headers: { Authorization: `Bearer ${VALUE}` }
    }
    expect(await secrets.remember(bundle)).toEqual({ enabled: true })
    expect(await secrets.stored('cio:kitchen')).toEqual(bundle)

    const path = ovenUtilitySecretsPath(home)
    const index = await readFile(path, 'utf8')
    expect(JSON.parse(index)).toEqual({
      enabled: true,
      stored: ['cio:kitchen'],
      slots: { 'cio:kitchen': 0 }
    })
    expect(index).not.toContain(VALUE)
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)

    // A host restart reads the same file, so the flag and the ids survive it.
    const reopened = new OvenUtilitySecrets({ home, backend })
    expect(await reopened.status()).toMatchObject({ available: true, stored: ['cio:kitchen'] })
  })

  it('writes nothing at all while the store is disabled', async () => {
    const home = await scratch()
    const backend = new FakeSecretBackend()
    const secrets = new OvenUtilitySecrets({ home, backend })

    expect(
      await secrets.remember({ utilityId: 'cio:kitchen', env: { KITCHEN_TOKEN: VALUE } })
    ).toEqual({ enabled: false })
    expect(backend.writes).toBe(0)
    expect(backend.values.size).toBe(0)
    expect(await secrets.stored('cio:kitchen')).toBeNull()
    await expect(stat(ovenUtilitySecretsPath(home))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses to turn storage on when the machine cannot keep a credential', async () => {
    const home = await scratch()
    const backend = new FakeSecretBackend()
    backend.available = false
    const secrets = new OvenUtilitySecrets({ home, backend })

    expect(await secrets.setEnabled(true)).toEqual({ enabled: false })
    expect(await secrets.status()).toEqual({
      backend: 'unavailable',
      available: false,
      enabled: false,
      reason: 'The test keychain is locked.',
      stored: []
    })
    expect(
      await secrets.remember({ utilityId: 'cio:kitchen', env: { KITCHEN_TOKEN: VALUE } })
    ).toEqual({ enabled: false })
    expect(backend.writes).toBe(0)
  })

  it('remembers, reads back and forgets one bundle, and can forget them all', async () => {
    const home = await scratch()
    const backend = new FakeSecretBackend()
    const secrets = new OvenUtilitySecrets({ home, backend })
    await secrets.setEnabled(true)
    await secrets.remember({ utilityId: 'cio:kitchen', env: { KITCHEN_TOKEN: VALUE } })
    await secrets.remember({ utilityId: 'cio:pantry', env: { PANTRY_TOKEN: VALUE } })
    expect(backend.values.size).toBe(2)
    expect(await secrets.status()).toMatchObject({ stored: ['cio:kitchen', 'cio:pantry'] })

    expect(await secrets.forget('cio:kitchen')).toBe(1)
    expect(await secrets.stored('cio:kitchen')).toBeNull()
    expect(await secrets.stored('cio:pantry')).toMatchObject({ env: { PANTRY_TOKEN: VALUE } })
    expect(await secrets.status()).toMatchObject({ stored: ['cio:pantry'] })

    await secrets.forgetAll()
    expect(backend.values.size).toBe(0)
    expect(await secrets.status()).toMatchObject({ stored: [] })
  })

  it('sweeps the whole namespace on disable, including a row the index lost', async () => {
    const home = await scratch()
    const backend = new FakeSecretBackend()
    const secrets = new OvenUtilitySecrets({ home, backend })
    await secrets.setEnabled(true)
    await secrets.remember({ utilityId: 'cio:kitchen', env: { KITCHEN_TOKEN: VALUE } })
    // A credential whose index row was lost: nothing can name it any more, and
    // the sweep is the only thing that can still find and remove it.
    await backend.write('cio-slot-7', JSON.stringify({ env: { LOST_TOKEN: VALUE } }))

    await secrets.forgetAll()

    expect(backend.values.size).toBe(0)
    expect(await secrets.stored('cio:kitchen')).toBeNull()
  })
})

describe('Oven secret backends', () => {
  it('falls back to encrypted files without a session bus and uses the service with one', async () => {
    const directory = join(
      await mkdtemp(join(resolve('.cio/tmp'), 'oven-secret-backend-')),
      'files'
    )
    const answers = (): SecretCommandResult => ({
      code: 0,
      stdout: '/usr/bin/secret-tool\n',
      stderr: ''
    })

    const withoutBus = recordingRunner(answers)
    const noBus = createOvenUtilitySecretBackend({
      platform: 'linux',
      env: {},
      runner: withoutBus.runner,
      directory
    })
    expect(await noBus.probe()).toEqual({ available: true })
    expect(noBus.id).toBe('linux-encrypted-file')
    await noBus.write('github', 'token-value')
    expect(await noBus.read('github')).toBe('token-value')
    // Windows has no POSIX owner bits: chmod leaves the mode at 0o666 there, so the
    // key file's mode is only meaningful on the POSIX runners.
    if (process.platform !== 'win32') {
      expect((await stat(join(directory, 'store-key'))).mode & 0o777).toBe(0o600)
    }
    // The value never lands on disk as plain text.
    const sealedFiles = (await readdir(directory)).filter((name) => name.endsWith('.sealed'))
    expect(sealedFiles).toHaveLength(1)
    expect((await readFile(join(directory, sealedFiles[0]))).includes('token-value')).toBe(false)
    await noBus.remove('github')
    expect(await noBus.read('github')).toBeNull()
    // A machine with no bus is never asked to run a tool that would hang on it.
    expect(withoutBus.calls).toHaveLength(0)

    const withBus = recordingRunner(answers)
    const bus = createOvenUtilitySecretBackend({
      platform: 'linux',
      env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
      runner: withBus.runner,
      directory
    })
    expect(await bus.probe()).toEqual({ available: true })
    expect(bus.id).toBe('linux-secret-service')
    expect(withBus.calls.map((call) => call.argv.slice(0, 2))).toEqual([
      ['which', 'secret-tool'],
      ['secret-tool', 'lookup']
    ])

    await bus.write('cio:kitchen', VALUE)
    expect(withBus.calls.at(-1)?.argv).toEqual([
      'secret-tool',
      'store',
      '--label=CodeInOven',
      'service',
      'codeinoven-oven',
      'key',
      'cio:kitchen'
    ])
    expect(withBus.calls.at(-1)?.stdin).toBe(VALUE)
    expect(withBus.calls.at(-1)?.argv).not.toContain(VALUE)
  })

  it('falls back to encrypted files when secret-tool is missing', async () => {
    const directory = join(
      await mkdtemp(join(resolve('.cio/tmp'), 'oven-secret-backend-')),
      'files'
    )
    const { runner } = recordingRunner(() => ({ code: 1, stdout: '', stderr: 'not found' }))
    const backend = createOvenUtilitySecretBackend({
      platform: 'linux',
      env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
      runner,
      directory
    })
    expect(await backend.probe()).toEqual({ available: true })
    expect(backend.id).toBe('linux-encrypted-file')
  })

  it('keeps a macOS value and its key out of argv', async () => {
    const directory = join(
      await mkdtemp(join(resolve('.cio/tmp'), 'oven-secret-backend-')),
      'files'
    )
    let key = ''
    const { runner, calls } = recordingRunner((argv) => {
      if (argv.includes('-i')) key = /-w (\S+)/u.exec(calls.at(-1)?.stdin ?? '')?.[1] ?? ''
      if (argv.includes('find-generic-password'))
        return key
          ? { code: 0, stdout: `${key}\n`, stderr: '' }
          : { code: 44, stdout: '', stderr: '' }
      if (argv.includes('delete-generic-password')) return { code: 44, stdout: '', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const backend = createOvenUtilitySecretBackend({
      platform: 'darwin',
      env: {},
      runner,
      directory
    })

    expect(await backend.probe()).toEqual({ available: true })
    expect(calls.at(-1)?.argv).toEqual(['/usr/bin/security', 'show-keychain-info'])

    await backend.write('cio:kitchen', VALUE)
    // `-w -` would store a dash, so the key is handed over in interactive mode.
    expect(calls.find((call) => call.stdin)?.argv).toEqual(['/usr/bin/security', '-i'])
    expect(key).toMatch(/^[0-9a-f]{64}$/u)
    for (const recorded of calls) expect(recorded.argv.join('\u0000')).not.toContain(key)
    for (const recorded of calls) expect(recorded.argv.join('\u0000')).not.toContain(VALUE)

    expect(await backend.read('cio:kitchen')).toBe(VALUE)
    for (const recorded of calls) expect(recorded.argv.join('\u0000')).not.toContain(VALUE)

    // Deleting what is already gone is the state the caller asked for.
    await expect(backend.remove('cio:kitchen')).resolves.toBeUndefined()
    expect(calls.at(-1)?.argv).toEqual([
      '/usr/bin/security',
      'delete-generic-password',
      '-s',
      'codeinoven-oven',
      '-a',
      'cio:kitchen'
    ])
  })
})

describe('Oven turn credentials', () => {
  const homes: string[] = []

  afterEach(async () => {
    for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
  })

  async function enabledStore(
    backend: SecretBackend = new FakeSecretBackend()
  ): Promise<OvenUtilitySecrets> {
    await mkdir(resolve('.cio/tmp'), { recursive: true })
    const home = await mkdtemp(join(resolve('.cio/tmp'), 'oven-utility-turn-'))
    homes.push(home)
    const secrets = new OvenUtilitySecrets({ home, backend })
    await secrets.setEnabled(true)
    return secrets
  }

  it('lets a turn value win and writes the rotation back', async () => {
    const secrets = await enabledStore()
    await secrets.remember({
      utilityId: 'cio:kitchen',
      env: { KITCHEN_TOKEN: 'stored', KITCHEN_REGION: 'eu' },
      headers: { Authorization: 'Bearer stored' }
    })

    const resolved = await resolveOvenUtilityTurnCredentials(
      turnWith(
        mcpServer({
          env: { KITCHEN_TOKEN: 'fresh' },
          headers: { Authorization: 'Bearer fresh' }
        })
      ),
      secrets
    )
    expect(resolved.utilities[0]?.server?.env).toEqual({
      KITCHEN_TOKEN: 'fresh',
      KITCHEN_REGION: 'eu'
    })
    expect(resolved.utilities[0]?.server?.headers).toEqual({ Authorization: 'Bearer fresh' })

    const stored = await secrets.stored('cio:kitchen')
    expect(stored?.env).toEqual({ KITCHEN_TOKEN: 'fresh', KITCHEN_REGION: 'eu' })
    expect(stored?.headers).toEqual({ Authorization: 'Bearer fresh' })
  })

  it('falls back to the stored bundle for a turn that carries nothing', async () => {
    const secrets = await enabledStore()
    await secrets.remember({
      utilityId: 'cio:kitchen',
      env: { KITCHEN_TOKEN: VALUE },
      headers: { Authorization: `Bearer ${VALUE}` }
    })

    const resolved = await resolveOvenUtilityTurnCredentials(turnWith(mcpServer()), secrets)
    expect(resolved.utilities[0]?.server?.env).toEqual({ KITCHEN_TOKEN: VALUE })
    expect(resolved.utilities[0]?.server?.headers).toEqual({ Authorization: `Bearer ${VALUE}` })
  })

  it('stops handing a forgotten secret to the next turn', async () => {
    const secrets = await enabledStore()
    await secrets.remember({ utilityId: 'cio:kitchen', env: { KITCHEN_TOKEN: VALUE } })

    const first = await resolveOvenUtilityTurnCredentials(turnWith(mcpServer(), 'turn-1'), secrets)
    expect(first.utilities[0]?.server?.env).toEqual({ KITCHEN_TOKEN: VALUE })

    expect(await secrets.forget('cio:kitchen')).toBe(1)
    const second = await resolveOvenUtilityTurnCredentials(turnWith(mcpServer(), 'turn-2'), secrets)
    expect(second.utilities[0]?.server?.env).toBeUndefined()
  })

  it('leaves a turn untouched and stores nothing while the store is off', async () => {
    const backend = new FakeSecretBackend()
    await mkdir(resolve('.cio/tmp'), { recursive: true })
    const home = await mkdtemp(join(resolve('.cio/tmp'), 'oven-utility-turn-'))
    homes.push(home)
    const secrets = new OvenUtilitySecrets({ home, backend })
    const turn = turnWith(mcpServer({ env: { KITCHEN_TOKEN: VALUE } }))

    expect(await resolveOvenUtilityTurnCredentials(turn, secrets)).toBe(turn)
    expect(backend.writes).toBe(0)
  })

  it('never writes a value into a log line', async () => {
    const info = vi.spyOn(Logger, 'info').mockImplementation(() => undefined)
    const error = vi.spyOn(Logger, 'error').mockImplementation(() => undefined)
    const dev = vi.spyOn(Logger, 'dev').mockImplementation(() => undefined)
    try {
      const secrets = await enabledStore()
      await secrets.remember({ utilityId: 'cio:kitchen', env: { KITCHEN_TOKEN: VALUE } })
      await resolveOvenUtilityTurnCredentials(turnWith(mcpServer()), secrets)
      await resolveOvenUtilityTurnCredentials(
        turnWith(mcpServer({ env: { KITCHEN_TOKEN: `${VALUE}-rotated` } })),
        secrets
      )
      await secrets.status()
      await secrets.forget('cio:kitchen')
      await secrets.forgetAll()
      const logged = JSON.stringify([...info.mock.calls, ...error.mock.calls, ...dev.mock.calls])
      expect(logged).not.toContain(VALUE)
    } finally {
      info.mockRestore()
      error.mockRestore()
      dev.mockRestore()
    }
  })
})

describe('Oven secret routes', () => {
  const hosts: OvenUtilityHostHandle[] = []
  const homes: string[] = []

  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close()
    for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
  })

  async function startHost(): Promise<{
    host: OvenUtilityHostHandle
    home: string
    backend: FakeSecretBackend
    token: string
  }> {
    await mkdir(resolve('.cio/tmp'), { recursive: true })
    const home = await mkdtemp(join(resolve('.cio/tmp'), 'oven-utility-secret-routes-'))
    homes.push(home)
    const backend = new FakeSecretBackend()
    const host = await startOvenUtilityHost({
      home,
      revision: REVISION,
      secrets: new OvenUtilitySecrets({ home, backend })
    })
    hosts.push(host)
    const state: OvenUtilityHostState | null = await readOvenUtilityHostState(home)
    if (!state) throw new Error('The host published no state file.')
    return { host, home, backend, token: state.hostToken }
  }

  it('administers the store only for the machine credential', async () => {
    const { host, home, backend, token } = await startHost()

    expect((await call(host.port, 'GET', '/host/secrets')).status).toBe(401)
    expect((await call(host.port, 'GET', '/host/secrets', undefined, 'turn-token-1')).status).toBe(
      401
    )
    const vault = await call(host.port, 'GET', '/host/secrets', undefined, token)
    expect(vault.status).toBe(200)
    expect(valueOf(vault)).toMatchObject({
      backend: 'macos-keychain',
      available: true,
      enabled: false,
      stored: []
    })

    const notABoolean = await call(
      host.port,
      'POST',
      '/host/secrets/enabled',
      { enabled: 'yes' },
      token
    )
    expect(notABoolean.status).toBe(400)
    expect(errorOf(notABoolean)).toContain('true or false')

    const enabled = await call(host.port, 'POST', '/host/secrets/enabled', { enabled: true }, token)
    expect(valueOf(enabled)).toEqual({ enabled: true })

    const kept = await call(
      host.port,
      'POST',
      '/host/secret',
      {
        utilityId: 'cio:kitchen',
        env: { KITCHEN_TOKEN: VALUE },
        headers: { Authorization: `Bearer ${VALUE}` }
      },
      token
    )
    expect(valueOf(kept)).toEqual({ enabled: true })
    expect(backend.values.size).toBe(1)
    expect((await call(host.port, 'GET', '/host/secrets', undefined, token)).body).toMatchObject({
      ok: true,
      value: { stored: ['cio:kitchen'] }
    })
    expect(await readFile(ovenUtilitySecretsPath(home), 'utf8')).not.toContain(VALUE)

    expect((await call(host.port, 'POST', '/host/secret', { env: {} }, token)).status).toBe(400)
    expect(
      (await call(host.port, 'POST', '/host/secret', { utilityId: 'cio:kitchen', env: [] }, token))
        .status
    ).toBe(400)
    expect(
      (
        await call(
          host.port,
          'POST',
          '/host/secret',
          { utilityId: 'cio:kitchen', env: { KITCHEN_TOKEN: 7 } },
          token
        )
      ).status
    ).toBe(400)

    const forgotten = await call(
      host.port,
      'POST',
      '/host/secret/forget',
      { utilityId: 'cio:kitchen' },
      token
    )
    expect(valueOf(forgotten)).toEqual({ forgotten: 1 })
    expect(backend.values.size).toBe(0)
    const forgetAll = await call(host.port, 'POST', '/host/secret/forget', {}, token)
    expect(valueOf(forgetAll)).toEqual({ forgotten: 0 })
    expect((await call(host.port, 'GET', '/host/secrets', undefined, token)).body).toMatchObject({
      ok: true,
      value: { stored: [] }
    })
  })

  it('answers the daemon credential requests against the running host', async () => {
    const { host, home, token } = await startHost()
    const context = {
      home,
      ensureHost: async (): Promise<{ port: number }> => ({ port: host.port })
    }

    expect(
      await answerOvenUtilityAdminRequest('utility-secrets', undefined, context)
    ).toMatchObject({
      backend: 'macos-keychain',
      available: true,
      stored: []
    })
    expect(
      await answerOvenUtilityAdminRequest('utility-secrets-enabled', { enabled: true }, context)
    ).toEqual({ enabled: true })
    await expect(
      answerOvenUtilityAdminRequest('utility-secrets-enabled', { enabled: 'yes' }, context)
    ).rejects.toThrow('true or false')

    expect(
      (
        await call(
          host.port,
          'POST',
          '/host/secret',
          { utilityId: 'cio:kitchen', env: { KITCHEN_TOKEN: VALUE } },
          token
        )
      ).status
    ).toBe(200)
    expect(
      await answerOvenUtilityAdminRequest('utility-secrets', undefined, context)
    ).toMatchObject({
      stored: ['cio:kitchen']
    })
    expect(
      await answerOvenUtilityAdminRequest(
        'utility-secret-forget',
        { utilityId: 'cio:kitchen' },
        context
      )
    ).toEqual({ forgotten: 1 })
    expect(await answerOvenUtilityAdminRequest('utility-secret-forget', {}, context)).toEqual({
      forgotten: 0
    })
    await expect(
      answerOvenUtilityAdminRequest('utility-secret-forget', { utilityId: 'not an id!' }, context)
    ).rejects.toThrow('valid utilityId')
  })
})
