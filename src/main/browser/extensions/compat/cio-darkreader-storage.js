/** Dark Reader expects a usable sync area even during first-run migration.
 * Electron has no Chrome account sync. Keep this area separate in local storage,
 * inside the extension's own session, and preserve callback/promise semantics. */
;(() => {
  const chromeApi = globalThis.chrome
  if (chromeApi?.runtime?.id !== 'eimadpbcbfnmbkopoojfekhnkhdbieeh') return
  const prefix = '__cioDarkReaderSync:'
  const areas = new WeakSet()
  for (const root of new Set([chromeApi, globalThis.browser].filter(Boolean))) {
    const storage = root.storage
    if (!storage?.local || areas.has(storage)) continue
    areas.add(storage)
    const local = storage.local
    const run = (task, callback) => {
      if (typeof callback !== 'function') return task
      task.then(callback, () => callback())
    }
    const get = (keys = null, callback) => {
      if (typeof keys === 'function') {
        callback = keys
        keys = null
      }
      const names =
        typeof keys === 'string'
          ? [keys]
          : Array.isArray(keys)
            ? keys
            : keys
              ? Object.keys(keys)
              : null
      return run(
        local.get(names ? names.map((key) => prefix + key) : null).then((stored) => {
          const result = keys && typeof keys === 'object' && !Array.isArray(keys) ? { ...keys } : {}
          for (const [key, value] of Object.entries(stored)) {
            if (key.startsWith(prefix)) result[key.slice(prefix.length)] = value
          }
          return result
        }),
        callback
      )
    }
    const area = {
      QUOTA_BYTES: 102400,
      QUOTA_BYTES_PER_ITEM: 8192,
      MAX_ITEMS: 512,
      get,
      set: (values, callback) =>
        run(
          local.set(
            Object.fromEntries(Object.entries(values).map(([key, value]) => [prefix + key, value]))
          ),
          callback
        ),
      remove: (keys, callback) =>
        run(
          local.remove((Array.isArray(keys) ? keys : [keys]).map((key) => prefix + key)),
          callback
        ),
      clear: (callback) =>
        run(
          local
            .get(null)
            .then((stored) =>
              local.remove(Object.keys(stored).filter((key) => key.startsWith(prefix)))
            ),
          callback
        ),
      getBytesInUse: (keys, callback) =>
        run(
          get(keys).then((values) => new TextEncoder().encode(JSON.stringify(values)).byteLength),
          callback
        )
    }
    try {
      Object.defineProperty(storage, 'sync', { value: area, configurable: true, writable: true })
    } catch (_error) {
      // A runtime with a non-replaceable area keeps its native implementation.
    }
  }
})()
