/**
 * Pi's native transcript access, driven twice: once on this machine's own
 * filesystem and once over an Oven's file API.
 *
 * The three operations that used to touch `node:fs` directly are the ones that
 * decide whether an Oven turn behaves like a local one:
 *
 * 1. seeding an edited mirror as a native transcript (`prefillNativeSession`),
 * 2. reading a delegated child's transcript, including waiting for pi to flush
 *    it, and the "no child transcript" outcome when it never appears,
 * 3. reconciling a compaction marker written to the transcript
 *    (`reconcileNativeCompactions`, reached by project path alone).
 *
 * Both runs assert the same observations, so parity is proven rather than
 * asserted: the same messages, the same stored transcript names, the same
 * recovered boundary.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentMessage } from '../../../src/lib/types'
import type { OvenWorkspaceRequest, OvenWorkspaceResult } from '../../../src/lib/ovens'
import type { PersistentCliSession } from '../../../src/main/drivers/persistent-cli-driver'
import {
  PiNativeSessions,
  type PiNativeSessionsHost
} from '../../../src/main/drivers/pi/pi-driver-native-session'
import {
  installRemotePiNativeTranscriptSource,
  localPiNativeTranscriptSource,
  nativePiSessionDir,
  parseNativePiTranscriptText,
  reconcileNativeCompactions,
  type PiNativeTranscriptSource
} from '../../../src/main/drivers/pi/pi-native-session'
import {
  ovenPiTranscriptSource,
  type OvenPiTranscriptRoute,
  type OvenPiTranscriptService
} from '../../../src/main/ovens/oven-pi-transcripts'
import type { StorageEngine } from '../../../src/main/storage/storage-engine'

const SESSION = 'session-1'
const CHILD = 'child-1'
const MISSING_CHILD = 'child-missing'
const OVEN = 'oven-parity'
/** The retained boundary's own timestamp, which reconciliation must recover. */
const BOUNDARY_AT = 1_767_225_610_000
/** The second compaction's boundary, which must come back as a message. */
const SECOND_AT = 1_767_225_620_000

/** The local half of the scenario: pi's layout under a scratch agent directory. */
const LOCAL_PROJECT = '/projects/parity'
/** The Oven half: the checkout the Oven-side pi works in, and its account root. */
const OVEN_PROJECT = '/home/ova/.local/share/codeinoven/checkouts/parity'
const OVEN_ACCOUNT = '/home/ova/.local/share/codeinoven/accounts/pi-a1'

const roots: string[] = []

afterEach(async () => {
  installRemotePiNativeTranscriptSource(null)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** A scratch directory, inside the project's own disposable space. */
async function scratch(): Promise<string> {
  const base = join(process.cwd(), '.cio', 'tmp')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'pi-native-parity-'))
  roots.push(root)
  return root
}

/** One mirrored message the app kept after the user edited the thread. */
function mirrored(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  createdAt = 1_767_225_600_000
): AgentMessage {
  return {
    id,
    role,
    createdAt,
    parts: [{ type: 'text', id: `${id}:text`, messageID: id, text }]
  }
}

/** The edited mirror both runs are seeded from. */
const MIRROR: AgentMessage[] = [
  mirrored('m-1', 'user', 'Plan the migration'),
  mirrored('m-2', 'assistant', 'Reading the schema first.')
]

/**
 * A transcript with two compaction entries: one the app already mirrored but
 * with no retained boundary, and one that never arrived as an event.
 */
function reconcileTranscript(nativeId: string): string {
  return `${[
    {
      type: 'session',
      version: 3,
      id: nativeId,
      timestamp: '2026-07-01T00:00:00.000Z',
      cwd: 'parity'
    },
    {
      type: 'message',
      id: 'entry-1',
      parentId: null,
      timestamp: '2026-07-01T00:00:00.500Z',
      message: {
        role: 'user',
        timestamp: BOUNDARY_AT,
        content: [{ type: 'text', text: 'Plan the migration' }]
      }
    },
    {
      type: 'compaction',
      summary: 'Schema read; the plan follows.',
      firstKeptEntryId: 'entry-1',
      timestamp: '2026-07-01T00:00:01.000Z'
    },
    {
      type: 'message',
      id: 'entry-2',
      parentId: 'entry-1',
      timestamp: '2026-07-01T00:00:01.500Z',
      message: {
        role: 'assistant',
        timestamp: SECOND_AT,
        model: 'gpt-5',
        provider: 'openai',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'The plan is three steps.' }]
      }
    },
    {
      type: 'compaction',
      summary: 'Second compaction after the plan.',
      firstKeptEntryId: 'entry-2',
      timestamp: '2026-07-01T00:00:02.000Z'
    }
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n')}\n`
}

