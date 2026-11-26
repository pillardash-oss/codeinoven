import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'

// The pawn unit reaches for Electron's windows when it broadcasts a card.
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn((): unknown[] => []) },
  app: { isPackaged: false, getPath: () => tmpdir() },
  ipcMain: { handle: () => undefined }
}))

import { ChatEnginePawnAgents } from '../../../src/main/chat/chat-engine/chat-engine-assignment-workers/chat-engine-assignment-workers-pawns'
import type { ChatEngine } from '../../../src/main/chat/chat-engine'
import type { HarnessDriver } from '../../../src/main/drivers/driver.interface'
import type { AgentMessage, Thread, ThreadSettings } from '../../../src/lib/types'

/**
 * A pawn answers only to the agent that spawned it, so the app has to be able to
 * report its run and restart it without a conversation. These lock in the two
 * facts the card depends on:
 *
 * - a settled turn is not a success: the pawn's own records decide, so a rate
 *   limit that closed a "completed" turn still reads as a failure;
 * - the retry re-runs the task the pawn was spawned with, on the thread's current
 *   settings, through an internal prompt its lock still accepts.
 */

const settings: ThreadSettings = {
  harnessId: 'opencode',
  providerId: 'opencode-go',
  modelId: 'deepseek-v4.1-flash',
  thinkingLevel: 'minimal',
  permissionLevel: 'auto_review',
  assignmentMode: false,
  loopMode: false
}

const PROJECT_ID = 'project-1'
const SPAWNER_THREAD_ID = 'spawner-thread-1'
const PAWN_THREAD_ID = 'pawn-thread-1'
const SESSION_ID = 'session-1'

function pawnThread(patch: Partial<Thread> = {}): Thread {
  return {
    id: PAWN_THREAD_ID,
    projectId: PROJECT_ID,
    providerId: 'opencode-go',
    title: 'pawn-naomi: refactor',
    titleSource: 'manual',
    status: 'interrupted',
    pinned: false,
    archived: false,
    read: true,
    settings,
    sessionId: SESSION_ID,
    coordinatorThreadId: SPAWNER_THREAD_ID,
    userInputLocked: true,
    createdAt: 1,
    updatedAt: 2,
    lastActivity: 2,
    workingDirectory: '/tmp/project-1',
    ...patch
  }
}

function assistantError(error: string): AgentMessage {
  return {
    id: `pi-${error.length}`,
    role: 'assistant',
    createdAt: 10,
    parts: [],
    error
  } as unknown as AgentMessage
}

interface StubOptions {
  thread?: Thread
  transcript?: AgentMessage[]
  sessionState?: 'working' | 'error'
  spawnerMessages?: AgentMessage[]
}

function stubHost(options: StubOptions = {}) {
  const thread = options.thread ?? pawnThread()
  const sendPrompt = vi.fn(async () => ({ id: 'msg-sent' }))
  const setStatus = vi.fn(async () => thread)
  const clearStoppedByUser = vi.fn(async () => undefined)
  const clearRetry = vi.fn()
  const clearRateLimitCooldown = vi.fn()
  const loadMessages = vi.fn(async () => options.transcript ?? [])
  const broadcast = vi.fn()
  const followWait = vi.fn(() => new Promise<unknown>(() => undefined))
  const driver = {
    id: 'opencode',
    loadMessages
  } as unknown as HarnessDriver
  const host = {
    threadManager: {
      getThread: vi.fn(async (_projectId: string, threadId: string) =>
        threadId === thread.id ? thread : null
      ),
      loadMessages: vi.fn(async () => options.spawnerMessages ?? []),
      upsertMessages: vi.fn(async () => undefined),
      setStatus,
      clearStoppedByUser
    },
    resolve: vi.fn(async () => ({ driver, projectPath: '/tmp/project-1' })),
    ensureSession: vi.fn(async () => SESSION_ID),
    sendPrompt,
    broadcast,
    sessionRegistry: new Map(),
    sessionStatuses: new Map<string, { state: string; issue?: { message: string } }>(
      options.sessionState
        ? [
            [
              SESSION_ID,
              options.sessionState === 'error'
                ? { state: 'error', issue: { message: '429: rate limit exceeded' } }
                : { state: 'working' }
            ]
          ]
        : []
    ),
    handledIdleSessions: new Set<string>(),
    state: {
      retryScheduler: { clear: clearRetry, clearRateLimitCooldown },
      userAbortedSessions: new Set<string>(),
      childSessionOwners: new Map(),
      childSessionActivityStatuses: new Map<string, string>(),
      completionWaiters: new Map<string, unknown>()
    },
    units: {
      messages: { touchUserActivity: vi.fn() },
      'turns-sessions': { waitForSessionCompletion: followWait }
    }
  }
  return {
    host: host as unknown as ChatEngine,
    sendPrompt,
    setStatus,
    clearRetry,
    clearRateLimitCooldown,
    clearStoppedByUser
  }
}

