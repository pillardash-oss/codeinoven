// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'
import type { Thread } from '$shared/types'
import type { QueuedMessageEntry } from '$lib/stores/renderer-recovery'
import {
  THREAD_FOREIGN_MARK,
  THREAD_GROUP_MARK,
  THREAD_STATE_MARKS
} from '$lib/components/threads/thread-state-marks'

// The row asks the live agent-run store whether a thread is working. These tests
// drive that one question directly, so a fixture can be "working" without a real
// session behind it.
// The context line only exists when there is something to put on it. A scope is
// the case that must not float: it belongs flush against the row's left edge.
const scope = vi.hoisted(() => ({ bucket: null as null | Record<string, unknown> }))
vi.mock('$lib/threads/thread-scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/threads/thread-scope')>()),
  // Only the bucket lookup is driven here; the name rule stays the real one, so
  // these tests exercise the shortening the row actually applies.
  threadScopeBucket: () => scope.bucket
}))

const runs = vi.hoisted(() => ({ busy: new Set<string>(), settled: false }))
vi.mock('$lib/stores/agent-runs.svelte', () => ({
  agentRuns: {
    hasSettled: () => runs.settled,
    isBusy: (projectId: string, threadId: string) => runs.busy.has(`${projectId}:${threadId}`),
    settledAt: () => null
  }
}))

// Whether another CodeInOven instance owns this thread's turn. The spine has to
// say so with its own mark, so these tests drive the question directly rather
// than standing up a second instance.
const foreign = vi.hoisted(() => ({ threads: new Set<string>() }))
vi.mock('$lib/stores/foreign-runs.svelte', () => ({
  foreignRuns: {
    isForeign: (projectId: string, threadId: string) =>
      foreign.threads.has(`${projectId}:${threadId}`),
    isWorkflow: () => false,
    transferState: () => ({ pending: false, error: null }),
    transfer: async () => undefined
  }
}))

/**
 * The detailed row: the spine redesign plus the two-status model on top of it.
 *
 * These lock in the promises the user is relying on:
 *  1. every live action the thread has is drawn at once, not ranked down to one;
 *  2. the rail always speaks for the thread's own state, and what is waiting on
 *     it rides the glyph above;
 *  3. the secondary slot is the flexible one, and the last action wins;
 *  4. project, scope, branch and where it runs share one meta line under the
 *     title, and a local thread spends no mark saying it is local;
 *  5. a settled row draws no spine and its title sits flush left; the gutter
 *     opens only while the row has a state to show;
 *  6. a pinned or bookmarked thread puts its pin at the head of the meta line,
 *     where clicking it is the way to remove it;
 *  7. the project is named with its own icon, never a coloured dot.
 */

// jsdom ships no ResizeObserver, and the one/two-line row measures its harness
// track with one. A no-op observer is enough: these tests assert what the row
// draws, not how many icons fit into a measured width.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub

const invokeMock = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('$lib/ipc.svelte', async (importOriginal) => {
  // `subscribeGuarded` is kept real: it is the guard the stores and the app
  // wiring subscribe through, and stubbing it would hide whether a subscription
  // is actually made.
  const actual = await importOriginal<typeof import('$lib/ipc.svelte')>()
  return { ...actual, invoke: invokeMock, subscribe: vi.fn(() => () => {}) }
})

const speech = vi.hoisted(() => ({
  recording: new Set<string>(),
  speaking: new Set<string>(),
  transcribing: new Set<string>()
}))

vi.mock('$lib/speech/speech-controller.svelte', () => ({
  speechController: {
    isRecordingThread: (id: string) => speech.recording.has(id),
    isSpeakingThread: (id: string) => speech.speaking.has(id),
    isTranscribingThread: (id: string) => speech.transcribing.has(id),
    isCapturingThread: () => false,
    threadIndicatorActionAt: () => 1,
    voiceSendStageForThread: () => null
  }
}))

