import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ThreadTransferResult } from '../../src/lib/types'
import type { HandoffAck, HandoffRequest } from '../../src/main/system/instance-handoff-bus'
import { InstanceHandoffBus } from '../../src/main/system/instance-handoff-bus'
import {
  ThreadTransferService,
  type ThreadTransferEngine
} from '../../src/main/chat/thread-transfer-service'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() }
}))

/**
 * The two-sided hand-off, both sides in this one process.
 *
 * The engine double resolves the transfer target   the thread itself, or the
 * coordinator of the workflow it belongs to   and liveness is the injected
 * probe, so a sibling instance can be stood up as a second service speaking over
 * a second bus on one temporary handoff directory. Both sides then run the real
 * file protocol: a request routed by target pid, an ack routed by requester pid.
 */

/** The pid the owner peer records in the ledger; never this process. */
const OWNER_PID = 424_242
/** The pid a second, unrelated instance records in the ledger. */
const OTHER_PID = 424_243
const PROJECT_ID = 'project1'
const THREAD_ID = 'thread1'

const directories: string[] = []
const services: ThreadTransferService[] = []

async function handoffDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'codeinoven-handoff-'))
  directories.push(directory)
  return directory
}

interface EngineStub {
  engine: ThreadTransferEngine
  resolve: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
  adopt: ReturnType<typeof vi.fn>
}

/** A chat engine double: only the transfer operations the service calls. */
function engineStub(
  options: {
    ownerPid?: number | null
    release?: { released: boolean; reason?: string } | Error
    adopt?: ThreadTransferResult | Error
  } = {}
): EngineStub {
  const resolve = vi.fn(async () => ({
    rootThreadId: THREAD_ID,
    ownerPid: options.ownerPid ?? null
  }))
  const release = vi.fn(async (): Promise<{ released: boolean; reason?: string }> => {
    if (options.release instanceof Error) throw options.release
    return options.release ?? { released: true }
  })
  const adopt = vi.fn(async (): Promise<ThreadTransferResult> => {
    if (options.adopt instanceof Error) throw options.adopt
    return options.adopt ?? { ok: true }
  })
  return {
    engine: {
      resolveTransferTarget: resolve,
      releaseThreadForTransfer: release,
      adoptTransferredThread: adopt
    },
    resolve,
    release,
    adopt
  }
}

interface Harness {
  directory: string
  /** The window asking for the run: speaks as this process. */
  adopter: ThreadTransferService
  adopterEngine: EngineStub
  /** The window that owns the run: speaks as the recorded sibling. */
  owner: ThreadTransferService
  ownerEngine: EngineStub
}

async function harness(
  options: {
    ownerAlive?: boolean
    ownsTurn?: number | null
    release?: { released: boolean; reason?: string } | Error
    adopt?: ThreadTransferResult | Error
    startOwner?: boolean
  } = {}
): Promise<Harness> {
  const directory = await handoffDirectory()
  const ownerPid = options.ownsTurn === null ? null : (options.ownsTurn ?? OWNER_PID)

  const adopterEngine = engineStub({ ownerPid, adopt: options.adopt })
  const ownerEngine = engineStub({ release: options.release })

  const adopter = new ThreadTransferService(adopterEngine.engine, {
    bus: new InstanceHandoffBus(directory),
    isRunOwnerAlive: () => options.ownerAlive ?? true
  })
  const owner = new ThreadTransferService(ownerEngine.engine, {
    bus: new InstanceHandoffBus(directory, OWNER_PID)
  })
  services.push(adopter, owner)
  adopter.start()
  if (options.startOwner ?? true) owner.start()

  return { directory, adopter, adopterEngine, owner, ownerEngine }
}

/** The JSON files peers have left in the shared handoff directory. */
function handoffFiles(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.endsWith('.json'))
}

/** A request file exactly as a peer bus writes it. */
async function writeRequestFile(
  directory: string,
  request: HandoffRequest,
  nameSuffix = ''
): Promise<void> {
  await writeFile(
    join(directory, `${request.requestId}${nameSuffix}.req.json`),
    JSON.stringify(request),
    'utf8'
  )
}

function requestFrom(requesterPid: number, targetPid: number, requestId: string): HandoffRequest {
  return {
    requestId,
    requesterPid,
    targetPid,
    projectId: PROJECT_ID,
    threadId: THREAD_ID,
    createdAt: Date.now()
  }
}

async function readAck(directory: string, requestId: string): Promise<HandoffAck> {
  return JSON.parse(await readFile(join(directory, `${requestId}.ack.json`), 'utf8')) as HandoffAck
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150))
}

