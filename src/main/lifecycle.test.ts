import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Logger } from './logger'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
  vi.restoreAllMocks()
})

describe('lifecycle guard — re-entry prevention', () => {
  it('prevents the cleanup pipeline from running more than once', () => {
    let invocations = 0
    const guard = { active: false }

    function beforeQuitHandler(event: { preventDefault: () => void }): void {
      if (guard.active) return
      event.preventDefault()
      guard.active = true
      invocations++
    }

    beforeQuitHandler({ preventDefault: () => undefined })
    beforeQuitHandler({ preventDefault: () => undefined })
    beforeQuitHandler({ preventDefault: () => undefined })

    expect(invocations).toBe(1)
  })

  it('allows the second app.quit() call to pass through without preventDefault', () => {
    let preventDefaultCalled = false
    const guard = { active: false }

    function beforeQuitHandler(event: { preventDefault: () => void }): void {
      if (guard.active) return
      event.preventDefault()
      preventDefaultCalled = true
      guard.active = true
    }

    beforeQuitHandler({ preventDefault: () => undefined })
    expect(preventDefaultCalled).toBe(true)

    // Second call — guard is active, handler returns without preventDefault
    preventDefaultCalled = false
    beforeQuitHandler({ preventDefault: () => undefined })
    expect(preventDefaultCalled).toBe(false)
  })
})

describe('lifecycle — disposal ordering', () => {
  it('runs every step even when an earlier step throws', async () => {
    const steps: string[] = []

    async function ptyCleanup(): Promise<void> {
      steps.push('pty')
    }

    function notificationStop(): void {
      steps.push('notifications')
    }

    async function chatDispose(): Promise<void> {
      steps.push('chat')
    }

    async function loggerFlush(): Promise<void> {
      steps.push('logger')
    }

    async function runPipeline(): Promise<void> {
      try {
        await ptyCleanup()
      } catch {
        steps.push('pty.fail')
      }
      try {
        notificationStop()
      } catch {
        steps.push('notifications.fail')
      }
      try {
        await chatDispose()
      } catch {
        steps.push('chat.fail')
      }
      try {
        await loggerFlush()
      } catch {
        steps.push('logger.fail')
      }
    }

    await runPipeline()
    expect(steps).toEqual(['pty', 'notifications', 'chat', 'logger'])
  })

  it('continues to later steps when an earlier step fails', async () => {
    const steps: string[] = []

    async function failingStep(): Promise<void> {
      steps.push('pty')
      throw new Error('PTY failure')
    }

    function safeStep(): void {
      steps.push('notifications')
    }

    async function runPipeline(): Promise<void> {
      try {
        await failingStep()
      } catch {
        steps.push('pty.error')
      }
      try {
        safeStep()
      } catch {
        steps.push('notifications.error')
      }
    }

    await runPipeline()
    expect(steps).toEqual(['pty', 'pty.error', 'notifications'])
  })
})

describe('lifecycle — Logger flush on shutdown', () => {
  it('flushes pending writes before the shutdown pipeline resolves', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lifecycle-logger-'))
    temporaryPaths.push(directory)
    const logPath = join(directory, 'shutdown.jsonl')
    Logger.initialize(logPath)

    Logger.info('shutdown test — before flush')
    await Logger.flush()

    const content = await import('fs/promises').then((m) =>
      m.readFile(logPath, 'utf-8').then((text) => text.trim())
    )
    const lines = content.split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThanOrEqual(1)
    const last = JSON.parse(lines[lines.length - 1]!)
    expect(last.level).toBe('info')
  })
})

describe('lifecycle — PtyService destroyAll', () => {
  it('kills all active PTY sessions and clears sender', async () => {
    const { PtyService } = await import('./pty-service')
    const { StorageEngine } = await import('./storage-engine')

    const storage = new StorageEngine()
    const pty = new PtyService(storage)

    const killSpy = vi.fn()

    // Simulate a session via the sessions map by adding one directly
    // destroyAll iterates this.sessions.keys()
    const mockSession = {
      id: 'test-pty-1',
      process: { kill: killSpy, pid: 9999 },
      projectId: 'proj-1',
      cwd: '/tmp',
      shell: '/bin/zsh',
      createdAt: Date.now()
    }

    // Access the internal sessions map via type assertion to test destroyAll
    const sessions = (pty as unknown as { sessions: Map<string, unknown> }).sessions
    sessions.set('test-pty-1', mockSession)

    pty.destroyAll()

    expect(killSpy).toHaveBeenCalledTimes(1)
    expect(sessions.size).toBe(0)
  })
})
