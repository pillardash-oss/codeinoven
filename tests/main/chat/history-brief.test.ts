import { describe, expect, it } from 'vitest'
import { formatHistoryBrief } from '../../../src/main/chat/chat-engine/chat-engine-message-text'
import type { AgentMessage, AgentPart } from '../../../src/lib/types'

/**
 * A rebuilt session (fork, account switch, harness switch, edited history) is
 * handed a short recap plus the thread id, never a replay of the conversation.
 * These lock in what the recap must name (the thread, what was asked, how the
 * last turn ended, what was done) and how small it stays on a long thread.
 */

function userMessage(id: string, text: string, createdAt: number): AgentMessage {
  return {
    id,
    role: 'user',
    origin: 'user',
    visibility: 'conversation',
    parts: [{ type: 'text', id: `${id}-text`, messageID: id, text }],
    createdAt
  }
}

function assistantMessage(
  id: string,
  parts: AgentPart[],
  createdAt: number,
  visibility: AgentMessage['visibility'] = 'conversation'
): AgentMessage {
  return { id, role: 'assistant', origin: 'provider', visibility, parts, createdAt }
}

function textPart(id: string, text: string): AgentPart {
  return { type: 'text', id: `${id}-text`, messageID: id, text }
}

function reasoningPart(id: string, text: string): AgentPart {
  return { type: 'reasoning', id: `${id}-reasoning`, messageID: id, text, time: {} }
}

function toolPart(
  id: string,
  tool: string,
  input: Record<string, unknown>,
  status: 'completed' | 'error',
  output: string
): AgentPart {
  return {
    type: 'tool',
    id: `${id}-tool`,
    messageID: id,
    callID: `${id}-call`,
    tool,
    state:
      status === 'error'
        ? { status, input, error: output, time: { start: 1, end: 2 } }
        : { status, input, output, time: { start: 1, end: 2 } }
  }
}

