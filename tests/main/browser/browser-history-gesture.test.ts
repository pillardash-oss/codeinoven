import { describe, expect, it } from 'vitest'
import {
  classifyHistoryGesture,
  readHistoryGestureFacts,
  type HistoryGestureFacts
} from '../../../src/main/browser/browser-service/browser-history-gesture'

function facts(overrides: Partial<HistoryGestureFacts> = {}): HistoryGestureFacts {
  return {
    gesture: 1,
    startedAt: 1_700_000_000_000,
    horizontal: -200,
    vertical: 0,
    momentum: false,
    wheelDetents: 0,
    events: 20,
    pageOwns: false,
    ...overrides
  }
}

describe('history gesture policy', () => {
  it('walks back for a leftward trackpad swipe on macOS', () => {
    expect(classifyHistoryGesture(facts({ momentum: true }), 'darwin')).toBe('back')
  })

  it('walks forward for a rightward trackpad swipe on macOS', () => {
    expect(classifyHistoryGesture(facts({ momentum: true, horizontal: 200 }), 'darwin')).toBe(
      'forward'
    )
  })

  it('refuses a gesture without inertia on macOS, however its steps were shaped', () => {
    // The tilt wheel and Logitech smooth scrolling both land here: plenty of
    // travel, plausible steps, and never the inertia a trackpad produces.
    expect(classifyHistoryGesture(facts({ momentum: false }), 'darwin')).toBeNull()
    expect(
      classifyHistoryGesture(facts({ momentum: false, wheelDetents: 0, events: 40 }), 'darwin')
    ).toBeNull()
  })

  it('refuses travel that is too short to be a deliberate swipe', () => {
    expect(classifyHistoryGesture(facts({ momentum: true, horizontal: -120 }), 'darwin')).toBeNull()
  })

  it('refuses a diagonal gesture the page has a pan of its own for', () => {
    expect(classifyHistoryGesture(facts({ momentum: true, vertical: 120 }), 'darwin')).toBeNull()
  })

  it('refuses a gesture the page had already claimed', () => {
    expect(classifyHistoryGesture(facts({ momentum: true, pageOwns: true }), 'darwin')).toBeNull()
  })

  it('recognises a tick-based wheel swipe where no momentum is reported', () => {
    expect(classifyHistoryGesture(facts({ events: 24 }), 'win32')).toBe('back')
  })

  it('refuses a tilt wheel where no momentum is reported', () => {
    expect(classifyHistoryGesture(facts({ wheelDetents: 2 }), 'win32')).toBeNull()
  })

  it('refuses travel reached by a handful of steps where no momentum is reported', () => {
    expect(classifyHistoryGesture(facts({ events: 3 }), 'linux')).toBeNull()
  })
})

describe('history gesture report reading', () => {
  it('accepts a report whose every fact has the right type', () => {
    expect(readHistoryGestureFacts(facts())).toEqual(facts())
  })

  it('refuses a report missing a fact', () => {
    const partial: unknown = { ...facts(), momentum: undefined }
    expect(readHistoryGestureFacts(partial)).toBeNull()
  })

  it('refuses a report whose travel is not a number', () => {
    expect(readHistoryGestureFacts({ ...facts(), horizontal: '200' })).toBeNull()
  })

  it('refuses a report that is not an object', () => {
    expect(readHistoryGestureFacts(null)).toBeNull()
    expect(readHistoryGestureFacts('gesture')).toBeNull()
  })

  it('refuses a report without the time its gesture began', () => {
    expect(readHistoryGestureFacts({ ...facts(), startedAt: undefined })).toBeNull()
    expect(readHistoryGestureFacts({ ...facts(), startedAt: 'now' })).toBeNull()
  })
})
