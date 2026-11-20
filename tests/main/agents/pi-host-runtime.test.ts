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
    const lineListeners: ((line: string) => void)[] = []
    const reply = (sessionId: string | undefined, id: string): void => {
      const line = JSON.stringify({
        type: 'response',
        id,
        ok: true,
        data: {
          sessionId,
          nativeSessionId: `native-${sessionId}`,
          sessionFile: `/agent/sessions/${sessionId}.jsonl`,
          cwd: `/work/${sessionId}`,
          agentDir: '/agent',
          isStreaming: false,
          isCompacting: false,
          messageCount: 0,
          pendingMessageCount: 0
        }
      })
      for (const listener of lineListeners) listener(line)
    }
    return {
      get pid(): number {
        return record.pid
      },
      send: (line) => {
        const request = JSON.parse(line) as { id?: unknown; sessionId?: unknown }
        if (typeof request.id !== 'string') return
        const sessionId = typeof request.sessionId === 'string' ? request.sessionId : undefined
        reply(sessionId, request.id)
      },
      onLine: (listener) => {
        lineListeners.push(listener)
      },
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
function hostRows(): {
  id: string
  pid: number | null
  name: string
  detail: string | null
  stoppable: boolean
}[] {
  return appServiceRegistry
    .list()
    .filter((row) => row.id.startsWith('pi-host-'))
    .map((row) => ({
      id: row.id,
      pid: row.pid,
      name: row.name,
      detail: row.detail,
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
      {
        id: 'pi-host-5123',
        pid: 5123,
        name: 'CIO Pi host',
        detail: 'No hosted threads',
        stoppable: true
      }
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

  /**
   * The row's count is what a host is carrying right now.
   *
   * The row is written when the process appears, which is before the first
   * session has landed on it, so a count written only then stays at the value
   * from the host's first instant   zero   for the rest of its life. A host
   * running the open thread was listed as carrying none for exactly that
   * reason.
   */
  it('counts the threads a host carries as they land and leave', async () => {
    const supervisor = piHostSupervisor()
    await supervisor.start()
    spawned[0]!.pid = 5125
    await vi.advanceTimersByTimeAsync(300)
    expect(hostRows()[0]?.detail).toBe('No hosted threads')

    await supervisor.createSession({
      sessionId: 'atlas',
      command: { type: 'create_session', cwd: '/work/atlas', agentDir: '/agent' }
    })
    expect(hostRows()[0]?.detail).toBe('1 hosted thread')

    await supervisor.createSession({
      sessionId: 'ledger',
      command: { type: 'create_session', cwd: '/work/ledger', agentDir: '/agent' }
    })
    expect(hostRows()[0]?.detail).toBe('2 hosted threads')

    await supervisor.disposeSession('ledger')
    expect(hostRows()[0]?.detail).toBe('1 hosted thread')
  })
})
