import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ChatEngineWorkStall,
  stalledWorkSteerPrompt
} from '../../src/main/chat/chat-engine/chat-engine-work-stall'
import type { ChatEngine } from '../../src/main/chat/chat-engine'
import type { AppConfig } from '../../src/lib/types'

/**
 * A host with the only surfaces the work-stall unit reads: the per-session
 * registry and status, the config, the owning-conversation lookups, and the
 * internal prompt dispatcher. Everything else stays unset, so a call the unit
 * does not need fails loudly instead of quietly.
 */
interface StallHost {
  state: {
    workStallTimers: Map<string, ReturnType<typeof setTimeout>>
    workStallNudgedTurns: Map<string, string>
    childSessionOwners: Map<string, { parentSessionId?: string }>
    childSessionActivityStatuses: Map<string, string>
  }
  sessionRegistry: Map<string, { activeTurnId?: string; ephemeral?: boolean }>
  sessionStatuses: Map<string, { state: string }>
  storage: { getConfig: () => Promise<AppConfig> }
  units: Record<string, Record<string, unknown>>
  threadManager: { getThread: () => Promise<{ settings: Record<string, string> }> }
  sendPrompt: (...args: unknown[]) => Promise<unknown>
}

interface HostFixture {
  host: StallHost
  unit: ChatEngineWorkStall
  sendPrompt: ReturnType<typeof vi.fn>
}

const SESSION = 'session-1'
const THREAD_SETTINGS = { harnessId: 'pi' }

