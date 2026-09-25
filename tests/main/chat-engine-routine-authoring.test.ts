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
import { RoutineRepo } from '../../src/main/database/repositories/routine-repo'
import { StorageEngine } from '../../src/main/storage/storage-engine'
import { ChatEngine } from '../../src/main/chat/chat-engine'
import { RoutineAuthoringCheckpoints } from '../../src/main/chat/routine-authoring-checkpoints'
import { ASSISTANT_SPACE_ID } from '../../src/lib/types'
import type { AgentMessage, CreateThreadInput, Routine, Thread } from '../../src/lib/types'

/**
 * A routine's Getting started conversation is an interview, and the interview
 * has to survive the model or harness the user is working on changing mid-way.
 * These lock in what every authoring turn starts from: the contract, the
 * checkpoint the agent keeps current, and every answer the user already
 * submitted.
 */

const SESSION_ID = 'sess-authoring'

const temporaryDatabases: Database[] = []
const originalConfigRoot = process.env['CODEINOVEN_CONFIG_ROOT']
let temporaryConfigRoot = ''

beforeEach(() => {
  temporaryConfigRoot = mkdtempSync(join(tmpdir(), 'codeinoven-routine-authoring-'))
  process.env['CODEINOVEN_CONFIG_ROOT'] = temporaryConfigRoot
})

afterEach(() => {
  temporaryDatabases.splice(0).forEach(destroyTestDb)
  rmSync(temporaryConfigRoot, { force: true, recursive: true })
  temporaryConfigRoot = ''
  if (originalConfigRoot === undefined) delete process.env['CODEINOVEN_CONFIG_ROOT']
  else process.env['CODEINOVEN_CONFIG_ROOT'] = originalConfigRoot
})

interface EngineInternals {
  threadManager: {
    createThread(input: CreateThreadInput): Promise<Thread>
    upsertMessages(
      projectId: string,
      threadId: string,
      messages: AgentMessage[],
      sessionId?: string
    ): Promise<void>
  }
  routineAuthoringInstruction(
    projectId: string,
    threadId: string,
    thread: Thread | null | undefined
  ): Promise<string | undefined>
  routineRunHiddenContext(thread: Thread | null | undefined): string | undefined
  routineHowToInstruction(thread: Thread | null | undefined): string | undefined
  createAssistantRunThread(input: { task: Thread; title: string }): Promise<Thread>
}

function internals(engine: ChatEngine): EngineInternals {
  return engine as unknown as EngineInternals
}

function routine(howTo: string): Routine {
  const now = Date.now()
  return {
    id: 'routine-authoring',
    name: 'Slack latest info',
    color: '#336699',
    schedule: null,
    howTo,
    connections: [],
    paused: false,
    createdAt: now,
    updatedAt: now
  }
}

async function setup(howTo: string): Promise<{
  engine: ChatEngine
  thread: Thread
  checkpoints: RoutineAuthoringCheckpoints
}> {
  const database = await createTestDb()
  temporaryDatabases.push(database)
  new ProjectRepo(database).upsert({
    id: ASSISTANT_SPACE_ID,
    name: 'Assistant',
    path: '',
    source: 'local',
    providerId: 'pi',
    workflowId: 'default',
    threadLimit: 10,
    changeTrackingMode: 'manual',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  new RoutineRepo(database).upsert(routine(howTo))

  const storage = new StorageEngine(temporaryConfigRoot)
  const engine = new ChatEngine(storage, database)
  const thread = await internals(engine).threadManager.createThread({
    projectId: ASSISTANT_SPACE_ID,
    providerId: 'pi',
    title: 'Getting started',
    routineId: routine(howTo).id,
    assistantGettingStarted: true
  })
  return { engine, thread, checkpoints: new RoutineAuthoringCheckpoints(storage) }
}

/** One stored question card, shaped as the engine persists an answer. */
function answeredQuestion(body: string): AgentMessage {
  const id = 'question-answer-0123456789abcdef01234567'
  return {
    id,
    role: 'user',
    origin: 'user',
    visibility: 'conversation',
    parts: [
      {
        type: 'user-presentation',
        id: `${id}-presentation`,
        messageID: id,
        presentation: { action: 'Answered agent question', body }
      }
    ],
    transportParts: [{ type: 'text', id: `${id}-transport-text`, messageID: id, text: body }],
    transportOrigin: 'user',
    createdAt: Date.now(),
    completedAt: Date.now()
  }
}

describe('routine run threads', () => {
  it('inherit their task routine so the how-to and run contract reach the run', async () => {
    const howTo = '# Saved how-to\n\nSearch the web and report.'
    const { engine, thread } = await setup(howTo)

    const run = await internals(engine).createAssistantRunThread({
      task: thread,
      title: 'Run · 09:07'
    })

    // The run keeps the task's routine, which is what carries the how-to and
    // the run contract into its system prompt.
    expect(run.routineId).toBe(routine(howTo).id)
    expect(run.assistantTaskId).toBe(thread.id)
    expect(internals(engine).routineHowToInstruction(run)).toBe(howTo)
    const contract = internals(engine).routineRunHiddenContext(run)
    expect(contract).toContain('Slack latest info')
    expect(contract).toContain('Its how-to is your instruction set')
    // A run is never an authoring turn: the interview contract must not apply.
    expect(
      await internals(engine).routineAuthoringInstruction(ASSISTANT_SPACE_ID, run.id, run)
    ).toBeUndefined()
  })
})

describe('routineAuthoringInstruction', () => {
  it('carries the contract, the checkpoint, and every resolved answer', async () => {
    const { engine, thread, checkpoints } = await setup('')
    await checkpoints.save(routine('').id, '- Cadence: 08:05 daily\n- Digest goes in CodeInOven')
    await internals(engine).threadManager.upsertMessages(
      ASSISTANT_SPACE_ID,
      thread.id,
      [answeredQuestion('1. Where should the daily digest be delivered?\n   - In CodeInOven')],
      SESSION_ID
    )

    const instruction = await internals(engine).routineAuthoringInstruction(
      ASSISTANT_SPACE_ID,
      thread.id,
      thread
    )

    expect(instruction).toBeDefined()
    expect(instruction).toContain('Slack latest info')
    expect(instruction).toContain('two separate single-choice questions')
    expect(instruction).toContain('## Getting started checkpoint (app-owned)')
    expect(instruction).toContain('- Cadence: 08:05 daily')
    expect(instruction).toContain('## Resolved decisions (app-owned, verbatim)')
    expect(instruction).toContain('Where should the daily digest be delivered?')
    expect(instruction).toContain('never ask about one again')
  })

  it('still carries the contract when the interview has saved nothing yet', async () => {
    const { engine, thread } = await setup('')

    const instruction = await internals(engine).routineAuthoringInstruction(
      ASSISTANT_SPACE_ID,
      thread.id,
      thread
    )

    expect(instruction).toContain('Slack latest info')
    expect(instruction).not.toContain('## Getting started checkpoint (app-owned)')
    expect(instruction).not.toContain('## Resolved decisions (app-owned, verbatim)')
  })

  it('is not an authoring turn once the routine has its how-to', async () => {
    const { engine, thread, checkpoints } = await setup('# Saved how-to')
    await checkpoints.save(routine('').id, '- Stale')

    const instruction = await internals(engine).routineAuthoringInstruction(
      ASSISTANT_SPACE_ID,
      thread.id,
      thread
    )

    expect(instruction).toBeUndefined()
  })
})
