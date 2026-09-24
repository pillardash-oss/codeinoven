import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { StorageEngine } from '../../src/main/storage/storage-engine'
import { RoutineAuthoringCheckpoints } from '../../src/main/chat/routine-authoring-checkpoints'
import {
  ROUTINE_AUTHORING_CHECKPOINT_LIMIT,
  ROUTINE_AUTHORING_UTILITY_ID,
  routineAuthoringContext,
  routineAuthoringProgressContext
} from '../../src/lib/routine-authoring'
import { formatInterviewDecisions } from '../../src/main/chat/chat-engine/chat-engine-message-text'
import type { AgentMessage } from '../../src/lib/types'

/**
 * A routine's Getting started conversation is an interview, and these lock in
 * the state that makes it survive a model or harness switch mid-way: the
 * app-owned checkpoint the agent keeps current, and the exact answers the user
 * already submitted.
 */

const temporaryPaths: string[] = []

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryPaths.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

async function testCheckpoints(): Promise<RoutineAuthoringCheckpoints> {
  const root = await temporaryDirectory('codeinoven-routine-checkpoints-')
  const storage = new StorageEngine(root)
  await storage.initialize()
  return new RoutineAuthoringCheckpoints(storage)
}

/**
 * One stored question card, shaped as `persistQuestionAnswer` writes it: the
 * visible answer bubble plus the exact transport record the model was given.
 */
function questionAnswerMessage(id: string, body: string, createdAt: number): AgentMessage {
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
    createdAt,
    completedAt: createdAt
  }
}

describe('RoutineAuthoringCheckpoints', () => {
  it('round-trips one checkpoint per routine and replaces it in place', async () => {
    const checkpoints = await testCheckpoints()
    expect(await checkpoints.read('routine-1')).toBeNull()

    await checkpoints.save('routine-1', '# Interview\n\n- Runs daily at 08:05')
    expect(await checkpoints.read('routine-1')).toContain('Runs daily at 08:05')

    await checkpoints.save('routine-1', '# Interview\n\n- Runs daily at 09:00')
    const updated = await checkpoints.read('routine-1')
    expect(updated).toContain('09:00')
    expect(updated).not.toContain('08:05')

    // One routine's checkpoint never leaks into another's.
    await checkpoints.save('routine-2', '# Interview\n\n- Different routine')
    expect(await checkpoints.read('routine-1')).toContain('09:00')
    expect(await checkpoints.read('routine-2')).toContain('Different routine')
  })

  it('clears a checkpoint without touching the others', async () => {
    const checkpoints = await testCheckpoints()
    await checkpoints.save('routine-1', '# Interview')
    await checkpoints.save('routine-2', '# Interview')

    await checkpoints.clear('routine-1')

    expect(await checkpoints.read('routine-1')).toBeNull()
    expect(await checkpoints.read('routine-2')).toBe('# Interview')
  })

  it('bounds the checkpoint and refuses an empty body or a traversal id', async () => {
    const checkpoints = await testCheckpoints()
    await expect(checkpoints.save('routine-1', '   ')).rejects.toThrow(/1-24000 characters/u)
    await expect(
      checkpoints.save('routine-1', 'x'.repeat(ROUTINE_AUTHORING_CHECKPOINT_LIMIT + 1))
    ).rejects.toThrow(/1-24000 characters/u)
    expect(() => checkpoints.path('../../escape')).toThrow(/Invalid routine id/u)
  })

  it('keeps the last write when two saves race', async () => {
    const checkpoints = await testCheckpoints()
    await Promise.all([
      checkpoints.save('routine-1', '# First'),
      checkpoints.save('routine-1', '# Second'),
      checkpoints.save('routine-1', '# Third')
    ])
    expect(await checkpoints.read('routine-1')).toBe('# Third')
  })
})

describe('formatInterviewDecisions', () => {
  it('reports every recorded answer in submission order', () => {
    const ledger = formatInterviewDecisions([
      questionAnswerMessage('question-answer-a', '1. When should it run?\n   - 08:05 daily', 1),
      questionAnswerMessage('question-answer-b', '1. Where does it go?\n   - In CodeInOven', 2)
    ])
    expect(ledger.indexOf('08:05 daily')).toBeLessThan(ledger.indexOf('In CodeInOven'))
  })

  it('keeps the newest answers when the character budget cannot hold them all', () => {
    const ledger = formatInterviewDecisions(
      [
        questionAnswerMessage('question-answer-a', 'oldest answer', 1),
        questionAnswerMessage('question-answer-b', 'newest answer', 2)
      ],
      'newest answer'.length
    )
    expect(ledger).toBe('newest answer')
  })
})

describe('routineAuthoringProgressContext', () => {
  it('carries the checkpoint and the resolved decisions as final', () => {
    const context = routineAuthoringProgressContext({
      checkpoint: '- Cadence: 08:05 daily',
      decisions: '1. Where does it go?\n   - In CodeInOven'
    })
    expect(context).toContain('- Cadence: 08:05 daily')
    expect(context).toContain('In CodeInOven')
    expect(context).toContain('never ask about one again')
    expect(context).toContain('do not re-offer their choices')
  })

  it('says nothing when the interview has neither state yet', () => {
    expect(routineAuthoringProgressContext({ checkpoint: null, decisions: '' })).toBe('')
  })
})

describe('routineAuthoringContext', () => {
  it('asks for the two priority brackets as two separate questions', () => {
    const contract = routineAuthoringContext('Slack latest info')
    expect(contract).toContain('two separate single-choice questions')
    expect(contract).toContain(ROUTINE_AUTHORING_UTILITY_ID)
    // The observed failure: one question carrying both brackets, answered as
    // eight selections that no turn could resolve back into brackets.
    expect(contract).toContain('a combined list produces an answer nobody can resolve')
  })

  it('finishes the connection setup before the recap and asks for credentials in the same turn', () => {
    const contract = routineAuthoringContext('Slack latest info')
    // The observed failure: the model installed Slack, hit a 401, and presented
    // the plan for confirmation instead of walking the user through the setup.
    expect(contract).toContain('patient and gentle')
    expect(contract).toContain('A connection that returns an authorization error is not set up')
    expect(contract).toContain(
      'Never present a plan as ready while a connection it depends on is unverified'
    )
    expect(contract).toContain('Walk the user through obtaining what only they can provide')
    expect(contract).toContain(
      'Ask for a credential the moment a connection needs one, in that same turn'
    )
    expect(contract).toContain('Never end a turn with a status report or a bare "not ready yet"')
    expect(contract).toContain('the connection actually works')
    expect(contract).toContain('cio_util_init')
    expect(contract).toContain('cio_util_docs_lookup')
  })
})
