/**
 * The Pi host rows the task manager reads.
 *
 * A host is an OS process, so the row that describes it has to carry its pid:
 * the task manager attaches CPU and memory by looking that pid up in the process
 * snapshot, and a row without one showed the host but never its usage.
 *
 * The launcher is mocked because a real host is an Electron utility process. The
 * double keeps Electron's actual shape too: `utilityProcess.fork` returns before
 * the operating system names a pid, so a transport reports 0 until the process
 * exists. That asynchronous pid is the whole point of the retry below.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostTransport } from '../../../src/main/agents/pi-host-supervisor'

const spawned: { pid: number; stopped: boolean }[] = []

vi.mock('../../../src/main/agents/pi-host-launcher', () => ({
  spawnPiHost: (): HostTransport => {
    const record = { pid: 0, stopped: false }
    spawned.push(record)
    return {
      get pid(): number {
        return record.pid
      },
      send: () => undefined,
      onLine: () => undefined,
      onExit: () => undefined,
      stop: () => {
        record.stopped = true
      }
    }
  }
}))

import { piHostSupervisor, stopPiHost } from '../../../src/main/agents/pi-host-runtime'
import { appServiceRegistry } from '../../../src/main/system/app-service-registry'

/** Rows this module owns, so another module's rows cannot affect the assertions. */
function hostRows(): { id: string; pid: number | null; name: string; stoppable: boolean }[] {
  return appServiceRegistry
    .list()
    .filter((row) => row.id.startsWith('pi-host-'))
    .map((row) => ({
      id: row.id,
      pid: row.pid,
      name: row.name,
      stoppable: row.stoppable
    }))
}

describe('Pi host service rows', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    stopPiHost()
    spawned.length = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('lists the host only once Electron has named its pid', async () => {
    const supervisor = piHostSupervisor()
    expect(hostRows()).toEqual([])

    await supervisor.start()
    // The spawn announced a host the operating system has not named yet: a row
    // registered now would carry pid 0 and never show usage.
    expect(hostRows()).toEqual([])

    spawned[0]!.pid = 5123
    await vi.advanceTimersByTimeAsync(300)

    expect(hostRows()).toEqual([
      { id: 'pi-host-5123', pid: 5123, name: 'CIO Pi host', stoppable: true }
    ])
  })

  it('stops only that host when the row is ended from the task manager', async () => {
    const supervisor = piHostSupervisor()
    await supervisor.start()
    spawned[0]!.pid = 5124
    await vi.advanceTimersByTimeAsync(300)
    const [row] = hostRows()
    expect(row?.pid).toBe(5124)

    await appServiceRegistry.stop(row?.id ?? '')

    expect(spawned[0]?.stopped).toBe(true)
    expect(hostRows()).toEqual([])
    expect(supervisor.pids()).toEqual([])
  })
})
