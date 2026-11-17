import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PiCioRuntimeFiles,
  cioCoreToolsDirectory
} from '../../../src/main/drivers/pi/pi-driver-cio-files'
import type { HandoffWorkerSession } from '../../../src/main/drivers/driver.interface'
import { StorageEngine } from '../../../src/main/storage/storage-engine'

/**
 * The two app-to-harness files a thread move depends on.
 *
 * A move stops the departing run, so these files are the only channel that
 * tells the harness "this is not a user stop, hand the workers over" and then
 * gives the adopting instance's harness the roster to reopen. Both are pure
 * file publications, which is exactly what makes them testable here: nothing in
 * either path needs a live pi process.
 */

const roots: string[] = []
const SESSION_ID = 'session-transfer'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ storage: StorageEngine; files: PiCioRuntimeFiles }> {
  const scratch = join(process.cwd(), '.cio', 'tmp')
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'pi-cio-files-'))
  roots.push(root)
  const storage = new StorageEngine(root)
  await storage.initialize()
  const files = new PiCioRuntimeFiles({
    storage,
    isTitleSession: () => false,
    registerWatchPath: () => undefined
  })
  return { storage, files }
}

/** Materialize the extension once, which is what registers the flag paths. */
async function materialize(files: PiCioRuntimeFiles): Promise<void> {
  await files.materializeCoreToolsExtension(SESSION_ID, false, process.cwd())
}

async function readJson(
  storage: StorageEngine,
  relative: string
): Promise<Record<string, unknown>> {
  const raw = await storage.readRaw(relative)
  return raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>)
}

const stopFlag = join(cioCoreToolsDirectory(SESSION_ID), 'stop-request.json')
const handoffWorkers = join(cioCoreToolsDirectory(SESSION_ID), 'handoff-workers.json')

describe('PiCioRuntimeFiles thread hand-off', () => {
  it('tells the harness a move is not a user stop', async () => {
    const { storage, files } = await fixture()
    await materialize(files)

    await files.publishStopRequest(SESSION_ID, undefined, 'transfer')

    expect(await readJson(storage, stopFlag)).toMatchObject({ reason: 'transfer' })
  })

  it('keeps a reasonless stop a user stop', async () => {
    const { storage, files } = await fixture()
    await materialize(files)

    await files.publishStopRequest(SESSION_ID)

    expect(await readJson(storage, stopFlag)).toMatchObject({ reason: 'user' })
  })

  it('publishes the workers a move carried over, before the adopting session exists', async () => {
    const { storage, files } = await fixture()
    const workers: HandoffWorkerSession[] = [
      {
        agentId: 'cio-subagent-1',
        purpose: 'implementation',
        sessionFile: '/sessions/worker-1.jsonl',
        modelId: 'anthropic/claude-sonnet-4',
        thinkingLevel: 'high',
        prompt: 'Refactor the transfer service'
      }
    ]

    // No materialization: the adopting instance writes the roster before the
    // resumed thread's harness process exists.
    await files.publishHandoffWorkers(SESSION_ID, workers)

    expect(await readJson(storage, handoffWorkers)).toEqual({ workers })
  })
})