/** A child session's transcript, as pi writes it once its first turn settles. */
function childTranscript(): string {
  return `${[
    {
      type: 'session',
      version: 3,
      id: CHILD,
      timestamp: '2026-06-01T00:00:00.000Z',
      cwd: 'parity'
    },
    {
      type: 'message',
      id: 'child-entry-1',
      parentId: null,
      timestamp: '2026-06-01T00:00:01.000Z',
      message: {
        role: 'user',
        timestamp: 1_780_000_001_000,
        content: [{ type: 'text', text: 'Explore the codebase' }]
      }
    },
    {
      type: 'message',
      id: 'child-entry-2',
      parentId: 'child-entry-1',
      timestamp: '2026-06-01T00:00:02.000Z',
      message: {
        role: 'assistant',
        timestamp: 1_780_000_002_000,
        model: 'gpt-5',
        provider: 'openai',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Found three call sites.' }]
      }
    }
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n')}\n`
}

/** The compaction the app already mirrored, missing only its boundary time. */
function mirroredCompaction(): AgentMessage {
  return {
    id: 'pi-session-1-compaction-0',
    role: 'assistant',
    origin: 'compaction',
    visibility: 'working_trace',
    createdAt: Date.parse('2026-07-01T00:00:01.000Z'),
    parts: [
      {
        type: 'compaction',
        id: 'pi-session-1-compaction-0:compaction',
        messageID: 'pi-session-1-compaction-0',
        auto: true,
        summary: 'Schema read; the plan follows.',
        firstKeptEntryId: 'entry-1'
      }
    ]
  }
}

/** One run's source, project path and the way the app is told about it. */
interface ParityRun {
  /** The machine's project path: the checkout the pi process works in. */
  projectPath: string
  /** This session's account root on that machine. */
  agentDirectory: string
  source: PiNativeTranscriptSource
  /**
   * Tell the app where that machine's transcripts are, exactly as production
   * does: a local driver installs nothing, an Oven driver installs its source.
   */
  install: () => void
}

/**
 * The observations both runs must agree on.
 *
 * The native session id is minted per run, so it is normalised out of every name
 * before the comparison: what must match is the name pi's own layout produces.
 */
interface ParityObservations {
  seeded: boolean
  seededMessages: string[]
  transcriptNames: string[]
  childMessages: string[]
  childTranscriptMissing: AgentMessage[]
  recovered: string[]
  retainedBoundary: number | undefined
}

/** A transcript source that keeps an Oven's files in memory. */
class FakeOvenFiles implements OvenPiTranscriptService {
  readonly files = new Map<string, Buffer>()
  readonly directories = new Set<string>()
  /** True for the bundle this app replaces: it has no `remove` at all. */
  cannotDelete = false

  async workspace(id: string, input: OvenWorkspaceRequest): Promise<OvenWorkspaceResult> {
    expect(id).toBe(OVEN)
    if (this.cannotDelete && input.operation === 'remove')
      throw new Error('Unsupported workspace operation.')
    switch (input.operation) {
      case 'list': {
        const root = ovenPath(input.root)
        if (!this.directories.has(root)) throw missing(`${root}/`)
        const prefix = `${root}/`
        const names = [...this.files.keys()]
          .filter((path) => path.startsWith(prefix))
          .map((path) => path.slice(prefix.length))
          .filter((name) => !name.includes('/'))
          .sort()
        return {
          root: input.root,
          files: names.map((name) => ({
            path: name,
            kind: 'file',
            size: this.files.get(`${prefix}${name}`)?.length ?? 0,
            modifiedAt: 0,
            mode: 0o600
          }))
        }
      }
      case 'read': {
        const path = `${ovenPath(input.root)}/${input.path}`
        const data = this.files.get(path)
        if (!data) throw missing(path)
        return {
          root: input.root,
          data: data.subarray(input.offset).toString('base64'),
          size: data.length
        }
      }
      case 'mkdir': {
        const path =
          input.path === '.' ? ovenPath(input.root) : `${ovenPath(input.root)}/${input.path}`
        this.directories.add(path)
        return { root: input.root }
      }
      case 'write': {
        const path = `${ovenPath(input.root)}/${input.path}`
        const data = Buffer.from(input.data, 'base64')
        const current = this.files.get(path) ?? Buffer.alloc(0)
        const merged = Buffer.alloc(Math.max(current.length, input.offset + data.length))
        current.copy(merged, 0)
        data.copy(merged, input.offset)
        this.files.set(path, merged)
        return { root: input.root }
      }
      case 'replace': {
        const path = `${ovenPath(input.root)}/${input.path}`
        const staged = `${ovenPath(input.root)}/${input.staged}`
        const data = this.files.get(staged)
        if (!data) throw missing(staged)
        this.files.delete(staged)
        this.files.set(path, data)
        return { root: input.root }
      }
      case 'remove': {
        const path = `${ovenPath(input.root)}/${input.path}`
        if (!this.files.delete(path)) throw missing(path)
        return { root: input.root }
      }
      default:
        throw new Error(`Unexpected workspace operation: ${input.operation}`)
    }
  }
}

