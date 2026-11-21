import { describe, expect, it, vi } from 'vitest'
import { PiHostSupervisor, type HostTransport } from '../../src/main/agents/pi-host-supervisor'
import { PiHostClient } from '../../src/main/drivers/pi/pi-host-client'
import { decideAdmission, type AdmissionDecision } from '../../src/lib/resource-admission'
import type {
  HostRequestEnvelope,
  HostSessionState
} from '../../src/main/drivers/pi/session-host/protocol'

/** A host that answers from a table, so the supervisor's rules can be watched. */
class FakeHost {
  readonly lines: HostRequestEnvelope[] = []
  stopped = false
  /** Answer `prompt` with a preflight disposition, instead of leaving it in flight. */
  answerPrompts = false
  /** Leave `compact` in flight, so a checkpoint's timeout behaviour is testable. */
  holdCompactions = false
  /** Sessions that report a turn in flight, so a rejoin cannot pick them up. */
  readonly streaming = new Set<string>()
  readonly transport: HostTransport
  #listeners: ((line: string) => void)[] = []
  #exitListeners: ((code: number | null) => void)[] = []
  #sessions = new Set<string>()

  constructor(pidValue: number) {
    this.transport = {
      pid: pidValue,
      send: (line) => {
        const request = JSON.parse(line) as HostRequestEnvelope
        this.lines.push(request)
        this.#answer(request)
      },
      onLine: (listener) => this.#listeners.push(listener),
      onExit: (listener) => this.#exitListeners.push(listener),
      stop: () => {
        this.stopped = true
      }
    }
  }

  state(sessionId: string): HostSessionState {
    return {
      sessionId,
      nativeSessionId: `native-${sessionId}`,
      sessionFile: `/agent/sessions/${sessionId}.jsonl`,
      cwd: `/work/${sessionId}`,
      agentDir: '/agent',
      thinkingLevel: 'low',
      isStreaming: this.streaming.has(sessionId),
      isCompacting: false,
      messageCount: 2,
      pendingMessageCount: 0
    }
  }

  exit(): void {
    for (const listener of this.#exitListeners) listener(1)
  }

  /** Push a line the supervisor did not ask for, the way a host forwards a dialog. */
  emit(line: unknown): void {
    for (const listener of this.#listeners) listener(JSON.stringify(line))
  }

  #answer(request: HostRequestEnvelope): void {
    const reply = (data: unknown): void => {
      const line = JSON.stringify({ type: 'response', id: request.id, ok: true, data })
      for (const listener of this.#listeners) listener(line)
    }
    switch (request.command.type) {
      case 'create_session':
        this.#sessions.add(String(request.sessionId))
        reply(this.state(String(request.sessionId)))
        return
      case 'get_state':
        reply(this.state(String(request.sessionId)))
        return
      case 'dispose_session':
        this.#sessions.delete(String(request.sessionId))
        reply({ disposed: true })
        return
      case 'prompt':
        // A prompt answers when the turn preflights; staying silent is how a
        // request that is still in flight looks.
        if (this.answerPrompts) reply({ disposition: 'started' })
        return
      case 'compact':
        if (!this.holdCompactions) reply({})
        return
      case 'list_sessions':
        reply(
          [...this.#sessions].map((sessionId) => ({
            sessionId,
            nativeSessionId: `n-${sessionId}`,
            cwd: `/work/${sessionId}`
          }))
        )
        return
      default:
        reply({})
    }
  }
}

function harness(): { supervisor: PiHostSupervisor; hosts: FakeHost[] } {
  const hosts: FakeHost[] = []
  const supervisor = new PiHostSupervisor(() => {
    const host = new FakeHost(500 + hosts.length)
    hosts.push(host)
    return host.transport
  })
  return { supervisor, hosts }
}

