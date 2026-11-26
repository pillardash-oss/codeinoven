import { describe, expect, it } from 'vitest'
import { partsToSearchText } from '../../../src/main/database/repositories/agent-message-repo'
import type { AgentPart } from '../../../src/lib/types'

/**
 * The search corpus is the words the conversation actually showed: the user's
 * request and the agent's own reply. Human search and the agent's
 * `search_threads` read this same text, so tool calls, results, reasoning and
 * sub-agent transcripts stay out of it by policy. Tool evidence is read through
 * `read_messages` instead, which returns it with the turn that produced it.
 */

function text(id: string, body: string): AgentPart {
  return { type: 'text', id, messageID: 'm', text: body }
}

describe('partsToSearchText', () => {
  it('keeps what the conversation said', () => {
    expect(partsToSearchText([text('p1', 'Fix the checkout retry')])).toBe('Fix the checkout retry')
  })

  it('keeps the answer a question card recorded', () => {
    const part: AgentPart = {
      type: 'question',
      id: 'p2',
      messageID: 'm',
      question: { prompt: 'Which branch?', answer: 'release/2.4', options: [] }
    }
    expect(partsToSearchText([part])).toContain('Which branch?')
    expect(partsToSearchText([part])).toContain('release/2.4')
  })

  it('keeps the body of an app presentation', () => {
    const part: AgentPart = {
      type: 'user-presentation',
      id: 'p3',
      messageID: 'm',
      presentation: { action: 'Answered agent question', body: 'Use the release branch' }
    }
    expect(partsToSearchText([part])).toContain('Use the release branch')
  })

  it('leaves reasoning out of the index', () => {
    const reasoning: AgentPart = {
      type: 'reasoning',
      id: 'p4',
      messageID: 'm',
      text: 'Internal plan nobody was shown',
      time: {}
    }
    expect(partsToSearchText([reasoning])).toBe('')
    expect(partsToSearchText([text('p5', 'The answer'), reasoning])).toBe('The answer')
  })

  it('leaves tool calls and their output out of the index', () => {
    const tool: AgentPart = {
      type: 'tool',
      id: 'p6',
      messageID: 'm',
      callID: 'call-1',
      tool: 'bash',
      state: {
        status: 'completed',
        input: { command: 'bun test' },
        output: 'this command output is not searchable',
        time: { start: 1, end: 2 }
      }
    }
    expect(partsToSearchText([tool])).toBe('')
  })

  it('leaves sub-agent transcripts out of the index', () => {
    const subagent = {
      type: 'subagent',
      id: 'p7',
      messageID: 'm',
      activity: {
        id: 'a1',
        description: 'Sweep the callers',
        prompt: 'Look at every caller of retry()',
        output: 'Found three callers'
      }
    } as unknown as AgentPart
    expect(partsToSearchText([subagent])).toBe('')
  })
})
