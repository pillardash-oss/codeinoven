import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn((): unknown[] => []) },
  app: { isPackaged: false, getPath: () => tmpdir() },
  ipcMain: { handle: () => undefined }
}))

import { createTestDb, destroyTestDb } from './database/test-helper'
import type { Database } from '../../src/main/database/database'
import { ProjectRepo } from '../../src/main/database/repositories/project-repo'
import { StorageEngine } from '../../src/main/storage/storage-engine'
import { ChatEngine } from '../../src/main/chat/chat-engine'
import type { PendingQuestionInfo } from '../../src/main/chat/chat-engine/chat-engine-types'
import type { SessionInfo } from '../../src/main/chat/chat-engine/chat-engine-types'
import type { CheckpointManager } from '../../src/main/storage/checkpoint-manager'
import {
  InactiveQuestionTurnError,
  QuestionRequestGoneError
} from '../../src/main/drivers/driver.interface'
import type {
  AgentMessage,
  AgentQuestionRequest,
  CreateThreadInput,
  Thread,
  ThreadSettings
} from '../../src/lib/types'

/**
 * When a question card outlives the harness turn that asked it, replying to the
 * driver writes into a closed conversation and the thread sits idle on an
 * answered card. These lock in the engine's two recoveries: resume the
 * persisted session with the decision when the driver can prove no turn is
 * live, and keep the old finalize behavior otherwise. They also lock in the
 * turn attribution that resume depends on, since a turn whose evidence is lost
 * records no file changes at all.
 */

const PROJECT_ID = 'p1'
const SESSION_ID = 'sess-1'
const REQUEST_ID = 'req-1'
const PROJECT_PATH = '/project'

const settings: ThreadSettings = {
  harnessId: 'pi',
  providerId: 'openai',
  modelId: 'gpt-5',
  thinkingLevel: 'medium',
  permissionLevel: 'auto_review'
}

interface EngineInternals {
  threadManager: {
    createThread(input: CreateThreadInput): Promise<Thread>
  }
  drivers: Map<string, unknown>
  pendingQuestions: Map<string, PendingQuestionInfo>
  handledIdleSessions: Set<string>
  checkpointManager: CheckpointManager
  sessionRegistry: Map<string, SessionInfo>
  registerSession(
    sessionId: string,
    projectId: string,
    threadId: string,
    projectPath: string,
    permissionLevel: SessionInfo['permissionLevel'],
    driverId: string,
    activeTurnId?: string,
    ephemeral?: boolean
  ): void
  reassertTurnToolEvidence(session: SessionInfo, messages: readonly AgentMessage[]): void
  registerPendingQuestion(
    driverId: string,
    projectId: string,
    threadId: string,
    projectPath: string,
    request: AgentQuestionRequest,
    timeoutMs: number
  ): PendingQuestionInfo
}

const temporaryDatabases: Database[] = []
const temporaryProjectRoots: string[] = []
const originalConfigRoot = process.env['CODEINOVEN_CONFIG_ROOT']
let temporaryConfigRoot = ''

beforeEach(() => {
  temporaryConfigRoot = mkdtempSync(join(tmpdir(), 'codeinoven-question-resume-'))
  process.env['CODEINOVEN_CONFIG_ROOT'] = temporaryConfigRoot
})

afterEach(() => {
  temporaryDatabases.splice(0).forEach(destroyTestDb)
  rmSync(temporaryConfigRoot, { force: true, recursive: true })
  temporaryProjectRoots.splice(0).forEach((path) => rmSync(path, { force: true, recursive: true }))
  temporaryConfigRoot = ''
  if (originalConfigRoot === undefined) delete process.env['CODEINOVEN_CONFIG_ROOT']
  else process.env['CODEINOVEN_CONFIG_ROOT'] = originalConfigRoot
})

function internals(engine: ChatEngine): EngineInternals {
  return engine as unknown as EngineInternals
}

/** The minimal user message `sendPrompt` resolves with; the resume path only
 *  needs a resolved promise to prove the turn went out. */
function promptMessage(): AgentMessage {
  return { id: 'msg-resume', role: 'user', parts: [], createdAt: Date.now() }
}

function setDriver(engine: ChatEngine, id: string, driver: Record<string, unknown>): void {
  internals(engine).drivers.set(id, driver)
}

