/**
 * Recording state for embedded-browser tabs.
 *
 * A tab shows a recording indicator while one of its frames holds a live
 * microphone, camera or screen capture. Electron exposes no capture state for a
 * `WebContentsView`, and the embedded browser deliberately gives remote content
 * no preload script (`docs/EMBEDDED_BROWSER_ARCHITECTURE.md`), so this observer
 * uses the one boundary that already runs page code: `executeJavaScript` in the
 * frame's own world, exactly as the labeled-dialog shim does.
 *
 * The injected script wraps `getUserMedia`/`getDisplayMedia` in that frame,
 * counts the live audio/video tracks it hands out, and returns a promise that
 * resolves with the new track count the moment it changes. Main re-arms that
 * promise once per frame after every answer, so a capture change costs one
 * message, an idle tab costs one pending promise per frame, and nothing polls:
 * no interval, no timer while a page sits still, no console channel, and no
 * bridge from page script back to privileged APIs.
 */

import type { WebFrameMain } from 'electron'
import { Logger } from '../../system/logger'
import {
  CAPTURE_REARM_INTERVAL_MS,
  MAX_CAPTURE_ARM_FAILURES,
  MAX_CAPTURED_FRAMES
} from './browser-validation'

export interface BrowserCaptureObserverDeps {
  /** Called when a tab's capture state changed, so the owner can publish it. */
  onChange: (tabId: string) => void
}

/** One frame under observation, within one document of one tab. */
interface ObservedFrame {
  frame: WebFrameMain
  /** Live capture tracks this frame reported. */
  count: number
  /** True while this frame has an outstanding promise to main, which is what
   *  keeps a duplicate arm from stacking a second waiter on the same observer. */
  pending: boolean
  /** Consecutive failed arms, so a frame that cannot run the observer is
   *  abandoned instead of retried forever. */
  failures: number
}

interface ObservedTab {
  /** Random global name the injected observer lives under in this tab's pages. */
  key: string
  /** Monotonic document id: a navigation makes every frame key that belonged to
   *  the previous document unreachable, so a late answer from it can neither
   *  write a stale count nor clear a newer arm's pending flag. */
  epoch: number
  frames: Map<string, ObservedFrame>
}

function frameKey(tab: ObservedTab, frame: WebFrameMain): string {
  return `${tab.epoch}:${frame.processId}:${frame.routingId}`
}

/**
 * The script installed into one frame's main world. It is idempotent per
 * document: the first call installs the observer under `key`, every later call
 * (another re-arm of the same document) just waits on it again.
 *
 * `key` is a per-tab random name, read once into a local of the returned
 * closure, so page script cannot guess the global it would have to forge to fake
 * a recording indicator.
 */
export function captureObserverScript(key: string): string {
  return `(() => {
  try {
    const key = ${JSON.stringify(key)};
    // No mediaDevices means the document cannot capture at all: an insecure
    // origin, or a page that deleted the API. Answering null stops main from
    // keeping an observer armed for a frame that can never report.
    if (!navigator.mediaDevices) return null;
    if (!globalThis[key]) {
      const tracks = new Set();
      const waiters = new Set();
      let reported = 0;
      const publish = () => {
        const total = tracks.size;
        if (total === reported) return;
        reported = total;
        for (const resolve of [...waiters]) {
          waiters.delete(resolve);
          resolve(total);
        }
      };
      const watchStream = (stream) => {
        try {
          if (stream && typeof stream.getTracks === 'function') {
            for (const track of stream.getTracks()) {
              if (track.kind !== 'audio' && track.kind !== 'video') continue;
              if (tracks.has(track)) continue;
              tracks.add(track);
              track.addEventListener('ended', () => {
                tracks.delete(track);
                publish();
              });
            }
            publish();
          }
        } catch (error) {
          // A page-shaped object that is not a real stream: nothing to count.
        }
        return stream;
      };
      const wrap = (name) => {
        const devices = navigator.mediaDevices;
        const original = devices ? devices[name] : undefined;
        if (typeof original !== 'function') return;
        Object.defineProperty(devices, name, {
          configurable: true,
          writable: true,
          value: function (...args) {
            const result = original.apply(this, args);
            if (result && typeof result.then === 'function') return result.then(watchStream);
            return result;
          }
        });
      };
      wrap('getUserMedia');
      wrap('getDisplayMedia');
      const observer = {
        wait: () =>
          new Promise((resolve) => {
            if (tracks.size !== reported) {
              reported = tracks.size;
              resolve(tracks.size);
              return;
            }
            waiters.add(resolve);
          })
      };
      Object.defineProperty(globalThis, key, {
        value: observer,
        configurable: true,
        enumerable: false,
        writable: false
      });
    }
    return globalThis[key].wait();
  } catch (error) {
    // A page can freeze the globals this installs into. Main then drops the
    // frame instead of arming it again.
    return null;
  }
})()`
}

