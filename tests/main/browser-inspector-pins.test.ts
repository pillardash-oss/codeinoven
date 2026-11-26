// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserInspectorTarget } from '../../src/lib/ipc/browser'
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

interface InstalledInspector {
  run: (command: unknown) => unknown
  wait: () => Promise<{ kind: string; target: BrowserInspectorTarget }>
}

function inspector(): InstalledInspector {
  return (globalThis as unknown as Record<string, InstalledInspector>)[KEY]!
}

beforeEach(() => {
  // A previous test's inspector is still wired into this document unless it is
  // told to cease: its listeners would intercept the next test's clicks.
  const previous = (globalThis as unknown as Record<string, Partial<InstalledInspector>>)[KEY]
  try {
    previous?.run?.({ type: 'cease' })
  } catch {
    // A document that already went away has nothing left to detach.
  }
  for (const host of document.querySelectorAll('[data-cio-inspector]')) host.remove()
  Reflect.deleteProperty(globalThis, KEY)
  document.body.innerHTML = '<div id="otp">Code</div>'
  document.querySelector('#otp')!.getBoundingClientRect = rect
})

describe('a picked element', () => {
  it('reports the page state the comment was written in, not only the element', async () => {
    install()
    const element = document.querySelector('#otp') as HTMLElement
    inspector().run({ type: 'arm' })

    const pending = inspector().wait()
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    const event = await pending

    expect(event.kind).toBe('pick')
    // The page the comment is about: the exact URL including any query and hash,
    // the colour scheme it rendered in, where it was scrolled to, how big the
    // whole document is, and at what zoom it was drawn.
    expect(event.target.page.url).toBe(window.location.href)
    expect(event.target.page.scheme).toBe('light')
    expect(event.target.page.scroll).toEqual({ x: 0, y: 0 })
    // jsdom has no layout, so the document extent is a number rather than a size:
    // the real capture reads it from the rendered document.
    expect(typeof event.target.page.extent.width).toBe('number')
    expect(typeof event.target.page.extent.height).toBe('number')
    expect(event.target.page.devicePixelRatio).toBeGreaterThan(0)
    expect(event.target.page.visualScale).toBeGreaterThan(0)
    // An element in the page itself is not drawn by a canvas, so it reports no
    // framed presentation and its own viewport as the layout it was measured in.
    expect(event.target.presented).toBeNull()
    expect(event.target.viewport).toEqual({ width: window.innerWidth, height: window.innerHeight })
  })

  it('names a transient surface and the identity attributes of what it holds', async () => {
    // A modal's contents are not in the page the agent reads: the surface and its
    // state are what say the element exists only while the dialog is open, and the
    // identity attributes are what keep naming it once it has re-rendered.
    document.body.innerHTML =
      '<dialog id="settings" open><form><button id="save" data-testid="save-plan" aria-expanded="false">Save</button></form></dialog>'
    const button = document.querySelector('#save') as HTMLElement
    button.getBoundingClientRect = rect
    install()
    inspector().run({ type: 'arm' })

    const pending = inspector().wait()
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    const event = await pending

    expect(event.target.identity).toEqual({ 'data-testid': 'save-plan' })
    expect(event.target.state).toEqual({ 'aria-expanded': 'false' })
    expect(event.target.surface?.name).toBe('dialog#settings')
    expect(event.target.surface?.state).toEqual({ open: 'true' })
    expect(event.target.matches).toBe(1)
  })

  it('says when a path is a shape rather than one element', async () => {
    // A path is built from a bounded number of ancestors, so two identical deep
    // subtrees produce one path that names both of them: the count is what tells
    // the agent the path has to be backed by identity attributes or content.
    const branch = (label: string): string => {
      let markup = `<button class="deep">${label}</button>`
      for (let level = 0; level < 9; level += 1) markup = `<div class="level">${markup}</div>`
      return markup
    }
    document.body.innerHTML = branch('A') + branch('B')
    const first = document.querySelector('.deep') as HTMLElement
    first.getBoundingClientRect = rect
    install()
    inspector().run({ type: 'arm' })

    const pending = inspector().wait()
    first.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    const event = await pending

    expect(event.target.matches).toBeGreaterThan(1)
    expect(event.target.surface).toBeNull()
  })

  it('pins a list row exactly while the row is the only thing at that path', async () => {
    document.body.innerHTML =
      '<ul><li class="row"><button class="act">A</button></li><li class="row"><button class="act">B</button></li></ul>'
    const second = document.querySelectorAll('.act')[1] as HTMLElement
    second.getBoundingClientRect = rect
    install()
    inspector().run({ type: 'arm' })

    const pending = inspector().wait()
    second.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    const event = await pending

    expect(event.target.matches).toBe(1)
    expect(event.target.selector).toContain('nth-of-type(2)')
  })
})

