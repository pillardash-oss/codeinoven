import type { WebContents } from 'electron'
import { describe, expect, it } from 'vitest'

import {
  agentCount,
  agentKeyCode,
  dragAgentMouse,
  normalizeAgentModifiers,
  pressAgentKey,
  sendAgentMouse
} from '../../../src/main/browser/browser-service/browser-agent-input'
import {
  reviewBrowserAction,
  type BrowserActionTarget
} from '../../../src/main/browser/browser-service/browser-action-policy'

/**
 * Real input and real review, without an Electron process.
 *
 * The browser's input pipeline is the only thing that makes an agent's click
 * trusted, so what matters here is the sequence and the shape of what is sent.
 * A recorder in place of `WebContents` is enough to hold that contract still.
 */

interface RecordedEvent {
  type: string
  x?: number
  y?: number
  button?: string
  clickCount?: number
  keyCode?: string
  modifiers?: string[]
  deltaX?: number
  deltaY?: number
  canScroll?: boolean
}

function recorder(): { contents: WebContents; events: RecordedEvent[] } {
  const events: RecordedEvent[] = []
  const contents = {
    isDestroyed: () => false,
    sendInputEvent: (event: RecordedEvent) => {
      events.push(event)
    }
  } as unknown as WebContents
  return { contents, events }
}

function target(overrides: Partial<BrowserActionTarget> = {}): BrowserActionTarget {
  return {
    tag: 'button',
    type: 'submit',
    role: '',
    label: 'Submit application',
    name: '',
    href: '',
    download: false,
    expanded: false,
    formMethod: 'post',
    formAction: 'https://jobs.example.com/apply',
    ...overrides
  }
}

describe('agent pointer input', () => {
  it('sends a click as a move, a press and a release at one point', async () => {
    const { contents, events } = recorder()
    await sendAgentMouse(contents, { action: 'click', x: 12, y: 34, modifiers: [] })
    expect(events.map((event) => event.type)).toEqual(['mouseMove', 'mouseDown', 'mouseUp'])
    expect(events.every((event) => event.x === 12 && event.y === 34)).toBe(true)
    expect(events[1]?.button).toBe('left')
  })

  it('sends a hover as a move and nothing else', async () => {
    const { contents, events } = recorder()
    await sendAgentMouse(contents, { action: 'hover', x: 5, y: 6, modifiers: [] })
    expect(events.map((event) => event.type)).toEqual(['mouseMove'])
  })

  it('sends a wheel event with the deltas the page scrolls by', async () => {
    const { contents, events } = recorder()
    await sendAgentMouse(contents, { action: 'wheel', x: 5, y: 6, deltaY: -240, modifiers: [] })
    expect(events.length).toBe(1)
    expect(events[0]).toMatchObject({ type: 'mouseWheel', deltaY: -240, canScroll: true })
  })

  it('interpolates a drag instead of jumping to its end', async () => {
    const { contents, events } = recorder()
    const result = await dragAgentMouse(contents, {
      from: { x: 0, y: 0 },
      to: { x: 300, y: 120 },
      modifiers: []
    })
    expect(result.steps).toBeGreaterThan(2)
    expect(events[0]?.type).toBe('mouseMove')
    // The press arrives after the pointer has settled on the start point, which is
    // what gives the target its hover state before the button goes down.
    expect(events.findIndex((event) => event.type === 'mouseDown')).toBe(2)
    expect(events.at(-1)?.type).toBe('mouseUp')
    expect(events.at(-1)).toMatchObject({ x: 300, y: 120 })
  })
})

describe('agent key input', () => {
  it('sends a character as a key down, a character and a key up', async () => {
    const { contents, events } = recorder()
    await pressAgentKey(contents, { key: 'a', modifiers: [], times: 1 })
    expect(events.map((event) => event.type)).toEqual(['keyDown', 'char', 'keyUp'])
    expect(events.every((event) => event.keyCode === 'a')).toBe(true)
  })

  it('sends a named key without a character event', async () => {
    const { contents, events } = recorder()
    await pressAgentKey(contents, { key: 'Enter', modifiers: [], times: 1 })
    expect(events.map((event) => event.type)).toEqual(['keyDown', 'keyUp'])
    expect(events[0]?.keyCode).toBe('Enter')
  })

  it('repeats a press the requested number of times, bounded', async () => {
    const { contents, events } = recorder()
    const result = await pressAgentKey(contents, { key: 'Tab', modifiers: [], times: 2 })
    expect(result.pressed).toBe(2)
    expect(events.filter((event) => event.type === 'keyDown').length).toBe(2)
    const clamped = await pressAgentKey(contents, { key: 'Tab', modifiers: [], times: 500 })
    expect(clamped.pressed).toBe(20)
  })

  it('carries the held modifiers', async () => {
    const { contents, events } = recorder()
    await pressAgentKey(contents, { key: 'Enter', modifiers: ['meta'], times: 1 })
    expect(events[0]?.modifiers).toEqual(['meta'])
  })

  it('refuses a page that is gone rather than reporting a press that never happened', async () => {
    const contents = { isDestroyed: () => true } as unknown as WebContents
    await expect(pressAgentKey(contents, { key: 'Enter', modifiers: [], times: 1 })).rejects.toThrow()
    expect(agentKeyCode('Escape')).toBe('Escape')
    expect(normalizeAgentModifiers(['cmd'])).toEqual(['meta'])
    expect(agentCount('nonsense', 1, 20)).toBe(1)
  })
})

describe('browser action review for the new operations', () => {
  it('allows pointer movement and a plain scroll', () => {
    expect(reviewBrowserAction('mouse', { action: 'move' }, null).approved).toBe(true)
    expect(reviewBrowserAction('mouse', { action: 'hover' }, null).approved).toBe(true)
    expect(reviewBrowserAction('scroll', {}, null).approved).toBe(true)
  })

  it('reviews a pointer click on the control it lands on', () => {
    expect(reviewBrowserAction('mouse', { action: 'click' }, target()).approved).toBe(false)
    expect(
      reviewBrowserAction(
        'mouse',
        { action: 'click' },
        target({ label: 'Next page', type: 'button', formAction: '' })
      ).approved
    ).toBe(true)
  })

  it('asks before anything that can reach the page as its own script', () => {
    const review = reviewBrowserAction('evaluate', { expression: 'document.title' }, null)
    expect(review.approved).toBe(false)
    expect(review.risk).toBe('high')
  })

  it('lets a caret key through and stops a submit key', () => {
    expect(reviewBrowserAction('press', { key: 'Tab' }, null).approved).toBe(true)
    expect(reviewBrowserAction('press', { key: 'ArrowDown' }, null).approved).toBe(true)
    expect(reviewBrowserAction('press', { key: 'Enter' }, null).approved).toBe(false)
    expect(
      reviewBrowserAction(
        'press',
        { key: 'Enter' },
        target({ tag: 'input', type: 'search', name: 'q', label: 'Search' })
      ).approved
    ).toBe(true)
  })

  it('allows choosing an ordinary option and asks about a consequential one', () => {
    expect(
      reviewBrowserAction(
        'select',
        {},
        target({ tag: 'select', type: '', label: 'Experience level' })
      ).approved
    ).toBe(true)
    expect(
      reviewBrowserAction('select', {}, target({ tag: 'select', type: '', label: 'Delete account' }))
        .approved
    ).toBe(false)
  })
})
