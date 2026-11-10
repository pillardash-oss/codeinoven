/**
 * `chrome.runtime.openOptionsPage()` for an extension's own page.
 *
 * An extension's action popup is a page this app hosts, and a "More settings" row
 * in it calls `openOptionsPage` directly from the page rather than from the
 * worker. This runtime has no implementation there, so the click did nothing at
 * all, which reads as a broken settings button. The service worker's own half of
 * the rule lives in `compat/preamble/index.ts`; this is the page's.
 *
 * The page cannot reach main on its own, so it says what it wants in one
 * `postMessage`, which the extension page preload (see
 * `browser-extension-page-tabs.ts`) listens for and forwards. That preload is the
 * only side that holds `ipcRenderer`, and it is already the door this app opens
 * for extension pages.
 *
 * Rule: it must never throw. A page with no shim is exactly as well off as before,
 * but a page whose injected source threw is a page whose other wrappers did not
 * run.
 */

;(() => {
  /** The one member this shim replaces on a namespace root the page calls through. */
  interface PageRuntime {
    openOptionsPage?(callback?: () => void): Promise<void>
  }

  /** One namespace root the page reaches the runtime through. */
  interface RuntimeRoot {
    runtime?: PageRuntime
  }

  type CompatGlobal = typeof globalThis & {
    chrome?: RuntimeRoot
    browser?: RuntimeRoot
  }

  const globals = globalThis as CompatGlobal
  const chromeApi = globals.chrome
  if (!chromeApi || typeof chromeApi !== 'object') return
  if (!chromeApi.runtime) return

  const roots: RuntimeRoot[] = []
  for (const candidate of [chromeApi, globals.browser]) {
    if (candidate && typeof candidate === 'object' && !roots.includes(candidate))
      roots.push(candidate)
  }

  const ask = (): void => {
    try {
      window.postMessage({ __cioPageCommand: 'open-options' }, '*')
    } catch {
      // A page with no window has nothing to ask through.
    }
  }

  for (const root of roots) {
    const runtime = root && root.runtime
    if (!runtime) continue
    try {
      // Replaced rather than ensured: the runtime either omits this member or
      // answers it with nothing, and a button bound to a call that does nothing is
      // indistinguishable from a broken one.
      Object.defineProperty(runtime, 'openOptionsPage', {
        value: (callback?: () => void) => {
          ask()
          if (typeof callback === 'function') {
            try {
              Promise.resolve().then(() => callback())
            } catch {
              // A callback that throws is the page's problem, not the shim's.
            }
          }
          return Promise.resolve()
        },
        configurable: true,
        writable: true
      })
    } catch {
      // A runtime that refuses the property leaves the page with what it had.
    }
  }
})()