describe('a design comment pin', () => {
  it('is drawn from the marker alone, with inspect mode off', () => {
    install()
    expect(pinElements()).toHaveLength(0)

    inspector().run({
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

/**
 * A drawer is a `<dialog>` opened with `showModal()`, and a modal dialog lives in
 * the document's top layer, which paints above every z-index page content can
 * carry. The overlay therefore has to share that layer and stay last in it, or
 * the box and the pins describe the drawer from behind it.
 *
 * jsdom has no popover API, so the two calls are stubbed to record when the
 * overlay joins the top layer and when it is moved to the end of it.
 */
describe('the overlay against the page top layer', () => {
  const calls: string[] = []

  function stubPopoverApi(): void {
    Object.defineProperty(HTMLElement.prototype, 'showPopover', {
      configurable: true,
      writable: true,
      value: () => {
        calls.push('show')
      }
    })
    Object.defineProperty(HTMLElement.prototype, 'hidePopover', {
      configurable: true,
      writable: true,
      value: () => {
        calls.push('hide')
      }
    })
  }

  function unstubPopoverApi(): void {
    Reflect.deleteProperty(HTMLElement.prototype, 'showPopover')
    Reflect.deleteProperty(HTMLElement.prototype, 'hidePopover')
  }

  function overlayHost(): HTMLElement {
    return document.querySelector('[data-cio-inspector]') as HTMLElement
  }

  async function waitFor(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (condition()) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  afterEach(() => {
    unstubPopoverApi()
    calls.length = 0
  })

  it('is a plain overlay on an engine with no popover API', () => {
    install()
    expect(overlayHost().hasAttribute('popover')).toBe(false)
  })

  it('joins the top layer so a drawer cannot cover it', () => {
    stubPopoverApi()
    install()

    expect(overlayHost().getAttribute('popover')).toBe('manual')
    expect(calls).toEqual(['show'])
  })

  it('moves back to the end of the top layer when a drawer opens after it', async () => {
    stubPopoverApi()
    install()
    calls.length = 0
    inspector().run({ type: 'arm' })
    // Arming takes a fresh place in the layer, so the first box drawn is on top
    // of a drawer that opened while the overlay was idle.
    expect(calls).toEqual(['hide', 'show'])
    calls.length = 0

    // A dialog announces itself as a toggle when showModal() runs, and that is
    // the only thing the overlay listens to: it does not watch the page's DOM.
    const dialog = document.createElement('dialog')
    document.body.appendChild(dialog)
    dialog.dispatchEvent(new Event('toggle'))

    await waitFor(() => calls.length === 2)
    expect(calls).toEqual(['hide', 'show'])
  })

  it('does not watch the tree it was injected into', async () => {
    stubPopoverApi()
    install()
    calls.length = 0
    inspector().run({ type: 'arm' })
    calls.length = 0

    // A re-rendering list is the normal state of the pages this overlay is
    // injected into. Watching the tree for surfaces made every one of these
    // nodes cost something; a surface announces itself instead.
    const list = document.createElement('div')
    document.body.appendChild(list)
    for (let index = 0; index < 500; index += 1) {
      const row = document.createElement('div')
      row.textContent = `row ${index}`
      list.appendChild(row)
    }
    await new Promise((resolve) => setTimeout(resolve, 120))

    expect(calls).toEqual([])
  })
})

function shadowElement(selector: string): HTMLElement | null {
  const host = document.querySelector('[data-cio-inspector]')
  return (host?.shadowRoot?.querySelector(selector) as HTMLElement | null) ?? null
}

/**
 * A disabled form control is the one element the browser refuses to report:
 * Chromium dispatches no pointer event to it or through it, so hovering it would
 * otherwise say nothing and the click that comments on it would never arrive.
 */
describe('a control the pointer never reports', () => {
  it('turns the hover state of a disabled control into the news the page has', () => {
    install()
    const style = document.querySelector('style[data-cio-inspector-cursor]') as HTMLStyleElement

    // An animation that paints nothing is what makes that hover state audible,
    // and the selector is a compound so no other element can match it.
    expect(style.textContent).toContain('*:disabled:hover{animation:cio-hover-seen')
    expect(style.textContent).toContain('@keyframes cio-hover-seen{}')
  })

  it('draws the box and takes the pick for a disabled control', async () => {
    document.body.innerHTML = '<button id="locked" disabled>Save</button>'
    const button = document.querySelector('#locked') as HTMLElement
    button.getBoundingClientRect = rect
    install()
    inspector().run({ type: 'arm' })

    const pending = inspector().wait()
    button.dispatchEvent(new Event('animationstart'))
    await new Promise((resolve) => setTimeout(resolve, 80))

    const proxy = shadowElement('[data-cio-hit]')
    expect(proxy).not.toBeNull()
    expect(proxy!.style.display).toBe('block')
    expect(shadowElement('.cio-hover')!.style.display).toBe('block')

    proxy!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    const event = await pending

    expect(event.kind).toBe('pick')
    // The agent is told the control is disabled, which is why it was inspected.
    expect(event.target.state).toEqual({ disabled: 'true' })
    expect(event.target.selector).toContain('#locked')
  })
})

/**
 * The page as a whole is not something a reader comments on.
 *
 * An app root fills the viewport without being html or body, and boxing it drew
 * a gold line around the entire browser that read as the app highlighting its
 * own window. The backdrop stays unmarked whether the pointer is on it or a
 * comment was left on it.
 */
describe('a wrapper that fills the viewport', () => {
  function viewportRect(): DOMRect {
    return {
      x: 0,
      y: 0,
      width: window.innerWidth,
      height: window.innerHeight,
      top: 0,
      left: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
      toJSON: () => ({})
    } as DOMRect
  }

  it('never draws the hover box around it', async () => {
    document.body.innerHTML = '<div id="app"><p id="copy">Hello</p></div>'
    const app = document.querySelector('#app') as HTMLElement
    app.getBoundingClientRect = viewportRect
    install()
    inspector().run({ type: 'arm' })

    app.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(shadowElement('.cio-hover')!.style.display).toBe('none')
    expect(shadowElement('.cio-label')!.style.display).toBe('none')
  })

  it('drops the box once the pointer leaves the page', async () => {
    document.body.innerHTML = '<p id="copy">Hello</p>'
    const copy = document.querySelector('#copy') as HTMLElement
    copy.getBoundingClientRect = rect
    install()
    inspector().run({ type: 'arm' })

    copy.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(shadowElement('.cio-hover')!.style.display).toBe('block')

    document.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }))
    expect(shadowElement('.cio-hover')!.style.display).toBe('none')
  })
})
