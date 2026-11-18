// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  agentDomClickScript,
  agentElementPointScript,
  agentEvaluateScript,
  agentFieldValueScript,
  agentLayersScript,
  agentQueryScript,
  agentSnapshotScript
} from '../../../src/main/browser/browser-service/browser-agent-page'

/**
 * A page is not a flat document of HTML elements, and these are the cases that
 * proved it: a control a web component drew inside a shadow root, an SVG icon a
 * pointer can press, a clickable div with no role at all, and a floating layer drawn
 * over the form the agent is filling.
 *
 * Every script is evaluated the way the page receives it, so this is the closest
 * available stand-in for the boundary between the app and a stranger's document.
 */

interface ElementReport {
  ref: string
  selector: string
  tag: string
  role: string
  label: string
  visible: boolean
  value?: string
  shadow?: boolean
  layer?: string
  aria?: Record<string, string>
}

interface SnapshotReport {
  elements: ElementReport[]
  layers?: Array<{ role: string; selector: string; label: string }>
  shadowRoots?: number
  count: number
}

interface QueryReport {
  found: boolean
  count: number
  elements: Array<{
    ref: string
    selector: string
    tag: string
    attributes?: Record<string, string>
    properties?: Record<string, unknown>
    style?: Record<string, string>
    accessibility?: {
      role: string
      name: string
      states: Record<string, string>
      focusable: boolean
    }
    text: string
  }>
}

function run<T>(source: string): T {
  return new Function(`return (${source})`)() as T
}

/** jsdom performs no layout, so every fixture is given the geometry the scripts measure. */
const box = {
  x: 0,
  y: 0,
  width: 120,
  height: 40,
  top: 0,
  left: 0,
  right: 120,
  bottom: 40,
  toJSON: () => ({})
} as DOMRect

beforeEach(() => {
  Element.prototype.getBoundingClientRect = () => box
  Element.prototype.scrollIntoView = () => undefined
  Object.defineProperty(HTMLElement.prototype, 'checkVisibility', {
    configurable: true,
    value: () => true
  })
})

afterEach(() => {
  document.body.innerHTML = ''
  Reflect.deleteProperty(globalThis, '__cioAgentRefSeq')
  Reflect.deleteProperty(globalThis, '__cioAgentRefStore')
  Reflect.deleteProperty(globalThis, '__cio')
})

function shadowHost(html: string): HTMLElement {
  document.body.innerHTML = '<my-panel></my-panel>'
  const host = document.body.firstElementChild
  if (!(host instanceof HTMLElement)) throw new Error('fixture missing')
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = html
  return host
}

function snapshot(overrides: Partial<Parameters<typeof agentSnapshotScript>[0]> = {}) {
  return run<SnapshotReport>(
    agentSnapshotScript({ interactiveOnly: true, maxElements: 300, maxText: 0, ...overrides })
  )
}

describe('a page made of shadow roots', () => {
  it('reports a control a web component drew, with a selector across the boundary', () => {
    const host = shadowHost('<button id="deploy">Deploy</button>')
    const report = snapshot()
    const button = report.elements.find((element) => element.label === 'Deploy')
    expect(button).toBeDefined()
    expect(button?.shadow).toBe(true)
    expect(button?.selector).toContain('>>> #deploy')
    expect(report.shadowRoots).toBe(1)
    // The reported path is one the toolkit resolves back to the same element.
    const read = run<{ found: boolean; value: string }>(
      agentFieldValueScript(button?.selector ?? '')
    )
    expect(read.found).toBe(true)
    expect(host.shadowRoot?.getElementById('deploy')?.textContent).toBe('Deploy')
  })

  it('acts on a reference from inside a shadow root, which no CSS selector reaches', () => {
    shadowHost('<input id="name" value="Lagos" />')
    const report = snapshot({ interactiveOnly: false })
    const field = report.elements.find((element) => element.tag === 'input')
    expect(field?.ref).toBeDefined()
    const read = run<{ found: boolean; value: string }>(agentFieldValueScript(field?.ref ?? ''))
    expect(read.found).toBe(true)
    expect(read.value).toBe('Lagos')
  })

  it('measures a control inside a shadow root as reachable, not covered by its own host', () => {
    const host = shadowHost('<button id="inner">Open</button>')
    const inner = host.shadowRoot?.getElementById('inner') ?? null
    // The browser reports the host at the point; the deep hit test descends into it,
    // which is exactly the difference between a trusted click and a refused one.
    document.elementFromPoint = () => host
    if (host.shadowRoot) {
      host.shadowRoot.elementFromPoint = () => inner
    }
    const point = run<{ found: boolean; coveredBy: unknown }>(
      agentElementPointScript('my-panel >>> #inner')
    )
    expect(point.found).toBe(true)
    expect(point.coveredBy).toBeNull()
  })

  it('clicks a control inside a shadow root through the composed event path', () => {
    const host = shadowHost('<div id="card">Card</div>')
    const card = host.shadowRoot?.getElementById('card') ?? null
    let seen = 0
    let composed = false
    card?.addEventListener('click', (event) => {
      seen += 1
      composed = event.composed
    })
    const result = run<{ clicked: boolean }>(agentDomClickScript('my-panel >>> #card'))
    expect(result.clicked).toBe(true)
    expect(seen).toBe(1)
    expect(composed).toBe(true)
  })
})

