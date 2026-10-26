import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  InstanceRegistry,
  type CrossInstanceThreadEvent
} from '../../src/main/system/instance-registry'

/**
 * The two halves of one shared-thread announcement.
 *
 * A batch this process publishes has to reach a sibling twice over: through the
 * registry entry (durable, and the only path to a peer that cannot dial) and
 * over the live link (immediate). Both arrive through the same listener and the
 * same batch id, so the contract under test is that publishing notifies local
 * consumers exactly once, that a batch received over the link is applied once,
 * and that neither path ever announces the other's batch back.
 */

const PROJECT_ID = 'project1'
const THREAD_ID = 'thread1'
const PEER_PID = 800_001

const directories: string[] = []
const registries: InstanceRegistry[] = []

afterEach(async () => {
  for (const registry of registries.splice(0)) registry.stop()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function registryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'codeinoven-instance-registry-'))
}

function createRegistry(directory: string): InstanceRegistry {
  const registry = new InstanceRegistry(directory, PEER_PID)
  registries.push(registry)
  return registry
}

function batch(threadId = THREAD_ID, overrides: Partial<CrossInstanceThreadEvent> = {}) {
  return {
    id: `peer:${threadId}:${Math.random()}`,
    emittedAt: Date.now(),
    rows: [{ projectId: PROJECT_ID, threadId }],
    drafts: [],
    messages: [],
    deleted: [],
    ...overrides
  } satisfies CrossInstanceThreadEvent
}

/** Resolve once `predicate` holds, so a coalesced publish never becomes a sleep. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for the instance registry')
}

describe('InstanceRegistry shared-thread announcements', () => {
  it('hands a published batch to local consumers, never back to the remote one', async () => {
    const registry = createRegistry(await registryDirectory())
    registry.start()
    const published: CrossInstanceThreadEvent[] = []
    const remote: CrossInstanceThreadEvent[] = []
    registry.onLocalThreadChanged((event) => published.push(event))
    registry.onThreadChanged((event) => remote.push(event))

    registry.publishThreadChanged(PROJECT_ID, THREAD_ID, 'row')

    await waitFor(() => published.length > 0)
    expect(published.map((event) => event.rows)).toEqual([
      [{ projectId: PROJECT_ID, threadId: THREAD_ID }]
    ])
    // A published batch is not a received one: forwarding it to the local remote
    // listener would make a window apply its own change as if a sibling sent it.
    expect(remote).toHaveLength(0)
  })

  it('applies a batch received over the live link once', async () => {
    const registry = createRegistry(await registryDirectory())
    const remote: CrossInstanceThreadEvent[] = []
    registry.onThreadChanged((event) => remote.push(event))
    const incoming = batch()

    registry.deliverRemoteThreadBatch(incoming)
    registry.deliverRemoteThreadBatch(incoming)

    expect(remote).toHaveLength(1)
    expect(remote[0]?.rows).toEqual(incoming.rows)
  })

  it('does not announce a batch it received back to this process', async () => {
    const registry = createRegistry(await registryDirectory())
    const published: CrossInstanceThreadEvent[] = []
    registry.onLocalThreadChanged((event) => published.push(event))

    registry.deliverRemoteThreadBatch(batch())
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(published).toHaveLength(0)
  })

  it('drops a batch that describes state a sibling has already moved past', async () => {
    const registry = createRegistry(await registryDirectory())
    const remote: CrossInstanceThreadEvent[] = []
    registry.onThreadChanged((event) => remote.push(event))

    registry.deliverRemoteThreadBatch(batch(THREAD_ID, { emittedAt: Date.now() - 5 * 60_000 }))

    expect(remote).toHaveLength(0)
  })

  it('keeps drafts in the batch a sibling receives', async () => {
    const registry = createRegistry(await registryDirectory())
    const remote: CrossInstanceThreadEvent[] = []
    registry.onThreadChanged((event) => remote.push(event))

    registry.deliverRemoteThreadBatch(
      batch(THREAD_ID, {
        rows: [],
        drafts: [{ projectId: PROJECT_ID, threadId: THREAD_ID }]
      })
    )

    expect(remote).toHaveLength(1)
    expect(remote[0]?.drafts).toEqual([{ projectId: PROJECT_ID, threadId: THREAD_ID }])
  })
})
