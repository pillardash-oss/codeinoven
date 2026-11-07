// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { designStatesScript } from '../../src/main/design/design-states-script'

/**
 * What a screen declares is what the canvas can frame.
 *
 * Discovery is a read: it never clicks, so the only evidence a state exists is the
 * declaration on the control that opens it. These tests pin the policy, because a
 * looser one clicks whatever looks pressable in a page the user is not watching.
 */

interface FoundState {
  click: string
  title: string | null
}

function discover(): FoundState[] {
  return (0, eval)(designStatesScript()) as FoundState[]
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('state discovery', () => {
  it('finds a declared dialog trigger and names it', () => {
    document.body.innerHTML =
      '<button id="open" aria-haspopup="dialog" aria-expanded="false" aria-controls="settings">Settings</button><dialog id="settings"></dialog>'
    expect(discover()).toEqual([{ click: 'button#open', title: 'Settings' }])
  })

  it('ignores a control that is already expanded', () => {
    document.body.innerHTML =
      '<button id="open" aria-expanded="true" aria-controls="menu">Filters</button><div id="menu"></div>'
    expect(discover()).toEqual([])
  })

  it('reads a declared trigger even when only aria-controls names its surface', () => {
    document.body.innerHTML =
      '<button id="open" aria-controls="menu">Filters</button><div id="menu" data-state="closed"></div>'
    expect(discover()).toEqual([{ click: 'button#open', title: 'Filters' }])
  })

  it('never treats the surface itself as the trigger', () => {
    document.body.innerHTML = '<div id="panel" data-state="open" aria-expanded="false">Panel</div>'
    expect(discover()).toEqual([])
  })

  it('ignores a declared trigger that is hidden or disabled', () => {
    document.body.innerHTML =
      '<div hidden><button id="a" aria-expanded="false">A</button></div>' +
      '<button id="b" aria-expanded="false" disabled>B</button>' +
      '<button id="c" aria-expanded="false">C</button>'
    expect(discover()).toEqual([{ click: 'button#c', title: 'C' }])
  })

  it('stops at the per-screen ceiling', () => {
    document.body.innerHTML = Array.from(
      { length: 10 },
      (_, index) => `<button id="b${index}" aria-expanded="false">B${index}</button>`
    ).join('')
    expect(discover()).toHaveLength(6)
  })
})
