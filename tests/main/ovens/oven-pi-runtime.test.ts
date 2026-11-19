/**
 * The route from a pi session to an Oven: which machine a session's peer starts
 * on, what argv it is started with, and which transport carries the protocol.
 *
 * Every service here is an in-memory fake: no SSH, no Oven, no network.
 */
import { mkdir, rmdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  OvenProbe,
  OvenRun,
  OvenRunEvent,
  OvenWorkspaceRequest,
  OvenWorkspaceResult,
  StartOvenRunInput
} from '../../../src/lib/ovens'
import type { ThreadSettings } from '../../../src/lib/types'
import {
  OvenPiSessions,
  createOvenPiLaunch,
  ovenPiOvenArgs,
  ovenPiRunEnvironment,
  ovenPiSessionsRoot,
  ovenPiTurnApplies,
  prepareOvenPiSession,
  type OvenPiLaunchService,
  type OvenPiSession
} from '../../../src/main/ovens/oven-pi-runtime'
import { ovenDataRoot, ovenDirKey } from '../../../src/main/ovens/remote/oven-root-paths'

const OVEN = 'oven-1'
const OTHER_OVEN = 'oven-2'
const HOME = '/home/ova'
const DATA_ROOT = ovenDataRoot(HOME)
const CHECKOUT = `${DATA_ROOT}/checkouts/${'a'.repeat(20)}`
const SESSION = 'session-1'

function probeFor(): OvenProbe {
  return {
    protocolVersion: 1,
    serviceRevision: 'test',
    platform: 'linux',
    architecture: 'x64',
    home: HOME,
    nodeVersion: '22.13.0',
    harnesses: [],
    activeRuns: 0
  }
}

function session(overrides: Partial<OvenPiSession> = {}): OvenPiSession {
  return {
    ovenId: OVEN,
    cwd: CHECKOUT,
    root: ovenPiSessionsRoot(DATA_ROOT, SESSION),
    environment: { PI_CODING_AGENT_DIR: `${DATA_ROOT}/accounts/a1` },
    extensionArgs: ['--extension', `${DATA_ROOT}/pi-extensions/k1/providers.ts`],
    transportService: {
      write: async () => undefined,
      events: async () => ({ run: run('completed'), events: [] }),
      stop: async () => undefined
    },
    ...overrides
  }
}

function run(status: OvenRun['status'], exitCode?: number | null): OvenRun {
  return { id: 'run-1', command: 'pi', cwd: CHECKOUT, status, createdAt: 1, exitCode }
}

interface Started {
  ovenId: string
  input: StartOvenRunInput
}

interface Written {
  ovenId: string
  runId: string
  input: string
  closeInput?: boolean
}

/** The Oven client, in memory: what was started, written and stopped. */
class FakeOven implements OvenPiLaunchService {
  readonly starts: Started[] = []
  readonly writes: Written[] = []
  readonly stops: { ovenId: string; runId: string }[] = []
  readonly workspaceCalls: string[] = []
  readonly stored = new Map<string, string>()
  failStart: Error | null = null
  /** The status every run reports, so a transport poll ends where a test says. */
  status: OvenRun['status'] = 'running'
  /** The records a run's journal holds, served to every events call. */
  journal: OvenRunEvent[] = []

  async start(ovenId: string, input: StartOvenRunInput): Promise<OvenRun> {
    if (this.failStart) throw this.failStart
    this.starts.push({ ovenId, input })
    return {
      id: input.id,
      command: input.command,
      cwd: input.cwd,
      status: 'running',
      createdAt: 1
    }
  }

  async write(ovenId: string, runId: string, input: string, closeInput?: boolean): Promise<void> {
    this.writes.push({ ovenId, runId, input, ...(closeInput === undefined ? {} : { closeInput }) })
  }

  async events(
    ovenId: string,
    runId: string,
    after: number
  ): Promise<{ run: OvenRun; events: OvenRunEvent[] }> {
    void ovenId
    return {
      run: { ...run(this.status), id: runId },
      events: this.journal.filter((event) => event.sequence > after)
    }
  }

  async stop(ovenId: string, runId: string): Promise<void> {
    this.stops.push({ ovenId, runId })
  }

  async probe(): Promise<OvenProbe> {
    return probeFor()
  }

  async workspace(_id: string, input: OvenWorkspaceRequest): Promise<OvenWorkspaceResult> {
    this.workspaceCalls.push(input.operation)
    if (input.operation === 'write' && input.path !== undefined && input.data !== undefined)
      this.stored.set(input.path, Buffer.from(input.data, 'base64').toString('utf8'))
    return { root: input.root }
  }
}

function settings(overrides: Partial<ThreadSettings> = {}): ThreadSettings {
  return { harnessId: 'pi', ovenId: OVEN, ...overrides } as ThreadSettings
}

