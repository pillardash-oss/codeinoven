// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'
import type { Thread } from '$shared/types'

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

  it('reserves no pin slot, so the primary line starts at the title', async () => {
    const { target, app } = render(thread({ pinned: true }))
    await tick()

    const pinButtons = target.querySelectorAll('[aria-label="Pin thread"], [aria-label="Unpin thread"]')
    expect(pinButtons.length).toBe(0)

    unmount(app)
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

  it('puts one status rail on the row and no legacy ring slot', async () => {
    const { target, app } = render(thread())
    await tick()

    const rows = target.querySelectorAll('button.flex.flex-col')
    expect(rows.length).toBe(1)

    unmount(app)
  })
})
