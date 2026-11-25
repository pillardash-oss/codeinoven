/**
 * The launch seam of the pi session host.
 *
 * One session start either spawns the local `pi --mode rpc` child it always
 * did, or hands the exact argv, cwd, and environment it built to an injected
 * launcher and speaks over the transport that launcher returns (a run on an
 * Oven). Everything about the session above that seam   bootstrap, the
 * session replacement, request correlation, event handling, teardown   is the
 * same code on both paths, which is what these tests pin down.
 *
 * Everything here is in memory except the default-path test, which spawns a real
 * `#!/bin/sh` stand-in for pi. No SSH, no Oven, no `pi` install.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OWNED_SESSION_MARKER } from '../../../src/main/drivers/cli-environment'
import { PI_COMPACTION_EXTENSION_KEY } from '../../../src/main/drivers/pi-compaction-extension'
import { PiRpcClient } from '../../../src/main/drivers/pi-rpc-client'
import type { RpcTransport } from '../../../src/main/drivers/pi-rpc-transport'
import type { PersistentCliSession } from '../../../src/main/drivers/persistent-cli-driver'
import {
  PiRpcSessions,
  type PiRpcLaunch,
  type PiRpcSessionsHost
} from '../../../src/main/drivers/pi/pi-driver-rpc'

/**
 * The harness runtime the session host would resolve on this machine. Both are
 * mocked so the test never depends on an installed (or bundled) Pi: the local
 * path is exercised against a shell fixture instead, and the launched path never
 * spawns anything.
 */
const runtimeMock = vi.hoisted(() => ({
  /** The command the prepared invocation names; the native-path fixture swaps it. */
  command: 'pi',
  preparedArgs: [] as string[][]
}))

vi.mock('../../../src/main/drivers/harness-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/drivers/harness-runtime')>()
  return {
    ...actual,
    resolveHarnessRuntime: vi.fn(async (command: string) => ({
      command,
      executable: command,
      resolvedPath: `/usr/local/bin/${command}`,
      target: { kind: 'native' }
    })),
    prepareHarnessInvocation: vi.fn(
      async (
        command: string,
        args: string[],
        options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
      ) => {
        runtimeMock.preparedArgs.push(args)
        return {
          command: runtimeMock.command,
          args,
          ...(options.cwd ? { cwd: options.cwd } : {}),
          env: options.env ?? {},
          shell: false,
          runtime: {
            command,
            executable: command,
            resolvedPath: `/usr/local/bin/${command}`,
            target: { kind: 'native' }
          }
        }
      }
    )
  }
})

const SESSION_ID = 'session-1'
const tick = (ms = 0): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms))

const scratchRoots: string[] = []
const liveSessions: PiRpcSessions[] = []

afterEach(async () => {
  for (const sessions of liveSessions.splice(0)) sessions.clear()
  runtimeMock.command = 'pi'
  runtimeMock.preparedArgs.length = 0
  await Promise.all(
    scratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

async function scratchDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codeinoven-pi-launch-'))
  scratchRoots.push(root)
  return root
}

function objectOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`expected a JSON object, got ${String(value)}`)
  return value as Record<string, unknown>
}

/** The record pi's core-tools extension posts once its session is usable. */
function compactionReadyRecord(): Record<string, unknown> {
  return {
    type: 'extension_ui_request',
    id: 'compaction-ready',
    method: 'setStatus',
    statusKey: PI_COMPACTION_EXTENSION_KEY,
    statusText: JSON.stringify({ type: 'ready' })
  }
}

interface FakePeer {
  transport: RpcTransport
  /** Every line the client framed, in order. */
  written: string[]
  /** The same lines parsed, so an assertion can name a request by its type. */
  requests: Record<string, unknown>[]
  closed: number
  /** Answer each request immediately, the way pi's rpc mode does. */
  autoRespond: boolean
  emit(record: Record<string, unknown>): void
  respond(request: Record<string, unknown>, data: unknown): void
  requestsOfType(type: string): Record<string, unknown>[]
  lastRequest(): Record<string, unknown>
}