describe('OvenPiSessions', () => {
  it('binds one session, replaces it, forgets it, and clears the rest', () => {
    const sessions = new OvenPiSessions()
    const first = session()
    sessions.bind(SESSION, first)
    expect(sessions.get(SESSION)).toBe(first)
    const replacement = session({ cwd: `${CHECKOUT}/worktree` })
    sessions.bind(SESSION, replacement)
    expect(sessions.get(SESSION)).toBe(replacement)
    sessions.forget(SESSION)
    expect(sessions.get(SESSION)).toBeUndefined()
    sessions.bind(SESSION, first)
    sessions.bind('session-2', session({ ovenId: OTHER_OVEN }))
    sessions.clear()
    expect(sessions.get(SESSION)).toBeUndefined()
    expect(sessions.get('session-2')).toBeUndefined()
  })
})

describe('ovenPiOvenArgs', () => {
  it('drops this machine paths, keeps the Oven ones, and appends the Oven argv', () => {
    const target = session()
    const coreTools = `${target.root}/runtime/cio-core-tools/${SESSION}/cio-core-tools.ts`
    const args = ovenPiOvenArgs(
      [
        '/Applications/CodeInOven.app/Contents/Resources/pi/index.js',
        '--mode',
        'rpc',
        '--extension',
        '/Users/dev/Library/Application Support/CodeInOven/runtime/cio-providers/providers.ts',
        '--extension',
        coreTools
      ],
      target
    )
    expect(args).toEqual(['--mode', 'rpc', '--extension', coreTools, ...target.extensionArgs])
  })

  it('reads the joined --extension=<path> spelling the same way', () => {
    const target = session()
    const local =
      '/Users/dev/Library/Application Support/CodeInOven/runtime/cio-providers/providers.ts'
    expect(ovenPiOvenArgs(['--mode', 'rpc', `--extension=${local}`], target)).toEqual([
      '--mode',
      'rpc',
      ...target.extensionArgs
    ])
  })

  it('starts the Oven argv at its first flag, whatever the local runtime prepended', () => {
    const target = session({ extensionArgs: [] })
    expect(ovenPiOvenArgs(['--mode', 'rpc'], target)).toEqual(['--mode', 'rpc'])
    expect(ovenPiOvenArgs(['/opt/cio/pi.mjs', '--mode', 'rpc'], target)).toEqual(['--mode', 'rpc'])
    expect(ovenPiOvenArgs(['C:\\cio\\pi.mjs', '--mode', 'rpc'], target)).toEqual(['--mode', 'rpc'])
  })
})

describe('createOvenPiLaunch', () => {
  it('starts exactly one pi run with the bound cwd, environment, and open input', async () => {
    const service = new FakeOven()
    const sessions = new OvenPiSessions()
    const bound = session()
    sessions.bind(SESSION, bound)
    const launch = createOvenPiLaunch({ sessions, service })

    await launch({
      sessionId: SESSION,
      command: '/opt/CodeInOven/bin/electron',
      args: ['/opt/cio/pi.mjs', '--mode', 'rpc', '--extension', '/local/core.ts'],
      cwd: '/Users/dev/project',
      env: { PATH: '/usr/bin' }
    })

    expect(service.starts).toHaveLength(1)
    const started = service.starts[0]
    expect(started?.ovenId).toBe(OVEN)
    expect(started?.input.command).toBe('pi')
    expect(started?.input.cwd).toBe(CHECKOUT)
    expect(started?.input.environment).toEqual(bound.environment)
    expect(started?.input.closeInput).toBe(false)
    expect(started?.input.input).toBe('')
    expect(started?.input.args).toEqual(['--mode', 'rpc', ...bound.extensionArgs])
  })

  it('writes through the transport to the run it just started', async () => {
    const service = new FakeOven()
    const sessions = new OvenPiSessions()
    sessions.bind(SESSION, session({ transportService: service }))
    const launch = createOvenPiLaunch({ sessions, service })

    const { transport } = await launch({
      sessionId: SESSION,
      command: 'pi',
      args: ['--mode', 'rpc'],
      cwd: CHECKOUT,
      env: {}
    })
    await transport.write('{"id":1}')
    service.status = 'completed'

    expect(service.writes).toEqual([
      { ovenId: OVEN, runId: service.starts[0]?.input.id, input: '{"id":1}\n' }
    ])
    await transport.close()
  })

  it('rejects a session that was never bound, naming the session', async () => {
    const service = new FakeOven()
    const launch = createOvenPiLaunch({ sessions: new OvenPiSessions(), service })
    await expect(
      launch({ sessionId: 'unbound-7', command: 'pi', args: [], cwd: '/x', env: {} })
    ).rejects.toThrow('unbound-7')
    expect(service.starts).toHaveLength(0)
  })

  it('rejects with the service message when the Oven refuses the start', async () => {
    const service = new FakeOven()
    service.failStart = new Error('The remote run does not exist.')
    const sessions = new OvenPiSessions()
    sessions.bind(SESSION, session())
    const launch = createOvenPiLaunch({ sessions, service })
    await expect(
      launch({ sessionId: SESSION, command: 'pi', args: [], cwd: CHECKOUT, env: {} })
    ).rejects.toThrow('The remote run does not exist.')
  })

  it('keeps two sessions on two Ovens apart', async () => {
    const service = new FakeOven()
    const sessions = new OvenPiSessions()
    sessions.bind(SESSION, session({ transportService: service }))
    sessions.bind('session-2', session({ ovenId: OTHER_OVEN, transportService: service }))
    const launch = createOvenPiLaunch({ sessions, service })

    await launch({
      sessionId: SESSION,
      command: 'pi',
      args: ['--mode', 'rpc'],
      cwd: CHECKOUT,
      env: {}
    })
    await launch({
      sessionId: 'session-2',
      command: 'pi',
      args: ['--mode', 'rpc'],
      cwd: CHECKOUT,
      env: {}
    })

    expect(service.starts.map((started) => started.ovenId)).toEqual([OVEN, OTHER_OVEN])
    expect(new Set(service.starts.map((started) => started.input.id)).size).toBe(2)
    expect(service.starts[0]?.input.args).toEqual(['--mode', 'rpc', ...session().extensionArgs])
  })
})

