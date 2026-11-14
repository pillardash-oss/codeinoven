// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AGENT_OWNED_ATTRIBUTE,
  AGENT_REF_ATTRIBUTE,
  agentCheckScript,
  agentCursorScript,
  agentDomClickScript,
  agentElementPointScript,
  agentComboboxScript,
  agentFileInputScript,
  agentFocusScript,
  agentFrameRectsScript,
  agentFrameRevealScript,
  agentPageOffsetScript,
  agentScrollScript,
  agentSelectScript,
  agentSnapshotScript,
  agentTypeScript,
  agentViewportScript,
  type AgentFrameRect
} from '../../../src/main/browser/browser-service/browser-agent-page'
import { agentCursorAppearance } from '../../../src/lib/browser/agent-cursor'
import {
  agentCount,
  agentKeyCode,
  normalizeAgentModifiers
} from '../../../src/main/browser/browser-service/browser-agent-input'

/**
 * The page-side scripts are evaluated expressions, exactly as the browser runs
 * them, so evaluating them here is the closest available stand-in for that
 * boundary. What these check is the contract the agent depends on: a snapshot that
 * reports a real selector, a live value and a stable reference, and typing that a
 * framework-controlled field actually keeps.
 */

interface SnapshotElement {
  ref: string
  selector: string
  tag: string
  label: string
  value?: string
  checked?: boolean
  box: { x: number; y: number; width: number; height: number }
}

interface SnapshotReport {
  text: string
  count: number
  elements: SnapshotElement[]
}

interface TypeReport {
  typed: boolean
  applied?: boolean
  value?: string
  reason?: string
}

function run<T>(source: string): T {
  return new Function(`return (${source})`)() as T
}

function snapshot(
  overrides: Partial<Parameters<typeof agentSnapshotScript>[0]> = {}
): SnapshotReport {
  return run<SnapshotReport>(
    agentSnapshotScript({ interactiveOnly: true, maxElements: 300, maxText: 20000, ...overrides })
  )
}

function elementWith(html: string): HTMLElement {
  document.body.innerHTML = html
  const element = document.body.firstElementChild
  if (!(element instanceof HTMLElement)) throw new Error('fixture missing')
  return element
}

afterEach(() => {
  document.body.innerHTML = ''
  Reflect.deleteProperty(globalThis, '__cioAgentRefSeq')
  Reflect.deleteProperty(globalThis, '__cioAgentCursor')
})

describe('agent snapshot', () => {
  it('reports the value, state and box of the fields a person would fill', () => {
    document.body.innerHTML = `
      <label for="email">Email address</label>
      <input id="email" type="email" name="email" value="leonard@example.com">
      <input id="agree" type="checkbox" name="agree" checked>
      <button type="submit">Send application</button>
    `
    const report = snapshot()
    const email = report.elements.find((element) => element.tag === 'input' && element.value)
    const agree = report.elements.find((element) => element.checked === true)
    const button = report.elements.find((element) => element.tag === 'button')

    expect(email?.value).toBe('leonard@example.com')
    expect(email?.selector).toBe('#email')
    expect(email?.ref).toMatch(/^r\d+$/u)
    expect(agree?.checked).toBe(true)
    expect(button?.label).toBe('Send application')
  })

  it('keeps a reference stable across two reads of the same document', () => {
    elementWith('<input id="first" type="text"><input id="second" type="text">')
    const before = snapshot().elements.find((element) => element.selector === '#second')
    const after = snapshot().elements.find((element) => element.selector === '#second')
    expect(after?.ref).toBe(before?.ref)
  })

  it('writes the reference onto the element so an action can address it by attribute', () => {
    elementWith('<input id="name" type="text">')
    const reported = snapshot().elements[0]
    const found = document.querySelector(`[${AGENT_REF_ATTRIBUTE}="${reported?.ref ?? ''}"]`)
    expect(found).not.toBeNull()
  })

  it('never reports the agent cursor as page content', () => {
    elementWith('<div><button>Continue</button></div>')
    const host = document.createElement('div')
    host.setAttribute(AGENT_OWNED_ATTRIBUTE, 'cursor')
    host.setAttribute('role', 'button')
    host.textContent = 'agent cursor'
    document.body.appendChild(host)
    const report = snapshot()
    expect(report.elements.some((element) => element.label === 'agent cursor')).toBe(false)
  })

  it('redacts a password field and still reports that it holds a value', () => {
    elementWith('<input id="secret" type="password" value="hunter2">')
    const reported = snapshot().elements[0] as SnapshotElement & { valueLength?: number }
    expect(reported.value).toBe('[redacted]')
    expect(reported.valueLength).toBe(7)
  })
})

