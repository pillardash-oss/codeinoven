import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StorageEngine } from '../../src/main/storage/storage-engine'
import { NotificationInboxStore } from '../../src/main/notifications/notification-inbox-store'
import { ASSISTANT_SPACE_ID, INBOX_PROJECT_ID } from '../../src/lib/types'
import type {
  AgentNotificationPayload,
  NotificationFamily,
  PersistedAgentNotification
} from '../../src/lib/ipc-contract'

let configRoot: string
let storage: StorageEngine
/** Every store a test builds, so teardown can drain its pending writes. */
let stores: NotificationInboxStore[]

function makeStore(): NotificationInboxStore {
  const store = new NotificationInboxStore(storage)
  stores.push(store)
  return store
}

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'codeinoven-notification-inbox-'))
  configRoot = join(root, 'config')
  await mkdir(configRoot, { recursive: true })
  storage = new StorageEngine(configRoot)
  stores = []
})

afterEach(async () => {
  // Writes are serialized and not awaited by the mutations, so the directory is
  // only safe to remove once every chain a test started has drained.
  await Promise.all(stores.map((store) => store.flush()))
  await rm(join(configRoot, '..'), { recursive: true, force: true })
})

function entry(
  overrides: Partial<PersistedAgentNotification> & Pick<PersistedAgentNotification, 'id'>
): PersistedAgentNotification {
  return {
    kind: 'completed',
    title: 'Chat finished',
    body: 'It did the thing.',
    projectId: 'project-1',
    threadId: 'thread-1',
    source: 'project',
    projectName: 'CodeInOven',
    timestamp: 1_000,
    ...overrides
  }
}

/** A second store over the same file, which is what a restart looks like. */
async function reopened(): Promise<NotificationInboxStore> {
  const store = makeStore()
  await store.load()
  return store
}