const pip = vi.hoisted(() => ({ threads: new Set<string>() }))
vi.mock('$lib/stores/pip.svelte', () => ({
  pipState: {
    isThreadUsingComputerUse: (id: string) => pip.threads.has(id),
    threadActivityAt: () => 1
  }
}))

vi.mock('$lib/stores/browser-audio.svelte', () => ({
  browserAudio: {
    threadAudioStartedAt: () => null,
    threadIsCapturing: () => false,
    activitiesForThread: () => []
  }
}))

vi.mock('$lib/stores/browser-access.svelte', () => ({
  browserStore: () => ({ hasThreadPeek: () => false })
}))

/**
 * The row asks the recovery store what is waiting on a thread: composer content
 * the user has typed, a message queued behind the run, and whether that message
 * waits on another thread. These spies drive that one question, so a fixture can
 * carry a draft or a queue without a composer behind it.
 */
const waiting = vi.hoisted(() => ({
  typed: false,
  /** Queued messages, oldest first: the head is what sends next. */
  queue: [] as QueuedMessageEntry[]
}))

const { rendererRecovery } = await import('$lib/stores/renderer-recovery.svelte')

vi.spyOn(rendererRecovery, 'hasDraftContent').mockImplementation(
  () => waiting.typed || waiting.queue.length > 0
)
// The row reads the typed-only signal for the draft mark, so a message already
// queued never reports as the user still typing.
vi.spyOn(rendererRecovery, 'hasTypedContent').mockImplementation(() => waiting.typed)
vi.spyOn(rendererRecovery, 'queuedMessageCount').mockImplementation(() => waiting.queue.length)
vi.spyOn(rendererRecovery, 'queuedMessageFor').mockImplementation(() => waiting.queue[0] ?? null)

const ThreadRow = (await import('$lib/components/threads/ThreadRow.svelte')).default

function thread(over: Partial<Thread> = {}): Thread {
  return {
    id: 't1',
    projectId: 'p1',
    title: 'Calibrate the mic input',
    status: 'completed',
    read: true,
    pinned: false,
    lastActivity: Date.now(),
    settings: { harnessId: 'claude-code', providerId: 'anthropic', modelId: 'sonnet' },
    usedHarnessIds: ['claude-code'],
    branch: 'feat/scopes',
    ...over
  } as unknown as Thread
}

/** A message queued behind the running turn, optionally waiting on another thread. */
function queuedMessage(waitsOnAnotherThread = false): QueuedMessageEntry {
  return {
    id: `q-${waiting.queue.length + 1}`,
    text: 'Queue this for me',
    attachments: [],
    promptReferences: [],
    projectReferences: [],
    taskReferences: [],
    startAfterThreads: waitsOnAnotherThread
      ? [{ id: 't2', title: 'Wait for the other thread' }]
      : []
  }
}

function render(t: Thread, over: Record<string, unknown> = {}) {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const pinCalls: Thread[] = []
  const app = mount(ThreadRow, {
    target,
    props: {
      thread: t,
      detailed: true,
      projectIconUrl: null,
      projectIconGlyph: null,
      onTogglePin: (thread: Thread) => pinCalls.push(thread),
      ...over
    }
  })
  flushSync()
  return { target, app, pinCalls }
}

