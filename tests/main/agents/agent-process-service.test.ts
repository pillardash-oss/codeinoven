import { mkdtemp, rm, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentProcessService } from '../../../src/main/agents/agent-process-service'
import type { ProcessSnapshotEntry } from '../../../src/main/agents/agent-process-service'

// Hermetic: the real implementation probes other processes' environments via
// `ps -E`, which is nondeterministic in CI and on developer machines. Fail the
// probe immediately so ownership falls back to the orphan check.
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
 * Regression: reapOrphans() must never kill a journaled root that still has a
 * live parent. The owned-process journal lives in shared userData, so when one
 * CodeInOven instance exits while another instance is running, its harness
 * roots survive in the journal. A freshly launched instance then reaped those
 * roots, SIGTERM'ing the sibling instance's live `codex app-server` mid-session.
 */
describe.skipIf(process.platform === 'win32')('AgentProcessService.reapOrphans', () => {
  const tempDirs: string[] = []
  // PIDs this large cannot exist on any supported platform, so the kill path
  // always observes ESRCH and the tests never signal a real process.
  const DEAD_PID_PARENT = 900_000_001
  const DEAD_PID = 900_000_002

  const snapshotEntry = (
    pid: number,
    parentPid: number,
    command = 'codex app-server'
  ): ProcessSnapshotEntry => ({
    pid,
    parentPid,
    command,
    cpuPercent: null,
    memoryBytes: null
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    )
  })

  async function serviceWithJournal(
    roots: Array<{ pid: number; command: string; cwd: string }>,
    snapshot: ProcessSnapshotEntry[]
  ): Promise<{ service: AgentProcessService; journalPath: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'codeinoven-agent-process-'))
    tempDirs.push(dir)
    const journalPath = join(dir, 'owned-processes.json')
    await writeFile(journalPath, `${JSON.stringify({ version: 1, roots })}\n`, 'utf8')
    const service = new AgentProcessService(() => Promise.resolve(snapshot))
    service.attachJournal(journalPath)
    return { service, journalPath }
  }

  it('skips a journaled root whose parent is still alive (owned by a sibling instance)', async () => {
    // Sibling instance 200 is live; its codex app-server 300 is still its child.
    const { service } = await serviceWithJournal(
      [{ pid: 300, command: 'codex app-server', cwd: '/project' }],
      [
        snapshotEntry(200, 1, 'CodeInOven-electron'),
        snapshotEntry(300, 200, 'codex app-server')
      ]
    )
    const result = await service.reapOrphans()
    expect(result.killed).toEqual([])
    expect(result.skipped).toEqual([300])
  })

  it('keeps the journal entry of a root that belongs to a live sibling instance', async () => {
    const { service, journalPath } = await serviceWithJournal(
      [{ pid: 300, command: 'codex app-server', cwd: '/project' }],
      [snapshotEntry(200, 1, 'CodeInOven-electron'), snapshotEntry(300, 200)]
    )
    await service.reapOrphans()
    const stored = JSON.parse(await readFile(journalPath, 'utf8')) as {
      roots: Array<{ pid: number }>
    }
    // The owning sibling instance may still crash later; a future launch must
    // remain able to reap this root once the sibling is gone.
    expect(stored.roots.map((root) => root.pid)).toEqual([300])
  })

  it('reaps an orphaned journaled root (dead parent) as before', async () => {
    const { service } = await serviceWithJournal(
      [{ pid: DEAD_PID, command: 'codex app-server', cwd: '/project' }],
      [snapshotEntry(DEAD_PID, DEAD_PID_PARENT)]
    )
    const result = await service.reapOrphans()
    expect(result.killed).toEqual([DEAD_PID])
  })

  it('drops the journal entry of a root that is no longer alive', async () => {
    const { service, journalPath } = await serviceWithJournal(
      [{ pid: DEAD_PID, command: 'codex app-server', cwd: '/project' }],
      [snapshotEntry(999_999, 1, 'unrelated')]
    )
    const result = await service.reapOrphans()
    expect(result.killed).toEqual([])
    expect(result.skipped).toEqual([DEAD_PID])
    const stored = JSON.parse(await readFile(journalPath, 'utf8')) as {
      roots: Array<{ pid: number }>
    }
    expect(stored.roots).toEqual([])
  })
})
