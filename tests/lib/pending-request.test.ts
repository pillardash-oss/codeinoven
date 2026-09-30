import { describe, expect, it } from 'vitest'
import {
  CONTINUATION_PROMPT_CHARACTER_LIMIT,
  CONTINUATION_REQUEST_PREAMBLE,
  continuationRequestPrompt,
  isContinuationRelayPrompt,
  pendingContinuationRequest
} from '../../src/lib/pending-request'
import type { AgentMessage, AgentPart, PromptAttachment } from '../../src/lib/types'

function message(id: string, role: 'user' | 'assistant', parts: AgentPart[]): AgentMessage {
  return { id, role, parts, createdAt: 1 }
}

function userText(id: string, text: string): AgentMessage {
  return message(id, 'user', [{ type: 'text', id: `${id}-text`, messageID: id, text }])
}

function assistantText(id: string, text: string): AgentMessage {
  return message(id, 'assistant', [{ type: 'text', id: `${id}-text`, messageID: id, text }])
}

function filePart(id: string, index: number): AgentPart {
  return {
    type: 'file',
    id: `${id}-file-${index}`,
    messageID: id,
    mime: 'image/png',
    url: `file:///Users/example/Pictures/screenshots/shot-${index}.png`,
    filename: `shot-${index}.png`
  }
}

const screenshot: PromptAttachment = {
  mime: 'image/png',
  url: 'file:///Users/example/Pictures/screenshots/shot-0.png',
  filename: 'shot-0.png'
}

/** A user message with prose and an attached screenshot. */
function userTextWithScreenshot(id: string, text: string): AgentMessage {
  const prose = userText(id, text)
  return { ...prose, parts: [...prose.parts, filePart(id, 0)] }
}

/** The app's own chip, e.g. a previous "Retry connection". */
function actionChip(id: string, action: string, body?: string, attachments = 0): AgentMessage {
  return message(id, 'user', [
    {
      type: 'user-presentation',
      id: `${id}-presentation`,
      messageID: id,
      presentation: { action, ...(body === undefined ? {} : { body }) }
    },
    ...Array.from({ length: attachments }, (_, index) => filePart(id, index))
  ])
}

function pendingText(messages: readonly AgentMessage[]): string | undefined {
  return pendingContinuationRequest(messages)?.text
}