function ovenPath(value: string): string {
  return value.replace(/\\/gu, '/').replace(/\/+$/u, '')
}

function missing(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, scandir '${path}'`), {
    code: 'ENOENT'
  })
}

/** The run whose transcripts are files on this machine. */
async function localRun(): Promise<ParityRun> {
  const agentDirectory = join(await scratch(), 'agent')
  await mkdir(nativePiSessionDir(LOCAL_PROJECT, agentDirectory), { recursive: true })
  return {
    projectPath: LOCAL_PROJECT,
    agentDirectory,
    source: localPiNativeTranscriptSource(agentDirectory),
    install: () => installRemotePiNativeTranscriptSource(null)
  }
}

/** The run whose transcripts live on an Oven. */
function ovenRun(): ParityRun {
  const service = new FakeOvenFiles()
  const route: OvenPiTranscriptRoute = { ovenId: OVEN, agentDirectory: OVEN_ACCOUNT }
  const source = ovenPiTranscriptSource({
    service,
    route: (projectPath) => (projectPath === OVEN_PROJECT ? route : null)
  })
  return {
    projectPath: OVEN_PROJECT,
    agentDirectory: OVEN_ACCOUNT,
    source,
    // Exactly what the Oven driver does when it is built: the whole app now
    // reads that machine's copies for the projects it holds.
    install: () => installRemotePiNativeTranscriptSource(source)
  }
}

/** A session record with no native binding yet, as an edited thread starts. */
function seedableSession(): PersistentCliSession {
  const now = Date.now()
  return {
    id: SESSION,
    title: 'Pi',
    projectPathHash: 'hash',
    messages: [],
    createdAt: now,
    updatedAt: now
  }
}

/**
 * The driver-side host for both transcript paths, with only what the scenario
 * reaches implemented: there is no live RPC client, no CLI session record, and
 * the engine's mirror is unavailable (which is what sends a child's transcript
 * load to the native file in the first place).
 */
function host(input: { run: ParityRun; record: PersistentCliSession }): PiNativeSessionsHost {
  return {
    agentDirectory: input.run.agentDirectory,
    nativeTranscripts: input.run.source,
    storage: { read: async () => null } as unknown as StorageEngine,
    hasClient: () => false,
    rpcClient: () => undefined,
    // A delegated child session is never persisted as a CLI session record:
    // that absence is what sends its load to the native transcript.
    session: async (_projectPath, sessionId) => {
      if (sessionId !== input.record.id) throw new Error('CLI session is unavailable')
      return input.record
    },
    persistSession: async () => undefined,
    sessionRecordPath: (sessionId) => `sessions/${sessionId}.json`,
    loadMirroredMessages: async () => {
      throw new Error('CLI session is unavailable')
    },
    findLatestThreadSession: async () => null,
    markNativeSessionResumed: () => undefined,
    childSnapshot: () => undefined,
    watchChildSession: () => undefined
  }
}

/** The text one transcript carries, so two runs compare messages, not bytes. */
async function transcriptLines(
  source: PiNativeTranscriptSource,
  projectPath: string,
  name: string,
  sessionId: string
): Promise<string[]> {
  const text = await source.read(projectPath, name)
  if (text === null) return []
  const messages = await parseNativePiTranscriptText(text, sessionId)
  return messages.map((message) => {
    const text = message.parts
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join(' ')
    return `${message.role}: ${text}`
  })
}

/** Drive the whole scenario against one machine. */
async function drive(run: ParityRun): Promise<ParityObservations> {
  run.install()
  const record = seedableSession()
  const sessions = new PiNativeSessions(host({ run, record }))

  // 1. Seed the edited mirror as a native transcript, then read it back.
  const seeded = await sessions.prefillNativeSession(run.projectPath, SESSION, MIRROR)
  const nativeId = record.nativeSessionId ?? ''
  expect(nativeId).not.toBe('')
  const seededName =
    (await run.source.list(run.projectPath))?.find((name) => name.endsWith(`_${nativeId}.jsonl`)) ??
    ''
  const seededMessages = await transcriptLines(run.source, run.projectPath, seededName, SESSION)
  const seededTimestamp = seededName.slice(0, seededName.indexOf('_'))

  // 2. A delegated child's transcript appears only after the caller started
  //    waiting, exactly as pi defers a new session's first flush.
  const childName = `2026-06-01T00-00-00-000Z_${CHILD}.jsonl`
  const childWrite = new Promise<void>((resolve) => {
    setTimeout(() => {
      void run.source.write(run.projectPath, childName, childTranscript()).then(
        () => resolve(),
        () => resolve()
      )
    }, 200)
  })
  const child = await sessions.loadSubagentMessages(run.projectPath, CHILD, {
    waitForFlush: true
  })
  await childWrite

  // 3. A settled child whose transcript never appeared.
  const childTranscriptMissing = await sessions.loadSubagentMessages(
    run.projectPath,
    MISSING_CHILD,
    { waitForFlush: false }
  )

  // 4. Reconcile a compaction marker: the mirrored compaction gets its retained
  //    boundary back, and the compaction no event ever reported is recovered.
  //    pi compaction rewrites the session's own file, so the newest transcript
  //    for that native id is the one the seeded conversation lives in.
  await run.source.write(run.projectPath, seededName, reconcileTranscript(nativeId))
  record.messages = [mirroredCompaction()]
  const recovered: string[] = []
  await reconcileNativeCompactions(
    record,
    run.projectPath,
    (messages) => {
      for (const message of messages) {
        for (const part of message.parts) {
          if (part.type !== 'compaction') continue
          recovered.push(`${part.summary}#${part.firstKeptCreatedAt ?? 'none'}`)
        }
      }
    },
    run.agentDirectory
  )
  const compactionPart = record.messages[0]?.parts[0]

  const names = ((await run.source.list(run.projectPath)) ?? [])
    .sort()
    // The seeded file is named after the instant it was written, which differs
    // between the two runs by definition: what must match is pi's naming.
    .map((name) => name.replace(seededTimestamp, '<seeded>').replace(nativeId, '<native>'))
  return {
    seeded,
    seededMessages,
    transcriptNames: names,
    childMessages: child.map((message) => {
      const text = message.parts
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join(' ')
      return `${message.role}: ${text}`
    }),
    childTranscriptMissing,
    recovered,
    retainedBoundary:
      compactionPart?.type === 'compaction' ? compactionPart.firstKeptCreatedAt : undefined
  }
}

