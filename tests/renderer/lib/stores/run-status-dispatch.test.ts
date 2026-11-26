// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The status a thread reports between the click and the harness's first word.
 *
 * The rule these lock in: a send or a retry is work from the moment the reader
 * asks for it. Nothing the machine still has to do underneath   aborting the
 * replaced run, releasing a rate-limited account's harness, spawning a new one,
 * waiting out a minute of process start   may make the row fall back to the
 * status the *previous* turn left behind.
 */

vi.mock('$lib/ipc.svelte', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/ipc.svelte')>()
  return {
    ...actual,
    invoke: vi.fn(async () => null),
    subscribe: () => () => {},
    subscribeGuarded: () => () => {}
  }
})

vi.mock('$lib/stores/app-errors.svelte', () => ({ showToastError: () => undefined }))

const { agentRuns } = await import('$lib/stores/agent-runs.svelte')
const { ThreadMessagesCache } = await import('$lib/stores/thread-messages-cache.svelte')
const { ThreadMessagesEvents } = await import('$lib/stores/thread-messages-events.svelte')

const PROJECT = 'p1'
const THREAD = 't1'
const SESSION = 'session-1'

function harness(): { events: InstanceType<typeof ThreadMessagesEvents> } {
  const cache = new ThreadMessagesCache()
  cache.setSessionId(PROJECT, THREAD, SESSION)
  return { events: new ThreadMessagesEvents(cache) }
}

/** A run-ending status the session that was replaced emits while it dies. */
function dyingSessionEvents(events: InstanceType<typeof ThreadMessagesEvents>): void {
  events.handle({ type: 'session.status', sessionId: SESSION, status: { state: 'idle' } } as never)
  events.handle({ type: 'session.idle', sessionId: SESSION } as never)
  events.handle({ type: 'session.error', sessionId: SESSION, error: 'aborted' } as never)
  events.handle({
    type: 'session.status',
    sessionId: SESSION,
    status: { state: 'waiting', issue: { kind: 'rate_limit', retryAt: null } }
  } as never)
}

beforeEach(() => {
  agentRuns.clear(PROJECT, THREAD)
})

describe('a turn dispatched from this window', () => {
  it('stays working when the run it replaced dies under it', () => {
    const { events } = harness()
    agentRuns.setBusy(PROJECT, THREAD, true, 'message-1')
    agentRuns.beginDispatch(PROJECT, THREAD)

    dyingSessionEvents(events)

    expect(agentRuns.isBusy(PROJECT, THREAD)).toBe(true)
  })

  it('keeps its retry clock instead of parking on the replaced account', () => {
    const { events } = harness()
    agentRuns.setBusy(PROJECT, THREAD, true, 'message-1')
    agentRuns.beginDispatch(PROJECT, THREAD)
    agentRuns.setRetryAt(PROJECT, THREAD, 5_000)

    dyingSessionEvents(events)

    expect(agentRuns.retryAt(PROJECT, THREAD)).toBe(5_000)
    expect(agentRuns.isBusy(PROJECT, THREAD)).toBe(true)
  })

  it('settles when the new harness states the run is over', () => {
    const { events } = harness()
    agentRuns.setBusy(PROJECT, THREAD, true, 'message-1')
    agentRuns.beginDispatch(PROJECT, THREAD)

    events.handle({
      type: 'session.status',
      sessionId: SESSION,
      status: { state: 'working' }
    } as never)
    events.handle({ type: 'session.idle', sessionId: SESSION } as never)

    expect(agentRuns.isBusy(PROJECT, THREAD)).toBe(false)
  })
})

describe('a turn nobody dispatched from here', () => {
  it('settles on the session end it hears about', () => {
    const { events } = harness()
    agentRuns.setBusy(PROJECT, THREAD, true, 'message-1')

    events.handle({ type: 'session.idle', sessionId: SESSION } as never)

    expect(agentRuns.isBusy(PROJECT, THREAD)).toBe(false)
  })
})