describe('pendingContinuationRequest', () => {
  it('relays the request whose turn produced no answer', () => {
    const messages = [
      userText('user-1', 'Add a keymap for quitting the app'),
      message('assistant-1', 'assistant', [])
    ]
    expect(pendingText(messages)).toBe('Add a keymap for quitting the app')
  })

  it('carries the files the pending request attached', () => {
    const messages = [
      userTextWithScreenshot('user-1', 'Now see these "general tasks"'),
      message('assistant-1', 'assistant', [])
    ]
    expect(pendingContinuationRequest(messages)).toEqual({
      text: 'Now see these "general tasks"',
      attachments: [screenshot]
    })
  })

  it('relays an attachments-only request that carries no prose', () => {
    const messages = [
      message('user-1', 'user', [filePart('user-1', 0)]),
      message('assistant-1', 'assistant', [])
    ]
    expect(pendingContinuationRequest(messages)).toEqual({ text: '', attachments: [screenshot] })
  })

  it('relays nothing once the request has a visible answer', () => {
    const messages = [
      userText('user-1', 'Add a keymap for quitting the app'),
      assistantText('assistant-1', 'Done, the shortcut is bound.')
    ]
    expect(pendingContinuationRequest(messages)).toBeUndefined()
  })

  it('keeps the request pending when the turn only produced tool calls', () => {
    const messages = [
      userText('user-1', 'Add a keymap for quitting the app'),
      message('assistant-1', 'assistant', [
        {
          type: 'tool',
          id: 'assistant-1:tool',
          messageID: 'assistant-1',
          callID: 'call-1',
          tool: 'bash',
          state: { status: 'error', input: { command: 'ls' }, output: '' }
        }
      ])
    ]
    expect(pendingText(messages)).toBe('Add a keymap for quitting the app')
  })

  it('skips the retry chip that was continuing the request', () => {
    const messages = [
      userText('user-1', 'Add a keymap for quitting the app'),
      message('assistant-1', 'assistant', []),
      actionChip('chip-1', 'Retry connection'),
      message('assistant-2', 'assistant', [])
    ]
    expect(pendingText(messages)).toBe('Add a keymap for quitting the app')
  })

  it('reads the request behind a chip that relayed its files, on a second retry', () => {
    const messages = [
      userTextWithScreenshot('user-1', 'Add a keymap for quitting the app'),
      message('assistant-1', 'assistant', []),
      actionChip('chip-1', 'Retry connection', undefined, 1),
      message('assistant-2', 'assistant', [])
    ]
    expect(pendingContinuationRequest(messages)).toEqual({
      text: 'Add a keymap for quitting the app',
      attachments: [screenshot]
    })
  })

  it('relays the newest request when an older one was answered', () => {
    const messages = [
      userText('user-1', 'First question'),
      assistantText('assistant-1', 'First answer'),
      userText('user-2', 'Second question'),
      message('assistant-2', 'assistant', [])
    ]
    expect(pendingText(messages)).toBe('Second question')
  })

  it('ignores activity-only user messages riding mid-turn', () => {
    const messages = [
      userText('user-1', 'Add a keymap for quitting the app'),
      message('activity-1', 'user', [
        { type: 'compaction', id: 'activity-1:compaction', messageID: 'activity-1', auto: true }
      ])
    ]
    expect(pendingText(messages)).toBe('Add a keymap for quitting the app')
  })

  it('treats a chip the user authored as a request of its own', () => {
    const messages = [
      userText('user-1', 'Draft the plan'),
      assistantText('assistant-1', 'Here it is.'),
      actionChip('chip-1', 'Answered agent question', 'Which database?\nSQLite'),
      message('assistant-2', 'assistant', [])
    ]
    expect(pendingText(messages)).toBe('Answered agent question\n\nWhich database?\nSQLite')
  })

  it('does not count hidden orchestration output as an answer', () => {
    const hidden: AgentMessage = {
      ...assistantText('assistant-1', 'internal note'),
      visibility: 'hidden'
    }
    const messages = [userText('user-1', 'Add a keymap for quitting the app'), hidden]
    expect(pendingText(messages)).toBe('Add a keymap for quitting the app')
  })

  it('has no pending request on an empty conversation', () => {
    expect(pendingContinuationRequest([])).toBeUndefined()
  })

  it('relays nothing for an empty placeholder message', () => {
    const messages = [message('user-1', 'user', [])]
    expect(pendingContinuationRequest(messages)).toBeUndefined()
  })
})

describe('continuationRequestPrompt', () => {
  it('carries the request with the app nudge', () => {
    const prompt = continuationRequestPrompt({
      text: 'Add a keymap for quitting the app',
      attachments: []
    })
    expect(prompt).toBe(
      [CONTINUATION_REQUEST_PREAMBLE, 'Add a keymap for quitting the app', 'Continue'].join('\n\n')
    )
  })

  it('marks the relay a send path can recognize', () => {
    expect(
      isContinuationRelayPrompt(
        continuationRequestPrompt({ text: 'Add a keymap', attachments: [] })
      )
    ).toBe(true)
    expect(isContinuationRelayPrompt('Continue')).toBe(false)
    expect(isContinuationRelayPrompt('Retry connection')).toBe(false)
  })

  it('marks an attachments-only relay as a continuation too', () => {
    const prompt = continuationRequestPrompt({ text: '   ', attachments: [screenshot] })
    expect(prompt).toBe([CONTINUATION_REQUEST_PREAMBLE, 'Continue'].join('\n\n'))
    expect(isContinuationRelayPrompt(prompt)).toBe(true)
  })

  it('keeps a caller-supplied nudge', () => {
    const prompt = continuationRequestPrompt(
      { text: 'Add a keymap', attachments: [] },
      'Complete the approved spec.'
    )
    expect(prompt.endsWith('Complete the approved spec.')).toBe(true)
    expect(prompt).toContain('Add a keymap\n\nComplete the approved spec.')
  })

  it('sends the bare nudge when there is no request to relay', () => {
    expect(continuationRequestPrompt({ text: '   ', attachments: [] })).toBe('Continue')
  })

  it('never composes a prompt past the send path limit', () => {
    const prompt = continuationRequestPrompt(
      { text: 'x'.repeat(240_000), attachments: [] },
      'Continue'
    )
    expect(prompt.length).toBeLessThanOrEqual(CONTINUATION_PROMPT_CHARACTER_LIMIT)
    expect(prompt.startsWith(CONTINUATION_REQUEST_PREAMBLE)).toBe(true)
    expect(prompt.endsWith('\n\nContinue')).toBe(true)
    expect(prompt.endsWith('…\n\nContinue')).toBe(true)
  })
})
