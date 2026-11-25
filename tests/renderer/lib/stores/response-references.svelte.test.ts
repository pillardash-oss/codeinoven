// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync } from 'svelte'

vi.mock('$lib/ipc.svelte', () => ({
  invoke: vi.fn(async () => null),
  subscribe: () => () => undefined,
  subscribeGuarded: () => () => undefined
}))

import { responseReferencesState } from '$lib/stores/response-references.svelte'
import type { ResponseReferenceAnchor } from '$lib/stores/response-references.svelte'
import { watchThreadReferences } from './response-references-reads.svelte'

/**
 * A comment written on one annotation must not invalidate the rest of the app.
 *
 * The store keeps every conversation's references in one `$state` record, and
 * the first annotation comment keystroke is the write that used to replace that
 * record: the sidebar, the header and each open composer re-read their thread
 * for a change that belongs to a single conversation. A keyed write is what
 * keeps a keystroke local, and these pin it — a write to one thread wakes only
 * that thread's readers, and the others still do see their own writes.
 */
describe('response references stay local to their thread', () => {
  const reference = (id: string, text: string): ResponseReferenceAnchor => ({
    id,
    label: 'Design element',
    text,
    kind: 'design'
  })

  const openWatchers: { stop: () => void }[] = []

  const watch = (projectId: string, threadId: string): ReturnType<typeof watchThreadReferences> => {
    const watcher = watchThreadReferences(projectId, threadId)
    openWatchers.push(watcher)
    return watcher
  }

  afterEach(() => {
    for (const watcher of openWatchers.splice(0)) watcher.stop()
    flushSync()
  })

  it('does not wake another conversation when one thread comment is typed', () => {
    responseReferencesState.setForThread('project-1', 'thread-a', [reference('mark-1', 'The card')])
    responseReferencesState.setForThread('project-1', 'thread-b', [reference('mark-2', 'The row')])
    flushSync()

    const watched = watch('project-1', 'thread-a')
    const other = watch('project-1', 'thread-b')
    expect(watched.runs()).toBe(1)
    expect(other.runs()).toBe(1)

    // What a keystroke in thread-b's comment box does.
    responseReferencesState.updateCommentDraft('project-1', 'thread-b', 'mark-2', 'The row, two')
    flushSync()

    expect(other.runs()).toBe(2)
    expect(watched.runs()).toBe(1)
    expect(responseReferencesState.forThread('project-1', 'thread-b')[0]?.comment).toBe(
      'The row, two'
    )
    expect(responseReferencesState.forThread('project-1', 'thread-a')[0]?.comment).toBeUndefined()
  })

  it('wakes its own readers, and keeps the rest of the list untouched', () => {
    responseReferencesState.setForThread('project-1', 'thread-a', [reference('mark-1', 'The card')])
    flushSync()
    const watched = watch('project-1', 'thread-a')
    expect(watched.runs()).toBe(1)

    responseReferencesState.updateComment('project-1', 'thread-a', 'mark-1', 'Tighten the padding')
    flushSync()

    expect(watched.runs()).toBe(2)
    expect(responseReferencesState.forThread('project-1', 'thread-a')[0]?.comment).toBe(
      'Tighten the padding'
    )
    expect(responseReferencesState.forThread('project-1', 'thread-a')[0]?.label).toBe(
      'Design element 1'
    )
  })

  it('drops the conversation from the shared list once its last reference goes', () => {
    responseReferencesState.setForThread('project-1', 'thread-c', [reference('mark-3', 'The chip')])
    flushSync()

    responseReferencesState.clearThread('project-1', 'thread-c')
    flushSync()

    expect(responseReferencesState.forThread('project-1', 'thread-c')).toEqual([])
    expect(responseReferencesState.entries().some((entry) => entry.threadId === 'thread-c')).toBe(
      false
    )
  })
})
