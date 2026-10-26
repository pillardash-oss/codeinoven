import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, RemoteAgentEventPayload } from '../../src/lib/types'
import {
  InstanceEventBus,
  type InstanceEventBusOptions
} from '../../src/main/system/instance-event-bus'
import type { CrossInstanceThreadEvent } from '../../src/main/system/instance-registry'

/**
 * Two peers, one directory: the shape two running apps share, without starting a
 * second app process. Each bus is given its own pid, its own view of the live
 * instance set, and its own membership channel, so every assertion below
 * describes the contract the app relies on: only render-only events cross, each
 * frame names the conversation that owns it, and a process running alone serves
 * nothing at all.
 */

const PEER_A = 700_001
const PEER_B = 700_002
const PROJECT_ID = 'project1'
const THREAD_ID = 'thread1'

const directories: string[] = []
const buses: InstanceEventBus[] = []

afterEach(async () => {
  for (const bus of buses.splice(0)) bus.stop()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function busDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'codeinoven-stream-bus-'))
}

/** The live instance set one peer sees, plus the membership channel it hears. */
interface Membership {
  pids: number[]
  listeners: Set<() => void>
  announce: () => void
}

function membership(...pids: number[]): Membership {
  const state: Membership = {
    pids,
    listeners: new Set(),
    announce: () => {
      for (const listener of state.listeners) listener()
    }
  }
  return state
}

/** One peer whose membership is decided by the test, not by the real registry. */
function peer(
  directory: string,
  pid: number,
  live: Membership,
  options: InstanceEventBusOptions = {}
): InstanceEventBus {
  const bus = new InstanceEventBus({
    directory,
    localPid: pid,
    liveInstancePids: () => live.pids,
    subscribeToMembership: (listener) => {
      live.listeners.add(listener)
      return () => live.listeners.delete(listener)
    },
    ...options
  })
  directories.push(directory)
  buses.push(bus)
  return bus
}

/** A thread invalidation batch, the shape the registry publishes. */
function threadBatch(threadId = THREAD_ID): CrossInstanceThreadEvent {
  return {
    id: `peer:${threadId}:${Math.random()}`,
    emittedAt: Date.now(),
    rows: [{ projectId: PROJECT_ID, threadId }],
    drafts: [],
    messages: [],
    deleted: []
  }
}

function deltaEvent(sessionId = 'session1'): AgentEvent {
  return {
    type: 'message.part.delta',
    sessionId,
    messageId: 'message1',
    partId: 'part1',
    field: 'text',
    delta: 'hello'
  }
}

/** Resolve once `predicate` holds, so a socket round trip never becomes a sleep. */
async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for the cross-instance bus')
}

