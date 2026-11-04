import type { WebContents } from 'electron'
import { Logger } from '../../system/logger'
import {
  classifyHistoryGesture,
  readHistoryGestureFacts,
  type HistoryDirection,
  type HistoryGestureFacts
} from './browser-history-gesture'
import { navigatePageHistory } from './browser-history-navigation'

interface SwipeDocument {
  cooldownUntil: number
  /** The last gesture main acted on, so its final report is not a second one. */
  lastGesture: number | null
}

// Weak ownership lets a destroyed page release its observer without a timer or
// a service-wide sweep. The cooldown survives replacement of the page document.
const documents = new WeakMap<WebContents, SwipeDocument>()
const SWIPE_WORLD_ID = 1001
const NAVIGATION_COOLDOWN_MS = 800
/** The global the page-side reporter is taken from, inside the isolated world. */
const RELAY_GLOBAL = '__cioHistorySwipeRelay'
/** Reports a page may hold while main answers the one before them. */
const MAX_QUEUED_REPORTS = 8
/** How long the page waits for a gesture to go quiet before reporting it. */
const GESTURE_TAIL_MS = 120
/** A gap this long starts a different gesture, never a continuation. */
const GESTURE_GAP_MS = 320
/** Travel worth reporting. The real bar is the service's, applied to the facts. */
const REPORTABLE_TRAVEL_PX = 40
/** Detent-sized jump: one notch of a mouse wheel, in pixels. */
const WHEEL_DETENT_PIXELS = 28
/** How far apart two detents of the same wheel turn can arrive. */
const WHEEL_DETENT_GAP_MS = 32

/**
 * The page-side reporter, installed once per document in an isolated world.
 *
 * It decides nothing. It measures one gesture, hands the facts to main, and goes
 * back to measuring. Every rule about what those facts mean lives in
 * `browser-history-gesture.ts`, which is what stops a mouse wheel and a trackpad
 * from being told apart by two different pieces of code.
 *
 * The one rule the page does own is when it is worth asking, because only the
 * page knows that a gesture is still moving: it asks as the travel grows past
 * each step while the OS reports the inertia of a lifted finger (a mouse never
 * sends one), and once more when the stream goes quiet. Main recognises every
 * report of one gesture by the gesture's own number, so asking early costs a
 * question and never a second navigation.
 */