describe('native transcript parity between this machine and an Oven', () => {
  it('seeds, reads a child and reconciles a compaction the same way on both', async () => {
    const local = await drive(await localRun())
    const oven = await drive(ovenRun())

    // The seeded transcript parses into the same conversation, whatever machine
    // wrote it, and the same native id is bound to it.
    expect(local.seeded).toBe(true)
    expect(oven.seeded).toBe(true)
    expect(local.seededMessages).toEqual([
      'user: Plan the migration',
      'assistant: Reading the schema first.'
    ])
    expect(oven.seededMessages).toEqual(local.seededMessages)

    // pi's own naming, in the directory pi itself reads: one seeded transcript
    // that the compaction rewrote, and one child transcript, on both machines.
    expect(oven.transcriptNames).toEqual(local.transcriptNames)
    expect(local.transcriptNames).toEqual([
      '2026-06-01T00-00-00-000Z_child-1.jsonl',
      '<seeded>_<native>.jsonl'
    ])

    // A child transcript only pi's own flush could produce, waited for and read.
    expect(local.childMessages).toEqual([
      'user: Explore the codebase',
      'assistant: Found three call sites.'
    ])
    expect(oven.childMessages).toEqual(local.childMessages)

    // No transcript at all is the same answer, not a local failure.
    expect(local.childTranscriptMissing).toEqual([])
    expect(oven.childTranscriptMissing).toEqual([])

    // The compaction marker reconciles the same way: the retained boundary is
    // backfilled and the unreported compaction is recovered with its own.
    expect(local.retainedBoundary).toBe(BOUNDARY_AT)
    expect(oven.retainedBoundary).toBe(BOUNDARY_AT)
    expect(local.recovered).toEqual([`Second compaction after the plan.#${SECOND_AT}`])
    expect(oven.recovered).toEqual(local.recovered)
  })

  it('reconciles a project that runs here on this machine, not over the Oven', async () => {
    const oven = ovenRun()
    // The Oven source is installed for the app, but this project is not one of
    // that machine's checkouts: its transcripts stay on this computer's disk.
    installRemotePiNativeTranscriptSource(oven.source)
    const local = await localRun()
    const record = seedableSession()
    record.nativeSessionId = 'local-native'
    const name = `2026-07-01T00-00-00-000Z_local-native.jsonl`
    await local.source.write(local.projectPath, name, reconcileTranscript('local-native'))
    record.messages = [mirroredCompaction()]
    const recovered: string[] = []

    await reconcileNativeCompactions(
      record,
      local.projectPath,
      (messages) => {
        recovered.push(...messages.map((message) => message.id))
      },
      local.agentDirectory
    )

    expect(oven.source.holds(local.projectPath)).toBe(false)
    expect(recovered).toHaveLength(1)
    expect(record.messages[0]?.parts[0]).toMatchObject({ firstKeptCreatedAt: BOUNDARY_AT })
  })
})
