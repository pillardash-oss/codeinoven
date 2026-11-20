/**
 * Pi's own transcripts read from the Oven a session runs on: the directory pi
 * uses, the names it lists, and the bytes of a transcript that never lands on
 * this computer.
 *
 * Every service here is an in-memory fake: no SSH, no Oven, no network.
 */
import { describe, expect, it } from 'vitest'
import { OVEN_UNSUPPORTED_WORKSPACE_OPERATION } from '../../../src/lib/ovens'
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
  OVEN_PI_TRANSCRIPT_POLL_MS,
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
  /** The mode each published file was given. */
  readonly modes = new Map<string, number>()
  /** True for the bundle this app replaces: it has no `remove` at all. */
  cannotDelete = false

  async workspace(id: string, input: OvenWorkspaceRequest): Promise<OvenWorkspaceResult> {
    expect(id).toBe(OVEN)
    this.calls.push(input)
    if (this.cannotDelete && input.operation === 'remove')
      throw new Error(OVEN_UNSUPPORTED_WORKSPACE_OPERATION)
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
            mode: this.modes.get(`${prefix}${name}`) ?? 0o600
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
      case 'mkdir': {
        const path =
          input.path === '.' ? asOvenPath(input.root) : `${asOvenPath(input.root)}/${input.path}`
        if (input.exclusive === true && this.directories.has(path))
          throw Object.assign(new Error(`EEXIST: file already exists, mkdir '${path}'`), {
            code: 'EEXIST'
          })
        this.directories.add(path)
        return { root: input.root }
      }
      case 'write': {
        const path = `${asOvenPath(input.root)}/${input.path}`
        if (!this.directories.has(asOvenPath(input.root))) throw missing(input.root)
        if (input.exclusive === true && this.files.has(path))
          throw Object.assign(new Error(`EEXIST: file already exists, open '${path}'`), {
            code: 'EEXIST'
          })
        const data = Buffer.from(input.data, 'base64')
        const current = this.files.get(path) ?? Buffer.alloc(0)
        const end = Math.max(current.length, input.offset + data.length)
        const merged = Buffer.alloc(end)
        current.copy(merged, 0)
        data.copy(merged, input.offset)
        this.files.set(path, merged)
        if (typeof input.mode === 'number') this.modes.set(path, input.mode)
        return { root: input.root }
      }
      case 'replace': {
        const path = `${asOvenPath(input.root)}/${input.path}`
        const staged = `${asOvenPath(input.root)}/${input.staged}`
        const data = this.files.get(staged)
        if (!data) throw missing(staged)
        this.files.delete(staged)
        this.modes.delete(staged)
        this.files.set(path, data)
        this.modes.set(path, input.mode)
        this.directories.add(asOvenPath(input.root))
        return { root: input.root }
      }
      case 'remove': {
        const path = `${asOvenPath(input.root)}/${input.path}`
        if (!this.files.delete(path)) throw missing(path)
        this.modes.delete(path)
        return { root: input.root }
      }
      case 'move': {
        const from = `${asOvenPath(input.root)}/${input.path}`
        const data = this.files.get(from)
        if (!data) throw missing(from)
        const to = `${asOvenPath(input.root)}/${input.to}`
        this.files.delete(from)
        this.files.set(to, data)
        // A parked entry brings its `.trash` directory into existence, which is
        // what lets the next removal look at what is already parked.
        this.directories.add(to.slice(0, to.lastIndexOf('/')))
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

  it('deletes a removed transcript from the directory pi resumes from', async () => {
    const service = new FakeOven()
    const name = transcriptName('2026-01-01T00-00-00-000Z')
    service.files.set(`${TRANSCRIPTS}/${name}`, Buffer.from('{}\n'))
    const source = ovenPiTranscriptSource({ service, route })

    await source.remove(CHECKOUT, name)

    expect(await source.list(CHECKOUT)).toEqual([])
    expect(service.calls.some((call) => call.operation === 'remove')).toBe(true)
    // Deleted, not parked: a machine that discards turns keeps no leftovers.
    expect([...service.files.keys()].filter((path) => path.includes('/.trash/'))).toHaveLength(0)
  })

  it('parks a removed transcript only when the Oven service predates remove', async () => {
    const service = new FakeOven()
    service.cannotDelete = true
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
    expect(await source.waitFor(CHECKOUT, '.jsonl', 10)).toBeNull()
    expect(source.holds(CHECKOUT)).toBe(false)
    expect(() => source.resolve(CHECKOUT, 'anything.jsonl')).toThrow(CHECKOUT)
  })

  it('holds only the checkouts a session of this runtime works in', () => {
    const source = ovenPiTranscriptSource({
      service: new FakeOven(),
      route: (projectPath) => (projectPath === CHECKOUT ? route() : null)
    })
    expect(source.holds(CHECKOUT)).toBe(true)
    expect(source.holds(`${DATA_ROOT}/checkouts/elsewhere`)).toBe(false)
  })

  it('stages a written transcript and publishes it in one step', async () => {
    const service = new FakeOven()
    service.directories.delete(TRANSCRIPTS)
    const source = ovenPiTranscriptSource({ service, route })
    const name = transcriptName('2026-01-01T00-00-00-000Z')
    const text = '{"type":"session"}\n'

    // pi creates the project's session directory on its first flush; a seeded
    // transcript creates it the same way.
    await source.write(CHECKOUT, name, text)

    expect(service.directories.has(TRANSCRIPTS)).toBe(true)
    expect(await source.list(CHECKOUT)).toEqual([name])
    expect(await source.read(CHECKOUT, name)).toBe(text)
    expect(service.modes.get(`${TRANSCRIPTS}/${name}`)).toBe(0o600)
    // Staged first, published by a rename: pi never opens half a transcript.
    const writes = service.calls.flatMap((call) => (call.operation === 'write' ? [call.path] : []))
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatch(new RegExp(`^${name}\\.[0-9a-f-]{36}\\.next$`, 'u'))
    const replace = service.calls.flatMap((call) => (call.operation === 'replace' ? [call] : []))
    expect(replace).toHaveLength(1)
    expect(replace[0]).toMatchObject({ path: name, staged: writes[0], mode: 0o600 })
    // Nothing is left behind beside the published transcript.
    expect([...service.files.keys()]).toEqual([`${TRANSCRIPTS}/${name}`])
  })

  it('writes a transcript longer than one chunk as one published file', async () => {
    const service = new FakeOven()
    const source = ovenPiTranscriptSource({ service, route })
    const name = transcriptName('2026-01-01T00-00-00-000Z')
    const text = `${'x'.repeat(3 * CHUNK)}\n`

    await source.write(CHECKOUT, name, text)

    expect(await source.read(CHECKOUT, name)).toBe(text)
    const offsets = service.calls.flatMap((call) =>
      call.operation === 'write' ? [call.offset] : []
    )
    expect(offsets).toEqual([0, CHUNK, 2 * CHUNK, 3 * CHUNK])
  })

  it('polls for a transcript pi has not flushed yet and resolves the newest match', async () => {
    const service = new FakeOven()
    const source = ovenPiTranscriptSource({ service, route })
    const older = transcriptName('2026-01-01T00-00-00-000Z')
    const newer = transcriptName('2026-02-01T00-00-00-000Z')

    const waiting = source.waitFor(CHECKOUT, `_${NATIVE}.jsonl`, 5_000)
    // The Oven-side pi flushes the child's session file once its first
    // assistant message completes, so the file is genuinely late.
    setTimeout(() => {
      service.files.set(`${TRANSCRIPTS}/${older}`, Buffer.from('{}\n'))
      service.files.set(`${TRANSCRIPTS}/${newer}`, Buffer.from('{}\n'))
    }, 300)

    expect(await waiting).toBe(`${TRANSCRIPTS}/${newer}`)
    expect(service.calls.filter((call) => call.operation === 'list').length).toBeGreaterThan(1)
  })

  it('answers null on time and never waits past the caller\u2019s budget', async () => {
    const service = new FakeOven()
    const source = ovenPiTranscriptSource({ service, route })
    const startedAt = Date.now()

    expect(await source.waitFor(CHECKOUT, `_${NATIVE}.jsonl`, 200)).toBeNull()
    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeGreaterThanOrEqual(190)
    // One listing may still be in flight when the deadline lands, and a poll may
    // not run longer than the time left, so the overshoot is a single poll.
    expect(elapsed).toBeLessThan(200 + OVEN_PI_TRANSCRIPT_POLL_MS + 150)
    expect(service.calls.filter((call) => call.operation === 'list').length).toBeGreaterThan(1)
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
