/** Dark Reader expects a usable sync area even during first-run migration.
 * Electron has no Chrome account sync. Keep this area separate in local storage,
 * inside the extension's own session, and preserve callback/promise semantics. */
;(() => {
  /** One storage value, which storage itself keeps as JSON. */
  type StorageValue = unknown

  /** The keys a caller may ask for: one name, a list of names, a map, or nothing. */
  type StorageKeys = string | string[] | Record<string, StorageValue> | null

  /** The callback a caller may hand to any member of the area. */
  type StorageCallback = (values?: unknown) => void

  /** The raw area every one of these answers is read from and written to. */
  interface NativeStorageArea {
    get(keys: string[] | null): Promise<Record<string, StorageValue>>
    set(values: Record<string, StorageValue>): Promise<unknown>
    remove(keys: string[]): Promise<unknown>
  }

  /** `chrome.storage`, of which only the `local` area is read here. */
  interface ChromeStorageSurface {
    local?: NativeStorageArea
  }

  /** The `chrome.runtime` surface this file reads the extension's id from. */
  interface ChromeRuntimeApi {
    id?: string
  }

  /** One root of the compat surface, which `chrome` and `browser` both are. */
  interface ChromeRoot {
    storage?: ChromeStorageSurface
    runtime?: ChromeRuntimeApi
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
  }

  /** The one typed view of the global, read through instead of `globalThis` itself. */
  const surface = globalThis as CompatGlobal

  const chromeApi = surface.chrome
  if (chromeApi?.runtime?.id !== 'eimadpbcbfnmbkopoojfekhnkhdbieeh') return
  const prefix = '__cioDarkReaderSync:'
  const areas = new WeakSet()
  for (const root of new Set([chromeApi, surface.browser].filter(Boolean)) as Set<ChromeRoot>) {
    const storage = root.storage
    if (!storage?.local || areas.has(storage)) continue
    areas.add(storage)
    const local = storage.local
    const run = <T>(task: Promise<T>, callback?: StorageCallback): Promise<T> | undefined => {
      if (typeof callback !== 'function') return task
      task.then(callback, () => callback())
    }
    const get = (keys: StorageKeys = null, callback?: StorageCallback) => {
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
      set: (values: Record<string, StorageValue>, callback?: StorageCallback) =>
        run(
          local.set(
            Object.fromEntries(Object.entries(values).map(([key, value]) => [prefix + key, value]))
          ),
          callback
        ),
      remove: (keys: string | string[], callback?: StorageCallback) =>
        run(
          local.remove((Array.isArray(keys) ? keys : [keys]).map((key) => prefix + key)),
          callback
        ),
      clear: (callback?: StorageCallback) =>
        run(
          local
            .get(null)
            .then((stored) =>
              local.remove(Object.keys(stored).filter((key) => key.startsWith(prefix)))
            ),
          callback
        ),
      getBytesInUse: (keys: StorageKeys | undefined, callback?: StorageCallback) =>
        run(
          get(keys)!.then((values) => new TextEncoder().encode(JSON.stringify(values)).byteLength),
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
