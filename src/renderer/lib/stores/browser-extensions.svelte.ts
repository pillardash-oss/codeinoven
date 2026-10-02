import { invoke, subscribe } from '$lib/ipc.svelte'
import { webstoreExtensionIdFromInput } from '$shared/browser/browser-webstore'
import type {
  BrowserExtension,
  BrowserExtensionActivity,
  BrowserExtensionActivityUpdate,
  BrowserExtensionInjection,
  BrowserExtensionInstallInput,
  BrowserExtensionProgress
} from '$shared/ipc-contract'
import { reportError } from './app-errors.svelte'

/** How one extension's action state is keyed in the two activity maps. */
const ACTIVITY_SEPARATOR = '\u0000'
function activityKey(boxId: string, extensionId: string): string {
  return `${boxId}${ACTIVITY_SEPARATOR}${extensionId}`
}
function activityTabKey(boxId: string, extensionId: string, tabId: string): string {
  return `${boxId}${ACTIVITY_SEPARATOR}${extensionId}${ACTIVITY_SEPARATOR}${tabId}`
}

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
 * One install the panel is following: queued, running, or the frame before it
 * resolves.
 *
 * Built from main's progress lines, plus the name the click knew. A store page
 * names its extension before anything has been downloaded, and that name is what
 * the user is looking for in the list, so it is kept rather than replaced by the
 * id main would otherwise have to show.
 */
export interface BrowserExtensionInstall {
  /** The install's own id, minted by the store and sent with it, so every
   *  progress line can be attributed to the click that asked for it. */
  installId: string
  /** What to call it on screen, or null when nobody knows a name yet. */
  name: string | null
  /** The Web Store id this install is for, or null when it came from a folder. */
  webstoreId: string | null
  /** The Web Store id or folder path main is working from. */
  label: string
  phase: BrowserExtensionProgress['phase']
  detail: string
  receivedBytes: number
  totalBytes: number
}

/**
 * What to call a folder install before its manifest has been read.
 *
 * The folder's own name is what the user picked and recognises; the full path is
 * not something the panel can show at a glance.
 */
