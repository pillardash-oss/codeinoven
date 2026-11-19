import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentMessage } from '../../../src/lib/types'
import type { PersistentCliSession } from '../../../src/main/drivers/persistent-cli-driver'
import type { PiSessionClient } from '../../../src/main/drivers/pi/pi-client'
import {
  PiNativeSessions,
  type PiNativeSessionsHost
} from '../../../src/main/drivers/pi/pi-driver-native-session'
import {
  findNativePiTranscriptName,
  localPiNativeTranscriptSource,
  nativePiSessionDir,
  parseNativePiSession,
  parseNativePiTranscriptText,
  type PiNativeTranscriptSource
} from '../../../src/main/drivers/pi/pi-native-session'
import type { StorageEngine } from '../../../src/main/storage/storage-engine'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** A scratch directory a test may fill with pi's own session files. */
async function scratch(): Promise<string> {
  const base = join(process.cwd(), '.cio', 'tmp')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'pi-native-transcripts-'))
  roots.push(root)
  return root
}

const PROJECT = '/projects/demo'
const NATIVE = '1f0e6a52-1f5c-4a4c-8f38-6d1c0f4b2a11'

/** One transcript pi itself would have written: session, turns, compaction. */
const TRANSCRIPT = [
  {
    type: 'session',
    version: 3,
    id: NATIVE,
    timestamp: '2026-01-01T00:00:00.000Z',
    cwd: PROJECT
  },
  {
    type: 'message',
    id: 'entry-1',
    parentId: null,
    timestamp: '2026-01-01T00:00:01.000Z',
    message: {
      role: 'user',
      timestamp: 1_767_225_601_000,
      content: [{ type: 'text', text: 'Plan the migration' }]
    }
  },
  {
    type: 'message',
    id: 'entry-2',
    parentId: 'entry-1',
    timestamp: '2026-01-01T00:00:02.000Z',
    message: {
      role: 'assistant',
      timestamp: 1_767_225_602_000,
      model: 'gpt-5',
      provider: 'openai',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'Reading the schema first.' }]
    }
  },
  {
    type: 'compaction',
    summary: 'The schema was read; the plan follows.',
    firstKeptEntryId: 'entry-1',
    timestamp: '2026-01-01T00:00:03.000Z'
  }
]

/** The transcript as one JSONL file's text. */
function transcriptText(): string {
  return `${TRANSCRIPT.map((entry) => JSON.stringify(entry)).join('\n')}\n`
}

/** One transcript's file name, in pi's `<timestamp>_<sessionId>.jsonl` form. */
function transcriptName(timestamp: string): string {
  return `${timestamp}_${NATIVE}.jsonl`
}

/**
 * A transcript source that keeps its files in memory.
 *
 * It is the seam a session running on another machine plugs into, so a test can
 * prove the resume path reads through it instead of this computer's disk.
 */
class FakeTranscripts implements PiNativeTranscriptSource {
  readonly files = new Map<string, string>()

  resolve(projectPath: string, fileName: string): string {
    return `${projectPath}/${fileName}`
  }

  async list(projectPath: string): Promise<string[] | null> {
    const names = [...this.files.keys()]
      .filter((path) => path.startsWith(`${projectPath}/`))
      .map((path) => path.slice(projectPath.length + 1))
    return names.length ? names : null
  }

  async read(projectPath: string, fileName: string): Promise<string | null> {
    return this.files.get(`${projectPath}/${fileName}`) ?? null
  }

  async remove(projectPath: string, fileName: string): Promise<void> {
    this.files.delete(`${projectPath}/${fileName}`)
  }
}

/** A session record with the native pi session this conversation was bound to. */
function sessionRecord(): PersistentCliSession {
  const now = Date.now()
  return {
    id: 'session-1',
    title: 'Pi',
    projectPathHash: 'hash',
    nativeSessionId: NATIVE,
    messages: [],
    createdAt: now,
    updatedAt: now
  }
}

/**
 * The driver-side host, with only what each test actually reaches implemented.
 *
 * The native-transcript host never reads the mirror on a resume, so the storage
 * engine is a stub: a test that unexpectedly calls it fails on its assertion
 * rather than silently reading a fixture.
 */
function host(overrides: Partial<PiNativeSessionsHost>): PiNativeSessionsHost {
  return {
    agentDirectory: undefined,
    storage: { read: async () => null } as unknown as StorageEngine,
    hasClient: () => false,
    rpcClient: () => undefined,
    session: async () => {
      throw new Error('CLI session is unavailable')
    },
    persistSession: async () => undefined,
    sessionRecordPath: (sessionId) => `sessions/${sessionId}.json`,
    loadMirroredMessages: async () => [],
    findLatestThreadSession: async () => null,
    markNativeSessionResumed: () => undefined,
    childSnapshot: () => undefined,
    watchChildSession: () => undefined,
    ...overrides
  }
}

/** A pi RPC client that records the transcript each resume opens. */
function client(switched: string[]): PiSessionClient {
  return {
    switchSession: async (file: string) => {
      switched.push(file)
    }
  } as unknown as PiSessionClient
}

