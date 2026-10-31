/**
 * A preload that grants nothing, for a window built with no bridge at all.
 *
 * A window opened from the app inherits the app's privileged preload unless its
 * own `webPreferences` says otherwise, and `preload: ''` is not that statement:
 * Electron requires an absolute path there and logs `preload script must have
 * absolute path` for the empty string, so every such window reported a failure
 * that had not happened. An absolute path to this file is the way to say "no
 * preload" in a form the host accepts.
 *
 * It has to emit one statement, because the preload bundle refuses a chunk that
 * owns modules and renders no code; a no-op assignment keeps that guard honest
 * and does nothing else.
 */
Object.defineProperty(globalThis, '__cioBlankPreload', { value: true })
