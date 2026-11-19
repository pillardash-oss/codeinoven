import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PiCioRuntimeFiles,
  PiCioSessionStorages,
  cioCoreToolsDirectory,
  type PiCioFilesStorage
} from '../../../src/main/drivers/pi/pi-driver-cio-files'
import { PiDriver } from '../../../src/main/drivers/pi-driver'
import type { CompactionFallbackContext } from '../../../src/main/drivers/driver.interface'
import { StorageEngine } from '../../../src/main/storage/storage-engine'

/**
 * Which file surface a session's handoff files land on.
 *
 * One driver instance serves every thread, and only some of those threads run
 * on a remote Oven. These tests pin the routing: a materialization writes into
 * exactly one session's store, never a sibling's, and dropping a route puts
 * that session back on the app's own engine with no other behaviour changed.
 */

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** One machine's handoff file store, in memory. */
class MemoryStorage implements PiCioFilesStorage {
  readonly files = new Map<string, string>()

  constructor(private readonly root: string) {}

  resolve(relativePath: string): string {
    return `${this.root}/${relativePath.replace(/\\/gu, '/')}`
  }

  async readRaw(relativePath: string): Promise<string | null> {
    return this.files.get(relativePath) ?? null
  }

  async writeRaw(relativePath: string, content: string): Promise<void> {
    this.files.set(relativePath, content)
  }

  async remove(relativePath: string): Promise<void> {
    this.files.delete(relativePath)
  }

  async getConfig(): Promise<{ agentQuestionCap: number }> {
    return { agentQuestionCap: 5 }
  }
}

interface MachineFixture {
  root: string
  engine: StorageEngine
}

async function localEngine(): Promise<MachineFixture> {
  const scratch = join(process.cwd(), '.cio', 'tmp')
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'pi-cio-files-storage-'))
  roots.push(root)
  const engine = new StorageEngine(root)
  await engine.initialize()
  return { root, engine }
}

function filesFor(machines: Map<string, PiCioFilesStorage>): PiCioRuntimeFiles {
  return new PiCioRuntimeFiles({
    storageFor: (sessionId) => {
      const storage = machines.get(sessionId)
      if (!storage) throw new Error(`No file surface was installed for session ${sessionId}`)
      return storage
    },
    isTitleSession: () => false,
    registerWatchPath: () => undefined
  })
}

describe('PiCioRuntimeFiles session storage', () => {
  it('materializes each session into its own store and never a sibling', async () => {
    const a = new MemoryStorage('/oven-a')
    const b = new MemoryStorage('/oven-b')
    const machines = new Map<string, PiCioFilesStorage>([
      ['session-a', a],
      ['session-b', b]
    ])
    const files = filesFor(machines)

    const extensionA = await files.materializeCoreToolsExtension('session-a', true, '/work')
    const extensionB = await files.materializeCoreToolsExtension('session-b', true, '/work')

    expect(extensionA).toBe(
      a.resolve(join(cioCoreToolsDirectory('session-a'), 'cio-core-tools.ts'))
    )
    expect(extensionB).toBe(
      b.resolve(join(cioCoreToolsDirectory('session-b'), 'cio-core-tools.ts'))
    )

    const directoryA = cioCoreToolsDirectory('session-a')
    const directoryB = cioCoreToolsDirectory('session-b')
    const pathsA = [...a.files.keys()]
    const pathsB = [...b.files.keys()]

    expect(pathsA.length).toBeGreaterThan(0)
    expect(pathsB.length).toBeGreaterThan(0)
    // Every file lives under its own session's directory; nothing bled across.
    for (const path of pathsA) expect(path.startsWith(directoryA)).toBe(true)
    for (const path of pathsB) expect(path.startsWith(directoryB)).toBe(true)
    expect(pathsA.some((path) => path.includes('session-b'))).toBe(false)
    expect(pathsB.some((path) => path.includes('session-a'))).toBe(false)

    // The seeds, and the question cap read from that machine's own config.
    expect(JSON.parse(a.files.get(join(directoryA, 'gateway-handoff.json')) ?? '')).toEqual({
      url: '',
      token: ''
    })
    expect(a.files.get(join(directoryA, 'allowed-tools.json'))).toBe('[]')
    expect(a.files.get(join(directoryA, 'system-prompt.txt'))).toBe('')
    expect(a.files.get(join(directoryA, 'cio-core-tools.ts'))).toContain('maxItems: 5')

    // A later publication follows the same route.
    await files.publishCioSystemPrompt('session-a', 'Be surgical.')
    expect(a.files.get(join(directoryA, 'system-prompt.txt'))).toBe('Be surgical.')
    expect(b.files.get(join(directoryB, 'system-prompt.txt'))).toBe('')
  })

  it('routes a per-turn flag file by the session that publishes it', async () => {
    const a = new MemoryStorage('/oven-a')
    const b = new MemoryStorage('/oven-b')
    const files = filesFor(
      new Map<string, PiCioFilesStorage>([
        ['session-a', a],
        ['session-b', b]
      ])
    )
    await files.materializeCoreToolsExtension('session-a', false, '/work')
    await files.materializeCoreToolsExtension('session-b', false, '/work')

    await files.publishOversizedRecovery('session-b', true)

    expect(b.files.get(join(cioCoreToolsDirectory('session-b'), 'oversized-recovery.json'))).toBe(
      JSON.stringify({ armed: true })
    )
    expect(a.files.get(join(cioCoreToolsDirectory('session-a'), 'oversized-recovery.json'))).toBe(
      JSON.stringify({ armed: false })
    )
  })
})