describe('prepareOvenPiSession', () => {
  it('puts the session under the Oven app data root and adds no extensions without sources', async () => {
    const service = new FakeOven()
    const prepared = await prepareOvenPiSession({
      service,
      ovenId: OVEN,
      sessionId: SESSION,
      prepared: {
        root: CHECKOUT,
        dataRoot: DATA_ROOT,
        environment: { ANTHROPIC_API_KEY: 'sk-test' }
      }
    })
    expect(prepared.ovenId).toBe(OVEN)
    expect(prepared.cwd).toBe(CHECKOUT)
    expect(prepared.root).toBe(`${DATA_ROOT}/pi-sessions/${ovenDirKey(SESSION)}`)
    expect(prepared.environment).toEqual({ ANTHROPIC_API_KEY: 'sk-test' })
    expect(prepared.extensionArgs).toEqual([])
    expect(prepared.transportService).toBe(service)
  })

  it('publishes the extensions it is given and returns their Oven argv', async () => {
    const service = new FakeOven()
    const scratch = join(process.cwd(), '.cio', 'tmp', `oven-pi-runtime-${randomUUID()}`)
    await mkdir(scratch, { recursive: true })
    const coreToolsPath = join(scratch, 'cio-core-tools.ts')
    const providersPath = join(scratch, 'providers.ts')
    await writeFile(coreToolsPath, 'export default function core(): void {}\n')
    await writeFile(providersPath, 'export default function providers(): void {}\n')
    try {
      const prepared = await prepareOvenPiSession({
        service,
        ovenId: OVEN,
        sessionId: SESSION,
        prepared: { root: CHECKOUT, dataRoot: DATA_ROOT, environment: {} },
        extensionSources: { coreToolsPath, providersPath }
      })
      expect(prepared.extensionArgs).toHaveLength(4)
      expect(prepared.extensionArgs[0]).toBe('--extension')
      expect(prepared.extensionArgs[1]).toContain(`${DATA_ROOT}/pi-extensions/`)
      expect(prepared.extensionArgs[1]).toContain('cio-core-tools.ts')
      expect(prepared.extensionArgs[3]).toContain('providers.ts')
      expect(service.workspaceCalls).toContain('ensure')
    } finally {
      await rm(coreToolsPath, { force: true })
      await rm(providersPath, { force: true })
      await rmdir(scratch)
    }
  })
})

describe('ovenPiTurnApplies', () => {
  it('routes a remote pi turn and nothing else', () => {
    expect(ovenPiTurnApplies(settings(), true)).toBe(true)
    expect(ovenPiTurnApplies(settings({ harnessId: 'claude-code' }), true)).toBe(false)
    expect(ovenPiTurnApplies(settings({ ovenId: 'local' }), true)).toBe(false)
    expect(ovenPiTurnApplies(settings(), false)).toBe(false)
    expect(ovenPiTurnApplies(undefined, true)).toBe(false)
  })
})

describe('ovenPiRunEnvironment', () => {
  it('forwards only the names the Oven accepts', () => {
    // A development shell exports lowercase names, and one of them failed the
    // whole run with "Invalid remote environment override" on the Oven.
    const environment = ovenPiRunEnvironment(
      { PI_SESSION: 'session-1' },
      {
        ANTHROPIC_API_KEY: 'sk-test',
        npm_config_user_agent: 'bun/1.4.3',
        npm_package_name: 'codeinoven',
        'BASH_FUNC_thing%%': '() { :; }',
        PATH: '/usr/local/bin',
        HOME: '/Users/someone',
        NODE_OPTIONS: '--max-old-space-size=4096',
        EMPTY: ''
      }
    )
    expect(environment).toEqual({
      ANTHROPIC_API_KEY: 'sk-test',
      PI_SESSION: 'session-1'
    })
  })

  it('drops a value larger than the Oven will accept', () => {
    const environment = ovenPiRunEnvironment({}, { HUGE_VALUE: 'x'.repeat(32_769) })
    expect(environment).toEqual({})
  })
})
