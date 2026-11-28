import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentProcessService } from '../../../src/main/agents/agent-process-service'
import type { ProcessSnapshotEntry } from '../../../src/main/agents/agent-process-service'

// Hermetic: the real probe reads other processes' environments with `ps`, which
// is nondeterministic in CI and on a developer machine.
vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (
      _command: string,
      _args: readonly string[],
      options: unknown,
      callback?: (error: Error | null) => void
    ) => {
      const done = typeof options === 'function' ? options : callback
      done?.(new Error('ownership probe unavailable in tests'))
    }
  )
}))

/**
 * A process the app started for a thread is a *root*, not a descendant of one.
 *
 * `cio_process_start` spawns the command detached and records its pid with
 * `watchProcess`, which files it under the turn's session. The service then only
 * walked *descendants* of a root into the table `list()` reads, so the pid the
 * tool had just returned was never listed for its own thread and
 * `cio_process_stop` refused it as "not owned by this thread"   the tool could
 * start something it could not stop, and the assistant that hit it asked the
 * user to close the dev server by hand.
 */
describe('AgentProcessService root attribution', () => {
  const ROOT_PID = 900_000_101
  const CHILD_PID = 900_000_102

  const entry = (pid: number, parentPid: number, command: string): ProcessSnapshotEntry => ({
    pid,
    parentPid,
    command,
    cpuPercent: null,
    memoryBytes: null
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('lists the root a thread started, and its children with it', async () => {
    const snapshot = [
      entry(ROOT_PID, process.pid, 'node vite dev --port 5392'),
      entry(CHILD_PID, ROOT_PID, 'esbuild --service')
    ]
    const service = new AgentProcessService(() => Promise.resolve(snapshot))
    service.claimSession('session-1', 'project-1', 'thread-1')
    service.watchProcess('session-1', ROOT_PID, 'node vite dev --port 5392', '/project')

    const listed = await service.list('project-1', 'thread-1')

    expect(listed.map((process) => process.pid)).toEqual([ROOT_PID, CHILD_PID])
    expect(listed.every((process) => process.scope === 'thread')).toBe(true)
  })

  it('stops refusing a pid the thread started', async () => {
    const snapshot = [entry(ROOT_PID, process.pid, 'node vite dev --port 5392')]
    const service = new AgentProcessService(() => Promise.resolve(snapshot))
    service.claimSession('session-1', 'project-1', 'thread-1')
    service.watchProcess('session-1', ROOT_PID, 'node vite dev --port 5392', '/project')

    // The ownership check in `killProcess` is `list()`, so a refused stop is a
    // missing row. Killing a pid this large fails with ESRCH and signals nothing.
    await expect(service.killProcess('project-1', 'thread-1', ROOT_PID)).resolves.toBeUndefined()
  })

  it('reports an app-wide root under the app, not under a thread', async () => {
    const snapshot = [entry(ROOT_PID, process.pid, 'bun run dev:probe')]
    const service = new AgentProcessService(() => Promise.resolve(snapshot))
    service.watchProcess(undefined, ROOT_PID, 'bun run dev:probe', '/project')

    const all = await service.listAll()

    expect(all.map((process) => [process.pid, process.scope])).toEqual([[ROOT_PID, 'app']])
  })
})
