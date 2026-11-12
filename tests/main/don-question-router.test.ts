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
import { StorageEngine } from '../../src/main/storage/storage-engine'
import { ChatEngine } from '../../src/main/chat/chat-engine'
import { DON_THREAD_ID } from '../../src/main/don/don-bootstrap'
import {
  answerTeammateQuestion,
  routeTeammateQuestion
} from '../../src/main/chat/don-question-router'
import type { PendingQuestionInfo } from '../../src/main/chat/chat-engine/chat-engine-types'
import {
  ASSISTANT_SPACE_ID,
  type AgentMessage,
  type AgentQuestion,
  type CreateThreadInput,
  type Thread,
  type ThreadSettings
} from '../../src/lib/types'
import { UTILITY_SUGGESTION_DECLINE_ANSWER } from '../../src/lib/utility-suggestion'

/**
 * The questions Don's team stops on are settled where the work was asked for.
 *
 * A dispatched child never asks the user anything: a question about the work goes
 * to Don, which answers it, and only a credential or a sign-in stays on the card in
 * Don's conversation. These cases lock in which questions are routed, that each one
 * wakes Don exactly once, that the decision lands in Don's thread under the
 * teammate's own name, and that Don can only answer a thread this conversation
 * started.
 */

const ASSISTANT_ID = 'assistant-1'
const ASSISTANT_NAME = 'Scout'
const SESSION_ID = 'sess-1'
const PROJECT_PATH = '/project'

const settings: ThreadSettings = {
  harnessId: 'pi',
  providerId: 'openai',
  modelId: 'gpt-5',
  thinkingLevel: 'medium',
  permissionLevel: 'auto_review'
}

interface EngineInternals {
  threadManager: { createThread(input: CreateThreadInput): Promise<Thread> }
  handledIdleSessions: Set<string>
}

const temporaryDatabases: Database[] = []
const originalConfigRoot = process.env['CODEINOVEN_CONFIG_ROOT']
let temporaryConfigRoot = ''

beforeEach(() => {
  temporaryConfigRoot = mkdtempSync(join(tmpdir(), 'codeinoven-don-router-'))
  process.env['CODEINOVEN_CONFIG_ROOT'] = temporaryConfigRoot
})

afterEach(() => {
  temporaryDatabases.splice(0).forEach(destroyTestDb)
  rmSync(temporaryConfigRoot, { force: true, recursive: true })
  temporaryConfigRoot = ''
  if (originalConfigRoot === undefined) delete process.env['CODEINOVEN_CONFIG_ROOT']
  else process.env['CODEINOVEN_CONFIG_ROOT'] = originalConfigRoot
})

function internals(engine: ChatEngine): EngineInternals {
  return engine as unknown as EngineInternals
}

async function seedProject(db: Database, id: string): Promise<void> {
  const inserted = await db.executeViaWorker(
    `INSERT INTO projects(id, name, path, source, provider_id, workflow_id, created_at, updated_at)
       VALUES (?, ?, '', 'local', 'openai', 'default', ?, ?)`,
    [id, id, Date.now(), Date.now()]
  )
  if (!inserted.ok) throw new Error(`project insert failed: ${inserted.error}`)
}

interface Fixture {
  engine: ChatEngine
  donThread: Thread
  childThread: Thread
}

/** A Don conversation and one teammate thread it dispatched. */
async function setup(options: { dispatchFromDon?: boolean } = {}): Promise<Fixture> {
  const db = await createTestDb()
  temporaryDatabases.push(db)
  await seedProject(db, ASSISTANT_SPACE_ID)
  const engine = new ChatEngine(new StorageEngine(temporaryConfigRoot), db)
  const donThread = await internals(engine).threadManager.createThread({
    id: DON_THREAD_ID,
    projectId: ASSISTANT_SPACE_ID,
    providerId: 'pi',
    title: 'Don',
    titleSource: 'manual',
    settings,
    workingDirectory: ''
  })
  const childThread = await internals(engine).threadManager.createThread({
    projectId: ASSISTANT_SPACE_ID,
    providerId: 'pi',
    title: 'Weekly digest',
    titleSource: 'manual',
    assistantId: ASSISTANT_ID,
    settings,
    workingDirectory: '',
    ...(options.dispatchFromDon === false
      ? {}
      : {
          dispatchOrigin: {
            assistantId: ASSISTANT_ID,
            assistantName: ASSISTANT_NAME,
            author: { assistantId: ASSISTANT_ID, name: ASSISTANT_NAME },
            initiatorProjectId: ASSISTANT_SPACE_ID,
            initiatorThreadId: DON_THREAD_ID,
            at: Date.now()
          }
        })
  })
  internals(engine).handledIdleSessions.add(SESSION_ID)
  return { engine, donThread, childThread }
}

function pendingQuestion(
  engine: ChatEngine,
  fixture: Fixture,
  requestId: string,
  questions: AgentQuestion[]
): PendingQuestionInfo {
  return engine.registerPendingQuestion(
    'pi',
    ASSISTANT_SPACE_ID,
    fixture.childThread.id,
    PROJECT_PATH,
    { requestId, sessionId: SESSION_ID, questions },
    60_000
  )
}

/** The minimal user message `sendPrompt` resolves with. */
function promptMessage(): AgentMessage {
  return { id: 'msg-don', role: 'user', parts: [], createdAt: Date.now() }
}

async function donMessages(engine: ChatEngine): Promise<AgentMessage[]> {
  return engine.threadManager.loadMessageRecords(ASSISTANT_SPACE_ID, DON_THREAD_ID)
}

