/**
 * Pi's own transcripts read from the Oven a session runs on: the directory pi
 * uses, the names it lists, and the bytes of a transcript that never lands on
 * this computer.
 *
 * Every service here is an in-memory fake: no SSH, no Oven, no network.
 */
import { describe, expect, it } from 'vitest'
import type {
  OvenProbe,
  OvenRun,
  OvenRunEvent,
  OvenWorkspaceRequest,
  OvenWorkspaceResult,
  StartOvenRunInput
} from '../../../src/lib/ovens'
import {
  findNativePiTranscriptName,
  localPiNativeTranscriptSource,
  nativePiSessionDir
} from '../../../src/main/drivers/pi/pi-native-session'
import {
  OVEN_PI_TRANSCRIPT_CHUNK_BYTES,
  ovenPiTranscriptSource,
  type OvenPiTranscriptRoute,
  type OvenPiTranscriptService
} from '../../../src/main/ovens/oven-pi-transcripts'
import { OvenPiRuntime, type OvenPiRuntimeService } from '../../../src/main/ovens/oven-pi-runtime'
import { ovenDataRoot } from '../../../src/main/ovens/remote/oven-root-paths'

const OVEN = 'oven-6a1f0d3c'
const HOME = '/home/ova'
const DATA_ROOT = ovenDataRoot(HOME)
const ACCOUNT = `${DATA_ROOT}/accounts/pi-a1`
const CHECKOUT = `${DATA_ROOT}/checkouts/${'a'.repeat(20)}`
const NATIVE = '1f0e6a52-1f5c-4a4c-8f38-6d1c0f4b2a11'
const CHUNK = OVEN_PI_TRANSCRIPT_CHUNK_BYTES
/** The Oven lists at most this many entries per page. */
const PAGE = 128

