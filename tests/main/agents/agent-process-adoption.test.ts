import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { INSTANCE_OWNER_ID } from '../../../src/main/system/process-ownership'

/**
 * Regression: a process this instance spawned must never be dropped because the
 * session stamped in its environment is not registered yet.
 *
 * The incident: an agent backgrounded `bun run dev`. The shell it ran in was
 * `/bin/bash`, whose environment macOS refuses to read, so the tree's only
 * readable stamps were on the wrapper start and on the vite child. Adoption
 * skipped the child because its parent was alive while its session was not
 * claimed, so the dev server holding port 5173 was tracked nowhere: the task
 * manager could not show it, the agent could not list it, and nothing could
 * stop it.
 */

const owned = vi.hoisted(() => {
  const environment = new Map<number, { owner: string; session: string | null }>()
  return { environment }
})

vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (
      command: string,
      args: readonly string[],
      options: unknown,
      callback?: (error: Error | null, result?: { stdout: string; stderr: string }) => void
    ) => {
      const done = typeof options === 'function' ? options : callback
      const finish = done as
        ((error: Error | null, result?: { stdout: string; stderr: string }) => void) | undefined
      // The environment probe is the one command that answers with ownership.
      if (command === 'ps' && args.includes('-E')) {
        const pids = String(args[args.indexOf('-p') + 1] ?? '')
          .split(',')
          .map((value) => Number(value))
        const stdout = pids.flatMap((pid) => {
          const stamp = owned.environment.get(pid)
          if (!stamp) return []
          const session = stamp.session ? ` CODEINOVEN_SESSION=${stamp.session}` : ''
          return [`${pid} node CODEINOVEN_OWNED=${stamp.owner}${session}`]
        })
        finish?.(null, { stdout: stdout.join('\n'), stderr: '' })
        return
      }
      // Every other probe (lsof for cwd and ports, netstat) is unavailable.
      finish?.(new Error('probe unavailable in tests'))
    }
  )
}))

const { AgentProcessService } = await import('../../../src/main/agents/agent-process-service')
type ProcessSnapshotEntry =
  import('../../../src/main/agents/agent-process-service').ProcessSnapshotEntry

const FAKE_PID = 900_000_000
const WRAPPER_PID = FAKE_PID + 10
const BASH_PID = FAKE_PID + 11
const SERVER_PID = FAKE_PID + 12

function entry(pid: number, parentPid: number, command: string): ProcessSnapshotEntry {
  return { pid, parentPid, command, cpuPercent: null, memoryBytes: null }
}

/** A detached `bun run dev` tree: wrapper, unreadable bash child, vite grandchild. */
function leakedDevServer(): ProcessSnapshotEntry[] {
  return [
    entry(WRAPPER_PID, 1, 'bun run dev'),
    entry(BASH_PID, WRAPPER_PID, '/bin/bash -c bun copy:wasm && vite dev'),
    entry(SERVER_PID, BASH_PID, 'node node_modules/.bin/vite dev')
  ]
}

describe.skipIf(process.platform === 'win32')('AgentProcessService adoption', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    owned.environment.clear()
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function serviceWith(
    snapshot: ProcessSnapshotEntry[]
  ): Promise<{ service: InstanceType<typeof AgentProcessService>; journalPath: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'codeinoven-adoption-'))
    tempDirs.push(dir)
    const journalPath = join(dir, 'owned-processes.json')
    const service = new AgentProcessService(() => Promise.resolve(snapshot))
    service.attachJournal(journalPath)
    return { service, journalPath }
  }

  it('adopts a stamped tree whose session this instance does not hold', async () => {
    const { service } = await serviceWith(leakedDevServer())
    // The wrapper and the server carry this instance's stamp; the bash child in
    // between has an environment macOS will not show.
    owned.environment.set(WRAPPER_PID, { owner: INSTANCE_OWNER_ID, session: 'unheld-session' })
    owned.environment.set(SERVER_PID, { owner: INSTANCE_OWNER_ID, session: 'unheld-session' })

    const processes = await service.listAll()
    // Every pid of the tree is a row: the port-holding child is no longer
    // invisible just because its parent is alive.
    expect(processes.map((row) => row.pid).sort()).toEqual(
      [WRAPPER_PID, BASH_PID, SERVER_PID].sort()
    )
    for (const row of processes) expect(row.scope).toBe('app')
  })

  it('never adopts a process stamped by another instance', async () => {
    const { service } = await serviceWith(leakedDevServer())
    owned.environment.set(WRAPPER_PID, { owner: 'i-1-00000000', session: null })
    owned.environment.set(SERVER_PID, { owner: 'i-1-00000000', session: null })

    expect(await service.listAll()).toEqual([])
  })

  it('gives the parked row to its thread once that session is registered', async () => {
    const { service } = await serviceWith(leakedDevServer())
    owned.environment.set(WRAPPER_PID, { owner: INSTANCE_OWNER_ID, session: 'late-session' })
    owned.environment.set(SERVER_PID, { owner: INSTANCE_OWNER_ID, session: 'late-session' })

    const before = await service.listAll()
    expect(before.every((row) => row.scope === 'app')).toBe(true)

    service.claimSession('late-session', 'project-1', 'thread-1')
    // A scan is throttled, so the promotion pass runs on a later poll.
    await new Promise((resolve) => setTimeout(resolve, 1_600))
    const owned_by_thread = await service.list('project-1', 'thread-1')
    expect(owned_by_thread.map((row) => row.pid).sort()).toEqual(
      [WRAPPER_PID, BASH_PID, SERVER_PID].sort()
    )
    expect(owned_by_thread.every((row) => row.scope === 'thread')).toBe(true)
    const after = await service.listAll()
    expect(after.map((row) => row.pid).sort()).toEqual([WRAPPER_PID, BASH_PID, SERVER_PID].sort())
    expect(after.every((row) => row.threadId === 'thread-1')).toBe(true)
  })

  it('journals an adopted tree so a crashed instance can still reap it', async () => {
    const { service, journalPath } = await serviceWith(leakedDevServer())
    owned.environment.set(WRAPPER_PID, { owner: INSTANCE_OWNER_ID, session: null })
    owned.environment.set(SERVER_PID, { owner: INSTANCE_OWNER_ID, session: null })

    await service.listAll()
    const { readFile } = await import('fs/promises')
    // The journal write is debounced; the list above settles well after it.
    await new Promise((resolve) => setTimeout(resolve, 600))
    const stored = JSON.parse(await readFile(journalPath, 'utf8')) as {
      roots: Array<{ pid: number }>
    }
    expect(stored.roots.map((root) => root.pid).sort()).toEqual(
      [WRAPPER_PID, BASH_PID, SERVER_PID].sort()
    )
  })
})
