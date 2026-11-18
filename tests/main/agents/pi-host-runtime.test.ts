/**
 * The Pi host rows the task manager reads.
 *
 * A host is an OS process, so the row that describes it has to carry its pid:
 * the task manager attaches CPU and memory by looking that pid up in the process
 * snapshot, and a row without one showed the host but never its usage.
 *
 * The launcher is mocked because a real host is an Electron utility process; the
 * transport double answers nothing, so only spawning and stopping are observed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostTransport } from '../../../src/main/agents/pi-host-supervisor'

const spawned: { pid: number; stopped: boolean }[] = []

vi.mock('../../../src/main/agents/pi-host-launcher', () => ({
  spawnPiHost: (): HostTransport => {
    const record = { pid: 5000 + spawned.length, stopped: false }
    spawned.push(record)
    return {
      pid: record.pid,
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
    stopPiHost()
    spawned.length = 0
  })

  it('registers the host row with its pid as soon as a host starts', async () => {
    const supervisor = piHostSupervisor()
    expect(hostRows()).toEqual([])

    const pid = await supervisor.start()

    expect(hostRows()).toEqual([
      { id: `pi-host-${pid}`, pid, name: 'CIO Pi host', stoppable: true }
    ])

    supervisor.stop()
    expect(hostRows()).toEqual([])
  })

  it('stops only that host when the row is ended from the task manager', async () => {
    const supervisor = piHostSupervisor()
    const pid = await supervisor.start()
    const [row] = hostRows()
    expect(row?.pid).toBe(pid)

    await appServiceRegistry.stop(row?.id ?? '')

    expect(spawned[0]?.stopped).toBe(true)
    expect(hostRows()).toEqual([])
    expect(supervisor.pids()).toEqual([])
  })
})
