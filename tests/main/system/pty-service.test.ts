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
  safeStorage: { isEncryptionAvailable: () => false }
}))

import { PtyService } from '../../../src/main/system/pty-service'
import { StorageEngine } from '../../../src/main/storage/storage-engine'

type TestPty = {
  create(
    id: string,
    projectId: string,
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
    const db = {
      get: vi.fn().mockReturnValue({
        id: 'p1',
        name: 'Project',
        path: root,
        source: 'local',
        hidden: false,
        providerId: 'openai',
        workflowId: 'default',
        threadLimit: 10,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }),
      run: vi.fn(),
      init: vi.fn().mockResolvedValue(undefined),
      close: vi.fn()
    }
    const scopeRoots = {
      resolve: vi.fn().mockResolvedValue({ ok: true, root: worktree })
    }
    const storage = new StorageEngine(root)
    ptySpawn.mockImplementation(() =>
      fakePty()
    )

    const service = new PtyService(storage, db as never, scopeRoots as never)

    const testable = asTest(service)
    await testable.create('term-1', 'p1', 80, 24, 'feature-scope')
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
    const db = {
      get: vi.fn().mockReturnValue({
        id: 'p1',
        name: 'Project',
        path: root,
        source: 'local',
        hidden: false,
        providerId: 'openai',
        workflowId: 'default',
        threadLimit: 10,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }),
      run: vi.fn(),
      init: vi.fn().mockResolvedValue(undefined),
      close: vi.fn()
    }
    const storage = new StorageEngine(root)
    ptySpawn.mockImplementation(() =>
      fakePty()
    )
    const service = new PtyService(storage, db as never, undefined)
    await asTest(service).create('term-2', 'p1', 80, 24)
    expect((ptySpawn.mock.calls[0]?.[2] as { cwd: string }).cwd).toBe(root)
    rmSync(root, { recursive: true, force: true })
  })
})
