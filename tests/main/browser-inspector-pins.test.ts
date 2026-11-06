// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { inspectorInstallScript } from '../../src/main/browser/browser-service/browser-inspector'

/**
 * The page side of a design comment.
 *
 * The app owns what a pin means; the page only has to draw it. A comment must be
 * an indicator the reader can click even with inspect mode off, because the
 * composer's edit action reopens the page to edit that comment, not to pick a
 * new element. This pins that the marker command alone is enough.
 */

const KEY = 'cio-inspector-test'

function install(): void {
  // A fresh document per test means a fresh install per test.
  ;(0, eval)(inspectorInstallScript(KEY))
}

function rect(): DOMRect {
  return {
    x: 10,
    y: 20,
    width: 120,
    height: 40,
    top: 20,
    left: 10,
    right: 130,
    bottom: 60,
    toJSON: () => ({})
  } as DOMRect
}

function pinElements(): Element[] {
  const host = document.querySelector('[data-cio-inspector]')
  return host?.shadowRoot ? [...host.shadowRoot.querySelectorAll('.cio-pin')] : []
}

beforeEach(() => {
  for (const host of document.querySelectorAll('[data-cio-inspector]')) host.remove()
  Reflect.deleteProperty(globalThis, KEY)
  document.body.innerHTML = '<div id="otp">Code</div>'
  document.querySelector('#otp')!.getBoundingClientRect = rect
})

describe('a design comment pin', () => {
  it('is drawn from the marker alone, with inspect mode off', () => {
    install()
    expect(pinElements()).toHaveLength(0)

    const inspector = (
      globalThis as unknown as { [key: string]: { run: (command: unknown) => unknown } }
    )[KEY]
    inspector.run({
      type: 'markers',
      markers: [{ id: 'marker-one', number: 1, comment: 'Make this bigger', selector: '#otp' }]
    })

    const [pin] = pinElements()
    expect(pin).toBeDefined()
    expect(pin.getAttribute('data-comment')).toBe('1')
    expect((pin as HTMLElement).style.display).toBe('inline-flex')
    expect(pin.getAttribute('aria-label')).toContain('click to edit the comment')
  })
})
