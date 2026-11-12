import { describe, expect, it } from 'vitest'
import {
  conversationAnswerText,
  conversationProseText,
  type ConversationTextScope
} from '../../src/renderer/lib/components/threads/conversation-text'

const group: ConversationTextScope = {
  assistantMode: false,
  groupThread: true,
  authoringThread: false
}
const assistant: ConversationTextScope = {
  assistantMode: true,
  groupThread: false,
  authoringThread: false
}
const project: ConversationTextScope = {
  assistantMode: false,
  groupThread: false,
  authoringThread: false
}

const wire = 'Drafting.\n\n<assistant_result>Sent it to Ola again.</assistant_result>'

describe('conversation text', () => {
  it('reads a group reply as its marked update', () => {
    expect(conversationAnswerText(group, wire)).toBe('Sent it to Ola again.')
  })
  it('keeps a streaming answer silent until the boundary opens', () => {
    expect(conversationAnswerText(group, 'Sent it to Ola', true)).toBe('')
    expect(conversationAnswerText(group, '<assistant_result>Sent it', true)).toBe('Sent it')
  })
  it('never shows the boundary in a project thread either', () => {
    expect(conversationAnswerText(project, '<assistant_result>Done.</assistant_result>')).toBe(
      'Done.'
    )
    expect(conversationAnswerText(project, 'Plain answer.')).toBe('Plain answer.')
  })
  it('draws the live prose through the same rule, and empty before the result opens', () => {
    // The line under the transcript used to receive the run's raw text, which is
    // how `<assistant_result>` reached the reader while the turn was working.
    expect(conversationProseText(group, '<assistant_result>Sent it to Ola again.')).toBe(
      'Sent it to Ola again.'
    )
    expect(conversationProseText(group, 'Working on it.')).toBe('')
    expect(conversationProseText(assistant, '<assistant_result>Sent it.')).toBe('Sent it.')
    expect(conversationProseText(project, 'Working on it.')).toBe('Working on it.')
  })
})
