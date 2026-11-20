import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { PiSessionHost } from '../../src/main/drivers/pi/session-host/session-host'
import type {
  HostRequestEnvelope,
  HostResponseEnvelope,
  HostSessionState
} from '../../src/main/drivers/pi/session-host/protocol'
import {
  SessionOwnership,
  canTransfer,
  locationFromState,
  resumeRequest
} from '../../src/main/agents/pi-session-transfer'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

async function workspace(): Promise<{ cwd: string; agentDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'cio-transfer-'))
  temporaryRoots.push(root)
  return { cwd: join(root, 'work'), agentDir: join(root, 'agent') }
}

/** A host driven in process, capturing the lines it would have written. */
function host(): {
  handle: (request: HostRequestEnvelope) => Promise<HostResponseEnvelope>
  dispose: () => void
} {
  let captured: HostResponseEnvelope | null = null
  const instance = new PiSessionHost((line) => {
    if (line.type === 'response') captured = line
  })
  return {
    async handle(request) {
      captured = null
      await instance.handle(request)
      if (captured === null) throw new Error(`No response for ${request.id}`)
      return captured
    },
    dispose: () => instance.dispose()
  }
}

async function create(
  target: ReturnType<typeof host>,
  sessionId: string,
  location: { cwd: string; agentDir: string }
): Promise<HostSessionState> {
  const response = await target.handle({
    type: 'request',
    id: `create-${sessionId}`,
    sessionId,
    command: { type: 'create_session', cwd: location.cwd, agentDir: location.agentDir }
  })
  if (!response.ok) throw new Error(response.error)
  return response.data as HostSessionState
}

describe('session transfer', () => {
  it('continues a session on a second host with its history intact', async () => {
    const location = await workspace()
    // Seed a transcript the way a real session writes one: the file only exists
    // once the conversation has a message in it.
    const seed = SessionManager.create(location.cwd, join(location.agentDir, 'sessions', 'seed'))
    seed.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'handover seed' }],
      timestamp: Date.now()
    })
    const transcript = seed.getSessionFile()
    expect(typeof transcript).toBe('string')

    const first = host()
    const second = host()
    try {
      const createdResponse = await first.handle({
        type: 'request',
        id: 'create-1',
        sessionId: 'sess-1',
        command: {
          type: 'create_session',
          cwd: location.cwd,
          agentDir: location.agentDir,
          sessionPath: String(transcript)
        }
      })
      if (!createdResponse.ok) throw new Error(createdResponse.error)
      const created = createdResponse.data as HostSessionState
      expect(created.messageCount).toBe(1)
      expect(canTransfer(created)).toBe(true)

      const moved = locationFromState('host-a', created)
      expect(moved.session.sessionPath).toBe(created.sessionFile)
      expect(moved.session.agentDir).toBe(location.agentDir)

      // The source host gives the session up before the target takes it.
      await first.handle({
        type: 'request',
        id: 'close-1',
        sessionId: 'sess-1',
        command: { type: 'dispose_session' }
      })

      const resumed = await second.handle(resumeRequest(moved.session, 'resume-1'))
      if (!resumed.ok) throw new Error(resumed.error)
      const state = resumed.data as HostSessionState
      expect(state.nativeSessionId).toBe(created.nativeSessionId)
      expect(state.cwd).toBe(created.cwd)
      expect(state.agentDir).toBe(created.agentDir)
      expect(state.sessionFile).toBe(created.sessionFile)
      expect(state.messageCount).toBe(created.messageCount)

      const messages = await second.handle({
        type: 'request',
        id: 'messages-1',
        sessionId: 'sess-1',
        command: { type: 'get_messages' }
      })
      if (!messages.ok) throw new Error(messages.error)
      const history = JSON.stringify(messages.data)
      expect(history).toContain('handover seed')
    } finally {
      first.dispose()
      second.dispose()
    }
  }, 60_000)

  it('keeps a sub-agent attached to its parent when it moves', async () => {
    const location = await workspace()
    const source = host()
    try {
      const created = await create(source, 'worker-1', location)
      const moved = locationFromState('host-a', created, 'parent-1')
      expect(moved.session.parentSessionId).toBe('parent-1')
      const request = resumeRequest(moved.session, 'resume-1')
      expect(request.sessionId).toBe('worker-1')
      // The parent link has to travel with the resume, or the target host adopts
      // the worker as an orphan.
      expect(request.command).toMatchObject({ type: 'create_session', parentSessionId: 'parent-1' })
    } finally {
      source.dispose()
    }
  }, 60_000)

  it('refuses to move a session that has no transcript', () => {
    expect(canTransfer(undefined)).toBe(false)
    expect(canTransfer({ sessionFile: '' } as HostSessionState)).toBe(false)
    const state = {
      sessionId: 'sess-1',
      nativeSessionId: 'native',
      cwd: '/work',
      agentDir: '/agent'
    } as HostSessionState
    expect(canTransfer(state)).toBe(false)
    expect(() => locationFromState('host-a', state)).toThrow(/no transcript/)
  })

  it('builds a resume request that carries what the target host needs', () => {
    const request = resumeRequest(
      {
        sessionId: 'sess-1',
        cwd: '/work',
        agentDir: '/agent',
        sessionPath: '/agent/sessions/x.jsonl',
        extensionPaths: ['/ext/cio.ts'],
        tools: ['bash'],
        model: { provider: 'opencode-go', id: 'deepseek-v4.1-flash' }
      },
      'req-1'
    )
    expect(request).toMatchObject({
      type: 'request',
      id: 'req-1',
      sessionId: 'sess-1',
      command: {
        type: 'create_session',
        cwd: '/work',
        agentDir: '/agent',
        sessionPath: '/agent/sessions/x.jsonl',
        extensionPaths: ['/ext/cio.ts'],
        tools: ['bash'],
        model: { provider: 'opencode-go', id: 'deepseek-v4.1-flash' }
      }
    })
  })
})