function makeHost(minutes = 10): HostFixture {
  const sendPrompt = vi.fn(async () => undefined)
  const host: StallHost = {
    state: {
      workStallTimers: new Map(),
      workStallNudgedTurns: new Map(),
      childSessionOwners: new Map(),
      childSessionActivityStatuses: new Map()
    },
    sessionRegistry: new Map([[SESSION, { activeTurnId: 'turn-1' }]]),
    sessionStatuses: new Map([[SESSION, { state: 'working' }]]),
    storage: {
      getConfig: async () => ({ steerToStartWorkMinutes: minutes }) as AppConfig
    },
    units: {
      misc: { hasInFlightWork: () => false },
      'temporary-chats': { temporaryChatForSession: () => undefined },
      'turns-dispatch': { driverForRuntime: () => ({ hasActiveTurn: () => true }) }
    },
    threadManager: { getThread: async () => ({ settings: THREAD_SETTINGS }) },
    sendPrompt
  }
  const unit = new ChatEngineWorkStall(host as unknown as ChatEngine)
  return { host, unit, sendPrompt }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('stalledWorkSteerPrompt', () => {
  it('names the window and forbids discussing the nudge', () => {
    const prompt = stalledWorkSteerPrompt(10)
    expect(prompt).toContain('10 minutes')
    expect(prompt).not.toContain('10 minute.')
    expect(prompt.toLowerCase()).toContain('stop stalling')
    expect(prompt.toLowerCase()).toContain('not one file has changed')
    expect(prompt).toContain('do not mention that you were nudged')
  })

  it('reads a single minute as singular', () => {
    expect(stalledWorkSteerPrompt(1)).toContain('the last 1 minute of this turn')
  })
})

describe('ChatEngineWorkStall', () => {
  it('steers once after the configured window with no file change', async () => {
    const { host, unit, sendPrompt } = makeHost(10)
    unit.noteTurnStarted(SESSION)
    await vi.advanceTimersByTimeAsync(9 * 60_000)
    expect(sendPrompt).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(sendPrompt).toHaveBeenCalledTimes(1)
    const call = sendPrompt.mock.calls[0] as unknown[]
    expect(call[5]).toBeUndefined()
    expect(call[10]).toBe('internal')
    expect(call[3]).toBe(stalledWorkSteerPrompt(10))
    expect(host.state.workStallNudgedTurns.get(SESSION)).toBe('turn-1')
  })

  it('never steers the same turn twice, however much traffic it emits', async () => {
    const { host, unit, sendPrompt } = makeHost(10)
    unit.noteTurnStarted(SESSION)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(sendPrompt).toHaveBeenCalledTimes(1)

    // Streamed events re-announce the working state and a late file change
    // restarts nothing while the turn's one nudge is already spent.
    unit.noteTurnStarted(SESSION)
    unit.noteFileProgress(SESSION)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(sendPrompt).toHaveBeenCalledTimes(1)
    expect(host.state.workStallTimers.size).toBe(0)
  })

  it('restarts the window on a real file change', async () => {
    const { unit, sendPrompt } = makeHost(10)
    unit.noteTurnStarted(SESSION)
    await vi.advanceTimersByTimeAsync(9 * 60_000)
    unit.noteFileProgress(SESSION)
    await vi.advanceTimersByTimeAsync(9 * 60_000)
    expect(sendPrompt).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(sendPrompt).toHaveBeenCalledTimes(1)
  })

  it('does not arm a second clock for an unchanged turn', async () => {
    const { host, unit } = makeHost(10)
    unit.noteTurnStarted(SESSION)
    const first = host.state.workStallTimers.get(SESSION)
    unit.noteTurnStarted(SESSION)
    expect(host.state.workStallTimers.get(SESSION)).toBe(first)
  })

  it('drops the clock and the budget when the turn ends', async () => {
    const { host, unit, sendPrompt } = makeHost(10)
    unit.noteTurnStarted(SESSION)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(sendPrompt).toHaveBeenCalledTimes(1)

    unit.endTurn(SESSION)
    expect(host.state.workStallTimers.size).toBe(0)
    expect(host.state.workStallNudgedTurns.size).toBe(0)

    // A genuinely new turn gets its own window and its own single nudge.
    host.sessionRegistry.set(SESSION, { activeTurnId: 'turn-2' })
    unit.noteTurnStarted(SESSION)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(sendPrompt).toHaveBeenCalledTimes(2)
    expect(host.state.workStallNudgedTurns.get(SESSION)).toBe('turn-2')
  })

  it('says nothing when the turn ended while the clock ran', async () => {
    const { host, unit, sendPrompt } = makeHost(10)
    unit.noteTurnStarted(SESSION)
    host.sessionStatuses.set(SESSION, { state: 'idle' })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(host.state.workStallNudgedTurns.size).toBe(0)
  })

  it('holds off when the driver already released the turn', async () => {
    const { host, unit, sendPrompt } = makeHost(10)
    host.units['turns-dispatch'] = { driverForRuntime: () => ({ hasActiveTurn: () => false }) }
    unit.noteTurnStarted(SESSION)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(sendPrompt).not.toHaveBeenCalled()
  })

  it('never steers a turn that is waiting on a running sub-agent', async () => {
    const { host, unit, sendPrompt } = makeHost(10)
    // A child session is registered from the harness-neutral `subagent` activity
    // the app folds every driver's child work into.
    host.state.childSessionOwners.set('child-1', { parentSessionId: SESSION })
    host.state.childSessionActivityStatuses.set('child-1', 'running')
    unit.noteTurnStarted(SESSION)

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(sendPrompt).not.toHaveBeenCalled()
    // The child keeps working, so the parent keeps waiting instead of stalling.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(host.state.workStallNudgedTurns.size).toBe(0)

    // Once the child settles with no file change behind it, the parent that
    // produced nothing is nudged on the next check.
    host.state.childSessionActivityStatuses.set('child-1', 'completed')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sendPrompt).toHaveBeenCalledTimes(1)
  })

  it('treats any unsettled child activity as work, including a registered child', async () => {
    const { host, unit, sendPrompt } = makeHost(10)
    host.state.childSessionOwners.set('child-1', { parentSessionId: SESSION })
    host.state.childSessionActivityStatuses.set('child-1', 'pending')
    unit.noteTurnStarted(SESSION)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(sendPrompt).not.toHaveBeenCalled()

    // A child session the engine sees as `working` counts even without activity.
    host.state.childSessionActivityStatuses.delete('child-1')
    host.sessionStatuses.set('child-1', { state: 'working' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sendPrompt).not.toHaveBeenCalled()

    host.sessionStatuses.set('child-1', { state: 'idle' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sendPrompt).toHaveBeenCalledTimes(1)
  })

  it('defers while the turn has an in-flight shell tool', async () => {
    const { host, unit, sendPrompt } = makeHost(10)
    let inFlight = true
    host.units['misc'] = { hasInFlightWork: () => inFlight }
    unit.noteTurnStarted(SESSION)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(sendPrompt).not.toHaveBeenCalled()

    inFlight = false
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sendPrompt).toHaveBeenCalledTimes(1)
  })

  it('ignores child sessions that belong to another turn', async () => {
    const { host, unit, sendPrompt } = makeHost(10)
    host.state.childSessionOwners.set('child-1', { parentSessionId: 'another-session' })
    host.state.childSessionActivityStatuses.set('child-1', 'running')
    unit.noteTurnStarted(SESSION)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(sendPrompt).toHaveBeenCalledTimes(1)
  })

  it('never arms for a child session or a temporary chat', async () => {
    const { host, unit } = makeHost(10)
    host.state.childSessionOwners.set('child-1', { parentSessionId: SESSION })
    host.sessionRegistry.set('child-1', { activeTurnId: 'child-turn' })
    host.sessionStatuses.set('child-1', { state: 'working' })
    unit.noteTurnStarted('child-1')

    host.sessionRegistry.set('chat-1', { activeTurnId: 'chat-turn' })
    host.units['temporary-chats'] = { temporaryChatForSession: () => ({ sessionId: 'chat-1' }) }
    unit.noteTurnStarted('chat-1')

    await vi.advanceTimersByTimeAsync(0)
    expect(host.state.workStallTimers.size).toBe(0)
  })

  it('does nothing when the configured window is not positive', async () => {
    const { host, unit } = makeHost(0)
    unit.noteTurnStarted(SESSION)
    await vi.advanceTimersByTimeAsync(0)
    expect(host.state.workStallTimers.size).toBe(0)
  })
})
