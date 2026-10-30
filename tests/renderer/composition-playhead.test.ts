import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The playhead a composition surface reads.
 *
 * These cover the one case the app cannot see from the outside: a composition page
 * that answers from the start of the film when the command was about the second the
 * user was on. That answer used to move the seek head to zero under the user's hands
 * while the picture stayed where it was, on annotating and again on closing the
 * annotation, so the correction is pinned here rather than tested by hand in the app.
 */

type Answer = {
  time: number
  playing: boolean
  duration: number
  loop: boolean
  error: string | null
}

const calls: { command: string; value: unknown }[] = []
let answer: (command: string, value: unknown) => Answer | null = () => null

vi.mock('$lib/ipc.svelte', () => ({
  invoke: (_channel: string, _tabId: string, command: string, value: unknown) => {
    calls.push({ command, value })
    return Promise.resolve(answer(command, value))
  },
  subscribe: () => () => undefined
}))

const { compositionPlayheadFor } = await import('$lib/stores/composition-playhead.svelte')

const playback = (time: number, playing = false): Answer => ({
  time,
  playing,
  duration: 70,
  loop: false,
  error: null
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 80))

let tab = 0
/** A playhead of its own per case, so one case cannot leave a second behind. */
const freshPlayhead = () => compositionPlayheadFor(`test-tab-${(tab += 1)}`)

beforeEach(() => {
  calls.length = 0
  answer = () => null
})

describe('a command answered from the start of the film', () => {
  it('keeps the second the surface was on, and puts the page back on it', async () => {
    const playhead = freshPlayhead()
    answer = () => playback(30)
    await playhead.command('pause')
    expect(playhead.time).toBe(30)

    // The next command re-arms a document that lost its runtime, which draws the
    // first frame and answers with zero.
    answer = (command) => (command === 'seek' ? playback(30) : playback(0))
    await playhead.command('pause')

    expect(playhead.time).toBe(30)
    await settle()
    expect(calls.some((call) => call.command === 'seek' && call.value === 30)).toBe(true)
  })

  it('leaves a play from the start at the start', async () => {
    const playhead = freshPlayhead()
    answer = () => playback(0, true)
    await playhead.command('toggle')
    expect(playhead.time).toBe(0)
    expect(playhead.playing).toBe(true)
  })

  it('lets a stop reach the start', async () => {
    const playhead = freshPlayhead()
    answer = () => playback(30)
    await playhead.command('pause')
    expect(playhead.time).toBe(30)

    answer = () => playback(0)
    await playhead.command('stop')
    expect(playhead.time).toBe(0)
  })

  it('takes an answer that carries the second as it is', async () => {
    const playhead = freshPlayhead()
    answer = () => playback(12)
    await playhead.command('pause')
    answer = () => playback(0.5)
    await playhead.command('pause')
    expect(playhead.time).toBe(0.5)
  })
})

describe('the bar while the page is answering', () => {
  it('shows the run flag the press asked for, before the page answers', async () => {
    const playhead = freshPlayhead()
    answer = () => playback(12)
    await playhead.command('pause')
    expect(playhead.playing).toBe(false)

    // A document that never answers must not leave the button reading "play".
    answer = () => null
    await playhead.command('play')
    expect(playhead.playing).toBe(true)
    expect(playhead.time).toBe(12)

    await playhead.command('pause')
    expect(playhead.playing).toBe(false)
  })

  it('keeps the second through a pause that re-armed the document', async () => {
    const playhead = freshPlayhead()
    answer = () => playback(40)
    await playhead.command('pause')
    answer = (command) => (command === 'seek' ? playback(40) : playback(0))
    await playhead.command('pause')
    expect(playhead.time).toBe(40)
    expect(playhead.playing).toBe(false)
  })
})