export function historySwipeInstallScript(): string {
  return String.raw`(() => {
  try {
    if (globalThis[${JSON.stringify(RELAY_GLOBAL)}]) return true;
    const state = {
      waiters: [],
      queued: [],
      gesture: 0,
      reportedAt: 0,
      lastAt: 0,
      horizontal: 0,
      vertical: 0,
      momentum: false,
      wheelDetents: 0,
      events: 0,
      pageOwns: false,
      blocked: false,
      lastMagnitude: 0,
      tail: 0
    };
    const clearTail = () => {
      if (state.tail) {
        clearTimeout(state.tail);
        state.tail = 0;
      }
    };
    const facts = () => ({
      gesture: state.gesture,
      horizontal: state.horizontal,
      vertical: state.vertical,
      momentum: state.momentum,
      wheelDetents: state.wheelDetents,
      events: state.events,
      pageOwns: state.pageOwns
    });
    const deliver = (value) => {
      const resolve = state.waiters.shift();
      if (resolve) resolve(value);
      else if (state.queued.length < ${MAX_QUEUED_REPORTS}) state.queued.push(value);
    };
    const reset = () => {
      clearTail();
      state.reportedAt = 0;
      state.lastAt = 0;
      state.horizontal = 0;
      state.vertical = 0;
      state.momentum = false;
      state.wheelDetents = 0;
      state.events = 0;
      state.pageOwns = false;
      state.blocked = false;
      state.lastMagnitude = 0;
    };
    /** The gestures that mattered, once the stream has gone quiet. */
    const finish = () => {
      clearTail();
      const value = state.blocked ? null : facts();
      reset();
      if (value && Math.abs(value.horizontal) >= ${REPORTABLE_TRAVEL_PX}) deliver(value);
    };
    const scheduleTail = () => {
      clearTail();
      state.tail = setTimeout(() => {
        state.tail = 0;
        finish();
      }, ${GESTURE_TAIL_MS});
    };
    /** Only the event's bounded ancestor chain is inspected, once per gesture. */
    const pageOwnsGesture = (path, deltaX) => {
      if (document.contentType.startsWith('image/')) return true;
      if (path.length > 32) return true;
      for (const target of path) {
        if (!(target instanceof Element)) continue;
        // Image viewers and drawing surfaces can pan without a DOM scrollbar.
        if (target.matches('canvas, svg, img, video, input, textarea, [contenteditable="true"]')) {
          return true;
        }
        const style = getComputedStyle(target);
        if (style.overscrollBehaviorX === 'contain' || style.overscrollBehaviorX === 'none') {
          return true;
        }
        const remaining = target.scrollWidth - target.clientWidth;
        const scrollingRoot = target === document.scrollingElement;
        if (
          remaining <= 2 ||
          (!scrollingRoot && !['auto', 'scroll', 'hidden'].includes(style.overflowX))
        ) {
          continue;
        }
        // RTL scrollLeft can be negative. Either endpoint remains a possible
        // browser gesture, but a gesture that starts as a pan stays a pan.
        const left = target.scrollLeft;
        const minimum = style.direction === 'rtl' ? -remaining : 0;
        const maximum = style.direction === 'rtl' ? 0 : remaining;
        if ((deltaX < 0 && left > minimum + 1) || (deltaX > 0 && left < maximum - 1)) {
          return true;
        }
      }
      return false;
    };
    window.addEventListener('wheel', (event) => {
      if (!event.isTrusted) return;
      const path = event.composedPath();
      // Let the site's handlers finish first, including handlers registered
      // after this observer. A prevented wheel belongs to the page.
      queueMicrotask(() => {
        const now = Date.now();
        const gap = state.lastAt === 0 ? Number.POSITIVE_INFINITY : now - state.lastAt;
        if (state.lastAt !== 0 && gap > ${GESTURE_GAP_MS}) reset();
        const first = state.lastAt === 0;
        state.lastAt = now;
        if (first) {
          state.gesture += 1;
          state.pageOwns = pageOwnsGesture(path, event.deltaX);
        }
        state.events += 1;
        // A wheel reports either one large jump per detent or a steady repeat of
        // the same step, and its detents cannot repeat faster than the wheel is
        // physically turned. A trackpad instead reports varied steps of a few
        // pixels, packed far closer together than that. This is measured here,
        // and weighed where the rules live.
        const magnitude = Math.abs(event.deltaX);
        const detentStep = magnitude >= 1 && magnitude === state.lastMagnitude;
        state.lastMagnitude = magnitude;
        if (gap >= ${WHEEL_DETENT_GAP_MS} && (magnitude >= ${WHEEL_DETENT_PIXELS} || detentStep)) {
          state.wheelDetents += 1;
        }
        if (
          event.defaultPrevented ||
          event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          event.shiftKey ||
          event.buttons !== 0 ||
          !Number.isFinite(event.deltaX) ||
          !Number.isFinite(event.deltaY)
        ) {
          state.blocked = true;
          scheduleTail();
          return;
        }
        // Reversing a swipe cancels it; distance is never accumulated across two
        // opposing motions. Small trackpad jitter is ignored.
        if (Math.abs(event.deltaX) > 1 && state.horizontal * event.deltaX < 0) {
          state.blocked = true;
          scheduleTail();
          return;
        }
        state.horizontal += event.deltaX;
        state.vertical += Math.abs(event.deltaY);
        if (state.vertical > 24 && state.vertical > Math.abs(state.horizontal)) {
          state.blocked = true;
          scheduleTail();
          return;
        }
        if (event.momentum === true) state.momentum = true;
        // Inertia is worth asking about at once: it is the moment the fingers
        // lifted. Asking again every step of travel keeps the answer current
        // without needing the end of the gesture, which can be a long glide.
        if (
          state.momentum &&
          Math.abs(state.horizontal) >= state.reportedAt + ${REPORTABLE_TRAVEL_PX}
        ) {
          state.reportedAt = Math.abs(state.horizontal);
          deliver(facts());
        }
        scheduleTail();
      });
    }, { passive: true });
    window.addEventListener('blur', reset);
    window.addEventListener('pagehide', reset);
    Object.defineProperty(globalThis, ${JSON.stringify(RELAY_GLOBAL)}, {
      value: {
        wait: () => new Promise((resolve) => {
          if (state.queued.length > 0) {
            resolve(state.queued.shift());
            return;
          }
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

/** The evaluation that returns the next gesture the page measured. */
export function historySwipeWaitScript(): string {
  return `(() => { const relay = globalThis[${JSON.stringify(RELAY_GLOBAL)}]; return relay ? relay.wait() : null; })()`
}

/**
 * Install the reporter on every main-frame document, for global, conversation
 * and popup pages alike, and answer its reports.
 *
 * Main owns the verdict (`classifyHistoryGesture`) and the traversal
 * (`navigatePageHistory`), so this gesture, a mouse side button and the browser's
 * own Back control all take the same route through one service.
 */
export function installBrowserHistorySwipe(
  contents: WebContents,
  platform: NodeJS.Platform = process.platform
): void {
  if (contents.isDestroyed()) return
  const previous = documents.get(contents)
  const state: SwipeDocument = {
    cooldownUntil: previous?.cooldownUntil ?? 0,
    lastGesture: null
  }
  documents.set(contents, state)

  const arm = (): void => {
    if (contents.isDestroyed() || documents.get(contents) !== state) return
    void contents
      .executeJavaScriptInIsolatedWorld(SWIPE_WORLD_ID, [{ code: historySwipeInstallScript() }])
      .then((installed: unknown) => {
        if (installed !== true) throw new Error('history gesture reporter refused to install')
        return contents.executeJavaScriptInIsolatedWorld(SWIPE_WORLD_ID, [
          { code: historySwipeWaitScript() }
        ])
      })
      .then((report: unknown) => {
        if (contents.isDestroyed() || documents.get(contents) !== state) return
        applyGestureReport(contents, state, report, platform)
        arm()
      })
      .catch((error: unknown) => {
        if (contents.isDestroyed() || documents.get(contents) !== state) return
        // A document swap rejects the outstanding wait routinely, and the
        // `dom-ready` that follows installs the reporter again for the new
        // document.
        Logger.dev('Browser history gesture reporter ended:', error)
      })
  }
  arm()
}

function applyGestureReport(
  contents: WebContents,
  state: SwipeDocument,
  report: unknown,
  platform: NodeJS.Platform
): void {
  const facts: HistoryGestureFacts | null = readHistoryGestureFacts(report)
  if (!facts) return
  // The page reports a swipe twice: the moment the fingers lift, and again when
  // the gesture goes quiet. One gesture walks history at most once.
  if (state.lastGesture === facts.gesture) return
  const direction: HistoryDirection | null = classifyHistoryGesture(facts, platform)
  if (!direction) return
  const now = Date.now()
  if (now < state.cooldownUntil) return
  state.cooldownUntil = now + NAVIGATION_COOLDOWN_MS
  state.lastGesture = facts.gesture
  navigatePageHistory(contents, direction)
}