function missing(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, scandir '${path}'`), {
    code: 'ENOENT'
  })
}

/** A path in the single spelling the Oven's own API uses. */
function asOvenPath(value: string): string {
  return value.replace(/\\/gu, '/').replace(/\/+$/u, '')
}

/** The directory pi writes this project's sessions into, on the Oven. */
const TRANSCRIPTS = asOvenPath(nativePiSessionDir(CHECKOUT, ACCOUNT))

/** One transcript's file name, in pi's `<timestamp>_<sessionId>.jsonl` form. */
function transcriptName(timestamp: string, sessionId = NATIVE): string {
  return `${timestamp}_${sessionId}.jsonl`
}

/**
 * The Oven's file API, in memory.
 *
 * Only the operations a transcript source may use exist, so an unexpected call
 * is a test failure, and every call is kept so a test can assert the offsets a
 * paged read actually used.
 */
class FakeOven implements OvenPiTranscriptService {
  readonly calls: OvenWorkspaceRequest[] = []
  /** File contents by absolute Oven path. */
  readonly files = new Map<string, Buffer>()
  /** Directories that exist; a path not listed here has never been created. */
  readonly directories = new Set<string>([TRANSCRIPTS, ACCOUNT])

  async workspace(id: string, input: OvenWorkspaceRequest): Promise<OvenWorkspaceResult> {
    expect(id).toBe(OVEN)
    this.calls.push(input)
    switch (input.operation) {
      case 'list': {
        const prefix = `${asOvenPath(input.root)}/`
        if (!this.directories.has(asOvenPath(input.root))) throw missing(prefix)
        const names = [...this.files.keys()]
          .filter((path) => path.startsWith(prefix))
          .map((path) => path.slice(prefix.length))
          // The Oven lists one directory's own entries, never a subdirectory's.
          .filter((name) => !name.includes('/'))
          .sort()
        const page = names.filter((name) => !input.after || name > input.after).slice(0, PAGE)
        return {
          root: input.root,
          files: page.map((name) => ({
            path: name,
            kind: 'file',
            size: this.files.get(`${prefix}${name}`)?.length ?? 0,
            modifiedAt: 0,
            mode: 0o600
          })),
          ...(page.length === PAGE ? { after: page[page.length - 1] } : {})
        }
      }
      case 'read': {
        const path = `${asOvenPath(input.root)}/${input.path}`
        const data = this.files.get(path)
        if (!data) throw missing(path)
        return {
          root: input.root,
          data: data.subarray(input.offset, input.offset + CHUNK).toString('base64'),
          size: data.length
        }
      }
      case 'move': {
        const from = `${asOvenPath(input.root)}/${input.path}`
        const data = this.files.get(from)
        if (!data) throw missing(from)
        this.files.delete(from)
        this.files.set(`${asOvenPath(input.root)}/${input.to}`, data)
        return { root: input.root }
      }
      default:
        throw new Error(`Unexpected workspace operation: ${input.operation}`)
    }
  }
}

/** The route lookup one bound session installs: its Oven and its account root. */
function route(): OvenPiTranscriptRoute {
  return { ovenId: OVEN, agentDirectory: ACCOUNT }
}

describe('ovenPiTranscriptSource', () => {
  it("resolves the directory pi's own layout names, on the Oven", () => {
    const source = ovenPiTranscriptSource({ service: new FakeOven(), route })
    const name = transcriptName('2026-01-01T00-00-00-000Z')
    const local = localPiNativeTranscriptSource(ACCOUNT)

    expect(source.resolve(CHECKOUT, name)).toBe(`${TRANSCRIPTS}/${name}`)
    expect(source.resolve(CHECKOUT, name)).toBe(asOvenPath(local.resolve(CHECKOUT, name)))
  })

  it('lists the transcript names one native session matches', async () => {
    const service = new FakeOven()
    for (const name of [
      transcriptName('2026-01-01T00-00-00-000Z'),
      transcriptName('2026-02-01T00-00-00-000Z'),
      transcriptName('2026-03-01T00-00-00-000Z', 'another-session')
    ])
      service.files.set(`${TRANSCRIPTS}/${name}`, Buffer.from('{}\n'))

    const source = ovenPiTranscriptSource({ service, route })

    expect(await source.list(CHECKOUT)).toEqual([
      transcriptName('2026-01-01T00-00-00-000Z'),
      transcriptName('2026-02-01T00-00-00-000Z'),
      transcriptName('2026-03-01T00-00-00-000Z', 'another-session')
    ])
    expect(await findNativePiTranscriptName(source, CHECKOUT, NATIVE)).toBe(
      transcriptName('2026-02-01T00-00-00-000Z')
    )
  })

  it('walks list pages so a busy session directory is never truncated', async () => {
    const service = new FakeOven()
    const names = Array.from({ length: PAGE + 3 }, (_, index) =>
      transcriptName(`2026-01-01T00-00-${String(index).padStart(2, '0')}-000Z`, `id-${index}`)
    )
    for (const name of names) service.files.set(`${TRANSCRIPTS}/${name}`, Buffer.from('{}\n'))

    const source = ovenPiTranscriptSource({ service, route })

    expect((await source.list(CHECKOUT))?.sort()).toEqual(names.sort())
    expect(service.calls.filter((call) => call.operation === 'list')).toHaveLength(2)
  })

  it('reassembles a transcript longer than one read chunk', async () => {
    const service = new FakeOven()
    const name = transcriptName('2026-01-01T00-00-00-000Z')
    const lines = Array.from(
      { length: 220 },
      (_, index) => `{"line":${index},"pad":"${'x'.repeat(1_900)}"}`
    )
    const text = `${lines.join('\n')}\n`
    expect(Buffer.byteLength(text)).toBeGreaterThan(3 * CHUNK)
    service.files.set(`${TRANSCRIPTS}/${name}`, Buffer.from(text, 'utf8'))

    const source = ovenPiTranscriptSource({ service, route })

    expect(await source.read(CHECKOUT, name)).toBe(text)
    const offsets = service.calls.flatMap((call) =>
      call.operation === 'read' ? [call.offset] : []
    )
    expect(offsets).toEqual([0, CHUNK, 2 * CHUNK, 3 * CHUNK])
  })

  it('parks a removed transcript in the same .trash convention handoffs use', async () => {
    const service = new FakeOven()
    const name = transcriptName('2026-01-01T00-00-00-000Z')
    service.files.set(`${TRANSCRIPTS}/${name}`, Buffer.from('{}\n'))
    const source = ovenPiTranscriptSource({ service, route })

    await source.remove(CHECKOUT, name)

    expect(await source.list(CHECKOUT)).toEqual([])
    expect(
      [...service.files.keys()].filter((path) => path.startsWith(`${TRANSCRIPTS}/.trash/`))
    ).toHaveLength(1)
  })

  it('reads an absent project as no transcripts, not a failure', async () => {
    const service = new FakeOven()
    const source = ovenPiTranscriptSource({ service, route })

    expect(await source.list(`${DATA_ROOT}/checkouts/never-opened`)).toBeNull()
    expect(await source.read(CHECKOUT, transcriptName('2026-01-01T00-00-00-000Z'))).toBeNull()
  })

  it('resolves nothing when no session is bound to that checkout', async () => {
    const source = ovenPiTranscriptSource({ service: new FakeOven(), route: () => null })

    expect(await source.list(CHECKOUT)).toBeNull()
    expect(await source.read(CHECKOUT, 'anything.jsonl')).toBeNull()
    expect(() => source.resolve(CHECKOUT, 'anything.jsonl')).toThrow(CHECKOUT)
  })
})

/** The whole Oven client, for the one path that ties a runtime to a driver. */
class FakeRuntimeService extends FakeOven implements Pick<OvenPiRuntimeService, 'probe' | 'start'> {
  readonly starts: { ovenId: string; input: StartOvenRunInput }[] = []

  async probe(): Promise<OvenProbe> {
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

  async start(ovenId: string, input: StartOvenRunInput): Promise<OvenRun> {
    this.starts.push({ ovenId, input })
    return { id: input.id, command: input.command, cwd: input.cwd, status: 'running', createdAt: 1 }
  }
}

/** The transport calls the runtime's launch path never makes in this test. */
function runService(): Pick<OvenPiRuntimeService, 'write' | 'events' | 'stop'> {
  return {
    write: async () => undefined,
    events: async () =>
      ({
        run: { id: 'run-1', command: 'pi', cwd: CHECKOUT, status: 'running', createdAt: 1 },
        events: []
      }) as {
        run: OvenRun
        events: OvenRunEvent[]
      },
    stop: async () => undefined
  }
}

describe('OvenPiRuntime native transcripts', () => {
  it("hands the driver the source of the account the session's pi was started with", async () => {
    const service = Object.assign(new FakeRuntimeService(), runService())
    const runtime = new OvenPiRuntime(service)
    const name = transcriptName('2026-01-01T00-00-00-000Z')
    service.files.set(`${TRANSCRIPTS}/${name}`, Buffer.from('{"type":"session"}\n'))

    await runtime.bind({
      sessionId: 'session-1',
      ovenId: OVEN,
      prepared: {
        root: CHECKOUT,
        dataRoot: DATA_ROOT,
        environment: { PI_CODING_AGENT_DIR: ACCOUNT }
      },
      config: async () => ({ agentQuestionCap: 3 })
    })

    // The source rides the launcher the Oven driver is built with, so no local
    // construction path changes and the driver reads the Oven's copies.
    const source = runtime.launch.nativeTranscripts
    expect(source).toBe(runtime.nativeTranscripts)
    expect(source?.resolve(CHECKOUT, name)).toBe(`${TRANSCRIPTS}/${name}`)
    expect(await source?.list(CHECKOUT)).toEqual([name])
    expect(await source?.read(CHECKOUT, name)).toBe('{"type":"session"}\n')

    // A checkout no session works in stays local.
    expect(await source?.list(`${DATA_ROOT}/checkouts/elsewhere`)).toBeNull()
  })
})
