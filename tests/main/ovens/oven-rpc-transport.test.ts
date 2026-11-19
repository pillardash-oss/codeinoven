/**
 * The Oven side of the RPC transport seam: a run's journal polled into the same
 * line stream a local pipe produces.
 *
 * Every service here is a fake in memory: no SSH, no Oven, no network.
 */
import { describe, expect, it, vi } from 'vitest'
import type { OvenRun, OvenRunEvent } from '../../../src/lib/ovens'
import { ovenRpcTransport, type OvenRunService } from '../../../src/main/ovens/oven-rpc-transport'

const tick = (ms = 0): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the transport')
    await tick(5)
  }
}

function run(status: OvenRun['status'], exitCode?: number | null): OvenRun {
  return { id: 'run-1', command: 'pi', cwd: '/oven/work', status, createdAt: 1, exitCode }
}

function page(events: OvenRunEvent[], status: OvenRun['status'], exitCode?: number | null) {
  return { run: run(status, exitCode), events }
}

interface FakeOven {
  service: OvenRunService
  writes: string[]
  eventCalls: number
  maxConcurrent: number
  stop: ReturnType<typeof vi.fn>
}

/** A service that answers the events call from a script, then repeats its last page. */
function fakeOven(pages: { run: OvenRun; events: OvenRunEvent[] }[]): FakeOven {
  const writes: string[] = []
  const stop = vi.fn(async () => undefined)
  let eventCalls = 0
  let active = 0
  let maxConcurrent = 0
  const service: OvenRunService = {
    write: async (_ovenId, _runId, input) => {
      writes.push(input)
    },
    events: async (_ovenId, _runId, after) => {
      active += 1
      maxConcurrent = Math.max(maxConcurrent, active)
      eventCalls += 1
      const next = pages[Math.min(eventCalls - 1, pages.length - 1)]
      active -= 1
      if (!next) throw new Error('the fake served no page')
      // The real service only ever returns records after the cursor it was given.
      return { run: next.run, events: next.events.filter((event) => event.sequence > after) }
    },
    stop
  }
  return {
    service,
    writes,
    stop,
    get eventCalls() {
      return eventCalls
    },
    get maxConcurrent() {
      return maxConcurrent
    }
  }
}

describe('ovenRpcTransport', () => {
  it('splits two journal pages into whole lines, forwards stderr, and exits once', async () => {
    const oven = fakeOven([
      page([{ sequence: 1, stream: 'stdout', text: '{"type":"agent_' }], 'running'),
      page(
        [
          { sequence: 2, stream: 'stdout', text: 'event"}\n{"type":"message"}\n' },
          { sequence: 3, stream: 'stderr', text: 'warning: slow provider\n' }
        ],
        'running'
      ),
      page(
        [{ sequence: 4, stream: 'exit', text: '{"code":0,"status":"completed"}' }],
        'completed',
        0
      )
    ])
    const transport = ovenRpcTransport({
      service: oven.service,
      ovenId: 'o',
      runId: 'run-1',
      pollMs: 1
    })
    const lines: string[] = []
    const stderr: string[] = []
    const exits: (number | null)[] = []
    transport.onLine((line) => lines.push(line))
    transport.onStderr((text) => stderr.push(text))
    transport.onExit((code) => exits.push(code))

    await waitFor(() => exits.length > 0)

    expect(lines).toEqual(['{"type":"agent_event"}', '{"type":"message"}'])
    expect(stderr).toEqual(['warning: slow provider\n'])
    expect(exits).toEqual([0])
    // A run that has ended is not polled again, and no poll overlapped another.
    const settled = oven.eventCalls
    expect(oven.maxConcurrent).toBe(1)
    await tick(20)
    expect(oven.eventCalls).toBe(settled)
    await transport.close()
  })

  it('writes each line with exactly one newline, one request at a time', async () => {
    const oven = fakeOven([page([], 'running')])
    const transport = ovenRpcTransport({ service: oven.service, ovenId: 'o', runId: 'run-1' })

    await Promise.all([
      transport.write('{"type":"prompt","id":"1"}'),
      transport.write('{"id":"2"}')
    ])

    expect(oven.writes).toEqual(['{"type":"prompt","id":"1"}\n', '{"id":"2"}\n'])
    await transport.close()
  })

  it('reports a lost channel as a single exit rather than an unhandled rejection', async () => {
    const service: OvenRunService = {
      write: async () => undefined,
      events: async () => {
        throw new Error('Connection to the Oven closed.')
      },
      stop: async () => undefined
    }
    const transport = ovenRpcTransport({ service, ovenId: 'o', runId: 'run-1', pollMs: 1 })
    const exits: (number | null)[] = []
    transport.onExit((code) => exits.push(code))
    transport.onLine(() => undefined)

    await waitFor(() => exits.length > 0)
    await tick(20)

    expect(exits).toEqual([null])
    await transport.close()
  })

  it('stops the run once on close and stops polling', async () => {
    const oven = fakeOven([page([{ sequence: 1, stream: 'stdout', text: 'x\n' }], 'running')])
    const transport = ovenRpcTransport({
      service: oven.service,
      ovenId: 'o',
      runId: 'run-1',
      pollMs: 5
    })
    const lines: string[] = []
    transport.onLine((line) => lines.push(line))
    await waitFor(() => lines.length > 0)

    await transport.close()
    await transport.close()

    expect(oven.stop).toHaveBeenCalledTimes(1)
    expect(oven.stop).toHaveBeenCalledWith('o', 'run-1')
    const settled = oven.eventCalls
    await tick(30)
    expect(oven.eventCalls).toBe(settled)
  })
})
