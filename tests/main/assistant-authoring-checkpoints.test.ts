import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { StorageEngine } from '../../src/main/storage/storage-engine'
import { AssistantAuthoringCheckpoints } from '../../src/main/chat/assistant-authoring-checkpoints'
import {
  ASSISTANT_AUTHORING_CHECKPOINT_LIMIT,
  ASSISTANT_AUTHORING_UTILITY_ID,
  assistantAuthoringContext,
  assistantAuthoringProgressContext
} from '../../src/lib/assistant-authoring'
import { formatInterviewDecisions } from '../../src/main/chat/chat-engine/chat-engine-message-text'
import type { AgentMessage } from '../../src/lib/types'

/**
 * An assistant's Getting started conversation is an interview, and these lock in
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

async function testCheckpoints(): Promise<AssistantAuthoringCheckpoints> {
  const root = await temporaryDirectory('codeinoven-assistant-checkpoints-')
  const storage = new StorageEngine(root)
  await storage.initialize()
  return new AssistantAuthoringCheckpoints(storage)
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

describe('AssistantAuthoringCheckpoints', () => {
  it('round-trips one checkpoint per assistant and replaces it in place', async () => {
    const checkpoints = await testCheckpoints()
    expect(await checkpoints.read('assistant-1')).toBeNull()

    await checkpoints.save('assistant-1', '# Interview\n\n- Runs daily at 08:05')
    expect(await checkpoints.read('assistant-1')).toContain('Runs daily at 08:05')

    await checkpoints.save('assistant-1', '# Interview\n\n- Runs daily at 09:00')
    const updated = await checkpoints.read('assistant-1')
    expect(updated).toContain('09:00')
    expect(updated).not.toContain('08:05')

    // One assistant's checkpoint never leaks into another's.
    await checkpoints.save('assistant-2', '# Interview\n\n- Different assistant')
    expect(await checkpoints.read('assistant-1')).toContain('09:00')
    expect(await checkpoints.read('assistant-2')).toContain('Different assistant')
  })

  it('clears a checkpoint without touching the others', async () => {
    const checkpoints = await testCheckpoints()
    await checkpoints.save('assistant-1', '# Interview')
    await checkpoints.save('assistant-2', '# Interview')

    await checkpoints.clear('assistant-1')

    expect(await checkpoints.read('assistant-1')).toBeNull()
    expect(await checkpoints.read('assistant-2')).toBe('# Interview')
  })

  it('bounds the checkpoint and refuses an empty body or a traversal id', async () => {
    const checkpoints = await testCheckpoints()
    await expect(checkpoints.save('assistant-1', '   ')).rejects.toThrow(/1-24000 characters/u)
    await expect(
      checkpoints.save('assistant-1', 'x'.repeat(ASSISTANT_AUTHORING_CHECKPOINT_LIMIT + 1))
    ).rejects.toThrow(/1-24000 characters/u)
    expect(() => checkpoints.path('../../escape')).toThrow(/Invalid assistant id/u)
  })

  it('keeps the last write when two saves race', async () => {
    const checkpoints = await testCheckpoints()
    await Promise.all([
      checkpoints.save('assistant-1', '# First'),
      checkpoints.save('assistant-1', '# Second'),
      checkpoints.save('assistant-1', '# Third')
    ])
    expect(await checkpoints.read('assistant-1')).toBe('# Third')
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

describe('assistantAuthoringProgressContext', () => {
  it('carries the checkpoint and the resolved decisions as final', () => {
    const context = assistantAuthoringProgressContext({
      checkpoint: '- Cadence: 08:05 daily',
      decisions: '1. Where does it go?\n   - In CodeInOven'
    })
    expect(context).toContain('- Cadence: 08:05 daily')
    expect(context).toContain('In CodeInOven')
    expect(context).toContain('never ask about one again')
    expect(context).toContain('do not re-offer their choices')
  })

  it('says nothing when the interview has neither state yet', () => {
    expect(assistantAuthoringProgressContext({ checkpoint: null, decisions: '' })).toBe('')
  })
})

describe('assistantAuthoringContext', () => {
  it('asks for the two priority brackets as two separate questions', () => {
    const contract = assistantAuthoringContext({ name: 'Slack latest info', scheduled: true })
    expect(contract).toContain('two separate single-choice questions')
    expect(contract).toContain(ASSISTANT_AUTHORING_UTILITY_ID)
    // The observed failure: one question carrying both brackets, answered as
    // eight selections that no turn could resolve back into brackets.
    expect(contract).toContain('a combined list produces an answer nobody can resolve')
  })

  it('finishes the connection setup before the recap and asks for credentials in the same turn', () => {
    const contract = assistantAuthoringContext({ name: 'Slack latest info', scheduled: true })
    // The observed failure: the model installed Slack, hit a 401, and presented
    // the plan for confirmation instead of walking the user through the setup.
    expect(contract).toContain('never make them feel behind for not already knowing')
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

  it('does not ask again for a name and personality the user already gave', () => {
    const settled = assistantAuthoringContext({
      name: 'Engineer',
      scheduled: false,
      personality: 'blunt and quick'
    })
    expect(settled).not.toContain('Ask what they would like to name you')
    expect(settled).toContain('are already settled')
    expect(settled).toContain('blunt and quick')

    // A create-by-chat assistant has no name yet, so the interview still opens
    // on the naming question.
    const unnamed = assistantAuthoringContext({ name: 'New assistant', scheduled: false })
    expect(unnamed).toContain('Ask what they would like to name you')
  })

  it('heads up the next-steps list that fits how the assistant runs', () => {
    expect(assistantAuthoringContext({ name: 'Digest', scheduled: true })).toContain(
      'lead with adding fallback models'
    )
    const onDemand = assistantAuthoringContext({ name: 'Digest', scheduled: false })
    expect(onDemand).toContain('lead with how to start a task')
    expect(onDemand).toContain('Cmd/Ctrl+N')
    expect(onDemand).not.toContain('fallback models')
  })
})
