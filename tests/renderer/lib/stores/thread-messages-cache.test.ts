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

describe('ThreadMessagesCache bounds', () => {
  let cache: ThreadMessagesCache

  beforeEach(() => {
    cache = new ThreadMessagesCache()
  })

  it('keeps at most the cached-thread cap of unobserved transcripts', () => {
    const cap = ThreadMessagesCache.MAX_CACHED_THREADS
    for (let index = 0; index < cap + 5; index += 1) {
      cache.reconcile(PROJECT, `thread-${index}`, [message(`m-${index}`)], null)
      cache.entry(PROJECT, `thread-${index}`)
    }
    // Every extra thread beyond the cap must have pushed an older one out, not
    // added to the pile: a session over dozens of threads is what grew the
    // renderer by hundreds of megabytes.
    const kept = Array.from({ length: cap + 5 }, (_unused, index) =>
      cache.entry(PROJECT, `thread-${index}`)
    ).filter((entry) => entry.loaded || entry.messages.length > 0)
    expect(kept.length).toBeLessThanOrEqual(cap)
  })

  it('never evicts a transcript a mounted reader holds', () => {
    const held = cache.entry(PROJECT, 'held-thread')
    cache.reconcile(PROJECT, 'held-thread', [message('held-message')], null)
    const release = cache.retain(PROJECT, 'held-thread')
    try {
      for (let index = 0; index < ThreadMessagesCache.MAX_CACHED_THREADS + 5; index += 1) {
        cache.reconcile(PROJECT, `other-${index}`, [message(`m-${index}`)], null)
        cache.entry(PROJECT, `other-${index}`)
      }
      // The reader on screen must still see its own conversation.
      expect(cache.messages(PROJECT, 'held-thread').map((entry) => entry.id)).toEqual([
        'held-message'
      ])
      expect(cache.entry(PROJECT, 'held-thread')).toBe(held)
    } finally {
      release()
    }
  })

  it('drops the least recently read transcript first', () => {
    const cap = ThreadMessagesCache.MAX_CACHED_THREADS
    for (let index = 0; index < cap; index += 1) {
      cache.reconcile(PROJECT, `t-${index}`, [message(`m-${index}`)], null)
      cache.entry(PROJECT, `t-${index}`)
    }
    // Touch the oldest one, so it is no longer the least recently read.
    cache.entry(PROJECT, 't-0')
    cache.reconcile(PROJECT, 'fresh', [message('fresh-message')], null)
    cache.entry(PROJECT, 'fresh')

    expect(cache.messages(PROJECT, 't-0')).toHaveLength(1)
    expect(cache.messages(PROJECT, 't-1')).toHaveLength(0)
  })
})

describe('ThreadMessagesCache frozen slots', () => {
  let cache: ThreadMessagesCache

  beforeEach(() => {
    cache = new ThreadMessagesCache()
  })

  it('treats only the thread on screen as live', () => {
    cache.setActive(PROJECT, 'live')
    expect(cache.isFrozen(PROJECT, 'live')).toBe(false)
    // A thread with no slot is absent, not frozen: the event path creates it.
    expect(cache.isFrozen(PROJECT, 'never-opened')).toBe(false)
    cache.reconcile(PROJECT, 'kept', [message('m1')], null)
    expect(cache.isFrozen(PROJECT, 'kept')).toBe(true)
  })

  it('freezes everything while the empty state is showing', () => {
    cache.setActive(PROJECT, 'live')
    cache.reconcile(PROJECT, 'kept', [message('m1')], null)
    cache.setActive(null, null)
    // Nothing is on screen, so no slot may be fed.
    expect(cache.isFrozen(PROJECT, 'live')).toBe(false)
    expect(cache.isFrozen(PROJECT, 'kept')).toBe(false)
    expect(cache.activeKey).toBeNull()
  })

  it('keeps three slots and never evicts the live one', () => {
    cache.reconcile(PROJECT, 'a', [message('a1')], null)
    cache.reconcile(PROJECT, 'b', [message('b1')], null)
    cache.setActive(PROJECT, 'a')
    for (let index = 0; index < 5; index += 1) {
      cache.reconcile(PROJECT, `extra-${index}`, [message(`m-${index}`)], null)
    }
    // The live transcript survives the pressure from everything opened after it.
    expect(cache.messages(PROJECT, 'a').map((entry) => entry.id)).toEqual(['a1'])
  })
})
