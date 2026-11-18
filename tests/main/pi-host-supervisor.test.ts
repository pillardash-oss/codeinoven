import { describe, expect, it, vi } from 'vitest'
import { PiHostSupervisor, type HostTransport } from '../../src/main/agents/pi-host-supervisor'
import { PiHostClient } from '../../src/main/drivers/pi/pi-host-client'
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
      isStreaming: false,
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
    expect(supervisor.sessions()).toEqual(['atlas'])
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

  it('refuses to move a session it never created', async () => {
    const { supervisor } = harness()
    await expect(supervisor.moveToNewHost('ghost')).rejects.toThrow(/Unknown session/)
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
