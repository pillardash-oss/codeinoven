import { invoke, subscribe } from '$lib/ipc.svelte'
import type {
  BrowserExtension,
  BrowserExtensionInjection,
  BrowserExtensionInstallInput,
  BrowserExtensionProgress
} from '$shared/ipc-contract'
import { reportError } from './app-errors.svelte'

/**
 * How the install-time compatibility preamble reached an extension's service
 * worker, in plain words.
 *
 * The injection shape is forced by the manifest rather than chosen, so the copy
 * explains what the runtime did instead of naming the mechanism. Kept here so the
 * install result and a row's detail view say the same sentence.
 */
export function browserExtensionInjectionLabel(injected: BrowserExtensionInjection): string {
  switch (injected) {
    case 'module-bootstrap':
      return 'Loaded through a module bootstrap, which reaches the service worker before its own imports run.'
    case 'prepend-classic':
      return 'Loaded by prepending the compatibility preamble to the extension service worker.'
    case 'prepend-mv2':
      return 'Loaded by prepending the compatibility preamble to the Manifest V2 background page.'
    case 'none':
      return 'No compatibility preamble was needed.'
    default:
      return 'The compatibility preamble was applied before the extension loaded.'
  }
}

/**
 * The browser's installed extensions, as the rail draws them.
 *
 * Main owns the extension store: it fetches, unpacks, pins and registers each
 * extension, and the runtime it loads is per jar rather than per page. This
 * store is the renderer's mirror of that list, so the extensions panel, a row's
 * enablement switch and the install surface all read one copy instead of asking
 * main separately.
 *
 * The list is replaced wholesale rather than patched: main publishes the whole
 * list after any change, because it is short, and one authoritative copy is what
 * stops a row that was removed in another window from lingering here.
 *
 * Like every other browser store this one is inert until {@link start} is
 * called. The extensions belong to the browser, the browser is not part of the
 * first paint, and a launch that never touches the browser must not pay for a
 * listener or a read.
 */
class BrowserExtensionsState {
  /** Every installed extension, in the order main reports them (oldest first). */
  extensions: BrowserExtension[] = $state([])
  /** True once the first read has answered, so the panel can tell "none
   *  installed" from "not read yet". */
  loaded = $state(false)
  /** The install currently running, or null. Main reports one at a time, and
   *  the extensions rail draws where the current one is. */
  progress: BrowserExtensionProgress | null = $state(null)
  /** True while an install is in flight, so the rail can keep the door it was
   *  started from shut and say what is happening. */
  installing = $state(false)

  /** Whether {@link start} has wired the runtime. Idempotent. */
  private started = false

  /** How many extensions are installed. */
  get count(): number {
    return this.extensions.length
  }

  /** How many of them are loaded into at least one jar. An installed but
   *  disabled extension is a row the user can still enable, never a hidden one. */
  get enabledCount(): number {
    return this.extensions.filter((extension) => extension.enabled).length
  }

  /**
   * The enabled extensions of one jar that declare a popup.
   *
   * A popup is the only part of an extension the user reaches from the rail, and
   * Electron draws no toolbar for it, so the rail is its host. An extension that
   * is disabled, loaded nowhere, or declares no popup has none to offer. The jar
   * is the vocabulary extension records use, where the context's own jar is the
   * empty string.
   */
  popupExtensionsInJar(jar: string): BrowserExtension[] {
    return this.extensions.filter(
      (extension) =>
        extension.enabled && extension.popupPath !== null && extension.boxes.includes(jar)
    )
  }

  /** How many extensions are pinned into the app header, for the cap's own rule. */
  get pinnedCount(): number {
    return this.extensions.filter((extension) => extension.pinned).length
  }

  /**
   * The pinned extensions of one jar, which is the header's whole list.
   *
   * A pin is a place in the app's own chrome, so it is shown while the box on
   * screen runs the extension and steps aside for every other box. An extension
   * that is disabled or loaded nowhere is not running in that jar, so it is not
   * pinned into anything either.
   */
  pinnedExtensionsInJar(jar: string): BrowserExtension[] {
    return this.extensions.filter(
      (extension) =>
        extension.pinned &&
        extension.enabled &&
        extension.popupPath !== null &&
        extension.boxes.includes(jar)
    )
  }