function fakePeer(): FakePeer {
  const lineHandlers: ((line: string) => void)[] = []
  const state: FakePeer = {
    written: [],
    requests: [],
    closed: 0,
    autoRespond: true,
    transport: {
      write: async (line: string) => {
        state.written.push(line)
        const request = objectOf(JSON.parse(line) as unknown)
        state.requests.push(request)
        if (!state.autoRespond) return
        // A real session reports its compaction extension ready right after the
        // replacement; the bootstrap refuses to continue without that record.
        if (request['type'] === 'new_session') state.emit(compactionReadyRecord())
        state.respond(request, { ok: true })
      },
      onLine: (handler) => lineHandlers.push(handler),
      onStderr: () => undefined,
      onExit: () => undefined,
      close: async () => {
        state.closed += 1
      }
    },
    emit: (record: Record<string, unknown>) => {
      const line = JSON.stringify(record)
      for (const handler of lineHandlers) handler(line)
    },
    respond: (request: Record<string, unknown>, data: unknown) => {
      state.emit({ type: 'response', id: request['id'], success: true, data })
    },
    requestsOfType: (type: string) => state.requests.filter((request) => request['type'] === type),
    lastRequest: () => {
      const request = state.requests[state.requests.length - 1]
      if (!request) throw new Error('nothing was written to the peer')
      return request
    }
  }
  return state
}

function persistentSession(sessionId: string): PersistentCliSession {
  const now = Date.now()
  return {
    id: sessionId,
    title: 'Pi',
    projectPathHash: 'x',
    messages: [],
    createdAt: now,
    updatedAt: now
  }
}

/** The parts of the driver the session host asks for, and nothing else. */
class FakeHost implements PiRpcSessionsHost {
  readonly id = 'pi'
  readonly accountEnvironment: NodeJS.ProcessEnv = {}
  readonly agentDirectory: string | undefined = undefined
  readonly launch: PiRpcLaunch | undefined
  readonly observeHarnessProcess = vi.fn()
  readonly rpcEvents: Record<string, unknown>[] = []
  readonly uiRequests: Record<string, unknown>[] = []
  readonly extensionStatuses: Record<string, unknown>[] = []
  /** Set right after the host is handed to the session host it reports into. */
  sessions: PiRpcSessions | null = null

  constructor(launch?: PiRpcLaunch) {
    this.launch = launch
  }

  readonly requireSession = async (): Promise<PersistentCliSession> => persistentSession(SESSION_ID)
  readonly isTitleSession = (): boolean => false
  readonly utilityRuntime = () => undefined
  readonly resolveRuntimePlaceholders = (value: string): string => value
  readonly workspaceTemporaryEnvironment = async (): Promise<{
    TMPDIR: string
    TEMP: string
    TMP: string
  }> => ({ TMPDIR: '/tmp/cio', TEMP: '/tmp/cio', TMP: '/tmp/cio' })
  readonly materializeCoreToolsExtension = async (): Promise<string> => '/tmp/cio/cio-core-tools.js'
  readonly materializeProvidersExtension = async (): Promise<string | null> => null
  readonly providerExtensionEnv = (): Record<string, string> | undefined => undefined
  readonly forgetCioSession = (): void => undefined
  readonly resumeNativeSession = async (): Promise<void> => undefined
  readonly syncNativeSessionId = async (): Promise<void> => undefined
  readonly initializeTurnState = (): void => undefined
  readonly hasActiveTurn = (): boolean => false
  readonly endActiveTurn = (): void => undefined
  readonly clearPageCompaction = (): void => undefined
  readonly resetSubagentWatch = (): void => undefined
  readonly publishWatchLists = (): void => undefined
  readonly failChildStreams = (): void => undefined
  readonly hasLiveChildSession = (): boolean => false
  readonly hasPendingUiRequest = (): boolean => false
  readonly forgetUsage = (): void => undefined
  readonly finishTurn = async (): Promise<void> => undefined
  readonly handleRpcEvent = async (record: Record<string, unknown>): Promise<void> => {
    this.rpcEvents.push(record)
  }
  readonly handleUiRequest = (record: Record<string, unknown>): void => {
    this.uiRequests.push(record)
  }
  /**
   * The real host flags the session ready and routes the rest; the bootstrap
   * aborts on a session whose compaction extension never reported itself.
   */
  readonly handleExtensionStatus = (record: Record<string, unknown>, sessionId: string): void => {
    this.extensionStatuses.push(record)
    if (
      record['statusKey'] === PI_COMPACTION_EXTENSION_KEY &&
      record['statusText'] === JSON.stringify({ type: 'ready' })
    ) {
      this.sessions?.markCompactionReady(sessionId)
    }
  }
}

function fixture(launch?: PiRpcLaunch): { host: FakeHost; sessions: PiRpcSessions } {
  const host = new FakeHost(launch)
  const sessions = new PiRpcSessions(host)
  host.sessions = sessions
  liveSessions.push(sessions)
  return { host, sessions }
}

/** The session's client, proven to be the RPC one before its surface is used. */
function rpcClientOf(sessions: PiRpcSessions, sessionId: string): PiRpcClient {
  const client = sessions.client(sessionId)
  if (!(client instanceof PiRpcClient)) throw new Error('the session has no PiRpcClient')
  return client
}