describe('agent typing', () => {
  it('keeps the text in a field that tracks its own value, as a framework does', () => {
    // React installs its own value setter on the node instance and updates the
    // tracker from it, then fires a change only when the node disagrees with that
    // tracker. Reproducing exactly that is what proves the prototype setter is the
    // path that reaches component state, and that a plain assignment does not.
    document.body.innerHTML = '<input id="title" type="text">'
    const field = document.querySelector('#title')
    if (!(field instanceof HTMLInputElement)) throw new Error('fixture missing')
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
    if (!descriptor?.get || !descriptor.set) throw new Error('the platform has no value accessor')
    let tracker = ''
    Object.defineProperty(field, 'value', {
      configurable: true,
      get(this: HTMLInputElement) {
        return descriptor.get?.call(this) ?? ''
      },
      set(this: HTMLInputElement, next: string) {
        tracker = next
        descriptor.set?.call(this, next)
      }
    })
    let state = ''
    field.addEventListener('input', () => {
      if (field.value !== tracker) state = field.value
    })

    field.value = 'typed by a naive tool'
    expect(state).toBe('')

    const report = run<TypeReport>(
      agentTypeScript({ selector: '#title', text: 'Engineer', append: false })
    )

    expect(report.typed).toBe(true)
    expect(report.applied).toBe(true)
    expect(report.value).toBe('Engineer')
    expect(state).toBe('Engineer')
  })

  it('appends when asked, and replaces when not', () => {
    const field = elementWith('<input id="note" type="text" value="one">') as HTMLInputElement
    run(agentTypeScript({ selector: '#note', text: ' two', append: true }))
    expect(field.value).toBe('one two')
    run(agentTypeScript({ selector: '#note', text: 'three', append: false }))
    expect(field.value).toBe('three')
  })

  it('reports a read-only field instead of pretending to type into it', () => {
    elementWith('<input id="locked" type="text" readonly>')
    const report = run<TypeReport>(
      agentTypeScript({ selector: '#locked', text: 'x', append: false })
    )
    expect(report.typed).toBe(false)
    expect(report.reason).toBe('the field is read-only')
  })

  it('fills an editable element that is not an input', () => {
    const editable = elementWith('<div id="editor" contenteditable="true"></div>')
    const report = run<TypeReport>(
      agentTypeScript({ selector: '#editor', text: 'Hello', append: false })
    )
    expect(report.typed).toBe(true)
    expect(editable.textContent).toBe('Hello')
  })
})

