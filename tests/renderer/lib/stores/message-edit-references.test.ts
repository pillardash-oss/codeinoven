// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromptReference } from '$shared/types'

vi.mock('$lib/ipc.svelte', () => ({
  invoke: vi.fn(async () => null),
  subscribe: () => () => undefined,
  subscribeGuarded: () => () => undefined
}))

import { threadMessages } from '$lib/stores/thread-messages.svelte'

const PROJECT = 'project-1'
const THREAD = 'thread-1'

function reference(id: string): PromptReference {
  return { id, label: 'Selection 1', text: 'the quoted passage', kind: 'selection' }
}

/**
 * Editing a message rewrites the prompt the agent receives, not only its words.
 *
 * A user message carries the selections, annotations and marks it was sent with.
 * The edit keeps the same row and resends it, so the row must still name them
 * afterwards: a resend that dropped them asked the agent a different question.
 */
describe('editing a message keeps its references', () => {
  beforeEach(() => {
    // A fresh row per test, under its own id, so nothing leaks between cases.
    threadMessages.stage(PROJECT, THREAD, `message-${Math.random()}`, 'original', [])
  })

  it('rewrites the row with the references the edit was sent with', () => {
    const messageId = 'message-1'
    threadMessages.stage(PROJECT, THREAD, messageId, 'original', [])
    threadMessages.beginEdit(PROJECT, THREAD, messageId, 'edited', [], [], [reference('ref-1')])

    const edited = threadMessages.messages(PROJECT, THREAD).find((m) => m.id === messageId)
    expect(edited?.references).toEqual([reference('ref-1')])
  })

  it('drops references when the edit carries none', () => {
    const messageId = 'message-2'
    threadMessages.stage(PROJECT, THREAD, messageId, 'original', [])
    threadMessages.beginEdit(PROJECT, THREAD, messageId, 'edited', [], [])

    const edited = threadMessages.messages(PROJECT, THREAD).find((m) => m.id === messageId)
    expect(edited?.references).toBeUndefined()
  })
})