describe('elements a flat query cannot see', () => {
  it('reports a clickable div that carries no role and no interactive tag', () => {
    document.body.innerHTML = '<div onclick="void 0" data-id="7">Approve order</div>'
    const report = snapshot({ interactiveOnly: false })
    const card = report.elements.find((element) => element.label === 'Approve order')
    expect(card).toBeDefined()
    expect(card?.tag).toBe('div')
  })

  it('clicks an SVG path, which has no click method of its own', () => {
    document.body.innerHTML =
      '<div id="chart"><svg role="img" aria-label="Revenue"><g><path id="bar" d="M0 0 L10 10"></path></g></svg></div>'
    const path = document.getElementById('bar')
    if (!path) throw new Error('fixture missing')
    let clicks = 0
    path.addEventListener('click', () => {
      clicks += 1
    })
    const report = snapshot()
    expect(report.elements.some((element) => element.tag === 'svg')).toBe(true)
    const result = run<{ clicked: boolean }>(agentDomClickScript('#bar'))
    expect(result.clicked).toBe(true)
    expect(clicks).toBe(1)
  })
})

describe('floating layers', () => {
  it('names the layer an open menu draws its controls in', () => {
    document.body.innerHTML = `
      <main><button id="trigger">Sort</button></main>
      <div role="menu" aria-label="Sort by"><button id="newest">Newest</button></div>
    `
    const report = snapshot()
    const item = report.elements.find((element) => element.label === 'Newest')
    expect(item?.layer).toBe('menu')
    expect(report.layers?.[0]?.role).toBe('menu')
    const layers = run<{ count: number; layers: Array<{ role: string; ref: string }> }>(
      agentLayersScript()
    )
    expect(layers.count).toBe(1)
    expect(layers.layers[0]?.role).toBe('menu')
    expect(layers.layers[0]?.ref).toMatch(/^r\d+$/u)
  })
})

describe('query', () => {
  it('reads every attribute, a property path, a style value and the accessibility description', () => {
    document.body.innerHTML =
      '<button id="go" data-state="busy" aria-label="Deploy now" aria-expanded="true">Deploy</button>'
    const report = run<QueryReport>(
      agentQueryScript({
        selector: '#go',
        properties: ['id', 'ownerDocument.title'],
        style: ['display'],
        outerHtml: 200
      })
    )
    expect(report.found).toBe(true)
    const element = report.elements[0]
    expect(element?.attributes?.['data-state']).toBe('busy')
    expect(element?.properties?.['id']).toBe('go')
    expect(typeof element?.style?.['display']).toBe('string')
    expect(element?.accessibility?.role).toBe('button')
    expect(element?.accessibility?.name).toBe('Deploy now')
    expect(element?.accessibility?.states['expanded']).toBe('true')
  })

  it('finds elements by role and by tag across shadow roots', () => {
    const host = shadowHost('<svg role="img" aria-label="Chart"><path d="M0 0"></path></svg>')
    const byRole = run<QueryReport>(agentQueryScript({ role: 'img' }))
    expect(byRole.count).toBe(1)
    expect(byRole.elements[0]?.tag).toBe('svg')
    const byTag = run<QueryReport>(agentQueryScript({ tag: 'path' }))
    expect(byTag.count).toBe(1)
    expect(byTag.elements[0]?.selector).toContain(host.tagName.toLowerCase())
  })

  it('reports nothing rather than throwing when the element is gone', () => {
    document.body.innerHTML = '<div></div>'
    const report = run<QueryReport>(agentQueryScript({ selector: '#gone' }))
    expect(report.found).toBe(false)
    expect(report.elements).toEqual([])
  })
})

describe('evaluate', () => {
  it('runs with the page toolkit on the global, so an expression reaches a shadow root', async () => {
    shadowHost('<span id="total">42</span>')
    const result = await run<Promise<{ ok: boolean; value: unknown }>>(
      agentEvaluateScript('__cio.deep("#total").textContent')
    )
    expect(result.ok).toBe(true)
    expect(result.value).toBe('42')
  })

  it('describes the element an expression returns instead of serialising a DOM node', async () => {
    document.body.innerHTML = '<button id="go">Go</button>'
    const result = await run<Promise<{ ok: boolean; value: unknown }>>(
      agentEvaluateScript('document.getElementById("go")')
    )
    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({ element: '#go', ref: expect.stringMatching(/^r\d+$/u) })
  })

  it('reports the page error instead of failing the call', async () => {
    const result = await run<Promise<{ ok: boolean; error: string }>>(
      agentEvaluateScript('document.nope.nope')
    )
    expect(result.ok).toBe(false)
    expect(typeof result.error).toBe('string')
  })
})
