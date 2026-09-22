import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { HandoffRequest } from '../../src/main/system/instance-handoff-bus'
import { InstanceHandoffBus } from '../../src/main/system/instance-handoff-bus'

/**
 * The bus with no watch events at all.
 *
 * A watch event is not a delivery guarantee: FSEvents can drop events for a
 * directory created moments before the watcher attached, coalesce several writes
 * into one event naming an already-replaced file, and inotify can overflow its
 * queue. The watcher is stubbed out here so every assertion below is satisfied by
 * the bus reading the directory itself, which is the floor a stranded request or
 * ack falls back to.
 */
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, watch: () => ({ on: () => undefined, close: () => undefined }) }
})

/** The peer that owns the run. */
const OWNER_PID = 424_242
/** An unrelated instance, standing in for a requester that is gone. */
const OTHER_PID = 424_243
const PROJECT_ID = 'project1'
const THREAD_ID = 'thread1'

const directories: string[] = []
const buses: InstanceHandoffBus[] = []

async function handoffDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'codeinoven-bus-'))
  directories.push(directory)
  return directory
}

function startedBus(directory: string, localPid?: number): InstanceHandoffBus {
  const bus =
    localPid === undefined
      ? new InstanceHandoffBus(directory)
      : new InstanceHandoffBus(directory, localPid)
  buses.push(bus)
  bus.start()
  return bus
}

function handoffFiles(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.endsWith('.json'))
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

afterEach(async () => {
  for (const bus of buses.splice(0)) bus.stop()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('InstanceHandoffBus', () => {
  it('delivers a request and its verdict with no watch events at all', async () => {
    const directory = await handoffDirectory()
    const requester = startedBus(directory)
    const owner = startedBus(directory, OWNER_PID)
    owner.onRequest((request) => {
      void owner.respond(request, 'accepted')
    })

    const ack = await requester.request(OWNER_PID, PROJECT_ID, THREAD_ID)

    expect(ack).toMatchObject({
      status: 'accepted',
      requesterPid: process.pid,
      targetPid: OWNER_PID
    })
    // Both sides retire their own files, so nothing is left for the sweep.
    expect(handoffFiles(directory)).toEqual([])
  })

  it('picks up a request that was already waiting when the bus started', async () => {
    const directory = await handoffDirectory()
    const request = requestFrom(OTHER_PID, OWNER_PID, 'waiting-1')
    await writeFile(
      join(directory, `${request.requestId}.req.json`),
      JSON.stringify(request),
      'utf8'
    )

    const owner = startedBus(directory, OWNER_PID)
    const received: HandoffRequest[] = []
    owner.onRequest((incoming) => received.push(incoming))

    await vi.waitFor(() => expect(received).toEqual([request]), { timeout: 10_000, interval: 25 })
  })

  it('leaves a request addressed to another process alone', async () => {
    const directory = await handoffDirectory()
    const owner = startedBus(directory, OWNER_PID)
    const received: HandoffRequest[] = []
    owner.onRequest((incoming) => received.push(incoming))
    const request = requestFrom(OTHER_PID, OTHER_PID, 'elsewhere-1')
    await writeFile(
      join(directory, `${request.requestId}.req.json`),
      JSON.stringify(request),
      'utf8'
    )

    // Longer than one directory read, so "not delivered" is not a timing accident.
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect(received).toEqual([])
    expect(handoffFiles(directory)).toEqual([`${request.requestId}.req.json`])
  })

  it('refuses an outstanding request when the bus shuts down', async () => {
    const directory = await handoffDirectory()
    const requester = startedBus(directory)

    const pending = requester.request(OWNER_PID, PROJECT_ID, THREAD_ID)
    expect(handoffFiles(directory)).toHaveLength(1)
    requester.stop()

    await expect(pending).resolves.toMatchObject({
      status: 'refused',
      reason: 'This instance is shutting down.'
    })
  })
})
