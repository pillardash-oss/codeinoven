import { describe, expect, it } from 'vitest'
import type { AgentMessage, AgentPart, AgentSubagentActivity } from '../../src/lib/types'
import {
  HANDED_OFF_WORKER_LIMIT,
  boundedWorkerRoster,
  handedOffWorkersNote,
  runningWorkers,
  type HandedOffWorker
} from '../../src/main/chat/thread-transfer-service/thread-transfer-workers'

/**
 * The roster a thread carries across a hand-off, and the note built from it.
 *
 * Two behaviours matter here and only these two: the roster must carry what a
 * resume needs (the session file above all, because that is the only handle the
 * adopting instance can open), and the note must never call a worker stopped
 * when the move actually continued it.
 */

function workerCard(
  agentId: string,
  activity: Partial<AgentSubagentActivity> & Pick<AgentSubagentActivity, 'status'>
): AgentPart {
  return {
    type: 'subagent',
    id: `part-${agentId}`,
    messageID: `message-${agentId}`,
    callID: agentId,
    activity: {
      agent: 'implementation',
      description: 'Delegated task',
      background: false,
      ...activity
    }
  }
}

function messageWith(...parts: AgentPart[]): AgentMessage {
  return { id: 'assistant-message', role: 'assistant', parts, createdAt: 1 }
}

function nestedWorker(agentId: string, sessionFile?: string): HandedOffWorker {
  return {
    agentId,
    label: `task ${agentId}`,
    kind: 'nested',
    ...(sessionFile ? { sessionFile } : {})
  }
}

describe('runningWorkers', () => {
  it('carries the session file, model, effort and prompt of a running card', () => {
    const workers = runningWorkers([
      messageWith(
        workerCard('agent-1', {
          status: 'running',
          prompt: 'Move the transfer hand-off to its own module.',
          modelId: 'anthropic/claude-sonnet-4-5',
          thinkingLevel: 'high',
          sessionFile: '/tmp/sessions/worker-1.jsonl'
        })
      )
    ])

    expect(workers).toEqual([
      {
        agentId: 'agent-1',
        label: 'implementation',
        kind: 'nested',
        sessionFile: '/tmp/sessions/worker-1.jsonl',
        modelId: 'anthropic/claude-sonnet-4-5',
        thinkingLevel: 'high',
        prompt: 'Move the transfer hand-off to its own module.'
      }
    ])
  })

  it('reads the child session id as the id when the call has no id of its own', () => {
    const part: AgentPart = {
      type: 'subagent',
      id: 'part-agent-2',
      messageID: 'message-agent-2',
      activity: {
        status: 'running',
        agent: 'implementation',
        description: 'Delegated task',
        background: false,
        childSessionId: 'child-session-2',
        sessionFile: '/tmp/sessions/worker-2.jsonl'
      }
    }
    const workers = runningWorkers([messageWith(part)])

    expect(workers.map((worker) => worker.agentId)).toEqual(['child-session-2'])
  })

  it('ignores cards that had already reported before the move', () => {
    const workers = runningWorkers([
      messageWith(
        workerCard('done', { status: 'completed', sessionFile: '/tmp/sessions/done.jsonl' }),
        workerCard('failed', { status: 'error', sessionFile: '/tmp/sessions/failed.jsonl' }),
        workerCard('stopped', { status: 'aborted', sessionFile: '/tmp/sessions/stopped.jsonl' }),
        workerCard('live', { status: 'running', sessionFile: '/tmp/sessions/live.jsonl' })
      )
    ])

    expect(workers.map((worker) => worker.agentId)).toEqual(['live'])
  })

  it('marks a card that names a pawn as a pawn, with no session file to resume', () => {
    const workers = runningWorkers([
      messageWith(workerCard('pawn-1', { status: 'running', pawn: true }))
    ])

    expect(workers).toEqual([{ agentId: 'pawn-1', label: 'implementation', kind: 'pawn' }])
  })
})

describe('handedOffWorkersNote', () => {
  it('names a worker with a session file as continuing and never asks for a re-spawn', () => {
    const note = handedOffWorkersNote([nestedWorker('agent-1', '/tmp/sessions/worker-1.jsonl')], {
      pawnsResumed: false
    })

    expect(note).toContain('1 nested worker came with it')
    expect(note).toContain('still running here')
    expect(note).toContain('- task agent-1 (agent-1)')
    expect(note).toContain('cio_agent_status')
    expect(note).toContain('cio_agent_output')
    expect(note).toContain('Do not spawn it again.')
    expect(note).not.toContain('cio_spawn_agent')
    expect(note).not.toContain('re-spawn')
    expect(note).not.toContain('not a failure of their work')
  })

  it('names a worker with no session file and an un-resumed pawn as stopped', () => {
    const note = handedOffWorkersNote(
      [nestedWorker('agent-1'), { agentId: 'pawn-1', label: 'task pawn-1', kind: 'pawn' }],
      { pawnsResumed: false }
    )

    expect(note).toContain('The move stopped 2 workers that could not come along')
    expect(note).toContain('that is not a failure of their work')
    expect(note).toContain('- task agent-1 (agent-1)')
    expect(note).toContain('- task pawn-1 (pawn-1)')
    expect(note).toContain('cio_spawn_agent')
    expect(note).toContain('Do not report these workers as failed.')
    expect(note).not.toContain('still running here')
  })

  it('leaves a resumed pawn out of the note entirely', () => {
    const note = handedOffWorkersNote([{ agentId: 'pawn-1', label: 'task pawn-1', kind: 'pawn' }], {
      pawnsResumed: true
    })

    expect(note).toBe('')
  })

  it('says both what came along and what the same move stopped', () => {
    const note = handedOffWorkersNote(
      [
        nestedWorker('agent-1', '/tmp/sessions/worker-1.jsonl'),
        nestedWorker('agent-2', '/tmp/sessions/worker-2.jsonl'),
        nestedWorker('agent-3')
      ],
      { pawnsResumed: false }
    )

    expect(note).toContain('2 nested workers came with it')
    expect(note).toContain('Do not spawn these workers again.')
    expect(note).toContain('The same move stopped 1 worker that could not come along')
    expect(note).toContain('- task agent-1 (agent-1)')
    expect(note).toContain('- task agent-3 (agent-3)')
  })

  it('summarizes the tail once a block exceeds the roster limit', () => {
    const workers = Array.from({ length: HANDED_OFF_WORKER_LIMIT + 3 }, (_unused, index) =>
      nestedWorker(`agent-${index}`)
    )
    const note = handedOffWorkersNote(workers, { pawnsResumed: false })
    const { named, omitted } = boundedWorkerRoster(workers)

    expect(omitted).toBe(3)
    expect(named).toHaveLength(HANDED_OFF_WORKER_LIMIT)
    expect(note).toContain('- and 3 more')
    expect(note).toContain(`(${workers[HANDED_OFF_WORKER_LIMIT - 1]?.agentId})`)
    expect(note).not.toContain(`(${workers[HANDED_OFF_WORKER_LIMIT]?.agentId})`)
  })
})
