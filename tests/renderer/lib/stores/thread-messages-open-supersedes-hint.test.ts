// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '$shared/types'

/**
 * An open is a decision and a hover is intent, so they must not share a read.
 *
 * The hover preload asks for four messages. The open asks for its aligned
 * window. When the open arrived while the hint was still in flight it joined
 * the hint's promise and was answered with those four messages: the open read
 * nothing, painted a tail it had not chosen, and the reader saw a conversation
 * four rows deep. These lock the rule that made it happen — an in-flight hint
 * never satisfies an open — so the alignment walk cannot be skipped again by a
 * pointer that happened to cross the row first.
 */

const HINT_WINDOW = 4
const OPEN_WINDOW = 12

function message(index: number, role: 'user' | 'assistant'): AgentMessage {
  const id = `${role}-${index}`
  return {
    id,
    role,
    origin: role === 'user' ? 'user' : 'assistant',
    visibility: 'conversation',
    parts: [{ type: 'text', id: `${id}-text`, messageID: id, text: `${role} ${index}` }],
    createdAt: index,
    completedAt: index
  }
}

/** A page whose oldest row is the prompt that opens the newest turn, so the
 *  alignment walk stops after the first read. */
function page(count: number): AgentMessage[] {
  return Array.from({ length: count }, (_, index) =>
    message(index, index % 2 === 0 ? 'user' : 'assistant')
  )
}

/** Releases the suspended hint read once the open has asked for its window. */
const hintGates: Array<() => void> = []

const invoke = vi.fn(async (channel: string, ..._args: unknown[]) => {
  if (channel !== 'thread:loadMessages') return null
  const [, , , limit] = _args as [string, string, unknown, number | undefined]
  if (limit === HINT_WINDOW) {
    // The hint stays in flight until the open has asked, which is the race.
    await new Promise<void>((resolve) => {
      hintGates.push(resolve)
    })
    return { messages: page(HINT_WINDOW), hasOlder: false, kind: 'window' }
  }
  return { messages: page(OPEN_WINDOW), hasOlder: false, kind: 'window' }
})

vi.mock('$lib/ipc.svelte', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/ipc.svelte')>()
  return {
    ...actual,
    invoke: (...args: unknown[]) => invoke(...(args as [string, ...unknown[]])),
    subscribe: () => () => {},
    subscribeGuarded: () => () => {}
  }
})

vi.mock('$lib/stores/app-errors.svelte', () => ({ showToastError: () => undefined }))

const { threadMessages } = await import('$lib/stores/thread-messages.svelte')

describe('opening a thread while its hover hint is in flight', () => {
  it('reads the open window instead of accepting the hint page', async () => {
    const projectId = 'project-1'
    const threadId = 'thread-1'
    hintGates.length = 0

    const hint = threadMessages.preload(projectId, threadId)
    // The open lands while the hint is still in flight.
    const open = threadMessages.load(projectId, threadId, OPEN_WINDOW)

    await vi.waitFor(() => expect(hintGates.length).toBeGreaterThan(0))
    hintGates[0]?.()
    await Promise.all([hint, open])

    expect(threadMessages.messages(projectId, threadId)).toHaveLength(OPEN_WINDOW)
  })
})
