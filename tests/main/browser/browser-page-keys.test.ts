// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

// The relay's only dependency is the logger, and the main-process logger reaches
// `fs` and `path`, which a jsdom run externalizes.
vi.mock('../../../src/main/system/logger', () => ({ Logger: { dev: () => {} } }))

import {
  pageKeyRelayInstallScript,
  pageKeyRelayWaitScript
} from '../../../src/main/browser/browser-service/browser-page-keys'

/**
 * The injected page observer is what makes an app shortcut survive a page that
 * does not handle it, and it is the only part of the browser keyboard path that
 * runs page-side code. These exercise the script itself: it reports a chord the
 * page's handlers left alone, and stays silent for one they took.
 */

function runScript(source: string): unknown {
  // The injected source is an evaluated expression, exactly as the isolated world
  // receives it; evaluating it here is the closest thing to that boundary.
  return new Function(`return (${source})`)()
}

function install(): void {
  expect(runScript(pageKeyRelayInstallScript())).toBe(true)
}

function nextReport(): Promise<unknown> {
  return runScript(pageKeyRelayWaitScript()) as Promise<unknown>
}

function press(init: KeyboardEventInit): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
}

/** A macrotask boundary, so the observer's deferred microtask has certainly run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  // Each test needs a fresh observer; the global is the install's own guard.
  Reflect.deleteProperty(globalThis, '__cioPageKeyRelay')
})

describe('page key relay', () => {
  it('reports a modifier chord the page left unhandled', async () => {
    install()
    const report = nextReport()
    press({ key: 'k', code: 'KeyK', metaKey: true })
    await expect(report).resolves.toMatchObject({ key: 'k', code: 'KeyK', meta: true })
  })

  it('stays silent for a chord the page prevented', async () => {
    install()
    window.addEventListener(
      'keydown',
      (event) => {
        if ((event as KeyboardEvent).key === 's') event.preventDefault()
      },
      { once: true }
    )
    const report = nextReport()
    press({ key: 's', code: 'KeyS', metaKey: true })
    // A second, unhandled chord proves the first was skipped rather than merely
    // queued behind it.
    press({ key: 'k', code: 'KeyK', metaKey: true })
    await expect(report).resolves.toMatchObject({ key: 'k' })
  })

  it('ignores a bare key, which is the page’s own typing', async () => {
    install()
    const report = nextReport()
    press({ key: 'a', code: 'KeyA' })
    press({ key: 'n', code: 'KeyN', altKey: true })
    await expect(report).resolves.toMatchObject({ key: 'n', alt: true })
  })

  it('keeps a report that arrives while nothing is waiting', async () => {
    install()
    press({ key: 'j', code: 'KeyJ', ctrlKey: true })
    await settle()
    await expect(nextReport()).resolves.toMatchObject({ key: 'j', control: true })
  })
})