describe('PiHostSupervisor', () => {
  it('starts one host and keeps every session on it', async () => {
    const { supervisor, hosts } = harness()
    await supervisor.createSession({
      sessionId: 'atlas',
      command: { type: 'create_session', cwd: '/work/atlas', agentDir: '/agent' }
    })
    await supervisor.createSession({
      sessionId: 'ledger',
      command: { type: 'create_session', cwd: '/work/ledger', agentDir: '/agent' }
    })
    expect(hosts).toHaveLength(1)
    expect(supervisor.sessions().sort()).toEqual(['atlas', 'ledger'])
    expect(await supervisor.listSessions()).toHaveLength(2)
  })

  it('stops the host once it holds no sessions', async () => {
    const { supervisor, hosts } = harness()
    await supervisor.createSession({
      sessionId: 'atlas',
      command: { type: 'create_session', cwd: '/work/atlas', agentDir: '/agent' }
    })
    await supervisor.disposeSession('atlas')
    expect(hosts[0].stopped).toBe(true)
    expect(supervisor.pid()).toBeNull()
  })

  /**
   * A host's row counts the turns in flight, not the sessions it keeps warm.
   *
   * A finished session stays on its host so the next prompt on that thread is
   * instant, so the two numbers differ for as long as a thread sits idle after
   * its turn. The row reports the one that answers what the process is doing.
   */
  it('counts the turns in flight rather than the sessions it keeps', async () => {
    const { supervisor } = harness()
    for (const sessionId of ['atlas', 'ledger']) {
      await supervisor.createSession({
        sessionId,
        command: { type: 'create_session', cwd: `/work/${sessionId}`, agentDir: '/agent' }
      })
    }
    expect(supervisor.sessionsOn(500)).toBe(2)
    expect(supervisor.busyOn(500)).toBe(0)

    const changes: number[] = []
    supervisor.onHostsChanged(() => changes.push(supervisor.busyOn(500)))
    supervisor.noteSessionBusy('atlas', true)
    expect(supervisor.busyOn(500)).toBe(1)
    // Repeating a state it already reported is not a change.
    const published = changes.length
    supervisor.noteSessionBusy('atlas', true)
    expect(changes.length).toBe(published)

    // A session that leaves its host cannot still be working on it.
    await supervisor.disposeSession('atlas')
    expect(supervisor.busyOn(500)).toBe(0)
    expect(changes).toContain(0)
  })

  /**
   * Where a session runs is part of what a host's row says, so every change of
   * that mapping has to be published.
   *
   * The row is registered the instant the process appears   before the session
   * that asked for it has landed   and nothing else refreshes it. A change
   * nobody hears therefore leaves the running host claiming it carries no
   * threads, which is how a host running the thread on screen was listed as
   * carrying none.
   */
  it('reports a session landing on and leaving a host', async () => {
    const { supervisor } = harness()
    const changes: number[] = []
    supervisor.onHostsChanged(() => changes.push(supervisor.sessionsOn(500)))
    await supervisor.createSession({
      sessionId: 'atlas',
      command: { type: 'create_session', cwd: '/work/atlas', agentDir: '/agent' }
    })
    expect(changes).toContain(1)
    expect(supervisor.sessionsOn(500)).toBe(1)
    // A second session on the same host is another count, and it is announced.
    await supervisor.createSession({
      sessionId: 'ledger',
      command: { type: 'create_session', cwd: '/work/ledger', agentDir: '/agent' }
    })
    expect(changes).toContain(2)
    await supervisor.disposeSession('ledger')
    expect(supervisor.sessionsOn(500)).toBe(1)
  })

  it('moves a session to a host of its own and resumes its transcript', async () => {
    const { supervisor, hosts } = harness()
    await supervisor.createSession({
      sessionId: 'atlas',
      command: { type: 'create_session', cwd: '/work/atlas', agentDir: '/agent' }
    })
    const moved = await supervisor.moveToNewHost('atlas')
    expect(hosts).toHaveLength(2)
    expect(hosts[0].stopped).toBe(true)
    const resume = hosts[1].lines.find((line) => line.command.type === 'create_session')
    expect(resume?.command).toMatchObject({
      type: 'create_session',
      cwd: '/work/atlas',
      agentDir: '/agent',
      sessionPath: '/agent/sessions/atlas.jsonl'
    })
    expect(moved.nativeSessionId).toBe('native-atlas')
    // The move has to answer where the session went, or the card that shows the
    // result has no pid to show.
    expect(supervisor.hostOf('atlas')).toBe(501)
    expect(supervisor.sessions()).toEqual(['atlas'])
  })

  it('moves a sub-agent session with its parent link intact', async () => {
    const { supervisor, hosts } = harness()
    // The app path: a child session is created naming its parent, the way the
    // driver creates a sub-agent. The record the supervisor keeps has to carry
    // that link into the resume, not just the hand-built request in the
    // transfer suite.
    await supervisor.createSession({
      sessionId: 'child-1',
      parentSessionId: 'parent-1',
      command: {
        type: 'create_session',
        cwd: '/work/atlas',
        agentDir: '/agent',
        parentSessionId: 'parent-1'
      }
    })
    await supervisor.moveToNewHost('child-1')
    const resume = hosts[1].lines.find((line) => line.command.type === 'create_session')
    expect(resume?.command).toMatchObject({
      type: 'create_session',
      agentDir: '/agent',
      sessionPath: '/agent/sessions/child-1.jsonl',
      // The live state the host reports wins over the create-time record.
      cwd: '/work/child-1',
      parentSessionId: 'parent-1'
    })
    expect(supervisor.sessions()).toEqual(['child-1'])
    expect(supervisor.hostOf('child-1')).toBe(501)
  })

  it('fails a pending request instead of hanging when the host dies', async () => {
    const { supervisor, hosts } = harness()
    await supervisor.createSession({
      sessionId: 'atlas',
      command: { type: 'create_session', cwd: '/work/atlas', agentDir: '/agent' }
    })
    const pending = supervisor.request('atlas', { type: 'prompt', message: 'hello' })
    hosts[0].exit()
    const response = await pending
    expect(response.ok).toBe(false)
    expect(supervisor.pid()).toBeNull()
  })

  /**
   * A prompt keeps its own command on the wire, with the steering preference as
   * the RPC option.
   *
   * Translating it into the `steer` command parked every hosted turn: Pi drains
   * its steering queue only inside a run, so an idle session accepted the prompt
   * in a millisecond, started nothing, and left the thread working forever.
   */
  it('sends a steered prompt as a prompt, never as a bare steer command', async () => {
    const { supervisor, hosts } = harness()
    await supervisor.createSession({
      sessionId: 'atlas',
      command: { type: 'create_session', cwd: '/work/atlas', agentDir: '/agent' }
    })
    hosts[0].answerPrompts = true
    const client = new PiHostClient({
      supervisor,
      sessionId: 'atlas',
      cwd: '/work/atlas',
      extensionPaths: []
    })
    try {
      await client.prompt('hello', undefined, 'steer')
    } finally {
      client.dispose()
    }
    const sent = hosts[0]?.lines.map((line) => line.command) ?? []
    expect(sent.some((command) => command.type === 'steer')).toBe(false)
    expect(sent.find((command) => command.type === 'prompt')).toMatchObject({
      type: 'prompt',
      message: 'hello',
      streamingBehavior: 'steer'
    })
  })

  it('forwards a dialog to its listener and answers it on the session', async () => {
    const { supervisor, hosts } = harness()
    await supervisor.createSession({
      sessionId: 'atlas',
      command: { type: 'create_session', cwd: '/work/atlas', agentDir: '/agent' }
    })
    const seen: { sessionId: string; method: string }[] = []
    supervisor.onUiRequest((sessionId, request) => seen.push({ sessionId, method: request.method }))
    hosts[0].emit({
      type: 'ui_request',
      sessionId: 'atlas',
      request: {
        id: 'ui-1',
        method: 'confirm',
        title: 'Allow write?',
        message: 'write a file',
        timeout: 1000
      }
    })
    expect(seen).toEqual([{ sessionId: 'atlas', method: 'confirm' }])
    await supervisor.respondToUi('atlas', 'ui-1', { confirmed: true })
    const answered = hosts[0].lines.find((line) => line.command.type === 'ui_response')
    expect(answered?.command).toMatchObject({
      type: 'ui_response',
      requestId: 'ui-1',
      response: { confirmed: true }
    })
  })

  it('stops calling a listener after it unsubscribes', async () => {
    const { supervisor, hosts } = harness()
    await supervisor.createSession({
      sessionId: 'atlas',
      command: { type: 'create_session', cwd: '/work/atlas', agentDir: '/agent' }
    })
    const listener = vi.fn()
    const off = supervisor.onUiRequest(listener)
    off()
    hosts[0].emit({
      type: 'ui_request',
      sessionId: 'atlas',
      request: { id: 'ui-2', method: 'notify', message: 'x', notifyType: undefined }
    })
    expect(listener).not.toHaveBeenCalled()
  })

  /**
   * A checkpoint summarizes a large transcript page by page and reports each
   * step as a status line, so its request must be measured by silence rather
   * than by total age: a fixed deadline killed a working compaction at the same
   * moment a hung one would have been caught.
   */
  it('keeps a compaction request alive while its session reports progress', async () => {
    vi.useFakeTimers()
    try {
      const hosts: FakeHost[] = []
      const own = new PiHostSupervisor(
        () => {
          const host = new FakeHost(700 + hosts.length)
          hosts.push(host)
          return host.transport
        },
        { requestTimeoutMs: 1000 }
      )
      await own.createSession({
        sessionId: 'atlas',
        command: { type: 'create_session', cwd: '/work/atlas', agentDir: '/agent' }
      })
      hosts[0].holdCompactions = true
      const pending = own.request('atlas', { type: 'compact' })
      const outcome = pending.then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      )

      await vi.advanceTimersByTimeAsync(800)
      hosts[0].emit({
        type: 'ui_request',
        sessionId: 'atlas',
        request: {
          id: 'ui-progress',
          method: 'setStatus',
          statusKey: 'codeinoven-compaction',
          statusText: 'progress'
        }
      })
      // Past the original deadline, which the progress line restarted.
      await vi.advanceTimersByTimeAsync(800)
      await expect(Promise.race([outcome, Promise.resolve('pending')])).resolves.toBe('pending')

      // Silence for one full window after the last line is what fails it.
      await vi.advanceTimersByTimeAsync(1200)
      await expect(outcome).resolves.toContain('did not answer compact')
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses to move a session it never created', async () => {
    const { supervisor } = harness()
    await expect(supervisor.moveToNewHost('ghost')).rejects.toThrow(/Unknown session/)
  })

  /**
   * The task manager stops one host by pid, and only that host's work ends.
   *
   * Its sessions are reported as lost so their turns fail visibly instead of
   * waiting on a process that no longer exists, and every other host keeps its
   * sessions because it was never the one the user ended.
   */
  it('stops one host by pid and reports only its sessions as lost', async () => {
    const hosts: FakeHost[] = []
    const supervisor = new PiHostSupervisor(
      () => {
        const host = new FakeHost(500 + hosts.length)
        hosts.push(host)
        return host.transport
      },
      { maxSessionsPerHost: 1 }
    )
    const lost: string[] = []
    supervisor.onSessionLost((sessionId) => lost.push(sessionId))
    await supervisor.createSession({
      sessionId: 'atlas',
      command: { type: 'create_session', cwd: '/work/atlas', agentDir: '/agent' }
    })
    await supervisor.createSession({
      sessionId: 'ledger',
      command: { type: 'create_session', cwd: '/work/ledger', agentDir: '/agent' }
    })
    expect(hosts).toHaveLength(2)
    expect(supervisor.pids()).toEqual(hosts.map((host) => host.transport.pid))

    supervisor.stopHost(hosts[0].transport.pid)

    expect(hosts[0].stopped).toBe(true)
    expect(hosts[1].stopped).toBe(false)
    expect(lost).toEqual(['atlas'])
    expect(supervisor.sessions()).toEqual(['ledger'])
    expect(supervisor.pids()).toEqual([hosts[1].transport.pid])

    // A row can outlive its process by one refresh: an unknown pid is ignored.
    supervisor.stopHost(999_999)
    expect(supervisor.sessions()).toEqual(['ledger'])
  })

  it('fails a request that never answers, rather than waiting forever', async () => {
    vi.useFakeTimers()
    try {
      const silent = new PiHostSupervisor(
        () => ({
          pid: 9,
          send: () => undefined,
          onLine: () => undefined,
          onExit: () => undefined,
          stop: () => undefined
        }),
        { requestTimeoutMs: 50 }
      )
      const pending = silent.request('atlas', { type: 'list_sessions' })
      const rejected = expect(pending).rejects.toThrow(/did not answer/)
      await vi.advanceTimersByTimeAsync(60)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * Where a new session lands, and how it gets home again.
 *
 * One host is the app's cheapest arrangement in RAM, so a second host is only
 * ever a loan against CPU pressure: it opens for new work while the CPU is busy,
 * and every session it borrowed resumes on the primary as soon as the same
 * reading says there is room.
 */
describe('PiHostSupervisor placement and rejoin', () => {
  /** A reading that says the CPU is busy, so new work needs a process of its own. */
  function busyCpu(): AdmissionDecision {
    return decideAdmission({
      cpuAvailablePercent: 1,
      memoryAvailableBytes: 6 * 1024 ** 3,
      totalMemoryBytes: 32 * 1024 ** 3
    })
  }

  /** A reading that says the device has room, so one host can carry everything. */
  function roomy(): AdmissionDecision {
    return decideAdmission({
      cpuAvailablePercent: 55,
      memoryAvailableBytes: 6 * 1024 ** 3,
      totalMemoryBytes: 32 * 1024 ** 3
    })
  }

  function harness(read: () => AdmissionDecision, rebalanceIntervalMs = 60_000) {
    const hosts: FakeHost[] = []
    const supervisor = new PiHostSupervisor(
      () => {
        const host = new FakeHost(500 + hosts.length)
        hosts.push(host)
        return host.transport
      },
      { readPressure: async () => read(), rebalanceIntervalMs }
    )
    return { supervisor, hosts }
  }

  function create(supervisor: PiHostSupervisor, sessionId: string): Promise<HostSessionState> {
    return supervisor.createSession({
      sessionId,
      command: { type: 'create_session', cwd: `/work/${sessionId}`, agentDir: '/agent' }
    })
  }

  it('opens one temporary host for new work while the CPU is busy', async () => {
    const { supervisor, hosts } = harness(busyCpu)
    await create(supervisor, 'atlas')
    await create(supervisor, 'ledger')
    // Both landed on the same temporary process: a loan against the CPU, not a
    // host per thread, which is what would spend the RAM a single host saves.
    expect(hosts).toHaveLength(2)
    expect(supervisor.hostOf('atlas')).toBe(501)
    expect(supervisor.hostOf('ledger')).toBe(501)
    expect(supervisor.pid()).toBe(500)
    supervisor.stop()
  })

  it('keeps new work on the primary while the device has room', async () => {
    const { supervisor, hosts } = harness(roomy)
    await create(supervisor, 'atlas')
    await create(supervisor, 'ledger')
    expect(hosts).toHaveLength(1)
    expect(supervisor.hostOf('atlas')).toBe(500)
    expect(supervisor.hostOf('ledger')).toBe(500)
  })

  it('rejoins both sessions into the primary once the device has room', async () => {
    let reading = busyCpu
    const { supervisor, hosts } = harness(() => reading())
    await create(supervisor, 'atlas')
    await create(supervisor, 'ledger')
    expect(supervisor.hostOf('atlas')).toBe(501)

    reading = roomy
    await supervisor.rebalance()

    expect(supervisor.hostOf('atlas')).toBe(500)
    expect(supervisor.hostOf('ledger')).toBe(500)
    // The temporary process stops once it holds nothing, and the transcripts it
    // carried are what the primary resumed, so no history is rebuilt.
    expect(hosts[1]?.stopped).toBe(true)
    expect(supervisor.pids()).toEqual([500])
    const resumed = hosts[0].lines
      .map((line) => line.command)
      .filter((command) => command.type === 'create_session')
      .map((command) => command.sessionPath)
    expect(resumed).toEqual(['/agent/sessions/atlas.jsonl', '/agent/sessions/ledger.jsonl'])
  })

  it('leaves a session with a turn in flight on its temporary host', async () => {
    let reading = busyCpu
    const { supervisor, hosts } = harness(() => reading())
    await create(supervisor, 'atlas')
    await create(supervisor, 'ledger')
    // A move is a resume, so picking up a session mid-answer would lose the turn.
    hosts[1]?.streaming.add('atlas')

    reading = roomy
    await supervisor.rebalance()

    expect(supervisor.hostOf('atlas')).toBe(501)
    expect(supervisor.hostOf('ledger')).toBe(500)
    expect(hosts[1]?.stopped).toBe(false)
  })

  it('holds the temporary host while the CPU is still busy', async () => {
    const { supervisor } = harness(busyCpu)
    await create(supervisor, 'atlas')
    await supervisor.rebalance()
    expect(supervisor.hostOf('atlas')).toBe(501)
    supervisor.stop()
  })

  it('drains the temporary host on its own once the reading clears', async () => {
    vi.useFakeTimers()
    try {
      let reading = busyCpu
      const { supervisor } = harness(() => reading(), 1000)
      await create(supervisor, 'atlas')
      expect(supervisor.hostOf('atlas')).toBe(501)

      reading = roomy
      await vi.advanceTimersByTimeAsync(1000)

      expect(supervisor.hostOf('atlas')).toBe(500)
      expect(supervisor.pids()).toEqual([500])
    } finally {
      vi.useRealTimers()
    }
  })
})