describe('agent controls', () => {
  it('chooses a select option by its visible label and reports it', () => {
    elementWith(
      '<select id="level"><option value="junior">Junior</option><option value="senior">Senior</option></select>'
    )
    const report = run<{ selected: boolean; value: string }>(
      agentSelectScript({ selector: '#level', label: 'Senior' })
    )
    expect(report.selected).toBe(true)
    expect(report.value).toBe('senior')
  })

  it('lists the options when nothing matched, so the agent can pick a real one', () => {
    elementWith('<select id="level"><option value="junior">Junior</option></select>')
    const report = run<{ selected: boolean; options: Array<{ value: string }> }>(
      agentSelectScript({ selector: '#level', value: 'principal' })
    )
    expect(report.selected).toBe(false)
    expect(report.options.map((option) => option.value)).toEqual(['junior'])
  })

  it('ticks a checkbox and reports the state the page kept', () => {
    const checkbox = elementWith('<input id="agree" type="checkbox">') as HTMLInputElement
    const report = run<{ checked: boolean; state: boolean }>(
      agentCheckScript({ selector: '#agree', checked: true })
    )
    expect(report.checked).toBe(true)
    expect(report.state).toBe(true)
    expect(checkbox.checked).toBe(true)
  })

  it('focuses a field and clicks one through its own handler', () => {
    let clicks = 0
    const button = elementWith('<button id="go">Go</button>') as HTMLButtonElement
    button.addEventListener('click', () => {
      clicks += 1
    })
    expect(run<{ clicked: boolean }>(agentDomClickScript('#go')).clicked).toBe(true)
    expect(clicks).toBe(1)
    const field = elementWith('<input id="target" type="text">')
    expect(run<{ focused: boolean }>(agentFocusScript('#target')).focused).toBe(true)
    expect(document.activeElement).toBe(field)
  })

  it('measures the point a click should land on, and notices when something covers it', () => {
    document.body.innerHTML = `
      <button id="start">Start</button>
      <div id="cover"></div>
    `
    // jsdom performs no layout, so the geometry the script measures is supplied
    // here: the same 100x40 box for both nodes, with the overlay on top.
    const box: DOMRect = {
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      top: 0,
      left: 0,
      right: 100,
      bottom: 40,
      toJSON: () => ({})
    }
    Element.prototype.getBoundingClientRect = () => box
    Element.prototype.scrollIntoView = () => undefined
    Object.defineProperty(HTMLElement.prototype, 'checkVisibility', {
      configurable: true,
      value: () => true
    })
    document.elementFromPoint = () => document.getElementById('cover')
    const covered = run<{ found: boolean; coveredBy?: { selector: string } | null }>(
      agentElementPointScript('#start')
    )
    expect(covered.found).toBe(true)
    expect(covered.coveredBy?.selector).toBe('#cover')
    document.elementFromPoint = () => document.getElementById('start')
    const reachable = run<{ found: boolean; coveredBy?: unknown }>(
      agentElementPointScript('#start')
    )
    expect(reachable.coveredBy).toBeNull()
  })

  it('scrolls the page and reports where it ended up', () => {
    document.body.innerHTML = '<div style="height:4000px">long</div>'
    const report = run<{ scrolled: boolean; y: number }>(
      agentScrollScript({ deltaX: 0, deltaY: 600 })
    )
    expect(report.scrolled).toBe(true)
    expect(report.y).toBe(0)
  })
})

/** The shipped appearance: ivory body, obsidian outline, auric ring, no scaling. */
const cursorAppearance = agentCursorAppearance({
  dark: false,
  contrast: 'normal',
  appFontSize: 15
})

describe('agent cursor', () => {
  it('draws one marked node and moves it instead of stacking copies', () => {
    document.body.innerHTML = '<button>Go</button>'
    run(agentCursorScript({ x: 10, y: 20, hide: false, appearance: cursorAppearance }))
    run(agentCursorScript({ x: 30, y: 40, hide: false, appearance: cursorAppearance }))
    const cursors = document.querySelectorAll(`[${AGENT_OWNED_ATTRIBUTE}="cursor"]`)
    expect(cursors.length).toBe(1)
    const host = cursors[0]
    expect(host instanceof HTMLElement ? host.style.left : '').toBe('30px')
    expect(host instanceof HTMLElement ? host.style.pointerEvents : '').toBe('none')
  })

  it('removes it when asked', () => {
    run(agentCursorScript({ x: 1, y: 1, hide: true, appearance: cursorAppearance }))
    expect(document.querySelectorAll(`[${AGENT_OWNED_ATTRIBUTE}="cursor"]`).length).toBe(0)
  })
})