describe('PiCioSessionStorages', () => {
  it('defaults every session to the local engine', () => {
    const local = new MemoryStorage('/local')
    const storages = new PiCioSessionStorages(local)
    expect(storages.storageFor('session-a')).toBe(local)
  })

  it('routes one session, restores it with null, and forgets a torn-down session', () => {
    const local = new MemoryStorage('/local')
    const remote = new MemoryStorage('/oven-a')
    const storages = new PiCioSessionStorages(local)

    storages.set('session-a', remote)
    expect(storages.storageFor('session-a')).toBe(remote)
    expect(storages.storageFor('session-b')).toBe(local)

    storages.set('session-a', null)
    expect(storages.storageFor('session-a')).toBe(local)

    storages.set('session-a', remote)
    storages.forget('session-a')
    expect(storages.storageFor('session-a')).toBe(local)

    storages.set('session-a', remote)
    storages.clear()
    expect(storages.storageFor('session-a')).toBe(local)
  })
})

describe('PiDriver session storage', () => {
  const COMPACTION_CONTEXT = join(cioCoreToolsDirectory('session-a'), 'compaction-context.json')

  it('publishes a routed session to its machine and restores the local engine on null', async () => {
    const { root, engine } = await localEngine()
    const remote = new MemoryStorage('/oven-a')
    const driver = new PiDriver(engine)

    driver.setSessionStorage('session-a', remote)
    await driver.publishCompactionContext(root, 'session-a', null)
    expect(remote.files.get(COMPACTION_CONTEXT)).toBe(
      JSON.stringify({ plan: null, progress: null, planPath: null, progressPath: null })
    )
    expect(await engine.readRaw(COMPACTION_CONTEXT)).toBeNull()

    driver.setSessionStorage('session-a', null)
    const context: CompactionFallbackContext = {
      plan: 'Ship the seam.',
      progress: 'Halfway.',
      planPath: 'plans/thread.md',
      progressPath: null
    }
    await driver.publishCompactionContext(root, 'session-a', context)
    expect(await engine.readRaw(COMPACTION_CONTEXT)).toBe(JSON.stringify(context))
    // The remote copy of the earlier turn is untouched by the local publish.
    expect(remote.files.get(COMPACTION_CONTEXT)).toBe(
      JSON.stringify({ plan: null, progress: null, planPath: null, progressPath: null })
    )

    // A session that was never routed keeps using the app's engine, and routing
    // one session never moves another.
    driver.setSessionStorage('session-a', remote)
    await driver.publishCompactionContext(root, 'session-b', context)
    expect(
      await engine.readRaw(join(cioCoreToolsDirectory('session-b'), 'compaction-context.json'))
    ).toBe(JSON.stringify(context))
    expect(
      remote.files.has(join(cioCoreToolsDirectory('session-b'), 'compaction-context.json'))
    ).toBe(false)
  })
})
