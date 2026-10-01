import { describe, expect, it } from 'vitest'
import type { TypesafeAnswerMap } from '../../src/lib/types'
import {
  memorySpanCandidates,
  readMemoryDecision
} from '../../src/main/chat/memory/memory-decision'

const RULE_MESSAGE = 'Never use checkbox inputs in this project going forward.'
const spans = memorySpanCandidates(RULE_MESSAGE)
const allowedScopes = ['project'] as const

function answers(input: {
  lasting: number
  taskOnly: number
  repeated: number
  spanConfidence?: number
  spanChoice?: string
}): TypesafeAnswerMap {
  return {
    lasting_intent: { type: 'noul', noul: input.lasting },
    current_task_only: { type: 'noul', noul: input.taskOnly },
    repeated_request: { type: 'noul', noul: input.repeated },
    rule_span: {
      type: 'choice',
      choice: input.spanChoice ?? 's0',
      probabilities: { s0: input.spanConfidence ?? 0.9 },
      confidence: input.spanConfidence ?? 0.9
    },
    category: {
      type: 'choice',
      choice: 'behavioral',
      probabilities: { behavioral: 0.9 },
      confidence: 0.9
    },
    priority: {
      type: 'choice',
      choice: 'high',
      probabilities: { high: 0.9 },
      confidence: 0.9
    },
    scope: { type: 'choice', choice: 'project', probabilities: { project: 0.9 }, confidence: 0.9 }
  }
}

describe('readMemoryDecision', () => {
  it('never proposes when the turn states nothing lasting, even if it is not a repeat', () => {
    // A first-time feature request: nothing lasting, ambiguous current-task, and
    // clearly not a repeat. The inverse of `repeated_request` alone used to be
    // enough to average the turn over the durability floor.
    const proposal = readMemoryDecision({
      answers: answers({ lasting: 0.19, taskOnly: 0.46, repeated: 0.18, spanConfidence: 0.9 }),
      spans,
      allowedScopes,
      defaultScope: 'project'
    })
    expect(proposal.propose).toBe(false)
  })

  it('proposes a genuine standing rule copied verbatim from the user message', () => {
    const proposal = readMemoryDecision({
      answers: answers({ lasting: 0.92, taskOnly: 0.05, repeated: 0.02, spanConfidence: 0.9 }),
      spans,
      allowedScopes,
      defaultScope: 'project'
    })
    expect(proposal.propose).toBe(true)
    expect(proposal.content).toBe(RULE_MESSAGE)
    expect(proposal.scope).toBe('project')
  })

  it('still requires the span choice to clear its own confidence floor', () => {
    const proposal = readMemoryDecision({
      answers: answers({ lasting: 0.9, taskOnly: 0.1, repeated: 0.1, spanConfidence: 0.3 }),
      spans,
      allowedScopes,
      defaultScope: 'project'
    })
    expect(proposal.propose).toBe(false)
  })
})
