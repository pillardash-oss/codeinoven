import { beforeEach, describe, expect, it } from 'vitest'

import { ThreadMessagesCache } from '$lib/stores/thread-messages-cache.svelte'
import type { AgentMessage } from '$shared/types'

const PROJECT = 'p1'
const THREAD = 't1'

/** A transcript row, shaped the way the cache stores one. */
function message(id: string, overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id,
    role: 'user',
    origin: 'user',
    visibility: 'conversation',
    parts: [{ type: 'text', id: `${id}-text`, messageID: id, text: id }],
    createdAt: 1_000,
    completedAt: 1_000,
    ...overrides
  }
}

function seed(cache: ThreadMessagesCache, messages: AgentMessage[]): void {
  cache.reconcile(PROJECT, THREAD, messages, null)
}

function ids(cache: ThreadMessagesCache): string[] {
  return cache.messages(PROJECT, THREAD).map((entry) => entry.id)
}

describe('ThreadMessagesCache.applyEdit', () => {
  let cache: ThreadMessagesCache

  beforeEach(() => {
    cache = new ThreadMessagesCache()
  })

  it('rewrites the edited message in place and drops the history below it', () => {
    seed(cache, [
      message('m1'),
      message('m2'),
      message('m3', { role: 'assistant', origin: 'assistant' }),
      message('m4')
    ])

    const edited = cache.applyEdit(PROJECT, THREAD, 'm2', (current) => ({
      ...current,
      parts: [{ type: 'text', id: 'm2-text', messageID: 'm2', text: 'rewritten' }]
    }))

    expect(edited?.id).toBe('m2')
    expect(ids(cache)).toEqual(['m1', 'm2'])
    const textPart = cache.messages(PROJECT, THREAD)[1]?.parts[0]
    expect(textPart?.type === 'text' ? textPart.text : null).toBe('rewritten')
  })

  it('keeps the identity of the edited row so its bubble is never remounted', () => {
    seed(cache, [message('m1', { createdAt: 500 }), message('m2', { createdAt: 900 })])

    const edited = cache.applyEdit(PROJECT, THREAD, 'm2', (current) => current)

    expect(edited?.createdAt).toBe(900)
    expect(cache.messages(PROJECT, THREAD)[1]?.createdAt).toBe(900)
  })

  it('leaves the transcript untouched when the message is not cached', () => {
    seed(cache, [message('m1')])

    expect(cache.applyEdit(PROJECT, THREAD, 'missing', (current) => current)).toBeNull()
    expect(ids(cache)).toEqual(['m1'])
  })
})

describe('ThreadMessagesCache.applyRemoval', () => {
  let cache: ThreadMessagesCache

  beforeEach(() => {
    cache = new ThreadMessagesCache()
  })

  it('drops the removed span', () => {
    seed(cache, [message('m1'), message('m2'), message('m3')])

    cache.applyRemoval(PROJECT, THREAD, [message('m1')])

    expect(ids(cache)).toEqual(['m1'])
  })

  it('keeps the message an edit rewrote at the end of the kept prefix', () => {
    seed(cache, [message('m1'), message('m2'), message('m3')])
    const edited = message('m2', {
      parts: [{ type: 'text', id: 'm2-text', messageID: 'm2', text: 'new words' }]
    })

    cache.applyRemoval(PROJECT, THREAD, [message('m1')], edited)

    expect(ids(cache)).toEqual(['m1', 'm2'])
    const textPart = cache.messages(PROJECT, THREAD)[1]?.parts[0]
    expect(textPart?.type === 'text' ? textPart.text : null).toBe('new words')
  })

  it('never duplicates a kept message the removal already contains', () => {
    seed(cache, [message('m1'), message('m2')])

    cache.applyRemoval(PROJECT, THREAD, [message('m1'), message('m2')], message('m2'))

    expect(ids(cache)).toEqual(['m1', 'm2'])
  })
})

describe('ThreadMessagesCache.latestUserMessageId', () => {
  let cache: ThreadMessagesCache

  beforeEach(() => {
    cache = new ThreadMessagesCache()
  })

  it('anchors a run to the prompt that opened its turn', () => {
    seed(cache, [message('m1'), message('m2', { role: 'assistant', origin: 'assistant' })])

    expect(cache.latestUserMessageId(PROJECT, THREAD)).toBe('m1')
  })

  it('skips rows written into the running turn, so streaming never looks like a new turn', () => {
    // An app continuation prompt and a transparent steer both ride the turn
    // they arrived under. Counting one as the turn's prompt made the next
    // streamed part read as a brand-new turn, and a new turn resets the working
    // trace's fold: the trace the reader had just opened closed under them.
    seed(cache, [
      message('m1'),
      message('m2', { origin: 'orchestrator' }),
      message('m3', { turnTransparent: true })
    ])

    expect(cache.latestUserMessageId(PROJECT, THREAD)).toBe('m1')
  })
})
