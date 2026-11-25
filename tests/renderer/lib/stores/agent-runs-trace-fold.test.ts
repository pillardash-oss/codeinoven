// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The working trace's fold while a turn is live.
 *
 * These lock in one promise: appending work to a live turn never takes away a
 * fold the reader chose. The default close on settle is the app's, so it only
 * applies to a trace nobody opened; leaving the thread is what resets a visit.
 */

vi.mock('$lib/ipc.svelte', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/ipc.svelte')>()
  return {
    ...actual,
    invoke: vi.fn(async () => []),
    subscribe: () => () => {},
    subscribeGuarded: () => () => {}
  }
})

vi.mock('$lib/stores/app-errors.svelte', () => ({ showToastError: () => undefined }))

const { agentRuns } = await import('$lib/stores/agent-runs.svelte')

const PROJECT = 'p1'
const THREAD = 't1'

function startLiveTurn(): void {
  agentRuns.setBusy(PROJECT, THREAD, true, 'message-1')
}

function readerOpens(): void {
  agentRuns.setTraceOpen(PROJECT, THREAD, true, true, false)
}

beforeEach(() => {
  agentRuns.clear(PROJECT, THREAD)
})

describe('the working trace fold', () => {
  it('stays as the reader left it when the live turn settles', () => {
    startLiveTurn()
    readerOpens()

    agentRuns.setIdle(PROJECT, THREAD)

    expect(agentRuns.isTraceOpen(PROJECT, THREAD)).toBe(true)
    expect(agentRuns.isTraceUserOpened(PROJECT, THREAD)).toBe(true)
  })

  it('closes a trace nobody opened when the turn settles', () => {
    startLiveTurn()

    agentRuns.setIdle(PROJECT, THREAD)

    expect(agentRuns.isTraceOpen(PROJECT, THREAD)).toBe(false)
  })

  it('keeps a reader-folded trace folded through later work in the same turn', () => {
    startLiveTurn()
    agentRuns.setTraceOpen(PROJECT, THREAD, false, false, true)

    // The same turn keeps streaming: busy again, same turn, no new turn id.
    agentRuns.setBusy(PROJECT, THREAD, true, 'message-1')

    expect(agentRuns.isTraceOpen(PROJECT, THREAD)).toBe(false)
    expect(agentRuns.isTraceUserFolded(PROJECT, THREAD)).toBe(true)
  })

  it('still opens the trace for the next turn the reader has not touched', () => {
    startLiveTurn()
    readerOpens()
    agentRuns.setIdle(PROJECT, THREAD)

    agentRuns.setBusy(PROJECT, THREAD, true, 'message-2')

    expect(agentRuns.isTraceOpen(PROJECT, THREAD)).toBe(true)
    expect(agentRuns.isTraceUserOpened(PROJECT, THREAD)).toBe(false)
  })

  it('survives the idle blip a harness reports between steps', () => {
    // A harness goes idle when a tool call finishes and busy again for the next
    // one. Every idle clears the turn id, so the next part looked like a new
    // turn   and a new turn reset the fold, closing the trace and the tool call
    // expanded inside it once per step.
    startLiveTurn()
    readerOpens()

    agentRuns.setIdle(PROJECT, THREAD)
    agentRuns.setBusy(PROJECT, THREAD, true, 'message-1')

    expect(agentRuns.isTraceOpen(PROJECT, THREAD)).toBe(true)
    expect(agentRuns.isTraceUserOpened(PROJECT, THREAD)).toBe(true)
  })

  it('keeps a reader-folded trace folded through a step boundary too', () => {
    startLiveTurn()
    agentRuns.setTraceOpen(PROJECT, THREAD, false, false, true)

    agentRuns.setIdle(PROJECT, THREAD)
    agentRuns.setBusy(PROJECT, THREAD, true, 'message-1')

    expect(agentRuns.isTraceOpen(PROJECT, THREAD)).toBe(false)
  })

  it('forgets the visit when the thread is left, and never while the run is live', () => {
    startLiveTurn()
    readerOpens()
    agentRuns.setIdle(PROJECT, THREAD)

    // Leaving a live run must not fold the work in progress.
    agentRuns.setBusy(PROJECT, THREAD, true, 'message-2')
    agentRuns.resetTraceView(PROJECT, THREAD)
    expect(agentRuns.isTraceOpen(PROJECT, THREAD)).toBe(true)

    // Leaving a settled thread starts it folded again.
    agentRuns.setIdle(PROJECT, THREAD)
    agentRuns.resetTraceView(PROJECT, THREAD)
    expect(agentRuns.isTraceOpen(PROJECT, THREAD)).toBe(false)
    expect(agentRuns.isTraceUserOpened(PROJECT, THREAD)).toBe(false)
  })
})
