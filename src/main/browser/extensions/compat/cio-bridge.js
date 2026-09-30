/**
 * The app's bridge page, written into an extension's own copy beside the
 * compatibility preamble.
 *
 * The preamble runs inside the extension's service worker, and nothing in the
 * runtime can hand a worker an event or read a worker's state: there is no
 * Electron API for either, and `ses.registerPreloadScript` does not reach an
 * extension worker (measured). This page is the other half of the channel:
 *
 *   - Main, which owns the page's `WebContents`, pushes a command in with
 *     `executeJavaScript` calling `__cioBridgeReceive`. The page hands it to the
 *     worker over a LONG-LIVED PORT named `__cio:bridge` (the direction measured
 *     to work, and the one that starts a worker Chromium has released). A port,
 *     not `runtime.sendMessage`, because a message is delivered to every
 *     `onMessage` listener the extension has and a real extension's listener can
 *     throw on a shape it does not know (uBlock Origin Lite's did, measured).
 *   - Main polls `__cioBridgeDrain`, which reads the worker's mailbox key out of
 *     `chrome.storage.session` fresh on every call and answers with it as a
 *     string. A fresh read keeps a worker that has since gone idle from ever
 *     being stale, and a string survives `executeJavaScript` whole.
 *
 * The page has no timers, no UI and no state of its own beyond the port: it is a
 * pipe, and main is the side that decides when something moves through it.
 */

;(() => {
  const chromeApi = globalThis.chrome
  if (!chromeApi) return

  const mailboxArea = () => {
    try {
      const storage = chromeApi.storage
      if (!storage) return null
      if (storage.session && typeof storage.session.get === 'function') return storage.session
      if (storage.local && typeof storage.local.get === 'function') return storage.local
    } catch {
      return null
    }
    return null
  }

  /**
   * The one port to the worker, kept for this page's life and reopened whenever
   * the worker is released or restarted. It is created on demand, because the
   * port disconnects with the worker and a fresh one is what starts it again.
   */
  let port = null
  const ensurePort = () => {
    if (port) return port
    try {
      port = chromeApi.runtime.connect({ name: '__cio:bridge' })
      if (port && port.onDisconnect && typeof port.onDisconnect.addListener === 'function') {
        port.onDisconnect.addListener(() => {
          port = null
        })
      }
    } catch {
      port = null
    }
    return port
  }

  const send = (command) => {
    const current = ensurePort()
    if (!current) return
    try {
      current.postMessage(command)
    } catch {
      // The worker went away between the check and the post. One retry on a fresh
      // port, because a tab event that arrives late is worse than one that does
      // not arrive at all.
      port = null
      const retried = ensurePort()
      if (!retried) return
      try {
        retried.postMessage(command)
      } catch {
        port = null
      }
    }
  }

  /** Main pushes one command into the extension's service worker through this. */
  globalThis.__cioBridgeReceive = (command) => send(command)

  /** Main reads the worker's mailbox through this. */
  globalThis.__cioBridgeDrain = () =>
    new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        try {
          resolve(value ? JSON.stringify(value) : 'null')
        } catch {
          resolve('null')
        }
      }
      const area = mailboxArea()
      if (!area) {
        finish(null)
        return
      }
      try {
        const returned = area.get('__cioMailbox', (value) => finish(value && value.__cioMailbox))
        if (returned && typeof returned.then === 'function') {
          returned.then(
            (value) => finish(value && value.__cioMailbox),
            () => finish(null)
          )
        }
      } catch {
        finish(null)
      }
      // A read that never answers must not leave main's poll hanging forever.
      setTimeout(() => finish(null), 2000)
    })
})()
