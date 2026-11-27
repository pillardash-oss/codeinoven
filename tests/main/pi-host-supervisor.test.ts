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
  /** Refuse a create, the way a host that cannot open the session answers. */
  refuseCreates = false
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
    const reply = (data: unknown, ok = true, error?: string): void => {
      const line = JSON.stringify({ type: 'response', id: request.id, ok, error, data })
      for (const listener of this.#listeners) listener(line)
    }
    switch (request.command.type) {
      case 'create_session':
        if (this.refuseCreates) {
          reply(undefined, false, 'create refused')
          return
        }
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
    // Two populated hosts: the session on the primary first, then a saturated
    // reading opens the loan the second one runs on.
    let cpu = 1.2
    const supervisor = new PiHostSupervisor(
      () => {
        const host = new FakeHost(500 + hosts.length)
        hosts.push(host)
        return host.transport
      },
      { readHostCpu: () => cpu }
    )
    const lost: string[] = []
    supervisor.onSessionLost((sessionId) => lost.push(sessionId))
    await supervisor.createSession({
      sessionId: 'atlas',
      command: { type: 'create_session', cwd: '/work/atlas', agentDir: '/agent' }
    })
    cpu = 98
    await supervisor.createSession({
      sessionId: 'ledger',
      command: { type: 'create_session', cwd: '/work/ledger', agentDir: '/agent' }
    })
    expect(hosts).toHaveLength(2)
    expect(supervisor.hostOf('atlas')).toBe(500)
    expect(supervisor.hostOf('ledger')).toBe(501)
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
 * ever a loan against the primary host's own CPU: it opens while that process is
 * spending a whole core on its sessions, and every session it borrowed resumes
 * on the primary once the host has room again. The machine being busy is never
 * the reason, because a second process cannot free a CPU that some other program
 * is holding: it only adds one more process to the machine.
 */
describe('PiHostSupervisor placement and rejoin', () => {
  const GIGABYTE = 1024 ** 3

  /** A host spending a whole core on its own sessions. */
  const SATURATED = 98
  /** What a hosted Pi session normally looks like. */
  const IDLE_HOST = 1.2
  /** A loaded host, still below the gate that opens another process. */
  const BUSY_HOST = 70

  /** A device short enough on memory that one more process would make it worse. */
  function shortDevice(): AdmissionDecision {
    return decideAdmission({
      cpuAvailablePercent: 1,
      memoryAvailableBytes: 0.2 * GIGABYTE,
      totalMemoryBytes: 32 * GIGABYTE
    })
  }

  /** A device with memory to spare, so it never refuses a process of its own. */
  function roomyDevice(): AdmissionDecision {
    return decideAdmission({
      cpuAvailablePercent: 1,
      memoryAvailableBytes: 6 * GIGABYTE,
      totalMemoryBytes: 32 * GIGABYTE
    })
  }

  function harness(
    readHostCpu: (pid: number) => number | null,
    options: {
      rebalanceIntervalMs?: number
      readPressure?: () => Promise<AdmissionDecision>
      /** Configure each host the moment the supervisor starts it. */
      configure?: (host: FakeHost) => void
    } = {}
  ) {
    const hosts: FakeHost[] = []
    const supervisor = new PiHostSupervisor(
      () => {
        const host = new FakeHost(500 + hosts.length)
        hosts.push(host)
        options.configure?.(host)
        return host.transport
      },
      {
        readHostCpu,
        readPressure: options.readPressure ?? (async () => roomyDevice()),
        rebalanceIntervalMs: options.rebalanceIntervalMs ?? 60_000
      }
    )
    return { supervisor, hosts }
  }

  function create(supervisor: PiHostSupervisor, sessionId: string): Promise<HostSessionState> {
    return supervisor.createSession({
      sessionId,
      command: { type: 'create_session', cwd: `/work/${sessionId}`, agentDir: '/agent' }
    })
  }

  /**
   * How many sessions a host carries never opens another process.
   *
   * Eight resident sessions opening a second host, sixteen a third and so on is
   * what made a busy window read as a leak: every one of those processes held
   * one heap for the same machine, and none of them fixed anything. A session
   * costs the host it runs on nothing extra, so every one of them shares the one
   * host, however many the window has.
   */
  it('keeps every session on one host however many there are', async () => {
    const { supervisor, hosts } = harness(() => IDLE_HOST)
    for (let index = 0; index < 20; index += 1) await create(supervisor, `thread-${index}`)

    expect(hosts).toHaveLength(1)
    expect(supervisor.sessionsOn(500)).toBe(20)
    supervisor.stop()
  })

  it('drains a loan back into a primary that carries many sessions', async () => {
    let cpu = IDLE_HOST
    const { supervisor, hosts } = harness(() => cpu)
    for (let index = 0; index < 12; index += 1) await create(supervisor, `thread-${index}`)

    cpu = SATURATED
    await create(supervisor, 'borrowed')
    expect(supervisor.hostOf('borrowed')).toBe(501)

    // The count the primary carries is not a reason to hold the loan: only its
    // own CPU is, and it has room now.
    cpu = IDLE_HOST
    await supervisor.rebalance()

    expect(supervisor.hostOf('borrowed')).toBe(500)
    expect(hosts[1].stopped).toBe(true)
    expect(supervisor.pids()).toEqual([500])
  })

  it('opens one temporary host while the primary host is saturated', async () => {
    const asked: number[] = []
    const { supervisor, hosts } = harness((pid) => {
      asked.push(pid)
      return SATURATED
    })
    await create(supervisor, 'atlas')
    await create(supervisor, 'ledger')
    // Both landed on the same temporary process: a loan against the host, not a
    // host per thread, which is what would spend the RAM a single host saves.
    expect(hosts).toHaveLength(2)
    expect(supervisor.hostOf('atlas')).toBe(501)
    expect(supervisor.hostOf('ledger')).toBe(501)
    expect(supervisor.pid()).toBe(500)
    // The reading is always about the process that would carry the work.
    expect(asked[0]).toBe(500)
    supervisor.stop()
  })

  /**
   * The regression this arrangement exists for: a machine pegged by something
   * else, with a host that is idle, opened a second host anyway and kept it. A
   * session that is not spending a core of its own has nothing to gain from
   * another process, and the machine has a process more to carry.
   */
  it('keeps new work on the primary while the machine is busy elsewhere', async () => {
    const { supervisor, hosts } = harness(() => IDLE_HOST)
    await create(supervisor, 'atlas')
    await create(supervisor, 'ledger')
    expect(hosts).toHaveLength(1)
    expect(supervisor.hostOf('atlas')).toBe(500)
    expect(supervisor.hostOf('ledger')).toBe(500)
  })

  it('keeps new work on the primary while the host is loaded but not saturated', async () => {
    const { supervisor, hosts } = harness(() => BUSY_HOST)
    await create(supervisor, 'atlas')
    await create(supervisor, 'ledger')
    expect(hosts).toHaveLength(1)
  })

  it('stays on the primary when no host reading arrives', async () => {
    const { supervisor, hosts } = harness(() => null)
    await create(supervisor, 'atlas')
    await create(supervisor, 'ledger')
    expect(hosts).toHaveLength(1)
  })

  it('refuses to open a host on a machine short on memory', async () => {
    const { supervisor, hosts } = harness(() => SATURATED, {
      readPressure: async () => shortDevice()
    })
    await create(supervisor, 'atlas')
    await create(supervisor, 'ledger')
    // A saturated host is a reason to open one, and a machine that cannot carry
    // another process is the one thing that outranks it.
    expect(hosts).toHaveLength(1)
    expect(supervisor.hostOf('ledger')).toBe(500)
  })

  it('rejoins both sessions into the primary once the host has room', async () => {
    let cpu = SATURATED
    const { supervisor, hosts } = harness(() => cpu)
    await create(supervisor, 'atlas')
    await create(supervisor, 'ledger')
    expect(supervisor.hostOf('atlas')).toBe(501)

    cpu = IDLE_HOST
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
    let cpu = SATURATED
    const { supervisor, hosts } = harness(() => cpu)
    await create(supervisor, 'atlas')
    await create(supervisor, 'ledger')
    // A move is a resume, so picking up a session mid-answer would lose the turn.
    hosts[1]?.streaming.add('atlas')

    cpu = IDLE_HOST
    await supervisor.rebalance()

    expect(supervisor.hostOf('atlas')).toBe(501)
    expect(supervisor.hostOf('ledger')).toBe(500)
    expect(hosts[1]?.stopped).toBe(false)
  })

  it('holds the temporary host while the primary host is still loaded', async () => {
    let cpu = SATURATED
    const { supervisor } = harness(() => cpu)
    await create(supervisor, 'atlas')

    // Below the gate that opened it, but not roomy enough to hand back: draining
    // here would only saturate the primary and open a host again next turn.
    cpu = BUSY_HOST
    await supervisor.rebalance()
    expect(supervisor.hostOf('atlas')).toBe(501)
    supervisor.stop()
  })

  it('drains the temporary host on its own once the reading clears', async () => {
    vi.useFakeTimers()
    try {
      let cpu = SATURATED
      const { supervisor } = harness(() => cpu, { rebalanceIntervalMs: 1000 })
      await create(supervisor, 'atlas')
      expect(supervisor.hostOf('atlas')).toBe(501)

      cpu = IDLE_HOST
      await vi.advanceTimersByTimeAsync(1000)

      expect(supervisor.hostOf('atlas')).toBe(500)
      expect(supervisor.pids()).toEqual([500])
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * A move is a home, and a process that is already up is always the cheaper
   * one.
   *
   * The move empties and stops the source host, so the session's new process is
   * all the app has left. The next session used to be sent to a freshly spawned
   * primary instead, which left two hosts running for good: the new primary, and
   * the moved session's host that nothing would ever drain.
   */
  it('adopts the host a move left running instead of opening a second one', async () => {
    const { supervisor, hosts } = harness(() => IDLE_HOST)
    await create(supervisor, 'atlas')
    await supervisor.moveToNewHost('atlas')
    expect(hosts).toHaveLength(2)
    expect(hosts[0].stopped).toBe(true)

    await create(supervisor, 'ledger')

    expect(hosts).toHaveLength(2)
    expect(supervisor.pid()).toBe(501)
    expect(supervisor.hostOf('atlas')).toBe(501)
    expect(supervisor.hostOf('ledger')).toBe(501)
    supervisor.stop()
  })

  /**
   * The drain check belongs to the process, not to one entry that fills it.
   *
   * A host opened by a move never had a session land on it through the create
   * path, so arming the check there left the moved host unsupervised until the
   * app restarted. It is armed at the spawn now, and the host with no primary
   * left over it takes the primary home on that tick.
   */
  it('watches a host a move opened, so it never arrives without a primary', async () => {
    vi.useFakeTimers()
    try {
      const { supervisor } = harness(() => IDLE_HOST, { rebalanceIntervalMs: 1000 })
      await create(supervisor, 'atlas')
      await supervisor.moveToNewHost('atlas')
      expect(supervisor.pid()).toBeNull()

      await vi.advanceTimersByTimeAsync(1000)

      expect(supervisor.pid()).toBe(501)
      expect(supervisor.pids()).toEqual([501])
      expect(supervisor.hostOf('atlas')).toBe(501)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops a host whose session never arrived', async () => {
    // The primary takes the first session with an idle reading, then a saturated
    // one opens the loan this create is meant to fail on.
    let cpu = IDLE_HOST
    const { supervisor, hosts } = harness(() => cpu, {
      // Every process the supervisor opens after the first one refuses the create
      // it was started for, which is what a host that cannot open the session
      // does.
      configure: (host) => {
        if (host.transport.pid > 500) host.refuseCreates = true
      }
    })
    await create(supervisor, 'atlas')
    expect(hosts).toHaveLength(1)
    expect(supervisor.hostOf('atlas')).toBe(500)

    cpu = SATURATED
    await expect(create(supervisor, 'ledger')).rejects.toThrow(/create refused/)

    expect(hosts).toHaveLength(2)
    expect(hosts[1].stopped).toBe(true)
    expect(supervisor.pids()).toEqual([500])
    expect(supervisor.sessions()).toEqual(['atlas'])
  })

  it('adopts the surviving host after the primary exits, never a third process', async () => {
    let cpu = SATURATED
    const { supervisor, hosts } = harness(() => cpu)
    await create(supervisor, 'atlas')
    await create(supervisor, 'ledger')
    expect(supervisor.pid()).toBe(500)

    hosts[0].exit()
    cpu = IDLE_HOST
    await create(supervisor, 'memo')

    expect(hosts).toHaveLength(2)
    expect(supervisor.pid()).toBe(501)
    expect(supervisor.hostOf('memo')).toBe(501)
    expect(supervisor.sessions().sort()).toEqual(['atlas', 'ledger', 'memo'])
    supervisor.stop()
  })
})
