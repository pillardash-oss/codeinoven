import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ChatEngineWorkStall,
  stalledWorkSteerPrompt
} from '../../src/main/chat/chat-engine/chat-engine-work-stall'
import type { ChatEngine } from '../../src/main/chat/chat-engine'
import { ASSISTANT_SPACE_ID, INBOX_PROJECT_ID, type AppConfig } from '../../src/lib/types'
import { GLOBAL_BROWSER_PROJECT_ID } from '../../src/lib/ipc/browser'

/**
 * A host with the only surfaces the work-stall unit reads: the per-session
 * registry and status, the config, the owning-conversation lookups, and the
 * internal prompt dispatcher. Everything else stays unset, so a call the unit
 * does not need fails loudly instead of quietly.
 */
interface StallHost {
  state: {
    workStallChecks: Map<string, { timer: ReturnType<typeof setTimeout>; turnKey: string }>
    workStallSettledTurns: Map<string, string>
    childSessionOwners: Map<string, { parentSessionId?: string }>
    childSessionActivityStatuses: Map<string, string>
  }
  sessionRegistry: Map<string, Record<string, unknown>>
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
const PROJECT = 'project-1'
const THREAD_SETTINGS = { harnessId: 'pi' }

function sessionInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: SESSION,
    projectId: PROJECT,
    threadId: 'thread-1',
    projectPath: '/project',
    driverId: 'pi',
    activeTurnId: 'turn-1',
    ...overrides
  }
}

function makeHost(minutes = 10): HostFixture {
  const sendPrompt = vi.fn(async () => undefined)
  const host: StallHost = {
    state: {
      workStallChecks: new Map(),
      workStallSettledTurns: new Map(),
      childSessionOwners: new Map(),
      childSessionActivityStatuses: new Map()
    },
    sessionRegistry: new Map([[SESSION, sessionInfo()]]),
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
    expect(call[0]).toBe(PROJECT)
    expect(call[3]).toBe(stalledWorkSteerPrompt(10))
    expect(call[10]).toBe('internal')
    expect(host.state.workStallSettledTurns.get(SESSION)).toBe('turn-1')
  })

  it('measures the window from the start of the turn, not from streamed events', async () => {
    const { unit, sendPrompt } = makeHost(10)
    unit.noteTurnStarted(SESSION)
    // Every streamed part re-announces the working state.
    for (let minute = 1; minute <= 9; minute += 1) {
      await vi.advanceTimersByTimeAsync(60_000)
      unit.noteTurnStarted(SESSION)
    }
    expect(sendPrompt).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(sendPrompt).toHaveBeenCalledTimes(1)
  })

  it('never steers a turn that changed a file at any point', async () => {
    const { host, unit, sendPrompt } = makeHost(10)
    unit.noteTurnStarted(SESSION)
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    const info = host.sessionRegistry.get(SESSION)
    if (!info) throw new Error('missing fixture session')
    info.changedPaths = new Set(['src/app.ts'])

    await vi.advanceTimersByTimeAsync(60 * 60_000)
    unit.noteTurnStarted(SESSION)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(sendPrompt).not.toHaveBeenCalled()
  })

  it('spends the turn check when a later steer re-announces the working state', async () => {
    const { unit, sendPrompt } = makeHost(10)
    unit.noteTurnStarted(SESSION)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(sendPrompt).toHaveBeenCalledTimes(1)

    // The steer dispatch marks the session working again; that is not a new turn.
    unit.noteTurnStarted(SESSION)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(sendPrompt).toHaveBeenCalledTimes(1)
  })

  it('gives a genuinely new turn its own full window', async () => {
    const { host, unit, sendPrompt } = makeHost(10)
    unit.noteTurnStarted(SESSION)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(sendPrompt).toHaveBeenCalledTimes(1)

    unit.endTurn(SESSION)
    host.sessionRegistry.set(SESSION, sessionInfo({ activeTurnId: 'turn-2' }))
    unit.noteTurnStarted(SESSION)
    await vi.advanceTimersByTimeAsync(9 * 60_000)
    expect(sendPrompt).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sendPrompt).toHaveBeenCalledTimes(2)
  })

  it('does not let a new turn inherit the previous turn’s remaining window', async () => {
    const { host, unit, sendPrompt } = makeHost(10)
    unit.noteTurnStarted(SESSION)
    await vi.advanceTimersByTimeAsync(9 * 60_000)
    // A new turn starts without the previous one settling.
    host.sessionRegistry.set(SESSION, sessionInfo({ activeTurnId: 'turn-2' }))
    unit.noteTurnStarted(SESSION)

    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(sendPrompt).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(8 * 60_000)
    expect(sendPrompt).toHaveBeenCalledTimes(1)
  })

  it('says nothing when the turn ended before the check landed', async () => {
    const { host, unit, sendPrompt } = makeHost(10)
    unit.noteTurnStarted(SESSION)
    host.sessionStatuses.set(SESSION, { state: 'idle' })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(host.state.workStallSettledTurns.size).toBe(0)
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
    expect(host.state.workStallSettledTurns.size).toBe(0)

    // A child whose files were claimed on the parent means the turn did work.
    const info = host.sessionRegistry.get(SESSION)
    if (!info) throw new Error('missing fixture session')
    info.changedPaths = new Set(['src/from-child.ts'])
    host.state.childSessionActivityStatuses.set('child-1', 'completed')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sendPrompt).not.toHaveBeenCalled()
  })

  it('steers after a child settles if the turn still changed nothing', async () => {
    const { host, unit, sendPrompt } = makeHost(10)
    host.state.childSessionOwners.set('child-1', { parentSessionId: SESSION })
    host.state.childSessionActivityStatuses.set('child-1', 'running')
    unit.noteTurnStarted(SESSION)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(sendPrompt).not.toHaveBeenCalled()

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

  it.each([INBOX_PROJECT_ID, ASSISTANT_SPACE_ID, GLOBAL_BROWSER_PROJECT_ID])(
    'never watches a conversation container (%s)',
    async (projectId) => {
      const { host, unit, sendPrompt } = makeHost(10)
      host.sessionRegistry.set(SESSION, sessionInfo({ projectId }))
      unit.noteTurnStarted(SESSION)
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      expect(sendPrompt).not.toHaveBeenCalled()
      expect(host.state.workStallChecks.size).toBe(0)
    }
  )

  it('never arms for a child session or a temporary chat', async () => {
    const { host, unit } = makeHost(10)
    host.state.childSessionOwners.set('child-1', { parentSessionId: SESSION })
    host.sessionRegistry.set('child-1', sessionInfo({ sessionId: 'child-1', activeTurnId: 'c' }))
    host.sessionStatuses.set('child-1', { state: 'working' })
    unit.noteTurnStarted('child-1')

    host.sessionRegistry.set('chat-1', sessionInfo({ sessionId: 'chat-1', activeTurnId: 't' }))
    host.units['temporary-chats'] = { temporaryChatForSession: () => ({ sessionId: 'chat-1' }) }
    unit.noteTurnStarted('chat-1')

    await vi.advanceTimersByTimeAsync(0)
    expect(host.state.workStallChecks.size).toBe(0)
  })

  it('does nothing when the configured window is not positive', async () => {
    const { host, unit } = makeHost(0)
    unit.noteTurnStarted(SESSION)
    await vi.advanceTimersByTimeAsync(0)
    expect(host.state.workStallChecks.size).toBe(0)
  })
})