describe('SessionOwnership', () => {
  it('gives a session to one host at a time', () => {
    const ownership = new SessionOwnership()
    ownership.claim('sess-1', 'host-a')
    expect(ownership.owner('sess-1')).toBe('host-a')
    expect(() => ownership.claim('sess-1', 'host-b')).toThrow(/already running on host-a/)
  })

  it('lets the owning host claim again and release', () => {
    const ownership = new SessionOwnership()
    ownership.claim('sess-1', 'host-a')
    ownership.claim('sess-1', 'host-a')
    ownership.release('sess-1', 'host-a')
    expect(ownership.owner('sess-1')).toBeNull()
  })

  it('refuses a release from a host that does not own it', () => {
    const ownership = new SessionOwnership()
    ownership.claim('sess-1', 'host-a')
    expect(() => ownership.release('sess-1', 'host-b')).toThrow(/owned by host-a/)
    expect(ownership.owner('sess-1')).toBe('host-a')
  })

  it('lists what a draining host has to hand off', () => {
    const ownership = new SessionOwnership()
    ownership.claim('sess-1', 'host-a')
    ownership.claim('sess-2', 'host-a')
    ownership.claim('sess-3', 'host-b')
    expect(ownership.ownedBy('host-a').sort()).toEqual(['sess-1', 'sess-2'])
    expect(ownership.ownedBy('host-b')).toEqual(['sess-3'])
    expect(ownership.ownedBy('host-c')).toEqual([])
  })

  it('hands a session over without a gap once the source releases it', () => {
    const ownership = new SessionOwnership()
    ownership.claim('sess-1', 'host-a')
    ownership.release('sess-1', 'host-a')
    ownership.claim('sess-1', 'host-b')
    expect(ownership.owner('sess-1')).toBe('host-b')
    expect(ownership.ownedBy('host-a')).toEqual([])
  })
})