export class BrowserCaptureObserver {
  private readonly tabs = new Map<string, ObservedTab>()

  constructor(private readonly deps: BrowserCaptureObserverDeps) {}

  /**
   * Observe one frame of a tab. Called for the main frame once its document is
   * parsed and for every other frame once it has loaded, so a recorder embedded
   * in an iframe is covered too. Watching a frame again is harmless: an
   * outstanding promise is reused instead of stacked.
   */
  watch(tabId: string, frame: WebFrameMain): void {
    if (frame.isDestroyed()) return
    const tab = this.tabFor(tabId)
    const key = frameKey(tab, frame)
    const observed = tab.frames.get(key)
    if (observed) {
      observed.frame = frame
    } else {
      if (tab.frames.size >= MAX_CAPTURED_FRAMES) return
      tab.frames.set(key, { frame, count: 0, pending: false, failures: 0 })
    }
    this.arm(tabId, key)
  }

  /** Total live capture tracks across the tab's observed frames. */
  captureCount(tabId: string): number {
    let total = 0
    for (const observed of this.tabs.get(tabId)?.frames.values() ?? []) total += observed.count
    return total
  }

  isCapturing(tabId: string): boolean {
    return this.captureCount(tabId) > 0
  }

  /**
   * Start a new document for this tab: every frame key from the previous
   * document is abandoned, so a capture that ended with it cannot keep the
   * recording indicator on. Each frame arms its own observer again when it
   * loads, and the frames of the tab's next document report as they start.
   */
  reset(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    tab.epoch += 1
    tab.frames.clear()
  }

  /** Forget a tab whose view is gone. */
  forget(tabId: string): void {
    this.tabs.delete(tabId)
  }

  dispose(): void {
    this.tabs.clear()
  }

  /** Ask one frame for the next capture-count change, then arm it again. */
  private arm(tabId: string, key: string): void {
    const tab = this.tabs.get(tabId)
    const observed = tab?.frames.get(key)
    if (!tab || !observed || observed.pending || observed.frame.isDestroyed()) return
    observed.pending = true
    const epoch = tab.epoch
    void observed.frame
      .executeJavaScript(captureObserverScript(tab.key), false)
      .then((reported: unknown) => {
        const current = this.frameFor(tabId, key, epoch)
        if (!current) return
        current.pending = false
        current.failures = 0
        if (typeof reported !== 'number') {
          // The observer refused to install (no mediaDevices in the document, or
          // a page that froze the globals it installs into). Observing this
          // frame is not going to work.
          this.forgetFrame(tabId, key, epoch)
          return
        }
        if (current.count !== reported) {
          current.count = reported
          this.deps.onChange(tabId)
        }
        this.scheduleArm(tabId, key, epoch)
      })
      .catch((error: unknown) => {
        const current = this.frameFor(tabId, key, epoch)
        if (!current) return
        current.pending = false
        // A frame dies routinely mid-navigation, and its world is replaced by
        // the next document: retry until it either answers or is abandoned, so a
        // document swap cannot leave the frame unsupervised.
        if (current.frame.isDestroyed()) {
          this.forgetFrame(tabId, key, epoch)
          return
        }
        current.failures += 1
        if (current.failures >= MAX_CAPTURE_ARM_FAILURES) {
          Logger.dev('Browser capture observer abandoned a frame:', { tabId, key, error })
          // Dropping the record republishes the tab, which clears an indicator
          // the abandoned frame was holding up.
          this.forgetFrame(tabId, key, epoch)
          return
        }
        this.scheduleArm(tabId, key, epoch)
      })
  }

  /**
   * Re-arm one frame after a bounded delay. The delay covers both paths: it
   * bounds how fast a page can drive the observer by starting and stopping
   * captures in a loop, and it bounds how often a frame that keeps failing is
   * retried.
   */
  private scheduleArm(tabId: string, key: string, epoch: number): void {
    setTimeout(() => {
      if (!this.frameFor(tabId, key, epoch)) return
      this.arm(tabId, key)
    }, CAPTURE_REARM_INTERVAL_MS)
  }

  /** The frame record for a tab, only while it still belongs to `epoch`. */
  private frameFor(tabId: string, key: string, epoch: number): ObservedFrame | undefined {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.epoch !== epoch) return undefined
    return tab.frames.get(key)
  }

  private forgetFrame(tabId: string, key: string, epoch: number): void {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.epoch !== epoch) return
    const observed = tab.frames.get(key)
    if (!observed) return
    tab.frames.delete(key)
    if (observed.count > 0) this.deps.onChange(tabId)
  }

  private tabFor(tabId: string): ObservedTab {
    let tab = this.tabs.get(tabId)
    if (!tab) {
      tab = { key: crypto.randomUUID(), epoch: 1, frames: new Map() }
      this.tabs.set(tabId, tab)
    }
    return tab
  }
}