describe('formatHistoryBrief', () => {
  it('opens with the thread id and where the full history lives', () => {
    const brief = formatHistoryBrief([userMessage('m1', 'Fix the checkout button', 1000)], {
      threadId: 'thread-abc',
      threadTitle: 'Checkout button',
      maxInputTokens: 4000
    })
    expect(brief).toContain('Resuming thread thread-abc ("Checkout button")')
    expect(brief).toContain('in the app database under that thread id')
    expect(brief).toContain('cio_util_diagnose')
    expect(brief).toContain("End of the recap. The user's actual request follows.")
  })

  it('lists the requests it kept with their message ids, oldest first', () => {
    const messages = Array.from({ length: 15 }, (_, index) =>
      userMessage(`m${index}`, `Request number ${index}`, 1000 + index)
    )
    const brief = formatHistoryBrief(messages, { threadId: 'thread-abc', maxInputTokens: 4000 })
    const omittedLine = brief.indexOf('earlier requests not listed here')
    expect(omittedLine).toBeGreaterThan(-1)
    // The newest twelve are listed, the oldest three are not.
    expect(brief).not.toContain('Request number 2:')
    expect(brief).toContain('Request number 3')
    expect(brief).toContain('m14: Request number 14')
    expect(brief.indexOf('m3: Request number 3')).toBeLessThan(
      brief.indexOf('m14: Request number 14')
    )
  })

  it('reports how the last turn ended from the assistant text, never its reasoning', () => {
    const brief = formatHistoryBrief(
      [
        userMessage('m1', 'Add the retry', 1000),
        assistantMessage(
          'a1',
          [
            reasoningPart('a1', 'Internal plan that must not leak into the recap'),
            textPart('a1', 'Wired the retry into the fetch path.')
          ],
          2000
        ),
        userMessage('m2', 'Now make it exponential', 3000)
      ],
      { threadId: 'thread-abc', maxInputTokens: 4000 }
    )
    expect(brief).toContain('Where the last turn left off:')
    expect(brief).toContain('Wired the retry into the fetch path.')
    expect(brief).not.toContain('Internal plan')
  })

  it('names what was done without replaying tool output', () => {
    const hugeOutput = 'x'.repeat(40_000)
    const brief = formatHistoryBrief(
      [
        userMessage('m1', 'Add the retry', 1000),
        assistantMessage(
          'a1',
          [
            toolPart('a1', 'bash', { command: 'bun test' }, 'completed', hugeOutput),
            toolPart('a1', 'edit', { file_path: 'src/retry.ts' }, 'error', 'write failed')
          ],
          2000
        )
      ],
      { threadId: 'thread-abc', maxInputTokens: 4000 }
    )
    expect(brief).toContain('What was done, oldest first:')
    expect(brief).toContain('ran a shell command: bun test')
    expect(brief).toContain('edited a file: src/retry.ts (failed)')
    expect(brief).not.toContain('xxxxxxxxxx')
  })

  it('stays short on a long thread', () => {
    const messages: AgentMessage[] = []
    for (let index = 0; index < 400; index += 1) {
      messages.push(
        userMessage(`u${index}`, `Request number ${index} with some detail`, index * 10)
      )
      messages.push(
        assistantMessage(
          `a${index}`,
          [
            toolPart(`a${index}`, 'bash', { command: `bun run step-${index}` }, 'completed', 'ok'),
            textPart(`a${index}`, `Finished step ${index}.`)
          ],
          index * 10 + 1
        )
      )
    }
    const brief = formatHistoryBrief(messages, { threadId: 'thread-abc', maxInputTokens: 4000 })
    // A short recap, not a transcript: a 400-turn thread still costs about a
    // thousand tokens instead of a window.
    expect(brief.length).toBeLessThan(12_000)
    expect(brief.split('\n').length).toBeLessThan(60)
  })

  it('leaves out orchestration and sub-agent turns from the request list', () => {
    const hidden = {
      ...userMessage('h1', 'INTERNAL orchestration instruction', 1000),
      visibility: 'hidden' as const
    }
    const brief = formatHistoryBrief(
      [
        hidden,
        userMessage('u1', 'The real request', 2000),
        assistantMessage(
          's1',
          [textPart('s1', 'A sub-agent finished its task')],
          3000,
          'subagent_trace'
        )
      ],
      { threadId: 'thread-abc', maxInputTokens: 4000 }
    )
    expect(brief).toContain('The real request')
    expect(brief).not.toContain('INTERNAL orchestration instruction')
    expect(brief).not.toContain('A sub-agent finished its task')
  })

  it('keeps the pointer when the recap has to be cut to fit the budget', () => {
    const messages = Array.from({ length: 12 }, (_, index) =>
      userMessage(`m${index}`, `Request number ${index}`, 1000 + index)
    )
    const brief = formatHistoryBrief(messages, { threadId: 'thread-abc', maxInputTokens: 1 })
    expect(brief).toContain('Resuming thread thread-abc')
    expect(brief).toContain('cut to fit the input budget')
    expect(brief).toContain('cio_util_diagnose')
    expect(brief).not.toContain('Request number 11')
  })

  it('names the thread checkpoints so the agent knows older windows exist', () => {
    const brief = formatHistoryBrief([userMessage('m1', 'Carry on', 1000)], {
      threadId: 'thread-abc',
      maxInputTokens: 4000,
      checkpoints: [
        {
          id: 'cp-2',
          threadId: 'thread-abc',
          sequence: 2,
          kind: 'auto',
          harnessId: 'pi',
          sessionId: 's2',
          projectPath: 'project',
          tokensBefore: 180_000,
          contextWindow: 200_000,
          createdAt: 2000,
          closedAt: 2100
        },
        {
          id: 'cp-1',
          threadId: 'thread-abc',
          sequence: 1,
          kind: 'harness-switch',
          harnessId: 'codex',
          sessionId: 's1',
          projectPath: 'project',
          createdAt: 1000,
          closedAt: 1100
        }
      ]
    })
    expect(brief).toContain('The windows this thread has already worked through')
    // Oldest first, so the agent reads them in the order the work happened.
    expect(brief.indexOf('cp-1')).toBeLessThan(brief.indexOf('cp-2'))
    expect(brief).toContain('#1 harness-switch')
    expect(brief).toContain('checkpoint_id')
  })

  it('renders nothing when there is no history to recap', () => {
    expect(formatHistoryBrief([], { threadId: 'thread-abc', maxInputTokens: 4000 })).toBe('')
  })
})
