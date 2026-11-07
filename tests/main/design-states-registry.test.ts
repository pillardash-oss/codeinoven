import { describe, expect, it } from 'vitest'
import {
  hasScreenStates,
  knownScreenStates,
  rememberScreenStates
} from '../../src/main/design/design-states-registry'

/**
 * A discovered state is only valid for the version of the design it was read from.
 *
 * The canvas generates its page on a request and cannot wait for a browser, so the
 * registry answers synchronously. That makes the stamp the whole safety story: a
 * state whose trigger has since been renamed would click nothing, and a state of an
 * older design must never be framed as if it were current.
 */

describe('discovered design states', () => {
  it('answers with the states of the design it read', () => {
    rememberScreenStates('/design/a', 10, [
      { entry: 'index.html', click: 'button#open', title: 'Settings' }
    ])
    expect(knownScreenStates('/design/a', 10)).toEqual([
      { entry: 'index.html', click: 'button#open', title: 'Settings' }
    ])
    expect(hasScreenStates('/design/a', 10)).toBe(true)
  })

  it('answers nothing for a version it has not read', () => {
    rememberScreenStates('/design/b', 10, [])
    expect(knownScreenStates('/design/b', 11)).toEqual([])
    expect(hasScreenStates('/design/b', 11)).toBe(false)
  })

  it('remembers that a design declares no states, so it is not read again', () => {
    rememberScreenStates('/design/c', 7, [])
    expect(knownScreenStates('/design/c', 7)).toEqual([])
    expect(hasScreenStates('/design/c', 7)).toBe(true)
  })
})
