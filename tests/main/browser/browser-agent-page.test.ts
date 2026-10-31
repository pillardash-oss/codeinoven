// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import {
  AGENT_OWNED_ATTRIBUTE,
  AGENT_REF_ATTRIBUTE,
  agentCheckScript,
  agentCursorScript,
  agentDomClickScript,
  agentElementPointScript,
  agentFocusScript,
  agentScrollScript,
  agentSelectScript,
  agentSnapshotScript,
  agentTypeScript
} from '../../../src/main/browser/browser-service/browser-agent-page'
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

function snapshot(overrides: Partial<Parameters<typeof agentSnapshotScript>[0]> = {}): SnapshotReport {
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

    const report = run<TypeReport>(agentTypeScript({ selector: '#title', text: 'Engineer', append: false }))

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
    const report = run<TypeReport>(agentTypeScript({ selector: '#locked', text: 'x', append: false }))
    expect(report.typed).toBe(false)
    expect(report.reason).toBe('the field is read-only')
  })

  it('fills an editable element that is not an input', () => {
    const editable = elementWith('<div id="editor" contenteditable="true"></div>')
    const report = run<TypeReport>(agentTypeScript({ selector: '#editor', text: 'Hello', append: false }))
    expect(report.typed).toBe(true)
    expect(editable.textContent).toBe('Hello')
  })
})

describe('agent controls', () => {
  it('chooses a select option by its visible label and reports it', () => {
    elementWith('<select id="level"><option value="junior">Junior</option><option value="senior">Senior</option></select>')
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
    const reachable = run<{ found: boolean; coveredBy?: unknown }>(agentElementPointScript('#start'))
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

describe('agent cursor', () => {
  it('draws one marked node and moves it instead of stacking copies', () => {
    document.body.innerHTML = '<button>Go</button>'
    run(agentCursorScript({ x: 10, y: 20, press: true, hide: false }))
    run(agentCursorScript({ x: 30, y: 40, press: false, hide: false }))
    const cursors = document.querySelectorAll(`[${AGENT_OWNED_ATTRIBUTE}="cursor"]`)
    expect(cursors.length).toBe(1)
    const host = cursors[0]
    expect(host instanceof HTMLElement ? host.style.left : '').toBe('30px')
    expect(host instanceof HTMLElement ? host.style.pointerEvents : '').toBe('none')
  })

  it('removes it when asked', () => {
    run(agentCursorScript({ x: 1, y: 1, press: false, hide: true }))
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
