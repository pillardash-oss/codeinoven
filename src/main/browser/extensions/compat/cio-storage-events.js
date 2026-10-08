/**
 * Electron stores extension data but does not deliver storage change events.
 * Keep observers in extension pages and workers in sync after successful writes.
 * BroadcastChannel stays within the extension origin and session partition; no
 * values travel through the app's renderer, main process, or persisted mailbox.
 */
;(() => {
  if (globalThis.__cioStorageEvents || !globalThis.chrome?.storage) return
  const roots = [...new Set([globalThis.chrome, globalThis.browser].filter(Boolean))]
  const errors = []
  globalThis.__cioStorageEvents = { errors }
  const recordError = (error) => {
    if (errors.length < 20) errors.push(String(error))
  }
  const event = () => {
    const listeners = new Set()
    return {
      addListener: (listener) => {
        if (typeof listener === 'function') listeners.add(listener)
      },
      removeListener: (listener) => listeners.delete(listener),
      hasListener: (listener) => listeners.has(listener),
      hasListeners: () => listeners.size > 0,
      emit: (...args) => {
        for (const listener of [...listeners]) {
          try {
            listener(...args)
          } catch (error) {
            recordError(error)
          }
        }
      }
    }
  }
  const changed = event()
  const areaEvents = new Map()
  const received = new Set()
  const sender = crypto.randomUUID()
  let sequence = 0
  const accept = (notice, ownWrite = false) => {
    if (!notice || typeof notice.id !== 'string' || !areaEvents.has(notice.areaName)) return false
    if (received.has(notice.id)) return false
    received.add(notice.id)
    if (received.size > 128) received.delete(received.values().next().value)
    const changes = { ...notice.changes }
    // The single Dark Reader worker already owns its live frame map. Echoing
    // queued snapshots back into that same map overwrites documents that
    // connected after the snapshot was taken. Other contexts still receive the
    // complete storage event, and settings changes retain normal delivery.
    if (
      ownWrite &&
      typeof document === 'undefined' &&
      globalThis.chrome.runtime.id === 'eimadpbcbfnmbkopoojfekhnkhdbieeh'
    ) {
      delete changes['TabManager-state']
    }
    emit(changes, notice.areaName)
    return true
  }
  const emit = (changes, areaName) => {
    if (!changes || typeof changes !== 'object' || !Object.keys(changes).length) return
    changed.emit(changes, areaName)
    areaEvents.get(areaName)?.emit(changes)
  }
  let channel
  try {
    channel = new BroadcastChannel('__cio:storage-changes')
    channel.onmessage = ({ data }) => {
      accept(data)
    }
  } catch (error) {
    recordError(error)
    return
  }
  // A channel does not wake a suspended service worker. A short native port does,
  // and the worker delivers the same notice once, whichever transport arrives
  // first. The port is released on acknowledgement or timeout.
  const portName = '__cio:storage-changes'
  const runtime = globalThis.chrome.runtime
  const ports = new Set()
  runtime.onConnect.addListener((port) => {
    if (port.name !== portName) return
    port.onMessage.addListener((notice) => {
      if (accept(notice)) channel.postMessage(notice)
      port.postMessage({ id: notice.id })
    })
  })
  const publish = (changes, areaName) => {
    if (!Object.keys(changes).length) return
    const notice = { id: sender + ':' + ++sequence, changes, areaName }
    accept(notice, true)
    try {
      channel.postMessage(notice)
      if (typeof document !== 'undefined' && ports.size < 64) {
        const port = runtime.connect({ name: portName })
        ports.add(port)
        const release = () => {
          clearTimeout(timer)
          if (!ports.delete(port)) return
          try {
            port.disconnect()
          } catch (error) {
            recordError(error)
          }
        }
        const timer = setTimeout(release, 5000)
        port.onMessage.addListener(release)
        port.onDisconnect.addListener(release)
        port.postMessage(notice)
      }
    } catch (error) {
      recordError(error)
    }
  }
  const replace = (target, name, value) => {
    Object.defineProperty(target, name, { value, configurable: true, writable: true })
  }
  const wrappedAreas = new WeakSet()
  for (const root of roots) {
    if (!root.storage) continue
    try {
      replace(root.storage, 'onChanged', changed)
      for (const areaName of ['local', 'session', 'sync']) {
        const area = root.storage[areaName]
        if (!area || typeof area.get !== 'function') continue
        let areaChanged = areaEvents.get(areaName)
        if (!areaChanged) {
          areaChanged = event()
          areaEvents.set(areaName, areaChanged)
        }
        replace(area, 'onChanged', areaChanged)
        if (wrappedAreas.has(area)) continue
        wrappedAreas.add(area)
        const native = {}
        for (const name of ['get', 'set', 'remove', 'clear']) {
          if (typeof area[name] === 'function') native[name] = area[name].bind(area)
        }
        // Serialize writes from this context so their old values and completion
        // events describe the same operation. Each area has its own small queue.
        let pending = Promise.resolve()
        const invoke = (name, args, completed) =>
          new Promise((resolve, reject) => {
            let finished = false
            const finish = (error, result) => {
              if (finished) return
              finished = true
              if (completed) {
                try {
                  completed(error, result)
                } catch (callbackError) {
                  recordError(callbackError)
                }
              }
              if (error) reject(error)
              else resolve(result)
            }
            try {
              const returned = native[name](...args, (result) => {
                const error = globalThis.chrome.runtime?.lastError
                finish(error ? new Error(error.message) : null, result)
              })
              if (returned && typeof returned.then === 'function') {
                returned.then(
                  (result) => finish(null, result),
                  (error) => finish(error)
                )
              }
            } catch (error) {
              finish(error)
            }
          })
        for (const name of ['set', 'remove', 'clear']) {
          if (!native[name]) continue
          replace(area, name, (...args) => {
            const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null
            // Capture set values now, before a caller can mutate its object while
            // the preceding write is pending. Storage itself uses JSON values.
            let values
            try {
              values = name === 'set' ? JSON.parse(JSON.stringify(args[0])) : null
            } catch (_error) {
              return native[name](...args, ...(callback ? [callback] : []))
            }
            const keys = name === 'clear' ? null : name === 'set' ? Object.keys(values) : args[0]
            let callbackCalled = false
            const task = pending.then(async () => {
              const before = await invoke('get', [keys])
              return invoke(
                name,
                name === 'clear' ? [] : [name === 'set' ? values : args[0]],
                (error) => {
                  // Complete the write before notifying observers. Otherwise
                  // Dark Reader treats its own save as a competing update and
                  // reloads stale frame state while another document connects.
                  if (callback) {
                    callbackCalled = true
                    callback()
                  }
                  if (!error) {
                    const changes = {}
                    const changedKeys =
                      name === 'set'
                        ? Object.keys(values)
                        : name === 'clear'
                          ? Object.keys(before)
                          : Array.isArray(keys)
                            ? keys
                            : [keys]
                    for (const key of changedKeys) {
                      const oldValue = before[key]
                      const newValue = name === 'set' ? values[key] : undefined
                      if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue
                      const change = {}
                      if (oldValue !== undefined) change.oldValue = oldValue
                      if (newValue !== undefined) change.newValue = newValue
                      changes[key] = change
                    }
                    publish(changes, areaName)
                  }
                }
              )
            })
            pending = task.catch(() => {})
            if (!callback) return task
            task.catch((error) => {
              // A failed pre-read still needs to complete the callback. Failures
              // from the actual mutation call it inside native lastError scope.
              if (!callbackCalled) {
                recordError(error)
                native[name](...args, callback)
              }
            })
          })
        }
      }
    } catch (error) {
      recordError(error)
    }
  }
})()