async function setup(
  projectPath = PROJECT_PATH
): Promise<{ engine: ChatEngine; threadId: string }> {
  const db = await createTestDb()
  temporaryDatabases.push(db)
  new ProjectRepo(db).upsert({
    id: PROJECT_ID,
    name: 'Project',
    path: projectPath,
    source: 'local',
    providerId: 'openai',
    workflowId: 'default',
    threadLimit: 10,
    changeTrackingMode: 'manual',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  const storage = new StorageEngine(temporaryConfigRoot)
  const engine = new ChatEngine(storage, db)
  const thread = await internals(engine).threadManager.createThread({
    projectId: PROJECT_ID,
    providerId: 'pi',
    title: 'Ask a question',
    settings
  })
  // The question's session already finalized its idle handling; without this
  // the resume path would wait for an idle event that will never arrive.
  internals(engine).handledIdleSessions.add(SESSION_ID)
  return { engine, threadId: thread.id }
}

function registerQuestion(engine: ChatEngine, threadId: string): void {
  internals(engine).registerPendingQuestion(
    'pi',
    PROJECT_ID,
    threadId,
    PROJECT_PATH,
    {
      requestId: REQUEST_ID,
      sessionId: SESSION_ID,
      questions: [{ prompt: 'Which channel?', header: 'Scope', options: ['#general'] }]
    },
    60_000
  )
}

describe('ChatEngine question reply after the owning turn ended', () => {
  it('resumes the persisted session when the driver proves no turn is live', async () => {
    const { engine, threadId } = await setup()
    setDriver(engine, 'pi', {
      replyToQuestion: async () => {
        throw new QuestionRequestGoneError(SESSION_ID, REQUEST_ID, 'Pi')
      },
      hasActiveTurn: () => false
    })
    registerQuestion(engine, threadId)
    const sendPrompt = vi.spyOn(engine, 'sendPrompt').mockResolvedValue(promptMessage())

    await engine.answerQuestion(PROJECT_ID, threadId, REQUEST_ID, [['#general']])

    expect(sendPrompt).toHaveBeenCalledTimes(1)
    const args = sendPrompt.mock.calls[0]
    expect(args?.[0]).toBe(PROJECT_ID)
    expect(args?.[1]).toBe(threadId)
    expect(args?.[4]).toEqual([])
    // The answer is a hidden internal turn: the visible record was already
    // persisted by `persistQuestionAnswer`.
    expect(args?.[10]).toBe('internal')
    expect(args?.[11]).toBeUndefined()
    expect(String(args?.[3])).toContain('Which channel?')
    expect(internals(engine).pendingQuestions.has(REQUEST_ID)).toBe(false)
  })

  it('finalizes instead of resuming while the driver still owns a live turn', async () => {
    const { engine, threadId } = await setup()
    setDriver(engine, 'pi', {
      replyToQuestion: async () => {
        throw new QuestionRequestGoneError(SESSION_ID, REQUEST_ID, 'Pi')
      },
      hasActiveTurn: () => true
    })
    registerQuestion(engine, threadId)
    const sendPrompt = vi.spyOn(engine, 'sendPrompt').mockResolvedValue(promptMessage())

    await engine.answerQuestion(PROJECT_ID, threadId, REQUEST_ID, [['#general']])

    expect(sendPrompt).not.toHaveBeenCalled()
    expect(internals(engine).pendingQuestions.has(REQUEST_ID)).toBe(false)
  })

  it('finalizes for a driver with no liveness probe, preserving the old behavior', async () => {
    const { engine, threadId } = await setup()
    setDriver(engine, 'pi', {
      replyToQuestion: async () => {
        throw new QuestionRequestGoneError(SESSION_ID, REQUEST_ID, 'Pi')
      }
    })
    registerQuestion(engine, threadId)
    const sendPrompt = vi.spyOn(engine, 'sendPrompt').mockResolvedValue(promptMessage())

    await engine.answerQuestion(PROJECT_ID, threadId, REQUEST_ID, [['#general']])

    expect(sendPrompt).not.toHaveBeenCalled()
    expect(internals(engine).pendingQuestions.has(REQUEST_ID)).toBe(false)
  })

  it("settles the unresumable turn's checkpoint so its file changes still reach a card", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'codeinoven-question-turn-'))
    temporaryProjectRoots.push(projectRoot)
    const { engine, threadId } = await setup(projectRoot)
    setDriver(engine, 'pi', {
      replyToQuestion: async () => {
        throw new QuestionRequestGoneError(SESSION_ID, REQUEST_ID, 'Pi')
      },
      hasActiveTurn: () => false
    })
    // The turn that asked the question left its checkpoint open on purpose, so
    // the answer could continue it. This driver proves it cannot.
    const internalsRef = internals(engine)
    const active = await internalsRef.checkpointManager.beginTurn(
      PROJECT_ID,
      threadId,
      projectRoot,
      'Turn that asked',
      false
    )
    internalsRef.sessionRegistry.set(SESSION_ID, {
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      threadId,
      projectPath: projectRoot,
      permissionLevel: 'auto_review',
      driverId: 'pi',
      activeTurnId: active.id
    })
    registerQuestion(engine, threadId)
    vi.spyOn(engine, 'sendPrompt').mockResolvedValue(promptMessage())

    await engine.answerQuestion(PROJECT_ID, threadId, REQUEST_ID, [['#general']])

    const stored = await internalsRef.checkpointManager.get(PROJECT_ID, threadId, active.id)
    expect(stored?.status).toBe('completed')
    expect(stored?.after).toBeDefined()
    expect(internalsRef.sessionRegistry.get(SESSION_ID)?.activeTurnId).toBeUndefined()
  })

  it('resumes an inactive-turn dismissal and keeps its visible presentation', async () => {
    const { engine, threadId } = await setup()
    setDriver(engine, 'pi', {
      rejectQuestion: async () => {
        throw new InactiveQuestionTurnError(SESSION_ID, REQUEST_ID, 'Pi')
      },
      hasActiveTurn: () => false
    })
    registerQuestion(engine, threadId)
    const sendPrompt = vi.spyOn(engine, 'sendPrompt').mockResolvedValue(promptMessage())

    await engine.dismissQuestion(PROJECT_ID, threadId, REQUEST_ID)

    expect(sendPrompt).toHaveBeenCalledTimes(1)
    const args = sendPrompt.mock.calls[0]
    expect(args?.[10]).toBe('internal')
    // A dismissal has no persisted record of its own, so the presentation that
    // explains the dismissal must still render.
    expect(args?.[11]).toEqual({ action: 'Dismissed agent question' })
    expect(internals(engine).pendingQuestions.has(REQUEST_ID)).toBe(false)
  })
})