describe('routing a dispatched teammate question to Don', () => {
  it('wakes Don once, with the question and the ids, and names the teammate', async () => {
    const fixture = await setup()
    const sendPrompt = vi.spyOn(fixture.engine, 'sendPrompt').mockResolvedValue(promptMessage())
    const pending = pendingQuestion(fixture.engine, fixture, 'req-work', [
      { prompt: 'Which channel should this go to?', header: 'Scope', options: ['#general'] }
    ])

    await routeTeammateQuestion(fixture.engine, pending)
    await routeTeammateQuestion(fixture.engine, pending)

    expect(sendPrompt).toHaveBeenCalledTimes(1)
    const [projectId, threadId, , prompt] = sendPrompt.mock.calls[0] ?? []
    expect(projectId).toBe(ASSISTANT_SPACE_ID)
    expect(threadId).toBe(DON_THREAD_ID)
    expect(prompt).toContain('req-work')
    expect(prompt).toContain('Which channel should this go to?')
    expect(prompt).toContain('cio_answer_teammate')

    const written = await donMessages(fixture.engine)
    const routed = written.filter((message) => message.id === 'don-question-req-work')
    expect(routed).toHaveLength(1)
    expect(routed[0]?.author?.name).toBe(ASSISTANT_NAME)
    expect(routed[0]?.author?.assistantId).toBe(ASSISTANT_ID)
  })

  it('leaves a thread Don did not dispatch alone', async () => {
    const fixture = await setup({ dispatchFromDon: false })
    const sendPrompt = vi.spyOn(fixture.engine, 'sendPrompt').mockResolvedValue(promptMessage())
    const pending = pendingQuestion(fixture.engine, fixture, 'req-unowned', [
      { prompt: 'Which channel?' }
    ])

    await routeTeammateQuestion(fixture.engine, pending)

    expect(sendPrompt).not.toHaveBeenCalled()
    expect(await donMessages(fixture.engine)).toHaveLength(0)
  })

  it('leaves a credential with the user', async () => {
    const fixture = await setup()
    const sendPrompt = vi.spyOn(fixture.engine, 'sendPrompt').mockResolvedValue(promptMessage())
    const pending = pendingQuestion(fixture.engine, fixture, 'req-secret', [
      { prompt: 'Paste the API key for the reporting account', secretRequest: true, secretId: 'k1' }
    ])

    await routeTeammateQuestion(fixture.engine, pending)

    expect(sendPrompt).not.toHaveBeenCalled()
  })

  it('leaves a sign-in with the user', async () => {
    const fixture = await setup()
    const sendPrompt = vi.spyOn(fixture.engine, 'sendPrompt').mockResolvedValue(promptMessage())
    const pending = pendingQuestion(fixture.engine, fixture, 'req-signin', [
      {
        prompt: 'Authorize the reporting server',
        mcpSignIn: {
          utilityId: 'utility-1',
          name: 'Reporting',
          endpoint: 'https://example.test/mcp',
          grantScope: 'thread',
          reason: 'The server asked for a grant'
        }
      }
    ])

    await routeTeammateQuestion(fixture.engine, pending)

    expect(sendPrompt).not.toHaveBeenCalled()
  })

  it('settles an install suggestion itself instead of handing it to the user', async () => {
    const fixture = await setup()
    const sendPrompt = vi.spyOn(fixture.engine, 'sendPrompt').mockResolvedValue(promptMessage())
    const pending = pendingQuestion(fixture.engine, fixture, 'req-install', [
      {
        prompt: 'Install Reporting Kit (mcp)?',
        header: 'Suggested capability',
        richOptions: [
          { label: 'Install', description: 'Add it to Utilities.' },
          { label: UTILITY_SUGGESTION_DECLINE_ANSWER, description: 'Leave it out for now.' }
        ],
        utilitySuggestion: {
          id: 'suggestion-1',
          name: 'Reporting Kit',
          kinds: ['mcp'],
          reason: 'The work reads from a reporting API.',
          utilities: []
        }
      }
    ])

    await routeTeammateQuestion(fixture.engine, pending)

    expect(sendPrompt).toHaveBeenCalledTimes(1)
    const prompt = sendPrompt.mock.calls[0]?.[3]
    expect(prompt).toContain('Never answer it with')
    expect(prompt).toContain(UTILITY_SUGGESTION_DECLINE_ANSWER)
  })
})

describe('Don answering its own child', () => {
  it('refuses a thread this conversation did not start', async () => {
    const fixture = await setup()
    const result = await answerTeammateQuestion(
      fixture.engine,
      { threadId: fixture.childThread.id, requestId: 'req-work', answers: [['#general']] },
      { projectId: ASSISTANT_SPACE_ID, threadId: 'some-other-thread' }
    )

    expect(result.answered).toBe(false)
    expect(result.error).toBe('That thread was not started from this conversation')
  })

  it('answers the request and says so in Don’s thread under the teammate', async () => {
    const fixture = await setup()
    const answerQuestion = vi.spyOn(fixture.engine, 'answerQuestion').mockResolvedValue()

    const result = await answerTeammateQuestion(
      fixture.engine,
      {
        threadId: fixture.childThread.id,
        requestId: 'req-work',
        answers: [['#general']],
        note: 'Reporting goes to #general.'
      },
      { projectId: ASSISTANT_SPACE_ID, threadId: DON_THREAD_ID }
    )

    expect(result).toEqual({ answered: true, threadId: fixture.childThread.id })
    expect(answerQuestion).toHaveBeenCalledWith(
      ASSISTANT_SPACE_ID,
      fixture.childThread.id,
      'req-work',
      [['#general']]
    )
    const written = await donMessages(fixture.engine)
    const note = written.find((message) => message.id === 'don-question-answer-req-work')
    expect(note?.author?.name).toBe(ASSISTANT_NAME)
  })
})