describe('a pawn run reports what actually happened', () => {
  it('reads the rate limit its transcript recorded, not the settled turn', async () => {
    const { host } = stubHost({
      transcript: [
        assistantError('429: {"type":"rate_limit_error","message":"Rate limit exceeded."}')
      ]
    })
    const pawns = new ChatEnginePawnAgents(host)

    const state = await pawns.pawnRunState(PROJECT_ID, PAWN_THREAD_ID)

    expect(state).toEqual({
      pawn: true,
      running: false,
      failure: '429: {"type":"rate_limit_error","message":"Rate limit exceeded."}'
    })
  })

  it('reports a live run as running and carries no failure', async () => {
    const { host } = stubHost({ sessionState: 'working' })
    const pawns = new ChatEnginePawnAgents(host)

    const state = await pawns.pawnRunState(PROJECT_ID, PAWN_THREAD_ID)

    expect(state).toEqual({ pawn: true, running: true, failure: null })
  })

  it('answers for a thread that is not a pawn at all', async () => {
    const { host } = stubHost({ thread: pawnThread({ coordinatorThreadId: undefined }) })
    const pawns = new ChatEnginePawnAgents(host)

    expect(await pawns.pawnRunState(PROJECT_ID, PAWN_THREAD_ID)).toEqual({
      pawn: false,
      running: false,
      failure: null
    })
  })
})

describe('a pawn run can be retried without a conversation', () => {
  const spawnerCard: AgentMessage = {
    id: `pawn:${PROJECT_ID}:${SESSION_ID}`,
    role: 'assistant',
    createdAt: 1,
    parts: [
      {
        type: 'subagent',
        id: 'part-1',
        messageID: 'pawn',
        callID: 'pawn',
        activity: {
          status: 'error',
          agent: 'refactor',
          description: 'refactor the journal shell',
          prompt: 'Own app/mount.ts and app/stream.ts and make them render from state.',
          childSessionId: SESSION_ID,
          background: true,
          pawn: true
        }
      }
    ]
  } as unknown as AgentMessage

  it('re-sends the recorded task as an internal prompt on the current settings', async () => {
    const { host, sendPrompt, clearRetry, clearStoppedByUser } = stubHost({
      spawnerMessages: [spawnerCard]
    })
    const pawns = new ChatEnginePawnAgents(host)

    await pawns.retryPawnRun(PROJECT_ID, PAWN_THREAD_ID)

    // The queued resume belonged to the failed attempt, and the user is running
    // this now.
    expect(clearRetry).toHaveBeenCalledWith(SESSION_ID)
    expect(clearStoppedByUser).toHaveBeenCalledWith(PROJECT_ID, PAWN_THREAD_ID)
    expect(sendPrompt).toHaveBeenCalledTimes(1)
    const [projectId, threadId, usedSettings, text, , , , , , , origin] = sendPrompt.mock
      .calls[0] as unknown as [
      string,
      string,
      ThreadSettings,
      string,
      unknown,
      unknown,
      unknown,
      unknown,
      unknown,
      unknown,
      string
    ]
    expect(projectId).toBe(PROJECT_ID)
    expect(threadId).toBe(PAWN_THREAD_ID)
    expect(usedSettings).toMatchObject({
      harnessId: settings.harnessId,
      providerId: settings.providerId,
      modelId: settings.modelId,
      thinkingLevel: settings.thinkingLevel
    })
    expect(origin).toBe('internal')
    expect(text).toContain('Own app/mount.ts and app/stream.ts')
    expect(text).toContain('This is a retry of this task')
  })

  it('refuses a thread that is not a pawn', async () => {
    const { host, sendPrompt } = stubHost({
      thread: pawnThread({ coordinatorThreadId: undefined })
    })
    const pawns = new ChatEnginePawnAgents(host)

    await expect(pawns.retryPawnRun(PROJECT_ID, PAWN_THREAD_ID)).rejects.toThrow('not a pawn agent')
    expect(sendPrompt).not.toHaveBeenCalled()
  })

  it('refuses to start a second turn over a live one', async () => {
    const { host, sendPrompt } = stubHost({ sessionState: 'working' })
    const pawns = new ChatEnginePawnAgents(host)

    await expect(pawns.retryPawnRun(PROJECT_ID, PAWN_THREAD_ID)).rejects.toThrow('still working')
    expect(sendPrompt).not.toHaveBeenCalled()
  })
})
