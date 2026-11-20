// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  promptFlight,
  promptLanding,
  promptFlightTravel
} from '$lib/components/chats/chat-composer-prompt-flight.svelte'

const EDITOR_ID = 'chat-composer-project-1-thread-1'

type Box = { left: number; top: number; width: number; height: number }

function stubRect(element: Element, box: Box): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    ...box,
    x: box.left,
    y: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
    toJSON: () => box
  })
}

/** The composer's draft editor and the row it will hand the words to. */
function mountSurface(draft: Box, landing: Box): { block: HTMLElement; editor: HTMLElement } {
  document.body.innerHTML = `
    <div id="${EDITOR_ID}"></div>
    <div class="message-block"><div data-conversation-searchable></div></div>
  `
  const editor = document.getElementById(EDITOR_ID)
  const target = document.querySelector('[data-conversation-searchable]')
  if (!editor || !target) throw new Error('surface not mounted')
  stubRect(editor, draft)
  stubRect(target, landing)
  const block = document.querySelector<HTMLElement>('.message-block')
  if (!block) throw new Error('row not mounted')
  return { block, editor }
}

const DRAFT: Box = { left: 300, top: 620, width: 480, height: 64 }
const LANDING: Box = { left: 300, top: 500, width: 480, height: 48 }

/** jsdom has no box for a range, so every range reads as empty and the store falls
 *  back to the editor's own rect   the path a browser only takes when the draft
 *  really is empty. */
beforeAll(() => {
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: 0, top: 0, width: 0, height: 0 })
  })
})

afterEach(() => {
  if (promptFlight.flight) promptFlight.finish(promptFlight.flight.id)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('a prompt leaving the composer', () => {
  it('flies to the row it belongs to and holds the row invisible until it lands', () => {
    vi.useFakeTimers({ now: 1_000 })
    const { block } = mountSurface(DRAFT, LANDING)

    promptFlight.depart(EDITOR_ID, 'Try to search now, I worked on some fixes')
    const config = promptLanding(block, { createdAt: 2_000, viewAttachedAt: 1_000 })

    expect(promptFlight.flight?.text).toBe('Try to search now, I worked on some fixes')
    expect(promptFlightTravel(promptFlight.flight!)).toEqual({ x: 0, y: 120 })
    // The row waits, then fades in under the words: the transcript never shows
    // the message twice and never shows neither.
    expect(config.delay).toBe(150)
    expect(config.duration).toBe(120)
    expect(config.css?.(0, 1)).toBe('opacity:0')
    expect(config.css?.(1, 0)).toBe('opacity:1')
  })

  it('hands the words over once, so a second row plays the quiet rise instead', () => {
    vi.useFakeTimers({ now: 1_000 })
    const { block } = mountSurface(DRAFT, LANDING)

    promptFlight.depart(EDITOR_ID, 'First')
    promptLanding(block, { createdAt: 2_000, viewAttachedAt: 1_000 })
    const second = promptLanding(block, { createdAt: 2_000, viewAttachedAt: 1_000 })

    expect(second.duration).toBe(160)
    expect(promptFlight.flight?.text).toBe('First')
  })

  it('drops a departure the transcript took too long to mount', () => {
    vi.useFakeTimers({ now: 1_000 })
    const { block } = mountSurface(DRAFT, LANDING)

    promptFlight.depart(EDITOR_ID, 'Queued while the thread was busy')
    vi.setSystemTime(3_000)
    const config = promptLanding(block, { createdAt: 2_000, viewAttachedAt: 1_000 })

    expect(promptFlight.flight).toBeNull()
    expect(config.duration).toBe(160)
  })

  it('never flies history the view mounted rather than sent', () => {
    const { block } = mountSurface(DRAFT, LANDING)

    promptFlight.depart(EDITOR_ID, 'Old words')
    const config = promptLanding(block, { createdAt: 900, viewAttachedAt: 1_000 })

    expect(config.duration).toBe(0)
    expect(promptFlight.flight).toBeNull()
  })

  it('flies nothing when the row landed off screen, or when motion is reduced', () => {
    const { block } = mountSurface(DRAFT, { ...LANDING, top: 4_000 })

    promptFlight.depart(EDITOR_ID, 'Out of view')
    expect(promptLanding(block, { createdAt: 2_000, viewAttachedAt: 1_000 }).duration).toBe(160)

    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
    mountSurface(DRAFT, LANDING)
    promptFlight.depart(EDITOR_ID, 'Reduced motion')
    expect(promptLanding(block, { createdAt: 2_000, viewAttachedAt: 1_000 }).duration).toBe(0)
    expect(promptFlight.flight).toBeNull()
  })

  it('records nothing when the composer holds no words to hand over', () => {
    const { block } = mountSurface(DRAFT, LANDING)

    promptFlight.depart(EDITOR_ID, '   ')
    expect(promptLanding(block, { createdAt: 2_000, viewAttachedAt: 1_000 }).duration).toBe(160)
    expect(promptFlight.flight).toBeNull()
  })
})