describe('InstanceEventBus', () => {
  it('delivers a stream event from the peer that produced it, naming its conversation', async () => {
    const directory = await busDirectory()
    const live = membership(PEER_A, PEER_B)
    const receiver = peer(directory, PEER_A, live)
    const sender = peer(directory, PEER_B, live)
    const received: RemoteAgentEventPayload[] = []
    receiver.onRemoteEvent((payload) => received.push(payload))
    sender.setSessionOwnerResolver(() => ({ projectId: PROJECT_ID, threadId: THREAD_ID }))
    receiver.start()
    sender.start()

    await waitFor(() => sender.hasConnectedPeers)
    sender.publishAgentEvent(deltaEvent())

    await waitFor(() => received.length > 0)
    expect(received[0]).toMatchObject({
      projectId: PROJECT_ID,
      threadId: THREAD_ID,
      from: PEER_B
    })
    expect(received[0]?.event).toEqual(deltaEvent())
  })

  it('never carries an event only the process that owns the run can act on', async () => {
    const directory = await busDirectory()
    const live = membership(PEER_A, PEER_B)
    const receiver = peer(directory, PEER_A, live)
    const sender = peer(directory, PEER_B, live)
    const received: RemoteAgentEventPayload[] = []
    receiver.onRemoteEvent((payload) => received.push(payload))
    receiver.start()
    sender.start()
    await waitFor(() => sender.hasConnectedPeers)

    const actionable: AgentEvent[] = [
      {
        type: 'permission.asked',
        sessionId: 'session1',
        permission: {
          id: 'permission1',
          sessionId: 'session1',
          permission: 'bash',
          patterns: ['rm -rf build'],
          metadata: {}
        }
      },
      { type: 'question.asked', sessionId: 'session1', requestId: 'request1', questions: [] }
    ]
    for (const event of actionable) sender.publishAgentEvent(event)
    sender.publishAgentEvent(deltaEvent())

    await waitFor(() => received.length > 0)
    expect(received.map((payload) => payload.event.type)).toEqual(['message.part.delta'])
  })

  it('serves and dials nothing while this process is the only live instance', async () => {
    const directory = await busDirectory()
    const live = membership(PEER_A)
    const alone = peer(directory, PEER_A, live)
    const received: RemoteAgentEventPayload[] = []
    alone.onRemoteEvent((payload) => received.push(payload))
    alone.start()

    alone.publishAgentEvent(deltaEvent())
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(received).toHaveLength(0)
    expect(alone.hasConnectedPeers).toBe(false)
    expect(alone.isServing).toBe(false)
  })

  it('connects when a sibling launches after this instance settled in', async () => {
    const directory = await busDirectory()
    const live = membership(PEER_A)
    const receiver = peer(directory, PEER_A, live)
    const sender = peer(directory, PEER_B, live)
    const received: RemoteAgentEventPayload[] = []
    receiver.onRemoteEvent((payload) => received.push(payload))
    receiver.start()
    // Before the sibling exists the receiver is alone, so it is not serving.
    expect(receiver.isServing).toBe(false)

    // The sibling launches and both processes learn the new membership the way
    // the instance registry announces a new live process.
    live.pids = [PEER_A, PEER_B]
    receiver.start()
    sender.start()
    live.announce()

    await waitFor(() => sender.hasConnectedPeers && receiver.hasConnectedPeers)
    sender.publishAgentEvent(deltaEvent())
    await waitFor(() => received.length > 0)
    expect(received[0]?.event.type).toBe('message.part.delta')
  })

  it('stops serving when the last sibling exits', async () => {
    const directory = await busDirectory()
    const live = membership(PEER_A, PEER_B)
    const alone = peer(directory, PEER_A, live)
    alone.start()
    expect(alone.isServing).toBe(true)

    live.pids = [PEER_A]
    live.announce()
    expect(alone.isServing).toBe(false)
    expect(alone.hasConnectedPeers).toBe(false)
  })

  it('carries shared-thread invalidations over the same link as the stream', async () => {
    const directory = await busDirectory()
    const live = membership(PEER_A, PEER_B)
    const receiver = peer(directory, PEER_A, live)
    const sender = peer(directory, PEER_B, live)
    const received: CrossInstanceThreadEvent[] = []
    receiver.onRemoteThreadChange((batch) => received.push(batch))
    receiver.start()
    sender.start()

    await waitFor(() => sender.hasConnectedPeers)
    const batch = threadBatch()
    sender.publishThreadChange(batch)

    await waitFor(() => received.length > 0)
    expect(received[0]).toEqual(batch)
  })

  it('links a peer whose endpoint appears only after a slow boot', async () => {
    const directory = await busDirectory()
    // Both instances already know about each other, but only the dialer is up:
    // the sibling's feature boot is still running, exactly the shape that used
    // to leave two windows listening and never connected.
    const live = membership(PEER_A, PEER_B)
    const receiver = peer(directory, PEER_A, live, {
      redial: { baseDelayMs: 5, maxDelayMs: 5 }
    })
    const sender = peer(directory, PEER_B, live, {
      redial: { baseDelayMs: 5, maxDelayMs: 5 }
    })
    const received: RemoteAgentEventPayload[] = []
    receiver.onRemoteEvent((payload) => received.push(payload))
    receiver.start()
    expect(receiver.hasConnectedPeers).toBe(false)

    await new Promise((resolve) => setTimeout(resolve, 300))
    sender.start()

    await waitFor(() => receiver.hasConnectedPeers && sender.hasConnectedPeers)
    sender.publishAgentEvent(deltaEvent())
    await waitFor(() => received.length > 0)
    expect(received[0]?.event).toEqual(deltaEvent())
  })
})
