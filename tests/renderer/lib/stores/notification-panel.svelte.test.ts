import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
const subscribe = vi.hoisted(() => vi.fn())

vi.mock('$lib/ipc.svelte', () => ({ invoke, subscribe }))
vi.mock('$lib/stores/assistant-routines.svelte', () => ({
  assistantRoutines: { missedRuns: [], spaceColor: null, routines: [] }
}))

import { APP_SLUG } from '$shared/brand'
import { ASSISTANT_SPACE_ID, INBOX_PROJECT_ID } from '$shared/types'
import type { AgentNotificationPayload } from '$shared/ipc-contract'
import type { Thread } from '$shared/types'

// Type-only, derived from the singleton: the state class is deliberately not
// exported, so each test gets a fresh instance by re-evaluating the module
// rather than sharing one that leaks notifications (and, worse, tombstones)
// between cases.
type PanelState = (typeof import('$lib/stores/notification-panel.svelte'))['notificationPanelState']

/**
 * The id a live delivery and thread-state hydration both derive for the same
 * failed thread. They are the same by construction (project, thread, status and
 * last update), which is what lets one tombstone stop both paths.
 */
const FAILED_ENTRY_ID = `${APP_SLUG}-project-1-thread-1-failed-100`

function payload(
  id: string,
  overrides: Partial<AgentNotificationPayload> = {}
): AgentNotificationPayload {
  return {
    id,
    kind: 'completed',
    title: 'Done',
    body: 'Finished the thing.',
    projectId: 'project-1',
    threadId: 'thread-1',
    source: 'project',
    projectName: 'CodeInOven',
    ...overrides
  }
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-1',
    projectId: 'project-1',
    providerId: 'pi',
    title: 'Thread',
    titleSource: 'default',
    status: 'failed',
    pinned: false,
    archived: false,
    read: false,
    createdAt: 1,
    updatedAt: 100,
    lastActivity: 100,
    workingDirectory: '',
    ...overrides
  } as Thread
}

let panel: PanelState

beforeEach(async () => {
  invoke.mockReset()
  invoke.mockResolvedValue(undefined)
  vi.resetModules()
  const { notificationPanelState } = await import('$lib/stores/notification-panel.svelte')
  panel = notificationPanelState
})

describe('dismissing a notification', () => {
  it('retires the panel entry and tells the durable store', () => {
    panel.add(payload('a'))
    expect(panel.totalCount).toBe(1)

    panel.dismiss('a')

    expect(panel.totalCount).toBe(0)
    expect(invoke).toHaveBeenCalledWith('notification:dismissInbox', 'a')
  })

  it('leaves the panel alone when only the toast expires', () => {
    // The agent-notification toast used to pass `onDismiss: () => dismiss(id)`,
    // so sonner's own expiry retired the panel entry too. Nothing in the toast
    // path dismisses now, so the panel entry outlives its toast.
    panel.add(payload('a'))
    expect(invoke).not.toHaveBeenCalledWith('notification:dismissInbox', 'a')
  })

  it('does not rebuild a dismissed entry from thread-state hydration', () => {
    panel.add(payload(FAILED_ENTRY_ID, { kind: 'error' }))
    panel.dismiss(FAILED_ENTRY_ID)

    // A thread row that still says `failed` is exactly what hydration rebuilds
    // from, so a dismissed failure used to reappear on the next scope load.
    panel.hydrateFromThreads([thread()], [])

    expect(panel.totalCount).toBe(0)
  })

  it('refuses a re-delivery of a dismissed id', () => {
    panel.add(payload('a'))
    panel.dismiss('a')
    panel.add(payload('a'))
    expect(panel.totalCount).toBe(0)
  })
})

describe('bulk dismissal', () => {
  it('tombstones a cleared tab so hydration cannot rebuild it', () => {
    panel.add(payload('project', { projectId: 'project-1' }))
    panel.add(
      payload('chat', { projectId: INBOX_PROJECT_ID, source: 'chat', kind: 'chat-completed' })
    )

    panel.dismissTab('chats')

    expect(panel.chatNotifications).toEqual([])
    expect(invoke).toHaveBeenCalledWith('notification:clearInbox', 'chat')
    // The chat entry is gone from the tab, and it must stay gone: clearing a tab
    // is the one-line dismissal many times over.
    panel.add(payload('chat', { projectId: INBOX_PROJECT_ID, source: 'chat' }))
    expect(panel.chatNotifications).toEqual([])
  })

  it('clears the projects tab by its complement, keeping chat and assistant', () => {
    panel.add(payload('project'))
    panel.add(payload('chat', { projectId: INBOX_PROJECT_ID, source: 'chat' }))
    panel.add(payload('assistant', { projectId: ASSISTANT_SPACE_ID, source: 'assistant' }))

    panel.dismissTab('projects')

    expect(panel.projectNotifications).toEqual([])
    expect(panel.chatNotifications.map((n) => n.id)).toEqual(['chat'])
    expect(panel.assistantNotifications.map((n) => n.id)).toEqual(['assistant'])
    expect(invoke).toHaveBeenCalledWith('notification:clearInbox', 'project')
  })

  it('clears everything and asks the store to clear without a family', () => {
    panel.add(payload(FAILED_ENTRY_ID, { kind: 'error' }))
    panel.add(payload('assistant', { projectId: ASSISTANT_SPACE_ID, source: 'assistant' }))

    panel.dismissAll()

    expect(panel.totalCount).toBe(0)
    expect(invoke).toHaveBeenCalledWith('notification:clearInbox')
    panel.hydrateFromThreads([thread()], [])
    expect(panel.totalCount).toBe(0)
  })

  it('does not tombstone the entries a tab clear keeps', () => {
    panel.add(payload('project'))
    panel.add(payload('chat', { projectId: INBOX_PROJECT_ID, source: 'chat' }))

    panel.dismissTab('chats')
    // The surviving project entry must still be hydratable, or clearing one tab
    // would silently retire the others too.
    panel.add(payload('project'))
    expect(panel.projectNotifications.map((n) => n.id)).toEqual(['project'])
  })
})

