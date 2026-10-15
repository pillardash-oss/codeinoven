/**
 * The page-side keyboard relay.
 *
 * A browser tab is a native `WebContentsView`, so a key pressed in the page never
 * reaches the renderer's DOM handlers: the app's own shortcuts would be dead
 * inside a page, and the last change that stopped claiming chords from a page left
 * them dead with no way back up. The app wants a page that draws its own shortcut
 * to keep it, and a shortcut the page does not handle to still run the app's
 * action. Neither the key nor the page's answer to it is visible in
 * `before-input-event`, so the page itself has to say whether it took the key.
 *
 * This installs one observer per document, in an isolated world, and reports a
 * chord only when the page's own handlers left it unhandled. The world is not
 * reachable from page script (`docs/EMBEDDED_BROWSER_ARCHITECTURE.md` gives
 * remote content no preload), so a page cannot see the listener, forge a report,
 * or remove it. The listener runs in the bubble phase and defers to a microtask,
 * so every page handler, including the document-level one a framework installs,
 * has run and `defaultPrevented` is final. This is the same channel
 * `browser-history-swipe.ts` uses to read a page's own answer to a gesture, and
 * the same one-event-at-a-time contract `browser-inspector.ts` runs.
 *
 * A native editing command (undo, copy) does not mark its `keydown` as handled, so
 * the chord list the renderer publishes simply never carries the editor chords a
 * caret owns. What reaches main is therefore a chord the app can act on without
 * taking the page's own behaviour.
 */

import type { WebContents } from 'electron'
import type { BrowserPageKey } from '../../../lib/ipc/browser'
import { Logger } from '../../system/logger'

/** The isolated world the observer lives in, distinct from the swipe's 1001. */
const PAGE_KEY_WORLD_ID = 1002
/** Reports a page may hold while main answers the one before them. */
const MAX_QUEUED_KEYS = 32
/** How long main waits before re-arming a page that refused an evaluation. */
const REARM_DELAY_MS = 150
/** Consecutive failures before a document is abandoned. */
const MAX_ARM_FAILURES = 4
/** The global the waited report is taken from, inside the isolated world. */
const RELAY_GLOBAL = '__cioPageKeyRelay'

/**
 * The observer, installed once per document and idempotent thereafter.
 *
 * Only a chord with Command, Control or Option/Alt held is considered: every
 * app-global binding carries one, and a plain keystroke is the page's own typing.
 * The report is queued rather than dropped when nothing is waiting, so a chord
 * pressed while main answers the one before it is not lost.
 */
export function pageKeyRelayInstallScript(): string {
  return String.raw`(() => {
  try {
    if (globalThis[${JSON.stringify(RELAY_GLOBAL)}]) return true;
    const state = { waiters: [], queued: [] };
    const emit = (report) => {
      const resolve = state.waiters.shift();
      if (resolve) resolve(report);
      else if (state.queued.length < ${MAX_QUEUED_KEYS}) state.queued.push(report);
    };
    window.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (!event.metaKey && !event.ctrlKey && !event.altKey) return;
      queueMicrotask(() => {
        if (event.defaultPrevented) return;
        emit({
          key: event.key.toLowerCase(),
          code: event.code,
          meta: event.metaKey,
          control: event.ctrlKey,
          shift: event.shiftKey,
          alt: event.altKey,
          repeat: event.repeat
        });
      });
    }, { passive: true });
    Object.defineProperty(globalThis, ${JSON.stringify(RELAY_GLOBAL)}, {
      value: {
        wait: () => new Promise((resolve) => {
          if (state.queued.length > 0) { resolve(state.queued.shift()); return; }
          state.waiters.push(resolve);
        })
      },
      configurable: true,
      enumerable: false,
      writable: false
    });
    return true;
  } catch (error) {
    // A page that froze the globals this installs into: main abandons it.
    return false;
  }
})()`
}

/** The evaluation that returns the next chord the page left unhandled. */
export function pageKeyRelayWaitScript(): string {
  return `(() => { const relay = globalThis[${JSON.stringify(RELAY_GLOBAL)}]; return relay ? relay.wait() : null; })()`
}

export interface BrowserPageKeysDeps {
  /** Called for every chord a page left unhandled, with the page's contents. */
  onKey: (contents: WebContents, key: BrowserPageKey) => void
}

interface RelayState {
  pending: boolean
  failures: number
  abandoned: boolean
}

/**
 * Owns one keyboard relay per page: installing it, waiting for its reports, and
 * re-arming after each. Identity of the state object is what tells an answer that
 * belongs to the current document from one a navigation has already replaced.
 */
export class BrowserPageKeys {
  private readonly documents = new WeakMap<WebContents, RelayState>()

  constructor(private readonly deps: BrowserPageKeysDeps) {}

  /**
   * Install the observer for the document that just arrived.
   *
   * A new document discards the previous state, so a report the old document owed
   * can never be delivered as if it belonged to the new one.
   */
  install(contents: WebContents): void {
    if (contents.isDestroyed()) return
    const state: RelayState = { pending: false, failures: 0, abandoned: false }
    this.documents.set(contents, state)
    this.arm(contents, state)
  }

  /** Stop reporting for a page that is going away. */
  release(contents: WebContents): void {
    const state = this.documents.get(contents)
    if (state) state.abandoned = true
    this.documents.delete(contents)
  }

  private arm(contents: WebContents, state: RelayState): void {
    if (state.pending || state.abandoned || contents.isDestroyed()) return
    if (this.documents.get(contents) !== state) return
    state.pending = true
    contents
      .executeJavaScriptInIsolatedWorld(PAGE_KEY_WORLD_ID, [
        { code: pageKeyRelayInstallScript() }
      ])
      .then((installed: unknown) => {
        if (installed !== true) throw new Error('page keyboard relay refused to install')
        return contents.executeJavaScriptInIsolatedWorld(PAGE_KEY_WORLD_ID, [
          { code: pageKeyRelayWaitScript() }
        ])
      })
      .then((report: unknown) => {
        if (this.documents.get(contents) !== state) return
        state.pending = false
        state.failures = 0
        if (report && typeof report === 'object') {
          this.deps.onKey(contents, report as BrowserPageKey)
        }
        this.arm(contents, state)
      })
      .catch((error: unknown) => {
        if (this.documents.get(contents) !== state) return
        state.pending = false
        if (contents.isDestroyed() || state.abandoned) return
        // A document swap rejects the outstanding promise routinely, so a failure
        // is retried rather than treated as abandon; only a page that keeps
        // refusing is dropped.
        state.failures += 1
        if (state.failures >= MAX_ARM_FAILURES) {
          Logger.dev('Browser page keyboard relay abandoned a document:', error)
          return
        }
        setTimeout(() => this.arm(contents, state), REARM_DELAY_MS)
      })
  }
}
