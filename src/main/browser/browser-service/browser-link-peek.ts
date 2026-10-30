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
 *
 * A page's own document is not the whole page. Every subframe a site embeds (a
 * checkout, a dashboard widget, an embedded editor) handles its own clicks, and
 * an event inside one never reaches the top document's listener: the link in it
 * kept Chromium's Option-click meaning, which is a download of the page. So the
 * observer is installed in every frame a page holds, and each frame's document
 * re-arms itself when it loads, the same way the top one does.
 */

import type { WebContents, WebFrameMain } from 'electron'
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
  /**
   * Whether the click landed inside a subframe, whose pixels are that frame's
   * own rather than the page's. Electron does not report where a frame sits in
   * the page, so the pointer is the only honest anchor for those.
   */
  frameRelative: boolean
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
 *
 * `frameRelative` only describes which coordinate space the numbers are in; it
 * is decided by main, never by the frame that reported them.
 */
export function parseLinkPeekReport(
  value: unknown,
  frameRelative = false
): BrowserLinkPeekRequest | null {
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
  return { url, x, y, frameRelative }
}

export interface BrowserLinkPeekDeps {
  /** Called for every Option-clicked link, with the page that reported it. */
  onPeek: (contents: WebContents, request: BrowserLinkPeekRequest) => void
}

interface RelayState {
  pending: boolean
  failures: number
}

/**
 * One page's relays: the top document's state machine, and the frames it holds.
 *
 * The state object's identity is what tells an answer that belongs to the
 * current document from one a navigation has replaced.
 */
interface PageRelay {
  main: RelayState
  /** Set when the page goes away, so no later answer is acted on. */
  abandoned: boolean
  /** Whether the frame watcher for this page is already installed. */
  watching: boolean
  /** Every frame that already carries the observer, installed once each. */
  frames: WeakSet<WebFrameMain>
  /** Frames whose outstanding wait is already running. */
  waiting: WeakSet<WebFrameMain>
}

/**
 * Owns one Option-click relay per page: installing it in the top document and in
 * every frame that document holds, waiting for reports, and re-arming after each.
 */
export class BrowserLinkPeek {
  private readonly pages = new WeakMap<WebContents, PageRelay>()

  constructor(private readonly deps: BrowserLinkPeekDeps) {}

  /**
   * Install the observers for the document that just arrived.
   *
   * The page's record outlives the document, because the frames it holds keep
   * their own observers across a top-level navigation: only the top document's
   * state machine is new, and the frame watcher is installed once per page.
   */
  install(contents: WebContents): void {
    if (contents.isDestroyed()) return
    let page = this.pages.get(contents)
    if (!page || page.abandoned) {
      page = {
        main: { pending: false, failures: 0 },
        abandoned: false,
        watching: false,
        frames: new WeakSet(),
        waiting: new WeakSet()
      }
      this.pages.set(contents, page)
    } else {
      page.main = { pending: false, failures: 0 }
    }
    this.arm(contents, page)
    this.watchFrames(contents, page)
  }

  /** Stop reporting for a page that is going away. */
  release(contents: WebContents): void {
    const page = this.pages.get(contents)
    if (page) page.abandoned = true
    this.pages.delete(contents)
  }

  /**
   * The top document's relay, in its own isolated world.
   *
   * Its answer is the click in the page's own pixels and in the page's own
   * coordinate space, which is what lets a peek grow out of the link itself.
   */
  private arm(contents: WebContents, page: PageRelay): void {
    const state = page.main
    if (state.pending || page.abandoned || contents.isDestroyed()) return
    if (this.pages.get(contents) !== page) return
    state.pending = true
    const inWorld = (code: string): Promise<unknown> =>
      contents.executeJavaScriptInIsolatedWorld(LINK_PEEK_WORLD_ID, [{ code }])
    inWorld(linkPeekInstallScript())
      .then((installed: unknown) => {
        if (installed !== true) throw new Error('link peek relay refused to install')
        return inWorld(linkPeekWaitScript())
      })
      .then((answer: unknown) => {
        // A navigation replaces the document this wait belonged to, and its
        // answer describes a page that is no longer there.
        if (this.pages.get(contents) !== page || page.main !== state) return
        state.pending = false
        state.failures = 0
        const request = parseLinkPeekReport(answer)
        if (request) this.deps.onPeek(contents, request)
        this.arm(contents, page)
      })
      .catch((error: unknown) => {
        if (this.pages.get(contents) !== page || page.main !== state) return
        state.pending = false
        if (contents.isDestroyed() || page.abandoned) return
        // A document swap rejects the outstanding promise routinely, so a failure
        // is retried rather than treated as abandon; only a page that keeps
        // refusing is dropped.
        state.failures += 1
        if (state.failures >= MAX_ARM_FAILURES) {
          Logger.dev('Browser link peek relay abandoned a document:', error)
          return
        }
        setTimeout(() => this.arm(contents, page), REARM_DELAY_MS)
      })
  }

  /**
   * Every frame the page holds, now and as it grows.
   *
   * A frame a document embeds is created and loaded on its own schedule, so the
   * watcher is installed once per page and then arms each frame's document as it
   * arrives, which is what keeps a link inside one from keeping Chromium's
   * Option-click meaning of "download this".
   */
  private watchFrames(contents: WebContents, page: PageRelay): void {
    let root: WebFrameMain
    try {
      root = contents.mainFrame
    } catch {
      // A page whose main frame was disposed holds no frame to arm, and nothing
      // here is worth reporting.
      return
    }
    for (const frame of root.framesInSubtree) {
      if (frame !== root) this.armFrame(contents, page, frame)
    }
    if (page.watching) return
    page.watching = true
    contents.on('frame-created', (_event, details) => {
      const current = this.pages.get(contents)
      const frame = details.frame
      if (frame && current) this.armFrame(contents, current, frame)
    })
  }

  /** Watch one frame, then arm the document it already holds. */
  private armFrame(contents: WebContents, page: PageRelay, frame: WebFrameMain): void {
    if (page.abandoned || frame.detached || page.frames.has(frame)) return
    page.frames.add(frame)
    frame.on('dom-ready', () => this.armInFrame(contents, page, frame))
    this.armInFrame(contents, page, frame)
  }

  /**
   * A subframe's relay, in that frame's own document.
   *
   * A frame has no isolated world of its own through this API, so the observer
   * runs beside the frame's script. That costs nothing an attacker did not
   * already have: the report is untrusted either way and is validated before it
   * opens anything, and a peek only ever previews a page.
   */
  private armInFrame(contents: WebContents, page: PageRelay, frame: WebFrameMain): void {
    if (page.abandoned || frame.detached || contents.isDestroyed()) return
    if (page.waiting.has(frame)) return
    page.waiting.add(frame)
    frame
      .executeJavaScript(linkPeekInstallScript())
      .then((installed: unknown) => {
        if (installed !== true) throw new Error('link peek relay refused to install')
        return frame.executeJavaScript(linkPeekWaitScript())
      })
      .then((answer: unknown) => {
        page.waiting.delete(frame)
        if (page.abandoned || frame.detached || contents.isDestroyed()) return
        const request = parseLinkPeekReport(answer, true)
        if (request) this.deps.onPeek(contents, request)
        this.armInFrame(contents, page, frame)
      })
      .catch(() => {
        // A frame mid-navigation rejects the outstanding wait routinely, and the
        // document that replaces it is armed by that frame's own `dom-ready`.
        page.waiting.delete(frame)
      })
  }
}
