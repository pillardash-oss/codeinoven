import { describe, expect, it, vi } from 'vitest'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn((): unknown[] => []) },
  app: { isPackaged: false, getPath: () => process.cwd() },
  ipcMain: { handle: vi.fn(), on: vi.fn() }
}))

// The real facade validates the sender frame of every invoke, which this suite
// has no window for. What matters here is which channel is registered and what
// its handler answers.
vi.mock('../../src/main/ipc/trusted-ipc-main', () => ({
  trustedIpcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown): void => {
      handlers.set(channel, handler)
    },
    on: (): void => undefined,
    removeHandler: (): void => undefined
  }
}))

import { registerThreadHandlers } from '../../src/main/ipc/handlers/thread-handlers'
import type { IpcHandlerContext } from '../../src/main/ipc/handlers/context'
import type { ThreadOpenDigest } from '../../src/lib/ipc/invoke-thread'

/**
 * The `thread:openDigest` channel itself.
 *
 * The aggregate read is tested against a real engine next door; this suite holds
 * the wiring: one channel answers the whole open, an aggregate that cannot
 * answer rejects so the renderer falls back to the channels it used before, and
 * a boot without a chat engine never answers an empty digest that would tell the
 * mount a working thread is idle.
 */

const emptyDigest: ThreadOpenDigest = {
  thread: null,
  permissions: [],
  questions: [],
  imageDescriptorErrors: [],
  sessionStatus: null,
  failures: []
}

function registerOpenDigest(
  readOpenDigest?: (projectId: string, threadId: string) => Promise<ThreadOpenDigest>
): (...args: unknown[]) => unknown {
  handlers.clear()
  const context = {
    database: {},
    options: {},
    projectManager: {},
    threadCreation: {},
    threadDeletion: {},
    threadManager: {},
    branchBackfillDeps: {},
    waitForThreadReady: vi.fn(),
    chatEngine: readOpenDigest === undefined ? undefined : { readOpenDigest }
  } as unknown as IpcHandlerContext
  registerThreadHandlers(context)
  const handler = handlers.get('thread:openDigest')
  if (!handler) throw new Error('thread:openDigest was not registered')
  return handler
}

describe('thread:openDigest channel', () => {
  it('answers one open with one aggregate read', async () => {
    const readOpenDigest = vi.fn(async () => emptyDigest)
    const handler = registerOpenDigest(readOpenDigest)

    await expect(handler({}, 'project-1', 'thread-1')).resolves.toEqual(emptyDigest)
    expect(readOpenDigest).toHaveBeenCalledTimes(1)
    expect(readOpenDigest).toHaveBeenCalledWith('project-1', 'thread-1')
  })

  it('rejects when the aggregate cannot answer, so the caller can fall back', async () => {
    const handler = registerOpenDigest(async () => {
      throw new Error('the database worker is unavailable')
    })

    await expect(handler({}, 'project-1', 'thread-1')).rejects.toThrow(
      'the database worker is unavailable'
    )
  })

  it('refuses to answer an empty digest without a chat engine', async () => {
    const handler = registerOpenDigest()

    await expect(handler({}, 'project-1', 'thread-1')).rejects.toThrow(
      'The thread open digest is unavailable.'
    )
  })

  it('validates the thread scope before reading anything', async () => {
    const readOpenDigest = vi.fn(async () => emptyDigest)
    const handler = registerOpenDigest(readOpenDigest)

    await expect(handler({}, 'project 1', 'thread-1')).rejects.toThrow('Project ID')
    expect(readOpenDigest).not.toHaveBeenCalled()
  })
})