afterEach(async () => {
  for (const service of services.splice(0)) service.dispose()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('ThreadTransferService', () => {
  it('leaves a thread nobody is running alone', async () => {
    const { adopter, adopterEngine, directory, ownerEngine } = await harness({ ownsTurn: null })

    await expect(adopter.transferToThisInstance(PROJECT_ID, THREAD_ID)).resolves.toEqual({
      ok: true
    })
    expect(adopterEngine.adopt).not.toHaveBeenCalled()
    expect(ownerEngine.release).not.toHaveBeenCalled()
    expect(handoffFiles(directory)).toEqual([])
  })

  it('leaves a thread this process already owns alone', async () => {
    const { adopter, adopterEngine, directory, ownerEngine } = await harness({
      ownsTurn: process.pid
    })

    await expect(adopter.transferToThisInstance(PROJECT_ID, THREAD_ID)).resolves.toEqual({
      ok: true
    })
    expect(adopterEngine.adopt).not.toHaveBeenCalled()
    expect(ownerEngine.release).not.toHaveBeenCalled()
    expect(handoffFiles(directory)).toEqual([])
  })

  it('refuses a run whose recorded owner is gone, without asking anyone', async () => {
    const { adopter, adopterEngine, directory, ownerEngine } = await harness({ ownerAlive: false })

    await expect(adopter.transferToThisInstance(PROJECT_ID, THREAD_ID)).resolves.toEqual({
      ok: false,
      reason: 'The instance running this thread is no longer running.'
    })
    expect(adopterEngine.adopt).not.toHaveBeenCalled()
    expect(ownerEngine.release).not.toHaveBeenCalled()
    expect(handoffFiles(directory)).toEqual([])
  })

  it('hands a run from the owning instance to the asking instance', async () => {
    const { adopter, adopterEngine, directory, ownerEngine } = await harness()

    await expect(adopter.transferToThisInstance(PROJECT_ID, THREAD_ID)).resolves.toEqual({
      ok: true
    })
    // The owner stopped its run for the transfer, then the adopter resumed it.
    expect(ownerEngine.release).toHaveBeenCalledWith(PROJECT_ID, THREAD_ID)
    expect(adopterEngine.adopt).toHaveBeenCalledWith(PROJECT_ID, THREAD_ID)
    // Both sides retired their files: nothing is left for the sweep.
    expect(handoffFiles(directory)).toEqual([])
  })

  it("carries the owner's refusal back to the asking instance", async () => {
    const reason = 'This workflow is waiting on the user and cannot be handed over.'
    const { adopter, adopterEngine, ownerEngine } = await harness({
      release: { released: false, reason }
    })

    await expect(adopter.transferToThisInstance(PROJECT_ID, THREAD_ID)).resolves.toEqual({
      ok: false,
      reason
    })
    expect(ownerEngine.release).toHaveBeenCalledWith(PROJECT_ID, THREAD_ID)
    expect(adopterEngine.adopt).not.toHaveBeenCalled()
  })

  it('refuses when the owner cannot stop its run', async () => {
    const { adopter, adopterEngine, ownerEngine } = await harness({
      release: new Error('harness teardown failed')
    })

    await expect(adopter.transferToThisInstance(PROJECT_ID, THREAD_ID)).resolves.toEqual({
      ok: false,
      reason: 'The instance running this thread could not stop its run.'
    })
    expect(ownerEngine.release).toHaveBeenCalledWith(PROJECT_ID, THREAD_ID)
    expect(adopterEngine.adopt).not.toHaveBeenCalled()
  })

  it('answers an accepted request once, even when its file is delivered twice', async () => {
    const { directory, ownerEngine } = await harness()
    const request = requestFrom(OTHER_PID, OWNER_PID, 'sibling-request-1')

    // Publishing a request is a write-then-rename, so one request can legitimately
    // surface as more than one file for the same id. Both are on disk before any
    // directory read, so one pass sees them together.
    await writeRequestFile(directory, request)
    await writeRequestFile(directory, request, '-again')

    await vi.waitFor(() => expect(ownerEngine.release).toHaveBeenCalledTimes(1), {
      timeout: 10_000,
      interval: 25
    })
    expect(await readAck(directory, request.requestId)).toMatchObject({
      requestId: request.requestId,
      requesterPid: OTHER_PID,
      status: 'accepted'
    })

    await settle()
    expect(ownerEngine.release).toHaveBeenCalledTimes(1)
  })

  it('ignores a release request addressed to another instance', async () => {
    const { directory, ownerEngine } = await harness()
    const request = requestFrom(OTHER_PID, OTHER_PID, 'sibling-request-2')

    await writeRequestFile(directory, request)
    await settle()
    expect(ownerEngine.release).not.toHaveBeenCalled()
  })

  it('answers a request that was waiting before this instance started', async () => {
    const { directory, owner, ownerEngine } = await harness({ startOwner: false })
    const request = requestFrom(OTHER_PID, OWNER_PID, 'sibling-request-3')
    // The asking instance wrote this while nothing here was listening, so no
    // watch event for it can ever arrive: only reading the directory delivers it.
    await writeRequestFile(directory, request)

    owner.start()

    await vi.waitFor(() => expect(ownerEngine.release).toHaveBeenCalledTimes(1), {
      timeout: 10_000,
      interval: 25
    })
    expect(await readAck(directory, request.requestId)).toMatchObject({
      requestId: request.requestId,
      status: 'accepted'
    })
  })

  it('retires a hand-off file a crashed process left behind', async () => {
    const { directory } = await harness()
    // An ack for a requester that is gone: nobody consumes it, so only age can.
    const stale = join(directory, 'sibling-request-4.ack.json')
    await writeFile(
      stale,
      JSON.stringify({
        requestId: 'sibling-request-4',
        requesterPid: OTHER_PID,
        targetPid: OWNER_PID,
        status: 'accepted',
        createdAt: Date.now()
      })
    )
    const tenMinutesAgo = Date.now() / 1000 - 600
    utimesSync(stale, tenMinutesAgo, tenMinutesAgo)

    await vi.waitFor(() => expect(handoffFiles(directory)).toEqual([]), {
      timeout: 10_000,
      interval: 50
    })
  })

  it('refuses a transfer that is in flight when this instance shuts down', async () => {
    const { adopter, adopterEngine, directory, owner } = await harness()
    // The owner never answers: this bus is stopped with the request outstanding.
    owner.dispose()

    const transfer = adopter.transferToThisInstance(PROJECT_ID, THREAD_ID)
    await vi.waitFor(() => expect(handoffFiles(directory)).toHaveLength(1), {
      timeout: 10_000,
      interval: 25
    })
    adopter.dispose()

    await expect(transfer).resolves.toEqual({
      ok: false,
      reason: 'This instance is shutting down.'
    })
    expect(adopterEngine.adopt).not.toHaveBeenCalled()
  })
})
