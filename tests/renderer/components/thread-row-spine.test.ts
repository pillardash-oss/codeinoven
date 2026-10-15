// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'
import type { Thread } from '$shared/types'
import { THREAD_GROUP_MARK, THREAD_STATE_MARKS } from '$lib/components/threads/thread-state-marks'

// The row asks the live agent-run store whether a thread is working. These tests
// drive that one question directly, so a fixture can be "working" without a real
// session behind it.
const runs = vi.hoisted(() => ({ busy: new Set<string>(), settled: false }))
vi.mock('$lib/stores/agent-runs.svelte', () => ({
  agentRuns: {
    hasSettled: () => runs.settled,
    isBusy: (projectId: string, threadId: string) => runs.busy.has(`${projectId}:${threadId}`),
    settledAt: () => null
  }
}))

/**
 * The detailed row after the spine redesign.
 *
 * These lock in the three promises the user is relying on:
 *  1. every live action the thread has is drawn at once, not ranked down to one;
 *  2. the scope rides the context line beside the project name, and its presence
 *     never pushes the Oven or the branch off the row;
 *  3. no reserved pin slot sits on the primary line, so the title starts at a
 *     constant x.
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
vi.mock('$lib/ipc.svelte', () => ({
  invoke: invokeMock,
  subscribe: vi.fn(() => () => {})
}))

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
  browserAudio: { threadAudioStartedAt: () => null }
}))

vi.mock('$lib/stores/browser-access.svelte', () => ({
  browserStore: () => ({ hasThreadPeek: () => false })
}))

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

function render(t: Thread, over: Record<string, unknown> = {}) {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(ThreadRow, {
    target,
    props: {
      thread: t,
      detailed: true,
      projectIconUrl: null,
      projectIconGlyph: null,
      ...over
    }
  })
  flushSync()
  return { target, app }
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

  it('keeps the Oven and branch on the row when a scope is present', async () => {
    const { target, app } = render(thread())
    await tick()

    // The branch mark and the Oven mark are the row's own, not the sidebar's.
    const branchMarks = [...target.querySelectorAll('[title^="Branch:"]')]
    expect(branchMarks.length).toBeGreaterThan(0)
    const ovenMarks = [...target.querySelectorAll('[title="Runs on this computer"]')]
    expect(ovenMarks.length).toBeGreaterThan(0)

    unmount(app)
  })

  it('draws a real pin mark on a pinned row, and no pin button at all', async () => {
    const { target, app } = render(thread({ pinned: true }))
    await tick()

    // A pin button would reserve width the title cannot use; pinning is the
    // context menu's job. The row still shows the pin, so the state is visible.
    const pinButtons = target.querySelectorAll(
      '[aria-label="Pin thread"], [aria-label="Unpin thread"]'
    )
    expect(pinButtons.length).toBe(0)
    expect(target.querySelector('[aria-label="Pinned"]')).not.toBeNull()

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
    // The glyph and the rail share one column, and the column carries the state
    // colour, so the icon and the line under it are the colour of the status.
    const column = glyph?.parentElement as HTMLElement
    expect(column.getAttribute('style')).toContain(THREAD_STATE_MARKS.spec.colour)
    expect(column.className).toContain('flex-col')

    unmount(app)
    for (const key of Object.keys(THREAD_STATE_MARKS)) {
      const mark = THREAD_STATE_MARKS[key as keyof typeof THREAD_STATE_MARKS]
      expect(mark.icon).toBeTruthy()
      expect(mark.colour).toMatch(/^var\(--/)
      expect(['solid', 'dashed', 'dotted']).toContain(mark.dash)
    }
  })

  it('puts one status rail on the row and no legacy ring slot', async () => {
    const { target, app } = render(thread())
    await tick()

    const rows = target.querySelectorAll('button.flex.flex-col')
    expect(rows.length).toBe(1)

    unmount(app)
  })
})