describe('restoring the durable inbox', () => {
  it('adopts restored entries and their tombstones', async () => {
    invoke.mockResolvedValue({
      notifications: [{ ...payload('kept'), timestamp: 50 }],
      dismissed: ['gone']
    })

    await panel.restoreFromStore()

    expect(panel.totalCount).toBe(1)
    expect(panel.visible.map((n) => n.id)).toEqual(['kept'])
    // The tombstone has to seed the live guard too, or a re-delivery would
    // resurrect what the user retired in the previous session.
    panel.add(payload('gone'))
    expect(panel.totalCount).toBe(1)
  })

  it('skips an entry the snapshot both lists and tombstones', async () => {
    invoke.mockResolvedValue({
      notifications: [{ ...payload('a'), timestamp: 50 }],
      dismissed: ['a']
    })

    await panel.restoreFromStore()

    expect(panel.totalCount).toBe(0)
  })

  it('does not double an entry the thread-state hydration already rebuilt', async () => {
    // Hydration and the store both build the failed-thread entry; ids are
    // deterministic, so the two must converge on one row.
    panel.hydrateFromThreads([thread()], [])
    invoke.mockResolvedValue({
      notifications: [{ ...payload(FAILED_ENTRY_ID, { kind: 'error' }), timestamp: 50 }],
      dismissed: []
    })

    await panel.restoreFromStore()

    expect(panel.totalCount).toBe(1)
  })

  it('leaves the panel usable when the inbox cannot be read', async () => {
    invoke.mockRejectedValue(new Error('no store'))
    await expect(panel.restoreFromStore()).resolves.toBeUndefined()
    expect(panel.totalCount).toBe(0)
  })
})

describe('naming an assistant failure', () => {
  it('names the routine a failed run of its Getting started host belongs to', async () => {
    const { assistantRoutines } = await import('$lib/stores/assistant-routines.svelte')
    assistantRoutines.routines = [{ id: 'routine-1', name: 'Slack digest' }] as never
    const setupTask = thread({
      id: 'task-setup',
      projectId: ASSISTANT_SPACE_ID,
      title: 'Getting started',
      assistantGettingStarted: true,
      routineId: 'routine-1',
      status: 'completed'
    })
    const run = thread({
      id: 'run-1',
      projectId: ASSISTANT_SPACE_ID,
      title: 'Run · 1 Jan',
      assistantTaskId: 'task-setup',
      routineId: 'routine-1',
      status: 'failed',
      updatedAt: 200
    })

    panel.hydrateFromThreads([setupTask, run], [])

    // "Assistant hit an error" said nothing about what failed, and the run's own
    // "Getting started" host title is an authoring thread, not a job.
    expect(panel.assistantNotifications.map((n) => n.title)).toEqual(['Slack digest hit an error'])
  })

  it('names the task a failed run ran when it is not an authoring host', () => {
    const task = thread({
      id: 'task-1',
      projectId: ASSISTANT_SPACE_ID,
      title: 'Inbox triage',
      status: 'completed'
    })
    const run = thread({
      id: 'run-2',
      projectId: ASSISTANT_SPACE_ID,
      title: 'Run · 2 Jan',
      assistantTaskId: 'task-1',
      status: 'failed',
      updatedAt: 300
    })

    panel.hydrateFromThreads([task, run], [])

    expect(panel.assistantNotifications.map((n) => n.title)).toEqual(['Inbox triage hit an error'])
  })
})

describe('dropping a deleted thread', () => {
  it('retires the entries and tells the durable store', () => {
    panel.add(payload('a', { threadId: 'gone' }))
    panel.add(payload('b', { threadId: 'kept' }))

    panel.dismissForThread('project-1', 'gone')

    expect(panel.visible.map((n) => n.id)).toEqual(['b'])
    expect(invoke).toHaveBeenCalledWith('notification:dismissInboxForThread', 'project-1', 'gone')
  })
})

describe('duplicate delivery', () => {
  it('keeps one entry per id', () => {
    panel.add(payload('a'))
    panel.add(payload('a'))
    expect(panel.totalCount).toBe(1)
  })
})

describe('opening the thread', () => {
  it('retires a completed entry once the thread is read', () => {
    // The other half of the dismissal rule: reading the thread acknowledges the
    // moments it reports, so reconcileThread retires them.
    panel.add(payload('a', { kind: 'completed' }))
    panel.reconcileThread(thread({ status: 'completed', read: false }))
    expect(panel.totalCount).toBe(1)

    panel.reconcileThread(thread({ status: 'completed', read: true }))
    expect(panel.totalCount).toBe(0)
  })

  it('keeps a needs-attention entry while the thread is parked on the user', () => {
    // A parked thread is live state, so reading its card answers nothing; only
    // the status change that answers the card retires the entry.
    panel.add(payload('a', { kind: 'attention' }))
    panel.reconcileThread(thread({ status: 'awaiting_approval', read: true }))
    expect(panel.totalCount).toBe(1)

    panel.reconcileThread(thread({ status: 'executing', read: true }))
    expect(panel.totalCount).toBe(0)
  })

  it('leaves other threads alone', () => {
    panel.add(payload('a', { threadId: 'thread-1' }))
    panel.add(payload('b', { threadId: 'thread-2' }))
    panel.reconcileThread(thread({ id: 'thread-1', status: 'completed', read: true }))
    expect(panel.visible.map((n) => n.id)).toEqual(['b'])
  })
})