function installFolderName(input: Omit<BrowserExtensionInstallInput, 'installId'>): string | null {
  if (input.source !== 'folder') return null
  const segments = input.value
    .trim()
    .split(/[\\/]/u)
    .filter((segment) => segment.length > 0)
  return segments[segments.length - 1] ?? null
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
  /**
   * Every install that is queued or running, oldest first.
   *
   * A list rather than one line, because installs overlap: two run at once and the
   * rest wait, so a single line would have to decide which of them it was
   * describing. It also names each one here before main has read anything out of a
   * package, which is what lets the click and its progress be the same thing from
   * the first frame.
   */
  installs: BrowserExtensionInstall[] = $state([])
  /** Extension ids whose user-requested update is downloading or applying. */
  updatingIds: string[] = $state([])
  /** Action state every tab of a box sees, keyed box + extension. */
  private activityGlobal: Record<string, BrowserExtensionActivity> = $state({})
  /** Action state one tab sees, over the extension's own, keyed box + extension
   *  + tab. */
  private activityByTab: Record<string, BrowserExtensionActivity> = $state({})

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

  /** How many extensions are pinned into the browser view's header, for the cap's
   *  own rule. */
  get pinnedCount(): number {
    return this.extensions.filter((extension) => extension.pinned).length
  }

  /** True while any install is queued or running, which is what the rail's own
   *  door and the panel's menu read to stay out of the way. */
  get installing(): boolean {
    return this.installs.length > 0
  }

  /** Whether one extension's Web Store package is being applied. */
  isUpdating(extensionId: string): boolean {
    return this.updatingIds.includes(extensionId)
  }

  /**
   * The install for one Web Store extension, or null when none is in flight.
   *
   * A store page's chip and the panel's offer row both read this, so they agree on
   * whether the offer has already been taken. Matched on the Web Store id rather
   * than on who clicked, because the page stays open while the install runs and the
   * chip has to keep saying so across a renderer reload that never saw the click.
   */
  installForWebstoreId(webstoreId: string): BrowserExtensionInstall | null {
    return this.installs.find((install) => install.webstoreId === webstoreId) ?? null
  }

  /**
   * The pinned extensions of one jar, which is the header's whole list.
   *
   * A pin is a place in the browser view's chrome and is drawn by no other view,
   * so it is shown while the box on screen runs the extension and steps aside for
   * every other box. An extension that is disabled or loaded nowhere is not
   * running in that jar, so it is not pinned into anything either.
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

  /**
   * The action state one pinned extension wears for one tab.
   *
   * The tab's own entry is merged over the extension's wider one field by field,
   * so an icon the extension set globally survives a badge it set for this tab.
   * Null when neither said anything, which is what leaves the pin drawing the
   * manifest icon with no badge.
   */
  activityFor(boxId: string, tabId: string, extensionId: string): BrowserExtensionActivity | null {
    const global = this.activityGlobal[activityKey(boxId, extensionId)]
    const local = this.activityByTab[activityTabKey(boxId, extensionId, tabId)]
    if (!global && !local) return null
    // Both entries carry `updatedAt`, so the merge always has one; the tab's
    // entry is read last, which is what makes it override the extension's own.
    return { ...(global ?? {}), ...(local ?? {}) } as BrowserExtensionActivity
  }

  /**
   * Apply one activity change from main.
   *
   * A reset is a worker that restarted: everything the extension had recorded
   * for its box is dropped first, because the fresh life holds none of it and
   * merging into the leftovers would show a badge no extension is wearing.
   */
  private applyActivity(update: BrowserExtensionActivityUpdate): void {
    const globalKey = activityKey(update.boxId, update.extensionId)
    if (update.reset) {
      const nextGlobal = { ...this.activityGlobal }
      const nextTabs = { ...this.activityByTab }
      delete nextGlobal[globalKey]
      const prefix = `${update.boxId}${ACTIVITY_SEPARATOR}${update.extensionId}${ACTIVITY_SEPARATOR}`
      for (const key of Object.keys(nextTabs)) {
        if (key.startsWith(prefix)) delete nextTabs[key]
      }
      this.activityGlobal = nextGlobal
      this.activityByTab = nextTabs
    }
    if (!update.activity) return
    if (update.tabId === null) {
      this.activityGlobal = { ...this.activityGlobal, [globalKey]: update.activity }
      return
    }
    this.activityByTab = {
      ...this.activityByTab,
      [activityTabKey(update.boxId, update.extensionId, update.tabId)]: update.activity
    }
  }

  /**
   * Apply one install's progress line.
   *
   * The entry is upserted rather than looked up, because main can be running an
   * install this renderer never asked for: a reload mid-install loses the click
   * that started it, and the rail still has to say what is happening. A terminal
   * line ends the entry, so a card can never outlive the install it describes.
   */
  private applyProgress(progress: BrowserExtensionProgress): void {
    if (progress.phase === 'done' || progress.phase === 'failed') {
      this.installs = this.installs.filter((install) => install.installId !== progress.installId)
      return
    }
    const existing = this.installs.find((install) => install.installId === progress.installId)
    if (!existing) {
      this.installs = [...this.installs, { ...progress, name: null }]
      return
    }
    // The local entry knows what the user clicked, which main cannot know until it
    // has read the package: the name a store page gave the extension.
    this.installs = this.installs.map((install) =>
      install.installId === progress.installId
        ? { ...install, ...progress, name: install.name }
        : install
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
    // One line per install, and installs overlap: the panel lists what is queued
    // and what is running from these.
    subscribe('browser:extensionProgress', (progress) => {
      this.applyProgress(progress)
    })
    // One extension's action state at a time, as its worker reports it. The pins
    // read the merge for the tab on screen from these two maps.
    subscribe('browser:extensionActivity', (update) => {
      this.applyActivity(update)
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
   * Resolves with the installed record, or null when it failed. The install is
   * named and listed here before it is sent, so the panel's list and the store
   * page's chip can attribute it from the frame the user clicked in rather than
   * waiting for main to read a name out of the package.
   *
   * It queues: main runs two at a time, so this answers when this install is done,
   * however many were in front of it, and its progress arrives meanwhile.
   */
  async install(
    input: Omit<BrowserExtensionInstallInput, 'installId'>,
    name: string | null = null
  ): Promise<BrowserExtension | null> {
    const installId = crypto.randomUUID()
    const label = input.value.trim()
    this.installs = [
      ...this.installs,
      {
        installId,
        name: name ?? installFolderName(input),
        // The page's offer matches on this, so it is resolved the same way main
        // resolves it rather than assumed from the source.
        webstoreId: input.source === 'webstore' ? webstoreExtensionIdFromInput(label) : null,
        label,
        phase: 'queued',
        detail: 'Starting',
        receivedBytes: 0,
        totalBytes: 0
      }
    ]
    try {
      const extension = await invoke('browser:extensionInstall', { ...input, installId })
      this.apply(extension)
      this.loaded = true
      return extension
    } catch (error: unknown) {
      reportError(error, 'The extension could not be installed.')
      return null
    } finally {
      this.installs = this.installs.filter((install) => install.installId !== installId)
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

  /** Apply a newer Web Store package after the user clicks its row action. */
  async updateFromWebStore(extensionId: string): Promise<void> {
    if (this.isUpdating(extensionId)) return
    this.updatingIds = [...this.updatingIds, extensionId]
    try {
      const extension = await invoke('browser:extensionUpdateFromWebStore', extensionId)
      this.apply(extension)
    } catch (error: unknown) {
      reportError(error, 'The extension could not be updated.')
    } finally {
      this.updatingIds = this.updatingIds.filter((id) => id !== extensionId)
    }
  }

  /** Load or unload an extension everywhere. Main decides where it can run, so
   *  disabling it is enough to make it inert without losing its settings. */
  async setEnabled(extensionId: string, enabled: boolean): Promise<void> {
    await this.patch(extensionId, { enabled }, 'The extension could not be updated.')
  }

  /** Pin or unpin one extension, for the place it takes in the browser view's
   *  header. Both pin rules are main's, so a refusal arrives as the error it is. */
  async setPinned(extensionId: string, pinned: boolean): Promise<void> {
    await this.patch(extensionId, { pinned }, 'The extension could not be pinned.')
  }

  /** Save a complete user-selected order for installed extensions. */
  async reorder(orderedIds: string[]): Promise<void> {
    try {
      await invoke('browser:extensionReorder', orderedIds)
    } catch (error: unknown) {
      reportError(error, 'The extensions could not be reordered.')
    }
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
