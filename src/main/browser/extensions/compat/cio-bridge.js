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
  const frameRequests = []
  const ensurePort = () => {
    if (port) return port
    try {
      port = chromeApi.runtime.connect({ name: '__cio:bridge' })
      port.onMessage.addListener((request) => {
        if (request && request.kind === 'frames-query' && frameRequests.length < 64) {
          frameRequests.push(request)
        }
      })
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

  /** Main answers a small batch using the session's actual frame tree. */
  globalThis.__cioBridgeDrainFrameRequests = () => JSON.stringify(frameRequests.splice(0, 8))

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

  /**
   * The file writes an extension asked for, which is how `chrome.userScripts`
   * gets code into a file the extension's own copy can register: a worker cannot
   * write a file, so it asks the app and waits for the answer.
   */
  globalThis.__cioBridgeDrainWrites = () =>
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
        const returned = area.get('__cioFileRequests', (value) =>
          finish(value && value.__cioFileRequests)
        )
        if (returned && typeof returned.then === 'function') {
          returned.then(
            (value) => finish(value && value.__cioFileRequests),
            () => finish(null)
          )
        }
      } catch {
        finish(null)
      }
      setTimeout(() => finish(null), 2000)
    })

  /**
   * Re-register the user scripts the extension registered, if something removed
   * them.
   *
   * `chrome.userScripts` keeps its own registry in a real browser, so an extension
   * that clears its content scripts (`chrome.scripting.unregisterContentScripts()`
   * with no filter, which uBlock Origin Lite does on every re-register) leaves its
   * user scripts alone. In this runtime the compatibility preamble rebuilds the
   * namespace on top of the scripting registry, so that same call wipes the user
   * scripts too. The registry the preamble keeps is the truth, and this replays the
   * missing entries, which is why it lives in the page rather than the worker: the
   * page is alive whenever the app's bridge is, even when the worker is asleep.
   */
  globalThis.__cioBridgeReassert = () =>
    new Promise((resolve) => {
      const scripting = chromeApi.scripting
      // The registry lives in `local` (it has to outlive a worker restart), while
      // the mailbox lives in `session`, so this reads the registry's own area.
      const registryArea = () => {
        try {
          if (chromeApi.storage && chromeApi.storage.local) return chromeApi.storage.local
          if (chromeApi.storage && chromeApi.storage.session) return chromeApi.storage.session
        } catch {
          return null
        }
        return null
      }
      const store = registryArea()
      if (!store || !scripting || typeof scripting.registerContentScripts !== 'function') {
        resolve('unavailable')
        return
      }
      const finish = (value) => resolve(value)
      ;(async () => {
        try {
          const bag = await store.get('__cioUserScripts')
          const entries = bag && Array.isArray(bag.__cioUserScripts) ? bag.__cioUserScripts : []
          if (entries.length === 0) {
            finish('empty')
            return
          }
          const present = await scripting.getRegisteredContentScripts()
          const known = new Set(present.map((entry) => entry && entry.id))
          const missing = entries.filter(
            (entry) =>
              entry &&
              typeof entry.registrationId === 'string' &&
              typeof entry.file === 'string' &&
              known.has(entry.registrationId) === false
          )
          if (missing.length === 0) {
            finish('present')
            return
          }
          await scripting.registerContentScripts(
            missing.map((entry) => ({
              id: entry.registrationId,
              world: entry.runtimeWorld === 'MAIN' ? 'MAIN' : 'ISOLATED',
              matches:
                Array.isArray(entry.matches) && entry.matches.length !== 0
                  ? entry.matches
                  : ['<all_urls>'],
              ...(Array.isArray(entry.excludeMatches) && entry.excludeMatches.length !== 0
                ? { excludeMatches: entry.excludeMatches }
                : {}),
              ...(entry.allFrames === true ? { allFrames: true } : {}),
              runAt: typeof entry.runAt === 'string' ? entry.runAt : 'document_start',
              js: [entry.file]
            }))
          )
          finish('restored:' + missing.length)
        } catch (error) {
          finish('error: ' + String(error))
        }
      })()
    })

  /** Main writes the answer to a file request (or any other value) back through
   *  this, because the worker can only read, never be called. */
  globalThis.__cioBridgeWrite = (key, value) =>
    new Promise((resolve) => {
      const area = mailboxArea()
      if (!area || typeof area.set !== 'function' || typeof key !== 'string' || !key) {
        resolve(false)
        return
      }
      try {
        const returned = area.set({ [key]: value })
        if (returned && typeof returned.then === 'function') {
          returned.then(
            () => resolve(true),
            () => resolve(false)
          )
        } else {
          resolve(true)
        }
      } catch {
        resolve(false)
      }
    })
})()
