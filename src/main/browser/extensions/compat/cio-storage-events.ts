/**
 * Electron stores extension data but does not deliver storage change events.
 * Keep observers in extension pages and workers in sync after successful writes.
 * BroadcastChannel stays within the extension origin and session partition; no
 * values travel through the app's renderer, main process, or persisted mailbox.
 */
;(() => {
  /** One property of a storage change event, as Chrome reports it. */
  interface StorageChange {
    oldValue?: unknown
    newValue?: unknown
  }

  /** The set of changes one write produced, keyed by the storage key it touched. */
  type StorageChanges = Record<string, StorageChange>

  /** A function an extension registered as a storage listener. */
  type StorageListener = (...args: unknown[]) => void

  /** The completion callback a storage caller may hand to `set`, `remove` or `clear`. */
  type StorageCallback = () => void

  /** One method of a storage area, as the native implementation exposes it. */
  type StorageCall = (...args: unknown[]) => unknown

  /**
   * One storage area the runtime exposes.
   *
   * Every member is read by name from a loop, so the area is read through an index
   * signature; a build that omits one of them answers `undefined` and is skipped.
   */
  interface ChromeStorageArea {
    [name: string]: StorageCall | undefined
  }

  /** `chrome.storage`, whose named areas (`local`, `session`, `sync`) are wrapped. */
  interface ChromeStorageSurface {
    [name: string]: ChromeStorageArea | undefined
  }

  /** One port of the runtime's message channel, opened for a single notice. */
  interface ChromePort {
    name?: string
    postMessage: (message: unknown) => void
    disconnect: () => void
    onMessage: { addListener: (listener: (notice: StorageNotice) => void) => void }
    onDisconnect: { addListener: (listener: () => void) => void }
  }

  /** The `chrome.runtime` surface this file connects through. */
  interface ChromeRuntimeApi {
    id?: string
    lastError?: { message?: string }
    connect: (info: { name?: string }) => ChromePort
    onConnect: { addListener: (listener: (port: ChromePort) => void) => void }
  }

  /** One root of the compat surface, which `chrome` and `browser` both are. */
  interface ChromeRoot {
    storage?: ChromeStorageSurface
    runtime: ChromeRuntimeApi
  }

  /** One storage change notice, on the broadcast channel and on the port alike. */
  interface StorageNotice {
    id: string
    areaName: string
    changes: StorageChanges
  }

  /** The bookkeeping this file publishes for the app's own diagnostics. */
  interface StorageEventsGlobal {
    errors: string[]
  }

  /** The `onChanged` event object each area and the namespace itself is given. */
  interface StorageEvent {
    addListener: (listener: unknown) => void
    removeListener: (listener: unknown) => void
    hasListener: (listener: unknown) => boolean
    hasListeners: () => boolean
    emit: (...args: unknown[]) => void
  }

  /** Whatever a native storage call returns when it answers with a promise. */
  interface Thenable {
    then(onFulfilled: (value: unknown) => void, onRejected: (error: unknown) => void): unknown
  }

  /**
   * The global this file is injected into.
   *
   * The injected script is not a module, so these declarations stay inside it and
   * nothing here is published to the page's own world.
   */
  type CompatGlobal = typeof globalThis & {
    chrome?: ChromeRoot
    browser?: ChromeRoot
    __cioStorageEvents?: StorageEventsGlobal
  }

  /** The one typed view of the global, read through instead of `globalThis` itself. */
  const surface = globalThis as CompatGlobal

  if (surface.__cioStorageEvents || !surface.chrome?.storage) return
  const roots = [...new Set([surface.chrome, surface.browser].filter(Boolean))] as ChromeRoot[]
  const errors: string[] = []
  surface.__cioStorageEvents = { errors }
  const recordError = (error: unknown) => {
    if (errors.length < 20) errors.push(String(error))
  }
  const event = (): StorageEvent => {
    const listeners = new Set<StorageListener>()
    return {
      addListener: (listener: unknown) => {
        if (typeof listener === 'function') listeners.add(listener as StorageListener)
      },
      removeListener: (listener: unknown) => listeners.delete(listener as StorageListener),
      hasListener: (listener: unknown) => listeners.has(listener as StorageListener),
      hasListeners: () => listeners.size > 0,
      emit: (...args: unknown[]) => {
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
  const areaEvents = new Map<string, StorageEvent>()
  const received = new Set<string>()
  const sender = crypto.randomUUID()
  let sequence = 0
  const accept = (notice: StorageNotice, ownWrite = false) => {
    if (!notice || typeof notice.id !== 'string' || !areaEvents.has(notice.areaName)) return false
    if (received.has(notice.id)) return false
    received.add(notice.id)
    if (received.size > 128) received.delete(received.values().next().value!)
    const changes = { ...notice.changes }
    // The single Dark Reader worker already owns its live frame map. Echoing
    // queued snapshots back into that same map overwrites documents that
    // connected after the snapshot was taken. Other contexts still receive the
    // complete storage event, and settings changes retain normal delivery.
    if (
      ownWrite &&
      typeof document === 'undefined' &&
      surface.chrome!.runtime.id === 'eimadpbcbfnmbkopoojfekhnkhdbieeh'
    ) {
      delete changes['TabManager-state']
    }
    emit(changes, notice.areaName)
    return true
  }
  const emit = (changes: StorageChanges, areaName: string) => {
    if (!changes || typeof changes !== 'object' || !Object.keys(changes).length) return
    changed.emit(changes, areaName)
    areaEvents.get(areaName)?.emit(changes)
  }
  let channel: BroadcastChannel
  try {
    channel = new BroadcastChannel('__cio:storage-changes')
    channel.onmessage = ({ data }: MessageEvent<unknown>) => {
      accept(data as StorageNotice)
    }
  } catch (error) {
    recordError(error)
    return
  }
  // A channel does not wake a suspended service worker. A short native port does,
  // and the worker delivers the same notice once, whichever transport arrives
  // first. The port is released on acknowledgement or timeout.
  const portName = '__cio:storage-changes'
  const runtime = surface.chrome.runtime
  const ports = new Set<ChromePort>()
  runtime.onConnect.addListener((port: ChromePort) => {
    if (port.name !== portName) return
    port.onMessage.addListener((notice: StorageNotice) => {
      if (accept(notice)) channel.postMessage(notice)
      port.postMessage({ id: notice.id })
    })
  })
  const publish = (changes: StorageChanges, areaName: string) => {
    if (!Object.keys(changes).length) return
    const notice: StorageNotice = { id: sender + ':' + ++sequence, changes, areaName }
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
  const replace = (target: Record<string, unknown>, name: string, value: unknown) => {
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
        const native: Record<string, StorageCall> = {}
        for (const name of ['get', 'set', 'remove', 'clear']) {
          if (typeof area[name] === 'function') native[name] = area[name]!.bind(area)
        }
        // Serialize writes from this context so their old values and completion
        // events describe the same operation. Each area has its own small queue.
        let pending: Promise<unknown> = Promise.resolve()
        const invoke = (
          name: string,
          args: unknown[],
          completed?: (error: unknown, result?: unknown) => void
        ) =>
          new Promise<unknown>((resolve, reject) => {
            let finished = false
            const finish = (error: unknown, result?: unknown) => {
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
              const returned = native[name](...args, (result: unknown) => {
                const error = surface.chrome!.runtime?.lastError
                finish(error ? new Error(error.message) : null, result)
              }) as Thenable | null
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
          replace(area, name, (...args: unknown[]) => {
            const callback =
              typeof args[args.length - 1] === 'function'
                ? (args.pop() as StorageCallback | undefined)
                : null
            // Capture set values now, before a caller can mutate its object while
            // the preceding write is pending. Storage itself uses JSON values.
            let values: Record<string, unknown> | null
            try {
              values =
                name === 'set'
                  ? (JSON.parse(JSON.stringify(args[0])) as Record<string, unknown>)
                  : null
            } catch (_error) {
              return native[name](...args, ...(callback ? [callback] : []))
            }
            const keys: string | string[] | null =
              name === 'clear'
                ? null
                : name === 'set'
                  ? Object.keys(values!)
                  : (args[0] as string | string[])
            let callbackCalled = false
            const task = pending.then(async () => {
              const before = (await invoke('get', [keys])) as Record<string, unknown>
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
                    const changes: StorageChanges = {}
                    const changedKeys =
                      name === 'set'
                        ? Object.keys(values!)
                        : name === 'clear'
                          ? Object.keys(before)
                          : Array.isArray(keys)
                            ? keys
                            : [keys!]
                    for (const key of changedKeys) {
                      const oldValue = before[key]
                      const newValue = name === 'set' ? values![key] : undefined
                      if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue
                      const change: StorageChange = {}
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
