import { describe, expect, it, vi } from 'vitest'
import { handleFatalStartupFailure, LifecycleDiagnostics } from './lifecycle-diagnostics'

describe('handleFatalStartupFailure', () => {
  it('closes every initialized resource and reports successes and failures', async () => {
    const closed: string[] = []
    const closeDatabase = vi.fn(() => {
      closed.push('database')
    })
    const closeChat = vi.fn(() => {
      closed.push('chatEngine')
    })
    const closeRemote = vi.fn(() => {
      throw new Error('remote dispose failed')
    })

    const outcome = await handleFatalStartupFailure({
      error: new Error('boot failed'),
      appName: 'CodeInOven',
      resources: [
        { name: 'chatEngine', close: closeChat },
        { name: 'remoteMode', close: closeRemote }
      ],
      closeDatabase,
      quit: () => undefined
    })

    expect(outcome.exitCode).toBe(1)
    expect(outcome.exited).toBe(true)
    expect(outcome.quitFailed).toBe(false)
    expect(outcome.closed).toEqual(['chatEngine', 'database'])
    expect(outcome.closeFailures).toEqual(['remoteMode'])
    expect(closed).toEqual(['chatEngine', 'database'])
  })

  it('terminates the process via process.exit when no quit callback is provided', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    try {
      const outcome = await handleFatalStartupFailure({
        error: new Error('boot failed'),
        appName: 'CodeInOven',
        closeDatabase: () => undefined,
        quit: undefined
      })
      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(outcome.exited).toBe(true)
    } finally {
      exitSpy.mockRestore()
    }
  })

  it('falls back to process.exit when the quit callback throws', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    try {
      const outcome = await handleFatalStartupFailure({
        error: new Error('boot failed'),
        appName: 'CodeInOven',
        closeDatabase: () => undefined,
        quit: () => {
          throw new Error('app.exit failed')
        }
      })
      expect(outcome.quitFailed).toBe(true)
      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(outcome.exited).toBe(true)
    } finally {
      exitSpy.mockRestore()
    }
  })

  it('reports every close failure and still exits nonzero', async () => {
    const outcome = await handleFatalStartupFailure({
      error: new Error('boot failed'),
      appName: 'CodeInOven',
      resources: [
        { name: 'a', close: () => undefined },
        { name: 'b', close: () => undefined },
        { name: 'c', close: () => void (() => undefined) }
      ],
      quit: () => undefined
    })
    expect(outcome.exitCode).toBe(1)
    expect(outcome.closed).toEqual(['a', 'b', 'c'])
    expect(outcome.closeFailures).toEqual([])
  })
})

describe('LifecycleDiagnostics spans', () => {
  it('records completed spans with bounded history', () => {
    let now = 0
    const diagnostics = new LifecycleDiagnostics({ now: () => now })
    const end = diagnostics.begin('startup')
    now += 50
    end()
    expect(diagnostics.spans()).toEqual([
      { name: 'startup', startMs: 0, endMs: 50, durationMs: 50 }
    ])
    expect(diagnostics.openSpanNames()).toEqual([])
  })

  it('tracks open spans separately', () => {
    const diagnostics = new LifecycleDiagnostics({ now: () => 0 })
    diagnostics.begin('boot')
    expect(diagnostics.openSpanNames()).toEqual(['boot'])
    expect(diagnostics.spans()).toEqual([])
  })
})