describe('ChatEngine turn attribution', () => {
  function registerTurn(engine: ChatEngine, threadId: string, activeTurnId: string): void {
    internals(engine).registerSession(
      SESSION_ID,
      PROJECT_ID,
      threadId,
      PROJECT_PATH,
      'auto_review',
      'pi',
      activeTurnId
    )
  }

  it('keeps an in-flight turn evidence when the same turn re-registers', async () => {
    const { engine, threadId } = await setup()
    registerTurn(engine, threadId, 'turn-1')
    const session = internals(engine).sessionRegistry.get(SESSION_ID)
    if (!session) throw new Error('session was not registered')
    // What the live part events built up during the turn. Losing this before
    // completion made the turn record no workspace change at all.
    session.changedPaths = new Set(['src/edited.ts'])
    session.preciseChangedPaths = new Map([['src/edited.ts', Date.now()]])
    session.unboundedToolObserved = true

    registerTurn(engine, threadId, 'turn-1')
    const refreshed = internals(engine).sessionRegistry.get(SESSION_ID)
    expect(refreshed?.unboundedToolObserved).toBe(true)
    expect([...(refreshed?.changedPaths ?? [])]).toEqual(['src/edited.ts'])
    expect(refreshed?.preciseChangedPaths?.has('src/edited.ts')).toBe(true)

    registerTurn(engine, threadId, 'turn-2')
    const next = internals(engine).sessionRegistry.get(SESSION_ID)
    expect(next?.unboundedToolObserved).toBe(false)
    expect(next?.changedPaths).toBeUndefined()
    expect(next?.preciseChangedPaths?.size).toBe(0)
  })

  it('re-asserts the mutating tools a settled transcript proves', async () => {
    const { engine } = await setup()
    const session: SessionInfo = {
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      threadId: 'thread-attribution',
      projectPath: PROJECT_PATH,
      permissionLevel: 'auto_review',
      driverId: 'codex'
    }

    internals(engine).reassertTurnToolEvidence(session, [
      {
        id: 'msg-1',
        role: 'assistant',
        createdAt: Date.now(),
        parts: [
          {
            type: 'tool',
            id: 'part-shell',
            messageID: 'msg-1',
            callID: 'call-shell',
            tool: 'command_execution',
            state: { status: 'completed', input: {} }
          },
          {
            type: 'tool',
            id: 'part-write',
            messageID: 'msg-1',
            callID: 'call-write',
            tool: 'write_file',
            state: { status: 'completed', input: { path: 'src/written.ts' } }
          }
        ]
      }
    ])

    // A shell tool means the turn's completion must use the whole workspace
    // diff; the file tool becomes a precise claim for the same turn.
    expect(session.unboundedToolObserved).toBe(true)
    expect([...(session.changedPaths ?? [])]).toEqual(['src/written.ts'])
    expect(session.preciseChangedPaths?.has('src/written.ts')).toBe(true)
  })
})