  /** Register the runtime's subscriptions and read the installed list once. */
  start(): void {
    if (this.started) return
    this.started = true
    // Main publishes the whole list after any change, so one subscription keeps
    // the rail current whether the user edited it here or the runtime changed on
    // its own (an update, a removed extension).
    subscribe('browser:extensions', (extensions) => {
      this.extensions = extensions
      this.loaded = true
    })
    // One install at a time, so a single progress line is enough: it names the
    // step, and the rail draws it until the install resolves.
    subscribe('browser:extensionProgress', (progress) => {
      this.progress = progress
    })
    void this.refresh()
  }

  /** Read the installed list from main. */
  private async refresh(): Promise<void> {
    try {
      this.extensions = await invoke('browser:extensions')
      this.loaded = true
    } catch (error: unknown) {
      reportError(error, 'Browser extensions could not be loaded.')
    }
  }

  /**
   * Put one extension's record where its id belongs: replace it in place, or
   * append a newly installed one. A mutation answers with the changed record, so
   * this is what applies its result without a second read.
   */
  private apply(extension: BrowserExtension): void {
    const index = this.extensions.findIndex((existing) => existing.id === extension.id)
    if (index === -1) {
      this.extensions = [...this.extensions, extension]
      return
    }
    this.extensions = this.extensions.map((existing) =>
      existing.id === extension.id ? extension : existing
    )
  }

  /**
   * Install an extension by Web Store id or URL, or from an unpacked folder.
   *
   * Resolves with the installed record, or null when it failed. The progress
   * line is cleared before the install starts and again when it ends, so the rail
   * never shows a stale phase from a previous attempt.
   */
  async install(input: BrowserExtensionInstallInput): Promise<BrowserExtension | null> {
    this.installing = true
    this.progress = null
    try {
      const extension = await invoke('browser:extensionInstall', input)
      this.apply(extension)
      this.loaded = true
      return extension
    } catch (error: unknown) {
      reportError(error, 'The extension could not be installed.')
      return null
    } finally {
      this.installing = false
      this.progress = null
    }
  }

  /** Remove an extension. The row leaves the list when main answers, and main
   *  publishes the new list too, so an open panel in another surface follows. */
  async uninstall(extensionId: string): Promise<void> {
    try {
      await invoke('browser:extensionUninstall', extensionId)
      this.extensions = this.extensions.filter((extension) => extension.id !== extensionId)
    } catch (error: unknown) {
      reportError(error, 'The extension could not be removed.')
    }
  }

  /** Load or unload an extension everywhere. Main decides where it can run, so
   *  disabling it is enough to make it inert without losing its settings. */
  async setEnabled(extensionId: string, enabled: boolean): Promise<void> {
    await this.patch(extensionId, { enabled }, 'The extension could not be updated.')
  }

  /** Pin or unpin one extension, for the place it takes in the app header. Both
   *  pin rules are main's, so a refusal arrives as the error it is. */
  async setPinned(extensionId: string, pinned: boolean): Promise<void> {
    await this.patch(extensionId, { pinned }, 'The extension could not be pinned.')
  }

  /**
   * Replace the whole set of jars an extension runs in.
   *
   * `boxes` is the full list, never a delta, because main replaces rather than
   * merges and one assignment here keeps the two sides from drifting. Null means
   * every jar, including ones made later; the empty string is the context's own
   * jar with no box.
   */
  async setBoxes(extensionId: string, boxes: string[]): Promise<void> {
    await this.patch(extensionId, { boxes }, 'The extension could not be updated.')
  }

  /** Send one patch to main and apply the record it answers with. */
  private async patch(
    extensionId: string,
    patch: { enabled?: boolean; boxes?: string[]; pinned?: boolean },
    fallback: string
  ): Promise<void> {
    try {
      const extension = await invoke('browser:extensionUpdate', extensionId, patch)
      this.apply(extension)
    } catch (error: unknown) {
      reportError(error, fallback)
    }
  }

  /** Ask the user for an unpacked extension folder. Null when they cancel. */
  async pickFolder(): Promise<string | null> {
    try {
      return await invoke('browser:extensionPickFolder')
    } catch (error: unknown) {
      reportError(error, 'The extension folder could not be chosen.')
      return null
    }
  }
}

export const browserExtensions = new BrowserExtensionsState()