describe('ThreadRow, the detailed spine row', () => {
  it('draws every live action at once, not only the loudest one', async () => {
    speech.recording.add('t1')
    pip.threads.add('t1')
    const { target, app } = render(thread())

    await tick()
    const statuses = [...target.querySelectorAll('[role="status"]')].map((n) =>
      n.getAttribute('title')
    )
    expect(statuses).toContain('Listening')
    expect(statuses).toContain('Agent using the computer')

    unmount(app)
    speech.recording.delete('t1')
    pip.threads.delete('t1')
  })

  it('keeps the branch on the meta line, and says nothing about running locally', async () => {
    scope.bucket = { id: 'b1', name: 'Future version', color: '#888888', pinned: false }
    const { target, app } = render(thread())
    await tick()

    expect(target.querySelectorAll('[title^="Branch:"]').length).toBeGreaterThan(0)
    expect(target.querySelector('[title="Runs on this computer"]')).toBeNull()

    unmount(app)
    scope.bucket = null
  })

  it('draws no spine on a settled thread, and its title sits flush left', async () => {
    const { target, app } = render(thread({ status: 'completed' }))
    await tick()

    expect(target.querySelector('[aria-label="Completed"]')).toBeNull()
    const row = target.querySelector('button') as HTMLElement
    expect(row.className).toContain('pl-2.5')
    expect(row.className).not.toContain('pl-[1.625rem]')

    unmount(app)
  })

  it('opens the gutter for a thread that has a state to show', async () => {
    const { target, app } = render(thread({ status: 'awaiting_approval' }))
    await tick()

    const row = target.querySelector('button') as HTMLElement
    expect(row.className).toContain('pl-[1.625rem]')

    unmount(app)
  })

  it('puts the pin at the head of the meta line, and unpins from it', async () => {
    const { target, app, pinCalls } = render(thread({ pinned: true }))
    await tick()

    const pin = target.querySelector('[role="button"][aria-label="Unpin thread"]') as HTMLElement
    expect(pin).not.toBeNull()
    // The gutter is the state's own column now: the pin is not in it.
    expect(target.querySelector('[aria-label="Completed"]')).toBeNull()

    pin.click()
    expect(pinCalls.map((t) => t.id)).toEqual(['t1'])

    unmount(app)
  })

  it('offers a bookmark removal in the same slot, and puts no pin on a plain row', async () => {
    const bookmarked = render(thread({ bookmarked: true }))
    await tick()
    expect(
      bookmarked.target.querySelector('[role="button"][aria-label="Remove bookmark"]')
    ).not.toBeNull()
    unmount(bookmarked.app)

    const plain = render(thread())
    await tick()
    expect(plain.target.querySelector('[role="button"][aria-label="Unpin thread"]')).toBeNull()
    unmount(plain.app)
  })

  it('anchors the mark column to the top when a rail is drawn', async () => {
    const { target, app } = render(thread({ status: 'awaiting_approval' }))
    await tick()

    const column = target.querySelector('[aria-label="Needs attention"]')
      ?.parentElement as HTMLElement
    // The rail is the flexible child that runs to the row's bottom edge.
    expect(column.className).not.toContain('justify-center')

    unmount(app)
  })

  it('keeps the rail on a thread that is still asking for something', async () => {
    const { target, app } = render(thread({ status: 'awaiting_approval' }))
    await tick()

    const glyph = target.querySelector('[aria-label="Needs attention"]')
    const column = glyph?.parentElement as HTMLElement
    // glyph, rail
    expect(column.children.length).toBe(2)

    unmount(app)
  })

  it('names the state with a glyph, so colour is never the only carrier', async () => {
    const { target, app } = render(thread({ status: 'spec' }))
    await tick()

    const marks = [...target.querySelectorAll('[role="img"]')].map((n) =>
      n.getAttribute('aria-label')
    )
    expect(marks).toContain('Spec ready')

    unmount(app)
  })

  it('rides a draft on top of the working state instead of replacing it', async () => {
    runs.busy.add('p1:t1')
    // A live run needs a bound session, which is what the row reads.
    const { target, app } = render(
      thread({ status: 'executing', read: true, sessionId: 's1' } as Partial<Thread>)
    )
    await tick()

    const marks = [...target.querySelectorAll('[role="img"]')].map((n) =>
      n.getAttribute('aria-label')
    )
    expect(marks).toContain('Working')

    unmount(app)
    runs.busy.delete('p1:t1')
  })

  it('draws every live action in the compact layout as well', async () => {
    speech.recording.add('t1')
    pip.threads.add('t1')
    const { target, app } = render(thread(), { detailed: false, compact: true })

    await tick()
    const statuses = [...target.querySelectorAll('[role="status"]')].map((n) =>
      n.getAttribute('title')
    )
    expect(statuses).toContain('Listening')
    expect(statuses).toContain('Agent using the computer')

    unmount(app)
    speech.recording.delete('t1')
    pip.threads.delete('t1')
  })

  it('names the specification with one mark everywhere it appears', async () => {
    // The user asked for one canonical icon per status. The specification is the
    // case that drifted: a document in some surfaces and a toolbox in others.
    const spec = THREAD_STATE_MARKS.spec.icon
    expect(spec).toBe(THREAD_STATE_MARKS.spec.icon)
    expect(THREAD_GROUP_MARK.Spec.icon).toBe(spec)
    expect(THREAD_STATE_MARKS.spec.colour).toBe(THREAD_GROUP_MARK.Spec.colour)
  })

  it('paints the state glyph in that state colour, and gives every state one', async () => {
    const { target, app } = render(thread({ status: 'spec' }))
    await tick()

    const glyph = target.querySelector('[aria-label="Spec ready"]')
    expect(glyph).not.toBeNull()
    // The glyph wears the state's own colour, so the icon is the colour rather
    // than merely sitting beside it.
    expect((glyph as HTMLElement).getAttribute('style')).toContain(THREAD_STATE_MARKS.spec.colour)
    // It sits above the rail, in one column.
    const column = glyph?.parentElement as HTMLElement
    expect(column.className).toContain('flex-col')

    unmount(app)
    for (const key of Object.keys(THREAD_STATE_MARKS)) {
      const mark = THREAD_STATE_MARKS[key as keyof typeof THREAD_STATE_MARKS]
      expect(mark.icon).toBeTruthy()
      expect(mark.colour).toMatch(/^var\(--/)
      expect(['solid', 'dashed', 'dotted']).toContain(mark.dash)
    }
  })

  it('draws the another-instance mark, not the working hammer, when a run belongs elsewhere', async () => {
    // A window that receives none of another instance's stream holds no live
    // output and no stop control for that run. The pickaxe would promise both,
    // so the spine swaps in the window glyph and keeps the working colour the
    // rest of the app already paints this state with.
    foreign.threads.add('p1:t1')
    runs.settled = true
    runs.busy.add('p1:t1')

    const { target, app } = render(thread({ status: 'executing' }))
    await tick()

    const glyph = target.querySelector('[aria-label="Running in another instance"]')
    expect(glyph).not.toBeNull()
    expect((glyph as HTMLElement).getAttribute('style')).toContain(THREAD_FOREIGN_MARK.colour)
    // The icon is the registry's own, so the row and the badge cannot drift.
    expect(THREAD_FOREIGN_MARK.icon).not.toBe(THREAD_STATE_MARKS.working.icon)
    // The rail still says work is happening, in the working colour.
    const column = glyph?.parentElement as HTMLElement
    expect(column.className).toContain('flex-col')

    unmount(app)
    foreign.threads.delete('p1:t1')
    runs.busy.delete('p1:t1')
    runs.settled = false
  })

  it('names the project on the meta line by its own icon, not a dot', async () => {
    scope.bucket = { id: 'b1', name: 'Future version', color: '#888888', pinned: false }
    const { target, app } = render(thread(), {
      projectName: 'milogs',
      projectIconUrl: 'data:image/svg+xml,%3Csvg/%3E'
    })
    await tick()

    expect(target.querySelector('[data-thread-context-line]')).toBeNull()
    expect(target.querySelector('[title="Future version"]')).not.toBeNull()
    const icon = target.querySelector('img[src^="data:image/svg+xml"]') as HTMLImageElement
    expect(icon).not.toBeNull()
    // It sits on the meta line beside the scope, and the line draws no colour
    // dot in its place: the project is named by its own icon.
    const meta = icon.closest('.col-start-1') as HTMLElement
    expect(meta).not.toBeNull()
    expect(meta.querySelectorAll('span[style*="background-color"]').length).toBe(0)

    unmount(app)
    scope.bucket = null
  })

  it('puts one status rail on the row and no legacy ring slot', async () => {
    const { target, app } = render(thread())
    await tick()

    const rows = target.querySelectorAll('button.flex.flex-col')
    expect(rows.length).toBe(1)

    unmount(app)
  })

  it('rides a waiting status above the thread state, and keeps the state on the rail', async () => {
    runs.busy.add('p1:t1')
    waiting.queue.push(queuedMessage())
    const { target, app } = render(
      thread({ status: 'executing', read: true, sessionId: 's1' } as Partial<Thread>)
    )
    await tick()

    // One mark, two statuses: the glyph is what waits, the rail is what the
    // thread is doing. The thread's own state never leaves the row.
    const glyph = target.querySelector('[aria-label="Working · Message queued"]')
    expect(glyph).not.toBeNull()
    const column = glyph?.parentElement as HTMLElement
    // glyph, rail
    expect(column.children.length).toBe(2)
    const rail = column.children[1] as HTMLElement
    expect(rail).not.toBeNull()
    // A live working rail paints its colour on the inner spans (track + light),
    // not on the rail box itself, so read the painted child.
    const painted = rail.querySelector('[style]') as HTMLElement | null
    expect(painted).not.toBeNull()
    expect(painted?.getAttribute('style')).toContain('var(--color-thread-working)')

    unmount(app)
    waiting.queue.length = 0
    runs.busy.delete('p1:t1')
  })

  it('lets typing take the secondary slot back from the queue', async () => {
    runs.busy.add('p1:t1')
    waiting.queue.push(queuedMessage())
    waiting.typed = true
    const { target, app } = render(
      thread({ status: 'executing', read: true, sessionId: 's1' } as Partial<Thread>)
    )
    await tick()

    // Last action wins: the user is typing, so the pen is what the row has to say
    // now, and the message already queued keeps no glyph of its own.
    expect(target.querySelector('[aria-label="Working · Draft in the composer"]')).not.toBeNull()
    expect(target.querySelector('[aria-label="Working · Message queued"]')).toBeNull()

    unmount(app)
    waiting.typed = false
    waiting.queue.length = 0
    runs.busy.delete('p1:t1')
  })

  it('wears the alarm clock only when the next message waits on another thread', async () => {
    waiting.queue.push(queuedMessage(true))
    const { target, app } = render(thread())
    await tick()

    expect(
      target.querySelector('[aria-label="Completed · Starts after another thread"]')
    ).not.toBeNull()

    unmount(app)
    waiting.queue.length = 0
  })

  it('keeps the clock when a plain message is ahead of a start-after', async () => {
    waiting.queue.push(queuedMessage(), queuedMessage(true))
    const { target, app } = render(thread())
    await tick()

    // The head of the queue is what happens next, so a message that still sends
    // the moment its run stops keeps the plain clock.
    expect(target.querySelector('[aria-label="Completed · Message queued"]')).not.toBeNull()
    expect(
      target.querySelector('[aria-label="Completed · Starts after another thread"]')
    ).toBeNull()

    unmount(app)
    waiting.queue.length = 0
  })

  it('keeps a settled thread quiet under the mark that is waiting', async () => {
    waiting.queue.push(queuedMessage())
    const { target, app } = render(thread())
    await tick()

    const glyph = target.querySelector('[aria-label="Completed · Message queued"]')
    expect(glyph).not.toBeNull()
    // The primary status is settled, so no rail is drawn: the waiting mark and
    // nothing else is in the column, and the row gains no attention for it.
    const column = glyph?.parentElement as HTMLElement
    expect(column.children.length).toBe(1)
    expect(column.className).toContain('justify-center')

    unmount(app)
    waiting.queue.length = 0
  })

  it("says both statuses in the compact row's one mark", async () => {
    waiting.queue.push(queuedMessage())
    const { target, app } = render(thread(), { detailed: false, compact: true })
    await tick()

    // The dot layouts have a single slot, so it wears the waiting mark and names
    // the thread's own state in its title: collapsing the row loses no status.
    expect(target.querySelector('[title="Completed · Message queued"]')).not.toBeNull()

    unmount(app)
    waiting.queue.length = 0
  })
})