describe('PiRpcSessions started through a launcher', () => {
  it('launches with the argv, cwd, and env the local path builds, and speaks over its transport', async () => {
    const project = await scratchDirectory()
    const peer = fakePeer()
    const launch = vi.fn<PiRpcLaunch>(async () => ({ transport: peer.transport }))
    const { host, sessions } = fixture(launch)

    const client = await sessions.ensureClient(project, SESSION_ID)

    expect(launch).toHaveBeenCalledTimes(1)
    const input = launch.mock.calls[0]?.[0]
    if (!input) throw new Error('the launcher was never called')
    expect(input.sessionId).toBe(SESSION_ID)
    expect(input.command).toBe('pi')
    expect(input.args[0]).toBe('--mode')
    expect(input.args[1]).toBe('rpc')
    expect(input.args).toContain('--extension')
    expect(input.cwd).toBe(project)
    // The account environment, the provider extension keys, and the session's
    // ownership marker travel exactly as they would to a local child.
    expect(input.env[OWNED_SESSION_MARKER]).toBe(SESSION_ID)

    // The session's own bootstrap went over the launched transport, framed the
    // way a local child would have received it.
    expect(peer.requestsOfType('new_session')).toHaveLength(1)
    expect(objectOf(JSON.parse(peer.written[0] ?? 'null') as unknown)['type']).toBe('new_session')

    // A request the client frames arrives at the peer, and the response the peer
    // sends back resolves it.
    peer.autoRespond = false
    const stats = client.getSessionStats()
    await tick()
    const request = peer.lastRequest()
    expect(request['type']).toBe('get_session_stats')
    peer.respond(request, { tokens: { total: 7 } })
    await expect(stats).resolves.toEqual({ tokens: { total: 7 } })

    // A record the peer sends unsolicited reaches the session's event handling.
    peer.emit({ type: 'message_update', text: 'hello' })
    expect(host.rpcEvents.map((record) => record['type'])).toContain('message_update')

    // Nothing local exists for this session: no child to observe, and no child
    // handle inside the client either.
    expect(host.observeHarnessProcess).not.toHaveBeenCalled()
    const rpc = rpcClientOf(sessions, SESSION_ID)
    expect(() => rpc.process).toThrow('This Pi session has no local process')
  })

  it('fails the session with the launcher error when the launch rejects', async () => {
    const project = await scratchDirectory()
    const launch = vi.fn<PiRpcLaunch>(async () => {
      throw new Error('the Oven run could not be started')
    })
    const { host, sessions } = fixture(launch)

    const error: unknown = await sessions.ensureClient(project, SESSION_ID).then(
      () => null,
      (rejection: unknown) => rejection
    )

    if (!(error instanceof Error)) throw new Error('the session did not fail with an error')
    // The launcher's own message, not the host wrapping it as a spawn failure.
    expect(error.message).toBe('the Oven run could not be started')
    expect(host.observeHarnessProcess).not.toHaveBeenCalled()
    expect(sessions.hasClient(SESSION_ID)).toBe(false)
  })
})

describe('PiRpcSessions without a launcher', () => {
  // The fixture is a POSIX shell script, so this proves the spawn path on the
  // platforms that path is native to; Windows runs the bundled utility host.
  it.skipIf(process.platform === 'win32')(
    'still spawns the local child and drives the session over its pipes',
    async () => {
      const project = await scratchDirectory()
      const script = join(project, 'pi')
      const ready = JSON.stringify(compactionReadyRecord())
      await writeFile(
        script,
        `#!/bin/sh
# Stand-in for pi --mode rpc: answer every request on stdin with a correlated
# response, and report the core-tools extension ready on a new session.
while IFS= read -r line; do
  case "$line" in
    *'"type":"new_session"'*) printf '%s\\n' '${ready}' ;;
  esac
  id=$(printf '%s' "$line" | sed -E 's/.*"id":"([^"]*)".*/\\1/')
  printf '{"type":"response","id":"%s","success":true,"data":{"spawned":true}}\\n' "$id"
done
`,
        { mode: 0o755 }
      )
      runtimeMock.command = script
      const { host, sessions } = fixture()

      const client = await sessions.ensureClient(project, SESSION_ID)

      // The default path builds the same argv the launcher would have received.
      expect(runtimeMock.preparedArgs[0]?.slice(0, 2)).toEqual(['--mode', 'rpc'])
      // A real child exists, is registered with the process tracker, and answers
      // the protocol over its own pipes.
      expect(host.observeHarnessProcess).toHaveBeenCalledTimes(1)
      const rpc = rpcClientOf(sessions, SESSION_ID)
      expect(rpc.process.pid).toBeGreaterThan(0)
      await expect(client.getState()).resolves.toEqual({ spawned: true })
    }
  )
})