describe('local Pi native transcript source', () => {
  it("lists, reads and removes pi's own session files", async () => {
    const agentDirectory = join(await scratch(), 'agent')
    const source = localPiNativeTranscriptSource(agentDirectory)
    const directory = nativePiSessionDir(PROJECT, agentDirectory)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, transcriptName('2026-01-01T00-00-00-000Z')), transcriptText())

    expect(source.resolve(PROJECT, transcriptName('2026-01-01T00-00-00-000Z'))).toBe(
      join(directory, transcriptName('2026-01-01T00-00-00-000Z'))
    )
    expect(await source.list(PROJECT)).toEqual([transcriptName('2026-01-01T00-00-00-000Z')])
    expect(await source.read(PROJECT, transcriptName('2026-01-01T00-00-00-000Z'))).toBe(
      transcriptText()
    )

    await source.remove(PROJECT, transcriptName('2026-01-01T00-00-00-000Z'))
    expect(await source.list(PROJECT)).toEqual([])
    expect(await source.read(PROJECT, transcriptName('2026-01-01T00-00-00-000Z'))).toBeNull()
  })

  it('reports an absent project directory as no transcripts, not a failure', async () => {
    const source = localPiNativeTranscriptSource(join(await scratch(), 'agent'))
    expect(await source.list('/projects/never-opened')).toBeNull()
    expect(await source.read('/projects/never-opened', 'anything.jsonl')).toBeNull()
  })
})

describe('findNativePiTranscriptName', () => {
  it('picks the newest file for one native session id', async () => {
    const source = new FakeTranscripts()
    for (const name of [
      transcriptName('2026-01-01T00-00-00-000Z'),
      transcriptName('2026-03-01T00-00-00-000Z'),
      transcriptName('2026-02-01T00-00-00-000Z'),
      `2026-04-01T00-00-00-000Z_${NATIVE}-child.jsonl`
    ]) {
      source.files.set(`${PROJECT}/${name}`, '')
    }
    expect(await findNativePiTranscriptName(source, PROJECT, NATIVE)).toBe(
      transcriptName('2026-03-01T00-00-00-000Z')
    )
  })

  it('finds nothing without a session file, and nothing for an absent directory', async () => {
    const source = new FakeTranscripts()
    expect(await findNativePiTranscriptName(source, PROJECT, NATIVE)).toBeNull()
    source.files.set(`${PROJECT}/${transcriptName('2026-01-01T00-00-00-000Z')}`, '')
    expect(await findNativePiTranscriptName(source, PROJECT, 'some-other-id')).toBeNull()
  })
})

describe('resuming through the transcript source', () => {
  it('opens the newest matching file the source resolves', async () => {
    const source = new FakeTranscripts()
    source.files.set(`${PROJECT}/${transcriptName('2026-01-01T00-00-00-000Z')}`, transcriptText())
    source.files.set(`${PROJECT}/${transcriptName('2026-02-01T00-00-00-000Z')}`, transcriptText())
    const switched: string[] = []
    const resumed: string[] = []
    const sessions = new PiNativeSessions(
      host({
        nativeTranscripts: source,
        session: async () => sessionRecord(),
        markNativeSessionResumed: (sessionId) => resumed.push(sessionId)
      })
    )

    await sessions.resumeNativePiSession(PROJECT, 'session-1', client(switched))

    expect(switched).toEqual([`${PROJECT}/${transcriptName('2026-02-01T00-00-00-000Z')}`])
    expect(resumed).toEqual(['session-1'])
  })

  it('leaves a fresh session in place when the source holds no transcript', async () => {
    const switched: string[] = []
    const resumed: string[] = []
    const sessions = new PiNativeSessions(
      host({
        nativeTranscripts: new FakeTranscripts(),
        session: async () => sessionRecord(),
        markNativeSessionResumed: (sessionId) => resumed.push(sessionId)
      })
    )

    await sessions.resumeNativePiSession(PROJECT, 'session-1', client(switched))

    expect(switched).toEqual([])
    expect(resumed).toEqual([])
  })

  it('reports native history and reads a cold session through the source', async () => {
    const source = new FakeTranscripts()
    source.files.set(`${PROJECT}/${transcriptName('2026-01-01T00-00-00-000Z')}`, transcriptText())
    const record = sessionRecord()
    const sessions = new PiNativeSessions(
      host({
        nativeTranscripts: source,
        session: async () => record,
        loadMirroredMessages: async () => {
          throw new Error('the mirror must not be read when the transcript is there')
        }
      })
    )

    expect(await sessions.holdsNativeHistory(PROJECT, 'session-1')).toBe(true)
    const messages: AgentMessage[] = await sessions.loadMessages(PROJECT, 'session-1')
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(messages[0]?.parts[0]).toMatchObject({ type: 'text', text: 'Plan the migration' })
    expect(messages[2]?.parts[0]).toMatchObject({ type: 'compaction' })
  })
})

describe('parsing a native transcript', () => {
  it('yields the same messages for local file text and remote text', async () => {
    const agentDirectory = join(await scratch(), 'agent')
    const directory = nativePiSessionDir(PROJECT, agentDirectory)
    await mkdir(directory, { recursive: true })
    const name = transcriptName('2026-01-01T00-00-00-000Z')
    await writeFile(join(directory, name), transcriptText())

    const local = await parseNativePiSession(join(directory, name), 'session-1')
    const remote = await parseNativePiTranscriptText(transcriptText(), 'session-1')

    expect(remote).toEqual(local)
    expect(local.map((message) => message.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(local[1]?.parts[0]).toMatchObject({ type: 'text', text: 'Reading the schema first.' })
  })

  it('parses CRLF text exactly as the local reader parses the same bytes', async () => {
    const crlf = transcriptText().replace(/\n/gu, '\r\n')
    const local = await parseNativePiTranscriptText(transcriptText(), 'session-1')
    expect(await parseNativePiTranscriptText(crlf, 'session-1')).toEqual(local)
  })
})