describe('agent key names', () => {
  it('normalises the names a person uses', () => {
    expect(agentKeyCode('enter')).toBe('Enter')
    expect(agentKeyCode('Tab')).toBe('Tab')
    expect(agentKeyCode('arrowleft')).toBe('Left')
    expect(agentKeyCode('f5')).toBe('F5')
    expect(agentKeyCode('a')).toBe('a')
  })

  it('refuses a key it cannot name rather than pressing nothing', () => {
    expect(() => agentKeyCode('Ctrl+Shift+K')).toThrow()
    expect(() => agentKeyCode('')).toThrow()
  })

  it('reads modifiers in the spelling a caller may use', () => {
    expect(normalizeAgentModifiers(['ctrl', 'shift'])).toEqual(['control', 'shift'])
    expect(normalizeAgentModifiers('meta+alt')).toEqual(['meta', 'alt'])
    expect(normalizeAgentModifiers(undefined)).toEqual([])
    expect(() => normalizeAgentModifiers(['hyper'])).toThrow()
  })

  it('clamps a repeat count instead of flooding a page', () => {
    expect(agentCount(3, 1, 20)).toBe(3)
    expect(agentCount(999, 1, 20)).toBe(20)
    expect(agentCount(undefined, 1, 20)).toBe(1)
  })
})

describe('agent snapshot inside a frame', () => {
  it('namespaces every reference with the document it came from', () => {
    document.body.innerHTML = '<button>Save</button><input aria-label="Region" />'
    const first = snapshot({ refPrefix: 'f2' })
    expect(first.elements.map((element) => element.ref)).toEqual(['f2r1', 'f2r2'])
    // Reading again keeps the same handles, so a reference taken from one read
    // still names the same element on the next.
    expect(snapshot({ refPrefix: 'f2' }).elements.map((element) => element.ref)).toEqual([
      'f2r1',
      'f2r2'
    ])
  })

  it('leaves the page its own unprefixed references', () => {
    document.body.innerHTML = '<button>Save</button>'
    expect(snapshot().elements[0]?.ref).toBe('r1')
  })
})

describe('agent frame geometry', () => {
  it('measures every frame a document hosts, in document order', () => {
    document.body.innerHTML = `
      <iframe src="https://example.com/blade" title="Deploy blade"></iframe>
      <iframe src="https://ads.example.com/slot"></iframe>
    `
    const rects = run<AgentFrameRect[]>(agentFrameRectsScript())
    expect(rects.map((rect) => rect.src)).toEqual([
      'https://example.com/blade',
      'https://ads.example.com/slot'
    ])
    expect(rects.map((rect) => rect.index)).toEqual([0, 1])
    expect(rects[0]?.title).toBe('Deploy blade')
  })

  it('reveals a frame before reporting where it landed', () => {
    document.body.innerHTML = '<iframe src="https://example.com/blade"></iframe>'
    const scrollIntoView = vi.fn()
    Reflect.set(Element.prototype, 'scrollIntoView', scrollIntoView)
    try {
      const rect = run<AgentFrameRect | null>(agentFrameRevealScript(0))
      expect(scrollIntoView).toHaveBeenCalledTimes(1)
      expect(rect?.src).toBe('https://example.com/blade')
      expect(rect?.index).toBe(0)
    } finally {
      Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
    }
  })

  it('reports a frame that is no longer there instead of a point', () => {
    document.body.innerHTML = ''
    expect(run<AgentFrameRect | null>(agentFrameRevealScript(3))).toBeNull()
  })

  it('reports the viewport and the page scroll offset it is measured in', () => {
    const viewport = run<{ width: number; height: number }>(agentViewportScript())
    const offset = run<{ x: number; y: number }>(agentPageOffsetScript())
    expect(viewport.width).toBeGreaterThan(0)
    expect(viewport.height).toBeGreaterThan(0)
    expect(offset).toEqual({ x: window.scrollX, y: window.scrollY })
  })
})

interface ComboboxReport {
  found: boolean
  combobox?: boolean
  expanded?: boolean
  listbox?: boolean
  value?: string
  options?: Array<{
    ref: string
    label: string
    value: string
    selected: boolean
    disabled: boolean
  }>
}

