/**
 * The page-side Option-click relay.
 *
 * Option/Alt+click on a link is the app's "take a peek": the link opens in the
 * Peek Window instead of navigating or starting Chromium's own download, which
 * is what an unmodified page would do with that gesture. A gesture inside a page
 * cannot be read from main: a browser tab is a native `WebContentsView`, its
 * clicks never reach the app's DOM, and Electron reports no click with its
 * modifiers. So the page reports it, exactly as the keyboard relay beside this
 * file reports a chord the page left unhandled (`browser-page-keys.ts`) and the
 * history observer reports a swipe (`browser-history-swipe.ts`).
 *
 * The listener sits in an isolated world with no app API exposed (see
 * `docs/EMBEDDED_BROWSER_ARCHITECTURE.md`), so page script cannot see it, forge
 * a report, or remove it. It runs in the capture phase on `window`, before any
 * page handler and before Chromium's own default, and it takes the event rather
 * than letting it through: a peek that also navigated would be two answers to
 * one click, and the link would leave the page the peek grew out of.
 *
 * Only a plain Option/Alt+click on an http(s) link is claimed. Every other
 * modifier combination keeps Chromium's meaning, so Command+click still opens a
 * background tab and a plain click still navigates.
 */

import type { WebContents } from 'electron'
import { Logger } from '../../system/logger'

/** The isolated world the observer lives in, distinct from the swipe's and the keys'. */
const LINK_PEEK_WORLD_ID = 1003
/** Reports a page may hold while main answers the one before them. */
const MAX_QUEUED_REPORTS = 8
/** How long main waits before re-arming a page that refused an evaluation. */
const REARM_DELAY_MS = 150
/** Consecutive failures before a document is abandoned. */
const MAX_ARM_FAILURES = 4
/** The global the waited report is taken from, inside the isolated world. */
const RELAY_GLOBAL = '__cioLinkPeekRelay'

/** One Option-clicked link: the address to peek, and where the click landed. */
export interface BrowserLinkPeekRequest {
  url: string
  /** The click in the page's own CSS pixels. */
  x: number
  y: number
}

/** The observer, installed once per document and idempotent thereafter. */
export function linkPeekInstallScript(): string {
  return String.raw`(() => {
  try {
    if (globalThis[${JSON.stringify(RELAY_GLOBAL)}]) return true;
    const state = { waiters: [], queued: [] };
    const emit = (report) => {
      const resolve = state.waiters.shift();
      if (resolve) resolve(report);
      else if (state.queued.length < ${MAX_QUEUED_REPORTS}) state.queued.push(report);
    };
    // The first anchor on the event's own path wins, and only an http(s) address
    // can be peeked: a mailto: or javascript: link is not a page.
    const linkFor = (path) => {
      for (const target of path) {
        if (!(target instanceof Element)) continue;
        const anchor = typeof target.closest === 'function'
          ? target.closest('a[href], area[href]')
          : null;
        if (!anchor) continue;
        try {
          const url = new URL(anchor.href, location.href);
          if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
          return url.href;
        } catch (error) {
          return null;
        }
      }
      return null;
    };
    window.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      if (event.button !== 0) return;
      const url = linkFor(event.composedPath());
      if (!url) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      emit({ url, x: event.clientX, y: event.clientY });
    }, { capture: true });
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

/** The evaluation that returns the next Option-clicked link the page reports. */
export function linkPeekWaitScript(): string {
  return `(() => { const relay = globalThis[${JSON.stringify(RELAY_GLOBAL)}]; return relay ? relay.wait() : null; })()`
}

/**
 * Read a page's report, which comes from a page and is therefore untrusted:
 * anything without an http(s) address and finite coordinates is no report.
 */
export function parseLinkPeekReport(value: unknown): BrowserLinkPeekRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const url = record['url']
  const x = record['x']
  const y = record['y']
  if (typeof url !== 'string' || typeof x !== 'number' || typeof y !== 'number') return null
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  } catch {
    return null
  }
  return { url, x, y }
}

export interface BrowserLinkPeekDeps {
  /** Called for every Option-clicked link, with the page that reported it. */
  onPeek: (contents: WebContents, request: BrowserLinkPeekRequest) => void
}

interface RelayState {
  pending: boolean
  failures: number
  abandoned: boolean
}

/**
 * Owns one Option-click relay per page: installing it, waiting for its reports,
 * and re-arming after each. Identity of the state object is what tells an answer
 * that belongs to the current document from one a navigation has replaced.
 */
export class BrowserLinkPeek {
  private readonly documents = new WeakMap<WebContents, RelayState>()

  constructor(private readonly deps: BrowserLinkPeekDeps) {}

  /** Install the observer for the document that just arrived. */
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
      .executeJavaScriptInIsolatedWorld(LINK_PEEK_WORLD_ID, [{ code: linkPeekInstallScript() }])
      .then((installed: unknown) => {
        if (installed !== true) throw new Error('link peek relay refused to install')
        return contents.executeJavaScriptInIsolatedWorld(LINK_PEEK_WORLD_ID, [
          { code: linkPeekWaitScript() }
        ])
      })
      .then((answer: unknown) => {
        if (this.documents.get(contents) !== state) return
        state.pending = false
        state.failures = 0
        const request = parseLinkPeekReport(answer)
        if (request) this.deps.onPeek(contents, request)
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
          Logger.dev('Browser link peek relay abandoned a document:', error)
          return
        }
        setTimeout(() => this.arm(contents, state), REARM_DELAY_MS)
      })
  }
}
