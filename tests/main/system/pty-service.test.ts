import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ptySpawn = vi.hoisted(() => vi.fn())
vi.mock('node-pty', () => ({
  spawn: ptySpawn
}))
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  safeStorage: { isAsyncEncryptionAvailable: async () => false }
}))

import { PtyService } from '../../../src/main/system/pty-service'
import { StorageEngine } from '../../../src/main/storage/storage-engine'

type TestPty = {
  create(
    id: string,
    projectId: string,
    threadId: string,
    cols: number,
    rows: number,
    scopeBucketId?: string
  ): Promise<{ id: string; pid: number }>
  sessions: Map<string, { cwd: string }>
}

function asTest(service: PtyService): TestPty {
  return service as unknown as TestPty
}

beforeEach(() => {
  ptySpawn.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** A `projects` row exactly as SQLite hands it back (`ProjectRepo` maps snake_case). */
function projectRow(path: string) {
  return {
    id: 'p1',
    name: 'Project',
    path,
    source: 'local',
    host: null,
    provider_id: 'openai',
    workflow_id: 'default',
    thread_limit: 10,
    hidden: 0,
    pinned: 0,
    sort_order: null,
    icon: null,
    color: null,
    icon_type: null,
    change_tracking_mode: 'manual',
    has_deployments: 0,
    created_at: Date.now(),
    updated_at: Date.now()
  }
}

/**
 * Database double for the PTY paths under test. `ProjectManager.getProject`
 * reads the project on the database worker, so the double has to answer
 * `queryViaWorker` with the same bounded result shape the real `Database` does.
 */
function fakeDatabase(path: string) {
  const row = projectRow(path)
  return {
    get: vi.fn().mockReturnValue(row),
    run: vi.fn(),
    init: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    queryViaWorker: vi.fn().mockResolvedValue({ ok: true, rows: [row], truncated: false })
  }
}

function fakePty() {
  const handlers: Record<string, () => void> = {}
  return {
    pid: 100,
    onData: (fn: () => void) => (handlers.data = fn),
    onExit: (fn: () => void) => (handlers.exit = fn),
    write: vi.fn(),
    resize: vi.fn(),
    kill: () => handlers.exit?.()
  }
}

describe('PtyService scope roots', () => {
  it('creates sessions in the requested scope root and keeps it for the lifetime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cio-pty-'))
    const worktree = mkdtempSync(join(tmpdir(), 'cio-pty-wt-'))
    const db = fakeDatabase(root)
    const scopeRoots = {
      resolve: vi.fn().mockResolvedValue({ ok: true, root: worktree })
    }
    const storage = new StorageEngine(root)
    ptySpawn.mockImplementation(() => fakePty())

    const service = new PtyService(storage, db as never, scopeRoots as never)

    const testable = asTest(service)
    await testable.create('term-1', 'p1', 't1', 80, 24, 'feature-scope')
    expect(testable.sessions.get('term-1')?.cwd).toBe(worktree)
    expect(ptySpawn).toHaveBeenCalled()
    expect((ptySpawn.mock.calls[0]?.[2] as { cwd: string }).cwd).toBe(worktree)

    // The terminal root is captured at creation even after a scope switch.
    expect(testable.sessions.get('term-1')?.cwd).toBe(worktree)

    rmSync(root, { recursive: true, force: true })
    rmSync(worktree, { recursive: true, force: true })
  })

  it('falls back to the project directory without a scope', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cio-pty-fb-'))
    const db = fakeDatabase(root)
    const storage = new StorageEngine(root)
    ptySpawn.mockImplementation(() => fakePty())
    const service = new PtyService(storage, db as never, undefined)
    await asTest(service).create('term-2', 'p1', 't1', 80, 24)
    expect((ptySpawn.mock.calls[0]?.[2] as { cwd: string }).cwd).toBe(root)
    rmSync(root, { recursive: true, force: true })
  })
})

/**
 * A pty double that can actually emit output and exit, so the delivery contract
 * between a shell and the renderer can be asserted.
 */
function streamingPty() {
  let onData: ((data: string) => void) | undefined
  let onExit: ((event: { exitCode: number }) => void) | undefined
  return {
    pid: 200,
    pause: vi.fn(),
    resume: vi.fn(),
    onData: (fn: (data: string) => void) => (onData = fn),
    onExit: (fn: (event: { exitCode: number }) => void) => (onExit = fn),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    emit: (data: string) => onData?.(data),
    exit: (exitCode = 0) => onExit?.({ exitCode })
  }
}

/** The window side of `sendToRenderer`, recording what the terminal would see. */
function fakeSender() {
  const sent: Array<{ channel: string; payload: unknown }> = []
  return {
    sent,
    send: vi.fn((channel: string, payload: unknown) => sent.push({ channel, payload })),
    isDestroyed: () => false,
    isCrashed: () => false,
    isLoadingMainFrame: () => false,
    mainFrame: null
  }
}

describe('PtyService terminal output pacing', () => {
  it('gathers a shell burst into one message instead of one message per chunk', async () => {
    vi.useFakeTimers()
    const root = mkdtempSync(join(tmpdir(), 'cio-pty-paced-'))
    const storage = new StorageEngine(root)
    const proc = streamingPty()
    ptySpawn.mockImplementation(() => proc)
    const service = new PtyService(storage, fakeDatabase(root) as never, undefined)
    const sender = fakeSender()
    service.attach(sender as never)

    await asTest(service).create('term-paced', 'p1', 't1', 80, 24)
    // A build is one long run of small writes; each used to be its own IPC
    // message, each one a renderer task and a WASM terminal write.
    for (let line = 0; line < 200; line++) proc.emit(`line ${line}\n`)

    expect(sender.sent).toEqual([])
    vi.advanceTimersByTime(20)

    expect(sender.sent).toHaveLength(1)
    expect(sender.sent[0]?.channel).toBe('pty:data:term-paced')
    expect(sender.sent[0]?.payload).toContain('line 0\n')
    expect(sender.sent[0]?.payload).toContain('line 199\n')

    vi.useRealTimers()
    rmSync(root, { recursive: true, force: true })
  })

  it('delivers the last output before the exit, never after it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cio-pty-exit-'))
    const storage = new StorageEngine(root)
    const proc = streamingPty()
    ptySpawn.mockImplementation(() => proc)
    const service = new PtyService(storage, fakeDatabase(root) as never, undefined)
    const sender = fakeSender()
    service.attach(sender as never)

    await asTest(service).create('term-exit', 'p1', 't1', 80, 24)
    proc.emit('build finished\n')
    proc.exit(0)

    // A terminal closed before the next frame must still show how the run ended,
    // and an exit may never overtake output that was written before it.
    expect(sender.sent).toEqual([
      { channel: 'pty:data:term-exit', payload: 'build finished\n' },
      { channel: 'pty:exit:term-exit', payload: 0 }
    ])

    rmSync(root, { recursive: true, force: true })
  })
})
