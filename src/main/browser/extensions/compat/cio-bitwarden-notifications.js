/**
 * Runs after Bitwarden's notification bootstrap in its isolated content world.
 * A repeated open can reach the iframe while its initial document still belongs
 * to the site. Keep updates until the extension document announces readiness,
 * with the same exact origin check Bitwarden uses for outgoing messages.
 */
;(() => {
  const service = globalThis.bitwardenAutofillInit?.overlayNotificationsContentService
  if (
    !service ||
    service.__cioNotificationFrames ||
    typeof service.openNotificationBar !== 'function' ||
    typeof service.sendMessageToNotificationBarIframe !== 'function' ||
    typeof service.closeNotificationBar !== 'function'
  ) {
    return
  }

  const expectedOrigin = `chrome-extension://${globalThis.chrome?.runtime?.id}`
  if (service.extensionOrigin !== expectedOrigin) return

  const open = service.openNotificationBar
  const send = service.sendMessageToNotificationBarIframe
  const close = service.closeNotificationBar
  const destroy = service.destroy
  const pendingLimit = 32
  const readyTimeoutMs = 5_000
  const retryLimit = 2
  let current = null
  let latestInit = null
  service.__cioNotificationFrames = { retries: 0, expired: false }

  const release = () => {
    if (current) {
      clearTimeout(current.timer)
      current.pending.length = 0
    }
    current = null
    latestInit = null
  }

  const waitForReady = (entry) => {
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      if (current !== entry) return
      if (!entry.frame.isConnected || service.notificationBarIframeElement !== entry.frame) {
        if (service.notificationBarIframeElement === entry.frame) {
          service.closeNotificationBar(false)
        } else {
          release()
        }
        return
      }
      if (entry.retries >= retryLimit) {
        service.__cioNotificationFrames.expired = true
        service.closeNotificationBar(false)
        return
      }
      entry.retries += 1
      service.__cioNotificationFrames.retries = entry.retries
      // Reload the same extension document. The verified handshake below also
      // reinitializes it after Bitwarden's original one-shot listener is gone.
      entry.ready = false
      entry.frame.src = entry.url
      waitForReady(entry)
    }, readyTimeoutMs)
  }

  const frameEntry = () => {
    const frame = service.notificationBarIframeElement
    if (!frame?.contentWindow) return null
    if (current?.frame === frame) return current
    const init = latestInit
    release()
    latestInit = init
    const url = new URL(frame.src)
    if (url.protocol !== 'chrome-extension:' || url.pathname !== '/notification/bar.html') {
      return null
    }
    current = { frame, url: frame.src, ready: false, pending: [], retries: 0, timer: null }
    service.__cioNotificationFrames.expired = false
    service.__cioNotificationFrames.retries = 0
    waitForReady(current)
    return current
  }

  service.openNotificationBar = function (initData) {
    if (this.notificationBarIframeElement && !this.notificationBarIframeElement.isConnected) {
      this.closeNotificationBar(false)
    }
    latestInit = {
      command: 'initNotificationBar',
      initData,
      parentOrigin: globalThis.location.origin
    }
    const result = open.call(this, initData)
    frameEntry()
    return result
  }

  service.sendMessageToNotificationBarIframe = function (message) {
    const entry = frameEntry()
    if (!entry) return
    const outgoing = message.command === 'initNotificationBar' ? (latestInit ?? message) : message
    if (entry.ready) {
      try {
        // A reload can leave the same WindowProxy pointing at a new blank
        // document. That document is readable again from the site.
        if (entry.frame.contentWindow.location.origin !== expectedOrigin) {
          entry.ready = false
          waitForReady(entry)
        }
      } catch {
        // The committed extension document is cross-origin. Native postMessage
        // still enforces the exact extension origin on every delivery.
      }
    }
    if (entry.ready) return send.call(this, outgoing)
    // Initialization is coalesced by openNotificationBar. Keep only bounded
    // follow-up updates, never a second copy of the initial notification data.
    if (message.command !== 'initNotificationBar') {
      if (entry.pending.length >= pendingLimit) entry.pending.shift()
      entry.pending.push(message)
    }
  }

  service.closeNotificationBar = function (...args) {
    release()
    return close.apply(this, args)
  }

  const onReady = (event) => {
    const entry = current
    if (
      !entry ||
      !event.isTrusted ||
      event.origin !== expectedOrigin ||
      event.source !== entry.frame.contentWindow ||
      event.data?.command !== 'initNotificationBar'
    ) {
      return
    }
    clearTimeout(entry.timer)
    // Let Bitwarden's original handshake listener finish first. Its captured
    // initial data must not overwrite a newer open that arrived during loading.
    entry.timer = setTimeout(() => {
      if (current !== entry) return
      if (!entry.frame.isConnected) {
        service.closeNotificationBar(false)
        return
      }
      entry.timer = null
      entry.ready = true
      if (latestInit) send.call(service, latestInit)
      const pending = entry.pending.splice(0)
      for (const message of pending) send.call(service, message)
    }, 0)
  }
  globalThis.addEventListener('message', onReady)
  globalThis.addEventListener('pagehide', release)
  if (typeof destroy === 'function') {
    service.destroy = function (...args) {
      release()
      globalThis.removeEventListener('message', onReady)
      globalThis.removeEventListener('pagehide', release)
      return destroy.apply(this, args)
    }
  }
})()
