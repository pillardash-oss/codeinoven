// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('$lib/ipc.svelte', () => ({
  invoke: vi.fn(async () => null),
  subscribe: () => () => undefined,
  subscribeGuarded: () => () => undefined
}))

import { flushSync } from 'svelte'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { watchDraftThreadRefs, watchThreadDraft } from './renderer-recovery-reads.svelte'

const PROJECT = 'write-project'
const THREAD_A = 'write-thread-a'
const THREAD_B = 'write-thread-b'

/**
 * Typing in one composer must not wake the rest of the app.
 *
 * Every draft lives in one shared record, and the first keystroke anywhere used
 * to replace that record, invalidating every reader in the app for a change that
 * belongs to a single conversation. A keyed write keeps it local, and these pin
 * both halves of the rule: a keystroke wakes only its own draft, while a draft
 * appearing or emptying still updates the list of threads that hold one (which
 * is what the sidebar scans).
 */
describe('draft writes stay local to their thread', () => {
  const openWatchers: { stop: () => void }[] = []

  const watchThread = (threadId: string): ReturnType<typeof watchThreadDraft> => {
    const watcher = watchThreadDraft(PROJECT, threadId)
    openWatchers.push(watcher)
    return watcher
  }

  const watchRefs = (): ReturnType<typeof watchDraftThreadRefs> => {
    const watcher = watchDraftThreadRefs()
    openWatchers.push(watcher)
    return watcher
  }

  afterEach(() => {
    for (const watcher of openWatchers.splice(0)) watcher.stop()
    rendererRecovery.setDraft(PROJECT, THREAD_A, '')
    rendererRecovery.setDraft(PROJECT, THREAD_B, '')
    flushSync()
  })

  it('wakes only the draft that was written', () => {
    rendererRecovery.setDraft(PROJECT, THREAD_A, 'one')
    rendererRecovery.setDraft(PROJECT, THREAD_B, 'two')
    flushSync()

    const a = watchThread(THREAD_A)
    const b = watchThread(THREAD_B)
    const beforeA = a.runs()
    const beforeB = b.runs()

    rendererRecovery.setDraft(PROJECT, THREAD_A, 'one more')
    flushSync()

    expect(a.runs()).toBeGreaterThan(beforeA)
    expect(b.runs()).toBe(beforeB)
    expect(rendererRecovery.draftFor(PROJECT, THREAD_A)).toBe('one more')
    expect(rendererRecovery.draftFor(PROJECT, THREAD_B)).toBe('two')
  })

  it('keeps the list of threads holding a draft up to date', () => {
    rendererRecovery.setDraft(PROJECT, THREAD_A, '')
    rendererRecovery.setDraft(PROJECT, THREAD_B, '')
    flushSync()

    const refs = watchRefs()
    const before = refs.runs()

    // A draft appearing is a key the record did not have: the list must see it.
    rendererRecovery.setDraft(PROJECT, THREAD_A, 'typed')
    flushSync()
    expect(refs.runs()).toBeGreaterThan(before)
    expect(rendererRecovery.listDraftThreadRefs()).toContainEqual({
      projectId: PROJECT,
      threadId: THREAD_A
    })

    // And emptying it removes it again.
    rendererRecovery.setDraft(PROJECT, THREAD_A, '')
    flushSync()
    expect(rendererRecovery.listDraftThreadRefs()).not.toContainEqual({
      projectId: PROJECT,
      threadId: THREAD_A
    })
  })

  it('commits the newest draft rather than the keystroke that armed the commit', async () => {
    rendererRecovery.setDraft(PROJECT, THREAD_A, 'first')
    rendererRecovery.setDraft(PROJECT, THREAD_A, 'second')
    flushSync()
    // The deferred commit serializes at fire time, so it carries the text the
    // draft holds then; nothing is lost by not stringifying on the keystroke.
    expect(rendererRecovery.draftFor(PROJECT, THREAD_A)).toBe('second')
  })
})