describe('agent combobox', () => {
  const originalRect = Element.prototype.getBoundingClientRect

  beforeEach(() => {
    // jsdom lays nothing out, so every control would report itself invisible.
    Element.prototype.getBoundingClientRect = () =>
      ({ x: 0, y: 0, width: 240, height: 32 }) as DOMRect
  })

  afterEach(() => {
    Element.prototype.getBoundingClientRect = originalRect
  })

  it('reports the options an open listbox offers, with references for each', () => {
    document.body.innerHTML = `
      <div role="dialog">
        <input id="region" role="combobox" aria-expanded="true" aria-controls="regions" />
        <ul id="regions" role="listbox">
          <li role="option" data-value="eastus">East US</li>
          <li role="option" data-value="westus2">West US 2</li>
          <li role="option" aria-disabled="true">North Europe</li>
        </ul>
      </div>
    `
    const report = run<ComboboxReport>(
      agentComboboxScript({ selector: '#region', open: false, refPrefix: 'f2' })
    )
    expect(report.combobox).toBe(true)
    expect(report.expanded).toBe(true)
    expect(report.listbox).toBe(true)
    expect(report.options?.map((option) => option.label)).toEqual([
      'East US',
      'West US 2',
      'North Europe'
    ])
    expect(report.options?.map((option) => option.ref)).toEqual(['f2r1', 'f2r2', 'f2r3'])
    expect(report.options?.[2]?.disabled).toBe(true)
  })

  it('opens the control by clicking it and its own combobox ancestor once', () => {
    document.body.innerHTML = `
      <div role="combobox" id="picker">
        <input id="region" aria-expanded="false" />
        <ul role="listbox"><li role="option">East US</li></ul>
      </div>
    `
    let pickerClicks = 0
    let fieldClicks = 0
    const picker = document.querySelector('#picker')
    picker?.addEventListener('click', (event) => {
      // A click on the field bubbles through the wrapper; only a click aimed at the
      // wrapper toggles the list a second time.
      if (event.target === picker) pickerClicks += 1
    })
    const field = document.querySelector('#region')
    field?.addEventListener('click', () => {
      fieldClicks += 1
      // The real control opens its list on its own click.
      field.setAttribute('aria-expanded', 'true')
    })
    const report = run<ComboboxReport>(agentComboboxScript({ selector: '#region', open: true }))
    expect(report.combobox).toBe(true)
    expect(fieldClicks).toBe(1)
    expect(pickerClicks).toBe(0)
  })

  it('does not call a plain text field a combobox', () => {
    document.body.innerHTML = '<input id="name" type="text" />'
    const report = run<ComboboxReport>(agentComboboxScript({ selector: '#name', open: false }))
    expect(report.combobox).toBe(false)
    expect(report.options).toEqual([])
  })

  it('reports a missing control rather than throwing', () => {
    document.body.innerHTML = ''
    expect(run<ComboboxReport>(agentComboboxScript({ selector: '#gone', open: true }))).toEqual({
      found: false
    })
  })
})

describe('agent file input', () => {
  it('reports what the input accepts before anything is attached', () => {
    document.body.innerHTML = '<input id="doc" type="file" multiple accept=".pdf" />'
    const state = run<{ available: boolean; multiple: boolean; accept: string }>(
      agentFileInputScript({ selector: '#doc' })
    )
    expect(state).toEqual({ available: true, multiple: true, accept: '.pdf', disabled: false })
  })

  it('refuses an element that is not a file input', () => {
    document.body.innerHTML = '<input id="name" type="text" />'
    expect(run<{ available: boolean }>(agentFileInputScript({ selector: '#name' }))).toEqual({
      available: false
    })
  })

  it('attaches the files it was given as bytes and fires the events a choice does', () => {
    if (typeof DataTransfer === 'undefined') return
    document.body.innerHTML = '<input id="doc" type="file" multiple />'
    const input = document.querySelector('#doc')
    if (!(input instanceof HTMLInputElement)) throw new Error('fixture missing')
    let changes = 0
    input.addEventListener('change', () => {
      changes += 1
    })
    const report = run<{ available: boolean; attached: number }>(
      agentFileInputScript({
        selector: '#doc',
        files: [{ name: 'rules.pdf', type: 'application/pdf', base64: btoa('document') }]
      })
    )
    expect(report.available).toBe(true)
    expect(report.attached).toBe(1)
    expect(changes).toBe(1)
    expect(input.files?.[0]?.name).toBe('rules.pdf')
    expect(input.files?.[0]?.type).toBe('application/pdf')
  })
})