describe('NotificationInboxStore', () => {
  it('keeps notifications across a restart', async () => {
    const store = makeStore()
    await store.load()
    store.add(entry({ id: 'a', timestamp: 10 }))
    store.add(entry({ id: 'b', timestamp: 20 }))
    await store.flush()

    const restored = await reopened()
    expect(restored.list().map((n) => n.id)).toEqual(['a', 'b'])
    // The panel renders each entry's age, so the arrival time has to be the one
    // from the original delivery rather than the moment the new window booted.
    expect(restored.list().map((n) => n.timestamp)).toEqual([10, 20])
  })

  it('returns entries oldest first', async () => {
    const store = makeStore()
    await store.load()
    store.add(entry({ id: 'newer', timestamp: 300 }))
    store.add(entry({ id: 'older', timestamp: 100 }))
    expect(store.list().map((n) => n.id)).toEqual(['older', 'newer'])
  })

  it('treats a repeated delivery of one id as a refresh, not a duplicate', async () => {
    const store = makeStore()
    await store.load()
    store.add(entry({ id: 'a', timestamp: 10, title: 'First' }))
    store.add(entry({ id: 'a', timestamp: 20, title: 'Second' }))
    const list = store.list()
    expect(list).toHaveLength(1)
    expect(list[0]?.title).toBe('Second')
  })

  it('does not resurrect a dismissed notification on re-delivery or restart', async () => {
    const store = makeStore()
    await store.load()
    store.add(entry({ id: 'a' }))
    store.dismiss('a')
    await store.flush()

    // The same event arriving again is the case a toast dismissal used to hit.
    expect(store.add(entry({ id: 'a' }))).toBe(false)
    expect(store.list()).toEqual([])

    const restored = await reopened()
    expect(restored.dismissedIds()).toEqual(['a'])
    expect(restored.list()).toEqual([])
  })

  it('skips an entry the file both lists and tombstones', async () => {
    // A write that landed just before its tombstone leaves the file holding
    // both, so the restore has to prefer the tombstone rather than the entry.
    await storage.write('state/notification-inbox.json', {
      version: 1,
      notifications: [entry({ id: 'a' }), entry({ id: 'b' })],
      dismissed: ['a']
    })

    const store = await reopened()
    expect(store.list().map((n) => n.id)).toEqual(['b'])
  })

  it("drops a deleted thread's notifications without tombstoning them", async () => {
    const store = makeStore()
    await store.load()
    store.add(entry({ id: 'a', threadId: 'thread-1' }))
    store.add(entry({ id: 'b', threadId: 'thread-2' }))
    store.dismissForThread('project-1', 'thread-1')
    await store.flush()

    expect(store.list().map((n) => n.id)).toEqual(['b'])
    // A thread id is never reused, so nothing could rebuild that entry and the
    // tombstone would only bloat the file.
    expect(store.dismissedIds()).toEqual([])

    const restored = await reopened()
    expect(restored.list().map((n) => n.id)).toEqual(['b'])
  })

  it('clears one family and leaves the others alone', async () => {
    const store = makeStore()
    await store.load()
    store.add(entry({ id: 'project', source: 'project' }))
    store.add(entry({ id: 'chat', source: 'chat', projectId: INBOX_PROJECT_ID }))
    store.add(entry({ id: 'side-chat', source: 'temporary-chat', projectId: INBOX_PROJECT_ID }))
    store.add(entry({ id: 'assistant', source: 'assistant', projectId: ASSISTANT_SPACE_ID }))

    store.clear('chat')
    expect(store.list().map((n) => n.id)).toEqual(['project', 'assistant'])
  })

  it('clears everything and tombstones it, so hydration cannot put it back', async () => {
    const store = makeStore()
    await store.load()
    store.add(entry({ id: 'a' }))
    store.add(entry({ id: 'b' }))
    store.clear()
    await store.flush()

    expect(store.list()).toEqual([])
    expect(store.dismissedIds().sort()).toEqual(['a', 'b'])

    const restored = await reopened()
    expect(restored.list()).toEqual([])
    expect(restored.add(entry({ id: 'a' }))).toBe(false)
  })

  it('trims the inbox to its cap, dropping the oldest entries', async () => {
    const store = makeStore()
    await store.load()
    for (let index = 0; index < 260; index += 1) {
      store.add(entry({ id: `n${index}`, timestamp: index }))
    }
    await store.flush()

    const restored = await reopened()
    const ids = restored.list().map((n) => n.id)
    expect(ids).toHaveLength(200)
    expect(ids[0]).toBe('n60')
    expect(ids.at(-1)).toBe('n259')
  })

  it('caps by age rather than insertion order', async () => {
    // A refreshed entry keeps its map slot but takes a newer arrival time, so
    // insertion order and age drift apart; the oldest *entry* is what must go.
    const store = makeStore()
    await store.load()
    for (let index = 0; index < 200; index += 1) {
      store.add(entry({ id: `n${index}`, timestamp: index }))
    }
    // `n0` is the oldest entry but the first in insertion order, and re-adding
    // it moves it to the far end of the age order.
    store.add(entry({ id: 'n0', timestamp: 5_000 }))
    store.add(entry({ id: 'extra', timestamp: 6_000 }))
    expect(store.list().length).toBe(200)
    expect(store.list().map((n) => n.id)).not.toContain('n1')
  })

  it('caps an oversized file written by an older build', async () => {
    const notifications = Array.from({ length: 250 }, (_, index) =>
      entry({ id: `n${index}`, timestamp: index })
    )
    await storage.write('state/notification-inbox.json', {
      version: 1,
      notifications,
      dismissed: []
    })

    const store = await reopened()
    expect(store.list()).toHaveLength(200)
    // The 50 oldest are the ones dropped.
    expect(store.list()[0]?.id).toBe('n50')
    expect(store.list().at(-1)?.id).toBe('n249')
  })

  it('drops malformed entries instead of failing the whole restore', async () => {
    await storage.write('state/notification-inbox.json', {
      version: 1,
      notifications: [entry({ id: 'good' }), { id: 'no-kind' }, null, 'nonsense'],
      dismissed: []
    })

    const store = await reopened()
    expect(store.list().map((n) => n.id)).toEqual(['good'])
  })

  it('starts empty when the store file is missing', async () => {
    const store = await reopened()
    expect(store.list()).toEqual([])
    expect(store.dismissedIds()).toEqual([])
  })

  it('survives an unreadable store file', async () => {
    await storage.write('state/notification-inbox.json', '{ not json')
    const store = await reopened()
    expect(store.list()).toEqual([])
  })
})

describe('NotificationInboxStore family grouping', () => {
  it('groups a payload by the tab its family names', () => {
    const cases: Array<[Partial<AgentNotificationPayload>, NotificationFamily]> = [
      [{ source: 'project', projectId: 'p' }, 'project'],
      [{ source: 'chat', projectId: INBOX_PROJECT_ID }, 'chat'],
      [{ source: 'temporary-chat', projectId: 'p' }, 'chat'],
      // A payload that predates the chat source still reads as a chat by project.
      [{ source: 'project', projectId: INBOX_PROJECT_ID }, 'chat'],
      [{ source: 'assistant', projectId: ASSISTANT_SPACE_ID }, 'assistant'],
      [{ source: 'project', projectId: ASSISTANT_SPACE_ID }, 'assistant']
    ]
    for (const [payload, family] of cases) {
      const store = makeStore()
      const full = entry({ id: family, ...payload })
      store.add(full)
      store.clear(family)
      // Grouping is observable through `clear`: the entry goes only when the
      // family the test named is the one the store derives from the payload.
      expect(store.list()).toEqual([])
    }
  })
})
