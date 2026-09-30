/**
 * Browser extensions: what is installed, and which jars load them.
 *
 * An extension is a piece of third-party code the app runs inside a box's session,
 * so four rules shape this service:
 *
 *   1. **Installation is an app-owned folder, never the user's.** The package is
 *      unpacked into `browser/extensions/<id>/source` and every load points there,
 *      so the app can re-apply its compatibility layer on an update and can delete
 *      an extension completely.
 *   2. **An extension is loaded per jar, not app-wide.** Chromium has no
 *      cross-session extension, so each box that enables one gets its own copy with
 *      its own storage. That is the point of containing an extension: two boxes can
 *      run different extensions, or the same one with separate state.
 *   3. **The jars are the global browser's.** Only that context's jars are
 *      reconciled: the panel that installs an extension, the boxes it can be placed
 *      in and the pins in the header all belong to that browser. A project's browser,
 *      which is the light one a conversation opens beside itself with no boxes and
 *      no extension chrome, never loads one, so no third-party code or extension
 *      renderer sits behind a thread browser.
 *   4. **It costs a renderer per jar it lives in, so it is unloaded the moment its
 *      jar has no live page.** An extension left loaded for a box the user closed
 *      is a renderer held for nothing.
 *
 * Loading is asynchronous while `ensureTab` is synchronous, so loading never happens
 * inside tab creation: the caller that is about to create a tab awaits
 * `ensureJarLoaded` first, and every other path is a fire-and-forget reconcile.
 */

/// <reference types="vite/client" />
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { dialog, type BrowserWindow, type Session } from 'electron'
import preambleSource from './compat/cio-compat-preamble.js?raw'
import { missingExtensionCapabilities } from '../../../lib/browser/browser-extension-capabilities'
import { MAX_PINNED_EXTENSIONS } from '../../../lib/browser/browser-extension-pins'
import { GLOBAL_BROWSER_PROJECT_ID } from '../../../lib/ipc/browser'
import type {
  BrowserExtension,
  BrowserExtensionActivity,
  BrowserExtensionActivityUpdate,
  BrowserExtensionInstallInput,
  BrowserExtensionMenuRecord,
  BrowserExtensionProgress
} from '../../../lib/ipc/browser'
import { Logger } from '../../system/logger'
import { getNotificationService } from '../../notifications/notification-service'
import { browserPartitionFor } from '../browser-service/browser-validation'
import { prepareExtensionSource } from './browser-extension-install-job'
import { COMPAT_BRIDGE_PAGE_FILE_NAME, ensureInjectionCurrent } from './browser-extension-inject'
import {
  BrowserExtensionBridge,
  type BrowserExtensionMailbox,
  type BrowserExtensionNotificationRecord,
  type BrowserExtensionSidePanelMailbox,
  type BrowserExtensionSidePanelOption,
  type BrowserExtensionSidePanelRequest
} from './browser-extension-bridge'
import { extensionIdFromInput, isExtensionId } from './browser-extension-crx'
import { downloadWebStoreRelease, resolveWebStoreRelease } from './browser-extension-webstore'
import {
  EXTENSION_MANIFEST_NAME,
  extensionPopupUrl,
  readActionIconDataUrl,
  readManifestObject
} from './browser-extension-source'
import { stripInstalledManifestPermissions } from './browser-extension-manifest'
import {
  BROWSER_EXTENSION_SOURCE_DIR,
  BROWSER_EXTENSION_STORE_DIR,
  BrowserExtensionRegistry,
  extensionRunsInJar,
  extensionSourceDirectory,
  toExtensionView,
  type BrowserExtensionRecord,
  type BrowserExtensionRegistryPersistence
} from './browser-extension-registry'
import { materializeUserScriptFiles } from './browser-extension-user-scripts'

/** How often progress reaches the renderer. A download reports per chunk and the
 *  install worker per phase, so without a gate a large package would send hundreds
 *  of events that all say the same thing. */
const PROGRESS_INTERVAL_MS = 200

/** How many installs run at once, and therefore how many downloads.
 *
 * Two is the point of the queue rather than a random number: a user installing
 * two extensions should not have to wait for the first to finish before the
 * second is even accepted, while a third download would only split the same
 * connection and disk between them. Everything else waits its turn. */
const MAX_CONCURRENT_INSTALLS = 2

/** Directories inside the store root that are not extensions. */
const STAGING_DIR = '.staging'
const DOWNLOADS_DIR = '.downloads'

/** The identity of one install, attached to every progress line it produces.
 *
 * Resolved once, when the install is accepted, so no two lines about the same
 * install can disagree about what they are describing. */
interface InstallContext {
  /** The caller's id for this install, which is what ties a line to its click. */
  installId: string
  /** The Web Store id or folder path the install is for, named before the
   *  extension has an id of its own. */
  label: string
  /** The Web Store id this install is for, or null when it came from a folder. */
  webstoreId: string | null
}

/** One accepted install that may not have started yet. */
interface QueuedInstall {
  input: BrowserExtensionInstallInput
  context: InstallContext
  resolve: (extension: BrowserExtension) => void
  reject: (error: unknown) => void
}

/** One jar with extensions loaded in it. The session is held, not looked up on
 *  demand: unloading must never be what creates a partition directory, and a
 *  lookup would also re-trigger the loading path it is trying to undo. */
interface LoadedJar {
  session: Session
  projectId: string
  boxId: string | null
  ids: Set<string>
  /** One live channel per loaded extension, keyed by extension id. */
  bridges: Map<string, BrowserExtensionBridge>
  /** The last mailbox each extension's worker wrote, which is also what the
   *  native context menu is built from. */
  mail: Map<string, BrowserExtensionMailbox>
  /** The worker life the last published activity came from, per extension. */
  publishedGeneration: Map<string, string>
  /** The highest notification sequence number already acted on, per extension,
   *  so the poll never raises the same request twice. Dropped when that
   *  extension's worker restarts, whose own sequence starts over. */
  notificationSeq: Map<string, number>
  /** The highest side-panel request sequence number already acted on, per
   *  extension, so the poll never raises the same request twice. Dropped when
   *  that extension's worker restarts, whose own sequence starts over. */
  sidePanelSeq: Map<string, number>
  /** Activity already sent to the renderer, so the 500 ms mailbox poll sends a
   *  change once instead of on every read. Keyed `extensionId\u0000tabId`. */
  published: Map<string, string>
  /** Snapshots waiting to be published, one extension's at a time. Resolving an
   *  action icon reads from disk, and two snapshots must not be published out of
   *  the order their worker wrote them in. */
  publishing: Promise<void>
}

/**
 * What the extension service needs from the browser service. Kept to a small
 * interface so the extension subsystem never reaches into a tab or a window it was
 * not handed.
 */
export interface BrowserExtensionHost {
  /** The window to parent a folder picker to, or null when there is none. */
  window(): BrowserWindow | null
  /** The session for a jar, created and configured if it does not exist yet. */
  sessionFor(projectId: string, boxId: string | null): Session
  /** Every jar that currently has a live page. */
  liveJars(): { projectId: string; boxId: string | null }[]
  /** The app tab a browser page belongs to, for action state an extension scoped
   *  to the tab ids the runtime gave it. */
  resolveTabId(projectId: string, contentsId: number): string | null
  /**
   * The tab events that describe a jar's tabs right now, in the order a
   * freshly started worker needs them.
   *
   * A worker that starts while tabs already exist has no way to learn about
   * them: `chrome.tabs.query` is answered from the runtime's own focus state,
   * which is empty whenever the window is not the focused one, and nothing else
   * announces a tab the extension did not see arrive. A restarted worker is a
   * fresh life with the same problem, so both are handed this replay. */
  tabReplay(projectId: string, boxId: string | null): BrowserExtensionTabReplay[]
  /** One extension's action state changed for a tab, or for every tab of its jar
   *  when the tab is null. */
  publishActivity(update: BrowserExtensionActivityUpdate): void
  /** Report one install step to the renderer. */
  reportProgress(progress: BrowserExtensionProgress): void
  /** The installed list changed. */
  publish(): void
  /** Raise one extension's side panel, loading the extension's own document in
   *  the jar it runs in. The panel is registered before this returns, so the
   *  worker's `onOpened` follows the request that asked for it. */
  openSidePanel(request: BrowserExtensionSidePanelOpenRequest): void
  /** Close one extension's side panel. `extensionTabId` names the tab the
   *  request was for; null closes it whatever tab it belongs to. */
  closeSidePanel(extensionId: string, extensionTabId: number | null): void
}

/** One side panel a worker asked the app to raise. The extension service
 *  resolves which tab and which path; the browser service owns the view and the
 *  jar's session, and loads the document this names. */
export interface BrowserExtensionSidePanelOpenRequest {
  projectId: string
  boxId: string | null
  extensionId: string
  extensionName: string
  /** The extension's own tab id, or null when the request named no tab and the
   *  active tab of the project's browser is the one meant. */
  extensionTabId: number | null
  path: string
  url: string
}

/** The tab events the app synthesizes, under the extension API's own names. */
export type BrowserExtensionTabEventName =
  'onCreated' | 'onUpdated' | 'onRemoved' | 'onActivated' | 'onHighlighted'

/** One tab event, in the shape `chrome.tabs` hands a listener its arguments. */
export interface BrowserExtensionTabReplay {
  name: BrowserExtensionTabEventName
  args: unknown[]
}

/**
 * The navigation lifecycle the app synthesizes for `chrome.webNavigation`, under
 * the extension API's own event names.
 *
 * Chromium's navigation runtime is not reachable from an embedded page, so these
 * come from the main frame's own `did-*` hooks instead. Only the main frame is
 * observed, which is why no subframe event is synthesized.
 */
export type BrowserExtensionWebNavigationEventName =
  | 'onBeforeNavigate'
  | 'onCommitted'
  | 'onDOMContentLoaded'
  | 'onCompleted'
  | 'onErrorOccurred'
  | 'onHistoryStateUpdated'
  | 'onReferenceFragmentUpdated'

/** Action state as an extension recorded it, or null when a patch carries
 *  nothing the pins can draw. Only the fields the extension actually set are
 *  carried, so the renderer merges a tab's entry over the extension's own
 *  instead of reading a missing field as a cleared one. */
function activityFromPatch(
  patch: Record<string, unknown>,
  at: number
): BrowserExtensionActivity | null {
  const activity: BrowserExtensionActivity = { updatedAt: at }
  if (typeof patch['badgeText'] === 'string') activity.badgeText = patch['badgeText']
  if (typeof patch['badgeColor'] === 'string') activity.badgeColor = patch['badgeColor']
  if ('iconUrl' in patch) {
    activity.iconUrl = typeof patch['iconUrl'] === 'string' ? patch['iconUrl'] : null
  }
  if ('title' in patch) {
    activity.title = typeof patch['title'] === 'string' ? patch['title'] : null
  }
  return Object.keys(activity).length > 1 ? activity : null
}

export class BrowserExtensionService {
  private readonly registry: BrowserExtensionRegistry
  /** The one registry read, awaited by everything that depends on it. Nothing
   *  loads an extension before it resolves. */
  private readonly ready: Promise<void>
  /** partition -> the extension ids loaded in it. */
  private readonly loaded = new Map<string, LoadedJar>()
  /** partition -> an in-flight reconcile, so two shows cannot race a load. */
  private readonly loading = new Map<string, Promise<void>>()
  /** Installs accepted but not started, oldest first. */
  private readonly installQueue: QueuedInstall[] = []
  /** How many installs are running right now. Never more than
   *  {@link MAX_CONCURRENT_INSTALLS}. */
  private runningInstalls = 0
  /** Every install that is queued or running, so a caller cannot name one that is
   *  already in flight and have its progress attributed to it. */
  private readonly installIds = new Set<string>()
  /** Per-install progress gating, keyed by install id: two installs reporting at
   *  the same moment must not suppress each other's lines the way one shared
   *  clock would. */
  private readonly installProgress = new Map<
    string,
    { at: number; phase: BrowserExtensionProgress['phase'] }
  >()
  /** Icons an extension set on its action, by absolute path. Shared across jars:
   *  the bytes belong to the extension's own folder, not to a session. */
  private readonly actionIcons = new Map<string, string | null>()
  /** The namespaced OS notification ids each extension currently has raised, so
   *  a `clearAll` can dismiss exactly that extension's cards. */
  private readonly raisedNotifications = new Map<string, Set<string>>()
  private disposed = false

  constructor(
    private readonly configRoot: string,
    persistence: BrowserExtensionRegistryPersistence,
    private readonly host: BrowserExtensionHost
  ) {
    this.registry = new BrowserExtensionRegistry(persistence)
    // Started, not awaited: a corrupt registry must not stop the app from
    // starting, and every path that needs the list awaits this promise.
    this.ready = this.registry.load().catch((error: unknown) => {
      Logger.error('Browser extension registry could not be read:', error)
    })
  }

  /** Wait for the registry to have been read. */
  async whenReady(): Promise<void> {
    await this.ready
  }

  /** The installed extensions, as the renderer draws them. */
  list(): BrowserExtension[] {
    return this.registry.list().map((record) => toExtensionView(record, []))
  }

  /**
   * The popup document one installed extension declares, as an address, when it
   * is enabled and runs in the jar asked for.
   *
   * Null for everything else, which is what every caller checks before it can
   * host one: an extension the jar does not run is not loaded there, so its own
   * page would have no extension behind it.
   */
  popupUrlFor(extensionId: string, boxId: string | null): string | null {
    const record = this.registry.get(extensionId)
    if (!record || !record.enabled) return null
    if (!extensionRunsInJar(record, boxId)) return null
    return extensionPopupUrl(record.id, record.popupPath)
  }

  /**
   * Install one extension, or queue it behind the installs already running.
   *
   * Two run at once and everything else waits. Nothing is shared between them: the
   * staging folder, the downloaded file and the progress lines are all the
   * install's own, so the slot is the only thing a queue has to hand out. The
   * promise answers when this install finishes, however long the queue in front of
   * it was, and its progress arrives on the event stream meanwhile.
   */
  async install(input: BrowserExtensionInstallInput): Promise<BrowserExtension> {
    if (this.disposed) throw new Error('The browser is shutting down')
    if (this.installIds.has(input.installId)) {
      throw new Error('That install is already running')
    }
    const context: InstallContext = {
      installId: input.installId,
      label: input.value.trim() || 'extension',
      // Resolved here rather than after the download so the very first line about
      // this install can be matched to the store page that asked for it.
      webstoreId: input.source === 'webstore' ? extensionIdFromInput(input.value) : null
    }
    this.installIds.add(context.installId)
    return new Promise<BrowserExtension>((resolve, reject) => {
      this.installQueue.push({ input, context, resolve, reject })
      // Reported before anything starts, so a queued install shows up in the panel
      // in the same breath as the click that asked for it.
      this.report(context, {
        phase: 'queued',
        detail: `Waiting for the ${this.runningInstalls === 1 ? 'install' : 'installs'} already running`
      })
      this.startQueuedInstalls()
    })
  }

  /** Hand the free slots to the installs waiting for them. */
  private startQueuedInstalls(): void {
    while (this.runningInstalls < MAX_CONCURRENT_INSTALLS) {
      const job = this.installQueue.shift()
      if (!job) return
      this.runningInstalls += 1
      void this.runQueuedInstall(job)
    }
  }

  /** Run one install, answer its caller, then release its slot for the next. */
  private async runQueuedInstall(job: QueuedInstall): Promise<void> {
    try {
      job.resolve(await this.runInstall(job.input, job.context))
    } catch (error: unknown) {
      const reason = error instanceof Error && error.message ? error.message : String(error)
      // A failure is a phase, not just a rejected promise: an install started from
      // the browser chrome has a progress line and no dialog of its own to fail in.
      this.report(job.context, { phase: 'failed', detail: reason })
      job.reject(error)
    } finally {
      this.runningInstalls -= 1
      this.installIds.delete(job.context.installId)
      this.installProgress.delete(job.context.installId)
      this.startQueuedInstalls()
    }
  }

  /** Uninstall an extension: stop it everywhere, then delete its files. */
  async uninstall(extensionId: string): Promise<void> {
    if (!isExtensionId(extensionId)) throw new TypeError('Browser extension ID is invalid')
    const record = this.registry.get(extensionId)
    if (!record) return
    await this.unloadEverywhere(extensionId)
    await rm(this.extensionDirectory(extensionId), { recursive: true, force: true })
    // Its icons went with the folder. Held bytes would outlive the files they
    // came from and be drawn for whatever is installed under the same id next.
    this.actionIcons.clear()
    await this.registry.remove(extensionId)
    this.host.publish()
  }

  /** Enable or disable one extension, choose the jars it runs in, or pin it into
   *  the browser view's header.
   *
   * The pin rules live here rather than in the panel, because a pin is a place in
   * that view's chrome: only a header's worth of them exists
   * (`MAX_PINNED_EXTENSIONS`), and a pin only means something for an extension
   * that declares a popup, since opening that popup is the only thing a pin does. */
  async update(
    extensionId: string,
    patch: { enabled?: boolean; boxes?: string[]; pinned?: boolean }
  ): Promise<BrowserExtension> {
    if (!isExtensionId(extensionId)) throw new TypeError('Browser extension ID is invalid')
    const current = this.registry.get(extensionId)
    if (!current) throw new Error('That extension is not installed')
    if (patch.pinned === true) {
      if (!current.popupPath) {
        throw new Error('That extension declares no popup to open from a pin')
      }
      const pinned = this.registry
        .list()
        .filter((record) => record.pinned && record.id !== extensionId)
      if (pinned.length >= MAX_PINNED_EXTENSIONS) {
        throw new Error(`Only ${MAX_PINNED_EXTENSIONS} extensions can be pinned at once`)
      }
    }
    const record = await this.registry.patch(extensionId, patch)
    if (!record) throw new Error('That extension is not installed')
    await this.reconcileLiveJars()
    this.host.publish()
    return toExtensionView(record, [])
  }

  /** Ask the user for an unpacked extension folder. */
  async pickFolder(): Promise<string | null> {
    const window = this.host.window()
    if (!window || window.isDestroyed()) return null
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose an unpacked extension folder',
      buttonLabel: 'Choose',
      properties: ['openDirectory']
    })
    if (result.canceled) return null
    return result.filePaths[0] ?? null
  }

  /**
   * Make one jar's loaded set match what the registry says it should be.
   *
   * Called before a page is created in a jar (awaited) and after any change to the
   * installed list (not awaited). Idempotent, and single-flight per partition: a
   * burst of shows for the same jar loads each extension once.
   */
  async ensureJarLoaded(projectId: string, boxId: string | null): Promise<void> {
    if (this.disposed) return
    await this.ready
    const partition = browserPartitionFor(projectId, boxId)
    const inFlight = this.loading.get(partition)
    if (inFlight) return inFlight
    const task = this.reconcileJar(projectId, boxId, partition).catch((error: unknown) => {
      Logger.error('Browser extensions could not be reconciled for a jar:', error)
    })
    this.loading.set(partition, task)
    try {
      await task
    } finally {
      this.loading.delete(partition)
    }
  }

  /**
   * Release a jar's extensions, because it has no live page left.
   *
   * This is the memory half of containment: a box the user closed keeps its
   * cookies on disk, but it does not keep a renderer per extension loaded into it.
   */
  async onJarEmptied(projectId: string, boxId: string | null): Promise<void> {
    if (this.disposed) return
    const partition = browserPartitionFor(projectId, boxId)
    // A load already in flight would otherwise finish after this and leave the jar
    // loaded with nothing to show for it.
    const inFlight = this.loading.get(partition)
    if (inFlight) await inFlight.catch(() => undefined)
    const state = this.loaded.get(partition)
    if (!state) return
    for (const id of [...state.ids]) {
      this.stopBridge(state, id)
      this.removeFromSession(state.session, id)
    }
    this.loaded.delete(partition)
  }

  /**
   * A box was deleted. Its id never comes back, so every extension that named it
   * forgets it, and anything loaded for it is released before its storage goes.
   */
  async forgetBox(projectId: string, boxId: string): Promise<void> {
    const partition = browserPartitionFor(projectId, boxId)
    await this.onJarEmptied(projectId, boxId)
    this.loaded.delete(partition)
    if (await this.registry.forgetBox(boxId)) this.host.publish()
  }
  /** Release everything, at shutdown or when the window that owned the sessions
   *  is going away. */
  async dispose(): Promise<void> {
    this.disposed = true
    // An install still waiting for a slot will never get one once the window is
    // going away, so its caller is answered instead of left pending forever.
    for (const job of this.installQueue.splice(0)) {
      this.installIds.delete(job.context.installId)
      job.reject(new Error('The browser closed before the install started'))
    }
    for (const [partition, state] of [...this.loaded]) {
      for (const id of [...state.ids]) {
        this.stopBridge(state, id)
        this.removeFromSession(state.session, id)
      }
      this.loaded.delete(partition)
    }
    this.loading.clear()
  }

  // ─── Install ───────────────────────────────────────────────────────────────

  private async runInstall(
    input: BrowserExtensionInstallInput,
    context: InstallContext
  ): Promise<BrowserExtension> {
    this.report(context, { phase: 'resolving', detail: 'Finding the extension' })

    const stagingRoot = join(this.storeRoot(), STAGING_DIR, randomUUID())
    const stagingSource = join(stagingRoot, BROWSER_EXTENSION_SOURCE_DIR)
    let crxPath: string | null = null
    let folderPath: string | null = null
    let webstoreId: string | null = null

    try {
      if (input.source === 'webstore') {
        webstoreId = extensionIdFromInput(input.value)
        if (!webstoreId) throw new Error('That is not a Chrome Web Store id or link')
        const release = await resolveWebStoreRelease(webstoreId)
        await mkdir(this.downloadRoot(), { recursive: true })
        // Named for the install rather than for the id: two installs of the same
        // extension may be in flight, and one finishing must not delete bytes the
        // other is still reading.
        crxPath = join(this.downloadRoot(), `${webstoreId}-${randomUUID()}.crx`)
        this.report(context, {
          phase: 'downloading',
          detail: `Downloading version ${release.version}`,
          totalBytes: release.size
        })
        await downloadWebStoreRelease(release, crxPath, (progress) => {
          this.report(context, {
            phase: 'downloading',
            detail: `Downloading version ${release.version}`,
            receivedBytes: progress.receivedBytes,
            totalBytes: progress.totalBytes
          })
        })
      } else {
        folderPath = await this.resolveFolder(input.value)
      }

      const result = await prepareExtensionSource(
        {
          destinationDir: stagingSource,
          crxPath,
          folderPath,
          expectedId: webstoreId,
          preamble: preambleSource
        },
        (progress) => {
          this.report(context, {
            phase: progress.phase,
            detail: progress.detail,
            receivedBytes: progress.receivedBytes,
            totalBytes: progress.totalBytes
          })
        }
      )

      if (!isExtensionId(result.id)) {
        throw new Error('The extension did not produce a usable identity')
      }
      const id = result.id
      this.report(context, { phase: 'registering', detail: 'Installing' })

      // Move the prepared tree to its final home. A rename, not a copy: it is the
      // same filesystem and the source folder may be tens of megabytes.
      const extensionDir = this.extensionDirectory(id)
      await rm(extensionDir, { recursive: true, force: true })
      await mkdir(extensionDir, { recursive: true })
      await rename(stagingSource, join(extensionDir, BROWSER_EXTENSION_SOURCE_DIR))
      // An install can replace an existing copy's files in place, and every icon
      // held in memory belongs to the tree that was just replaced.
      this.actionIcons.clear()

      const warnings: string[] = []
      if (result.skippedLinks > 0) {
        warnings.push(`${result.skippedLinks} symbolic links in the folder were skipped`)
      }
      if (result.manifestVersion === 2) {
        warnings.push(
          'This is a Manifest V2 extension. The runtime warns that support for it is deprecated.'
        )
      }
      const declaredEnabled = result.ruleResources.filter((resource) => resource.enabled)
      if (declaredEnabled.length > 0 && result.injected === 'none') {
        warnings.push(
          `It ships ${declaredEnabled.length} filter rulesets enabled by default, and this runtime ignores that flag.`
        )
      }

      const record: BrowserExtensionRecord = {
        id,
        name: result.name,
        version: result.version,
        description: result.description,
        source: input.source,
        webstoreId,
        popupPath: result.popupPath,
        pinned: false,
        iconDataUrl: result.iconDataUrl,
        declaredPermissions: result.declaredPermissions,
        ruleResources: result.ruleResources,
        manifestVersion: result.manifestVersion,
        missingCapabilities: [...missingExtensionCapabilities(result.declaredPermissions)],
        warnings,
        injected: result.injected,
        sourceHash: result.sourceHash,
        enabled: true,
        // Where the install put it, which the caller chose: the jar the user was
        // looking at, never every jar. An absent list means loaded nowhere yet.
        boxes: input.boxes ?? [],
        installedAt: Date.now()
      }
      await this.registry.upsert(record)
      this.report(context, { phase: 'done', detail: `Installed ${result.name}` })
      await this.reconcileLiveJars()
      this.host.publish()
      return toExtensionView(record, [])
    } finally {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
      if (crxPath) await rm(crxPath, { force: true }).catch(() => undefined)
    }
  }

  /** A picked folder has to be one the app can actually read an extension from, and
   *  never one inside the app's own store, which would nest an install in itself. */
  private async resolveFolder(rawPath: string): Promise<string> {
    const value = rawPath.trim()
    if (!value || !isAbsolute(value)) {
      throw new Error('An extension folder has to be given as an absolute path')
    }
    const folder = resolve(value)
    if (folder.startsWith(this.storeRoot() + sep)) {
      throw new Error("That folder is inside the app's own extension store")
    }
    let stats
    try {
      stats = await stat(folder)
    } catch {
      throw new Error('That folder could not be read')
    }
    if (!stats.isDirectory()) throw new Error('That is not a folder')
    if (!existsSync(join(folder, EXTENSION_MANIFEST_NAME))) {
      throw new Error('That folder is not an extension: it has no manifest.json')
    }
    return folder
  }

  // ─── Session loading ───────────────────────────────────────────────────────

  private async reconcileLiveJars(): Promise<void> {
    for (const jar of this.host.liveJars()) {
      await this.ensureJarLoaded(jar.projectId, jar.boxId)
    }
  }

  /**
   * The extensions one jar should be running, given what is installed.
   *
   * Only the global browser's context has jars that extensions may live in. An
   * extension is third-party code that browser runs, and the panel that installs it,
   * the boxes it can be placed in and the pins in the header are all that browser's,
   * so a project's browser (the light one a conversation opens beside itself, with
   * no boxes and no extension chrome) must never load one.
   *
   * The empty jar id is what makes this a rule rather than a filter: it names "the
   * context's own jar", which read without the context matches every project's jar
   * too, so a record placed in "No box" would otherwise put an extension renderer,
   * its service worker and its load warnings behind every thread browser.
   */
  private desiredForJar(projectId: string, boxId: string | null): BrowserExtensionRecord[] {
    if (projectId !== GLOBAL_BROWSER_PROJECT_ID) return []
    return this.registry
      .list()
      .filter((record) => record.enabled && extensionRunsInJar(record, boxId))
  }

  private async reconcileJar(
    projectId: string,
    boxId: string | null,
    partition: string
  ): Promise<void> {
    const desired = this.desiredForJar(projectId, boxId)
    const desiredIds = new Set(desired.map((record) => record.id))
    const current = this.loaded.get(partition)?.ids ?? new Set<string>()
    const toUnload = [...current].filter((id) => !desiredIds.has(id))
    const toLoad = desired.filter((record) => !current.has(record.id))
    if (toUnload.length === 0 && toLoad.length === 0) return

    // Only now is a session asked for, which is what creates its profile directory.
    // A jar nobody enables anything in never reaches this line.
    const session = this.host.sessionFor(projectId, boxId)
    const state = this.loadedFor(partition, session, projectId, boxId)
    for (const id of toUnload) {
      this.stopBridge(state, id)
      this.removeFromSession(session, id)
    }
    for (const id of toUnload) state.ids.delete(id)
    if (toLoad.length === 0) return

    let changed = false
    for (const record of toLoad) {
      if (await this.loadIntoSession(state, record)) changed = true
    }
    if (changed) this.host.publish()
  }

  private async loadIntoSession(
    state: LoadedJar,
    record: BrowserExtensionRecord
  ): Promise<boolean> {
    const directory = extensionSourceDirectory(this.configRoot, record.id)
    try {
      await this.refreshInstalledPreamble(directory, record)
      await this.refreshCapabilityReport(record)
      await this.makeManifestLoadable(directory)
      await state.session.extensions.loadExtension(directory, { allowFileAccess: false })
      state.ids.add(record.id)
      this.startBridge(state, record)
      // A successful load answers any earlier failure, so the row stops claiming
      // the extension is broken when it is not.
      return this.registry.setLoadWarning(record.id, null)
    } catch (error) {
      const reason = error instanceof Error && error.message ? error.message : String(error)
      const warning = `It could not be loaded (${reason})`
      Logger.error(`Browser extension ${record.id} could not be loaded:`, error)
      return this.registry.setLoadWarning(record.id, warning)
    }
  }

  /**
   * Keep an installed copy's compatibility preamble current.
   *
   * The preamble is the app's own code living inside the extension, so a copy
   * installed before a preamble fix landed would keep the old one for the rest of
   * its life and the fix would only ever apply to extensions installed afterwards.
   * Refreshing is safe here and only here: the file is being handed to Electron for
   * the first time in this jar, so nothing has executed the old text yet.
   */
  private async refreshInstalledPreamble(
    directory: string,
    record: BrowserExtensionRecord
  ): Promise<void> {
    if (record.injected === 'none') return
    try {
      const manifest = await readManifestObject(directory)
      const outcome = await ensureInjectionCurrent(directory, manifest, preambleSource)
      if (outcome === 'rewritten') {
        Logger.dev('Browser extension preamble refreshed:', { extensionId: record.id })
      }
    } catch (error) {
      // A copy that cannot be refreshed still loads. The preamble is an addition,
      // never a requirement, so this must not become a load failure.
      Logger.dev('Browser extension preamble could not be refreshed:', {
        extensionId: record.id,
        error
      })
    }
  }

  /**
   * Keep an installed extension's capability report current.
   *
   * The report is a fact about this app's own surface, and that surface grows: a
   * namespace the preamble learns to implement (or a bridge that learns to carry)
   * is a capability the extension gets back. The list is computed at install time,
   * so without this an extension installed before the fix would keep claiming the
   * loss for the rest of its life.
   */
  private async refreshCapabilityReport(record: BrowserExtensionRecord): Promise<void> {
    const missing = [...missingExtensionCapabilities(record.declaredPermissions)]
    const same =
      missing.length === record.missingCapabilities.length &&
      missing.every((capability, index) => record.missingCapabilities[index] === capability)
    if (same) return
    try {
      await this.registry.patch(record.id, { missingCapabilities: missing })
      Logger.dev('Browser extension capability report refreshed:', {
        extensionId: record.id,
        missing
      })
    } catch (error) {
      Logger.dev('Browser extension capability report could not be refreshed:', {
        extensionId: record.id,
        error
      })
    }
  }

  /**
   * Hand Chromium words it knows.
   *
   * A manifest that declares a permission this runtime has never had is loaded
   * anyway, but Chromium announces every such name on stderr, so a jar holding a
   * real extension printed a block of "Permission 'x' is unknown" warnings on
   * every launch. The copy's permissions are trimmed to what this runtime can be
   * handed, here rather than only at install, so a copy unpacked before this rule
   * existed stops warning on its next load too. Nothing the extension can do is
   * lost   Chromium granted nothing for those names, and the app's own shims do not
   * read the manifest at all   while what the extension declared stays in this
   * app's own record (see `browser-extension-manifest`).
   */
  private async makeManifestLoadable(directory: string): Promise<void> {
    try {
      const removed = await stripInstalledManifestPermissions(directory)
      if (removed.length > 0) {
        Logger.dev('Browser extension manifest trimmed to the permissions this runtime knows:', {
          directory,
          removed
        })
      }
    } catch (error) {
      // A copy whose manifest cannot be rewritten still loads, and still warns,
      // which is worse than quiet and far better than not loading at all.
      Logger.dev('Browser extension manifest could not be trimmed:', { directory, error })
    }
  }

  private removeFromSession(session: Session, extensionId: string): void {
    try {
      session.extensions.removeExtension(extensionId)
    } catch (error) {
      Logger.dev('Browser extension could not be unloaded:', { extensionId, error })
    }
  }

  private async unloadEverywhere(extensionId: string): Promise<void> {
    for (const [partition, state] of [...this.loaded]) {
      if (!state.ids.has(extensionId)) continue
      this.stopBridge(state, extensionId)
      this.removeFromSession(state.session, extensionId)
      state.ids.delete(extensionId)
      if (state.ids.size === 0) this.loaded.delete(partition)
    }
  }

  private loadedFor(
    partition: string,
    session: Session,
    projectId: string,
    boxId: string | null
  ): LoadedJar {
    const existing = this.loaded.get(partition)
    if (existing) return existing
    const created: LoadedJar = {
      session,
      projectId,
      boxId,
      ids: new Set(),
      bridges: new Map(),
      mail: new Map(),
      publishedGeneration: new Map(),
      notificationSeq: new Map(),
      sidePanelSeq: new Map(),
      published: new Map(),
      publishing: Promise.resolve()
    }
    this.loaded.set(partition, created)
    return created
  }

  // ─── The bridge into a worker ──────────────────────────────────────────────

  /**
   * One tab fact, delivered into every extension loaded in that tab's jar.
   *
   * The runtime delivers no tab events of its own, so this is where an extension's
   * state machine is fed: created, updated, activated, highlighted or removed in
   * the argument shapes `chrome.tabs` documents, so a listener written against the
   * real API runs unmodified. Nothing crosses into a worker when the jar has no
   * extension loaded.
   */
  onTabEvent(
    projectId: string,
    boxId: string | null,
    name: BrowserExtensionTabEventName,
    args: unknown[]
  ): void {
    const state = this.loaded.get(browserPartitionFor(projectId, boxId))
    if (!state || state.bridges.size === 0) return
    for (const bridge of state.bridges.values()) bridge.push({ kind: 'tab', name, args })
  }

  /**
   * One main-frame navigation fact, delivered into every extension loaded in
   * that tab's jar.
   *
   * `chrome.webNavigation` is compiled out of the runtime, so nothing drives an
   * extension's navigation listeners on its own. The app watches the tab's own
   * main frame and hands each step over in the details shape the API documents,
   * so a listener written against the real API runs unmodified. Nothing crosses
   * into a worker when the jar has no extension loaded.
   */
  onWebNavigationEvent(
    projectId: string,
    boxId: string | null,
    name: BrowserExtensionWebNavigationEventName,
    details: Record<string, unknown>
  ): void {
    const state = this.loaded.get(browserPartitionFor(projectId, boxId))
    if (!state || state.bridges.size === 0) return
    for (const bridge of state.bridges.values()) {
      bridge.push({ kind: 'web-navigation', name, args: [details] })
    }
  }

  /** Open the channel into one extension's worker, beside its load. */
  private startBridge(state: LoadedJar, record: BrowserExtensionRecord): void {
    if (state.bridges.has(record.id)) return
    // An extension with no background has no worker to talk to.
    if (record.injected === 'none') return
    const loaded = state.session.extensions.getExtension(record.id)
    const base =
      loaded && typeof loaded.url === 'string' && loaded.url
        ? loaded.url
        : `chrome-extension://${record.id}/`
    const pageUrl = `${base.endsWith('/') ? base : `${base}/`}${COMPAT_BRIDGE_PAGE_FILE_NAME}`
    const bridge = new BrowserExtensionBridge({
      session: state.session,
      extensionId: record.id,
      pageUrl,
      onMailbox: (mail, restarted) => this.onMailbox(state, record.id, mail, restarted),
      onUnavailable: (reason) =>
        Logger.dev('Browser extension bridge unavailable:', { extensionId: record.id, reason }),
      // Sent after `startup` and after every restart, because a worker that has
      // just begun its life knows of no tab that was already open.
      tabReplay: () => this.host.tabReplay(state.projectId, state.boxId),
      // `chrome.userScripts.register` takes code and this runtime only registers
      // files, so the preamble asks for the write and waits for the answer.
      materializeUserScripts: (request) =>
        materializeUserScriptFiles(extensionSourceDirectory(this.configRoot, record.id), request)
    })
    state.bridges.set(record.id, bridge)
    bridge.start()
  }

  /** Release one extension's channel and forget everything read through it. */
  private stopBridge(state: LoadedJar, extensionId: string): void {
    const bridge = state.bridges.get(extensionId)
    if (bridge) {
      bridge.dispose()
      state.bridges.delete(extensionId)
    }
    state.mail.delete(extensionId)
    state.publishedGeneration.delete(extensionId)
    state.notificationSeq.delete(extensionId)
    state.sidePanelSeq.delete(extensionId)
    this.dismissExtensionNotifications(extensionId)
    for (const key of [...state.published.keys()]) {
      if (key.startsWith(`${extensionId}\u0000`)) state.published.delete(key)
    }
  }

  /**
   * One snapshot from a worker, turned into what the app draws.
   *
   * A restarted worker is a fresh life with no memory of the last one, so its
   * first snapshot is announced as a reset: the renderer drops every entry it
   * held for that extension before the new life's entries arrive, instead of
   * merging a new badge into a dead life's icon.
   */
  private onMailbox(
    state: LoadedJar,
    extensionId: string,
    mail: BrowserExtensionMailbox,
    restarted: boolean
  ): void {
    state.mail.set(extensionId, mail)
    if (restarted) {
      this.host.publishActivity({
        boxId: state.boxId ?? '',
        extensionId,
        tabId: null,
        activity: null,
        reset: true
      })
      for (const key of [...state.published.keys()]) {
        if (key.startsWith(`${extensionId}\u0000`)) state.published.delete(key)
      }
      // The dead life's notification sequence means nothing to the new one.
      state.notificationSeq.delete(extensionId)
      // Nor does its side-panel request sequence.
      state.sidePanelSeq.delete(extensionId)
    }
    state.publishedGeneration.set(extensionId, mail.generation)
    this.handleNotifications(state, extensionId, mail)
    this.handleSidePanelRequests(state, extensionId, mail)
    // Publishing resolves each icon's bytes, so it is queued per jar: two
    // snapshots landing out of order would draw the older state over the newer.
    state.publishing = state.publishing
      .then(() => this.publishSnapshot(state, extensionId, mail))
      .catch((error: unknown) =>
        Logger.dev('Browser extension activity could not be published:', {
          extensionId,
          error
        })
      )
  }

  /**
   * Act on the OS notifications a worker asked the app to raise.
   *
   * Only entries newer than the highest sequence already acted on are handled,
   * so the 500 ms poll re-reading the same snapshot never raises a card twice.
   * A restarted worker starts its sequence over with no memory, so its
   * bookkeeping is dropped with the generation reset in `onMailbox`.
   */
  private handleNotifications(
    state: LoadedJar,
    extensionId: string,
    mail: BrowserExtensionMailbox
  ): void {
    if (mail.notifications.length === 0) return
    const lastSeen = state.notificationSeq.get(extensionId) ?? 0
    let newest = lastSeen
    for (const entry of mail.notifications) {
      if (entry.seq <= lastSeen) continue
      newest = Math.max(newest, entry.seq)
      this.applyNotification(state, extensionId, entry)
    }
    state.notificationSeq.set(extensionId, newest)
  }

  /**
   * One notification request: raise, replace or dismiss the card it names.
   *
   * The extension's own id is kept for the click that comes back to it, while
   * the OS card is keyed by an id namespaced with the extension so two
   * extensions cannot collide. A click or a user close is pushed straight into
   * the worker that raised the card, from the jar whose bridge it is.
   */
  private applyNotification(
    state: LoadedJar,
    extensionId: string,
    entry: BrowserExtensionNotificationRecord
  ): void {
    const service = getNotificationService()
    const namespacedId = `${extensionId}:${entry.id}`
    const raised = this.raisedNotifications.get(extensionId) ?? new Set<string>()
    this.raisedNotifications.set(extensionId, raised)
    switch (entry.kind) {
      case 'create':
      case 'update': {
        const record = this.registry.get(extensionId)
        raised.add(namespacedId)
        service?.notifyExternal({
          id: namespacedId,
          title: entry.options?.title?.trim() || record?.name || 'Extension',
          message: entry.options?.message ?? '',
          silent: entry.options?.silent === true,
          onClick: (): void =>
            this.pushNotificationCommand(state, extensionId, {
              kind: 'notification-click',
              id: entry.id
            }),
          onClose: (): void => {
            raised.delete(namespacedId)
            this.pushNotificationCommand(state, extensionId, {
              kind: 'notification-close',
              id: entry.id,
              byUser: true
            })
          }
        })
        break
      }
      case 'clear':
        raised.delete(namespacedId)
        service?.dismissExternal(namespacedId)
        break
      case 'clearAll':
        if (service) {
          for (const id of raised) service.dismissExternal(id)
        }
        raised.clear()
        break
    }
  }

  /** Hand one notification command back to the extension's own worker. */
  private pushNotificationCommand(
    state: LoadedJar,
    extensionId: string,
    command: Record<string, unknown>
  ): void {
    state.bridges.get(extensionId)?.push(command)
  }

  /** Drop every OS notification an extension still has raised. */
  private dismissExtensionNotifications(extensionId: string): void {
    const raised = this.raisedNotifications.get(extensionId)
    if (!raised) return
    this.raisedNotifications.delete(extensionId)
    const service = getNotificationService()
    if (!service) return
    for (const id of raised) service.dismissExternal(id)
  }

  /**
   * Act on the side-panel requests a worker queued.
   *
   * Only entries newer than the highest sequence already acted on are handled, so
   * the 500 ms poll re-reading the same snapshot never raises a panel twice. A
   * restarted worker starts its sequence over with no memory, so its bookkeeping
   * is dropped with the generation reset in `onMailbox`.
   */
  private handleSidePanelRequests(
    state: LoadedJar,
    extensionId: string,
    mail: BrowserExtensionMailbox
  ): void {
    if (mail.sidePanel.requests.length === 0) return
    const lastSeen = state.sidePanelSeq.get(extensionId) ?? 0
    let newest = lastSeen
    for (const entry of mail.sidePanel.requests) {
      if (entry.seq <= lastSeen) continue
      newest = Math.max(newest, entry.seq)
      this.applySidePanelRequest(state, extensionId, mail.sidePanel, entry)
    }
    state.sidePanelSeq.set(extensionId, newest)
  }

  /** One side-panel request: raise the panel for its tab, or close it. */
  private applySidePanelRequest(
    state: LoadedJar,
    extensionId: string,
    sidePanel: BrowserExtensionSidePanelMailbox,
    entry: BrowserExtensionSidePanelRequest
  ): void {
    if (entry.kind === 'close') {
      this.host.closeSidePanel(extensionId, entry.tabId ?? null)
      return
    }
    const record = this.registry.get(extensionId)
    const path = this.resolveSidePanelPath(sidePanel.options, entry.tabId)
    if (!path) {
      // An extension that opens a panel it never gave a path is nothing to show,
      // which is the same answer Chromium gives.
      Logger.dev('An extension side panel was requested with no usable path:', {
        extensionId,
        tabId: entry.tabId ?? null
      })
      return
    }
    const url = extensionPopupUrl(extensionId, path)
    if (!url) {
      Logger.dev('An extension side panel path could not be resolved:', { extensionId, path })
      return
    }
    this.host.openSidePanel({
      projectId: state.projectId,
      boxId: state.boxId,
      extensionId,
      extensionName: record?.name ?? extensionId,
      extensionTabId: entry.tabId ?? null,
      path,
      url
    })
  }

  /**
   * The path one side panel opens: the record for the request's own tab when it
   * exists and is not disabled, otherwise the extension-wide default. Null when
   * neither yields a path, which is the one case there is nothing to host.
   */
  private resolveSidePanelPath(
    options: BrowserExtensionSidePanelOption[],
    tabId: number | undefined
  ): string | null {
    const perTab =
      tabId === undefined ? undefined : options.find((option) => option.tabId === tabId)
    const fallback = options.find((option) => option.tabId === undefined)
    const chosen = perTab && perTab.enabled !== false ? perTab : fallback
    const path = chosen?.path
    return typeof path === 'string' && path.length > 0 ? path : null
  }

  /**
   * The side panel an action click should open for one extension, or null when
   * the extension did not ask for that behavior or has no usable path.
   *
   * An extension that sets `openPanelOnActionClick` gets its panel when its
   * action is clicked, exactly as Chromium behaves; the path rules are the same
   * ones its own `sidePanel.open` request follows.
   */
  sidePanelForActionClick(
    projectId: string,
    boxId: string | null,
    extensionId: string,
    extensionTabId: number
  ): { extensionName: string; path: string; url: string } | null {
    const sidePanel = this.loaded
      .get(browserPartitionFor(projectId, boxId))
      ?.mail.get(extensionId)?.sidePanel
    if (!sidePanel || sidePanel.behavior?.openPanelOnActionClick !== true) return null
    const path = this.resolveSidePanelPath(sidePanel.options, extensionTabId)
    if (!path) {
      Logger.dev('An extension side panel action click had no usable path:', { extensionId })
      return null
    }
    const url = extensionPopupUrl(extensionId, path)
    if (!url) {
      Logger.dev('An extension side panel action click path could not be resolved:', {
        extensionId,
        path
      })
      return null
    }
    const record = this.registry.get(extensionId)
    return { extensionName: record?.name ?? extensionId, path, url }
  }

  /** Tell one extension's worker that its panel opened, for its own
   *  `chrome.sidePanel.onOpened`. */
  reportSidePanelOpened(
    projectId: string,
    boxId: string | null,
    extensionId: string,
    extensionTabId: number
  ): void {
    this.pushSidePanelCommand(projectId, boxId, extensionId, {
      kind: 'side-panel-opened',
      tabId: extensionTabId
    })
  }

  /** Tell one extension's worker that its panel closed, for its own
   *  `chrome.sidePanel.onClosed`. */
  reportSidePanelClosed(
    projectId: string,
    boxId: string | null,
    extensionId: string,
    extensionTabId: number
  ): void {
    this.pushSidePanelCommand(projectId, boxId, extensionId, {
      kind: 'side-panel-closed',
      tabId: extensionTabId
    })
  }

  /** Hand one side-panel command back to the extension's own worker. */
  private pushSidePanelCommand(
    projectId: string,
    boxId: string | null,
    extensionId: string,
    command: Record<string, unknown>
  ): void {
    this.loaded.get(browserPartitionFor(projectId, boxId))?.bridges.get(extensionId)?.push(command)
  }

  /**
   * One snapshot published, with every icon address it carries replaced by the
   * icon's own bytes.
   *
   * A snapshot older than the one already held is dropped: each mailbox carries
   * the whole action state, so the newer snapshot publishes everything this one
   * would have, and dropping it keeps a slow disk read from drawing stale state.
   */
  private async publishSnapshot(
    state: LoadedJar,
    extensionId: string,
    mail: BrowserExtensionMailbox
  ): Promise<void> {
    if (state.mail.get(extensionId) !== mail) return
    const directory = extensionSourceDirectory(this.configRoot, extensionId)
    const global = await this.drawableActivity(directory, extensionId, mail.actions.global)
    this.publishActivityEntry(state, extensionId, null, global, mail.at)
    for (const [tabId, patch] of Object.entries(mail.actions.tabs)) {
      const appTabId = this.host.resolveTabId(state.projectId, Number(tabId))
      if (!appTabId) continue
      const resolved = await this.drawableActivity(directory, extensionId, patch)
      this.publishActivityEntry(state, extensionId, appTabId, resolved, mail.at)
    }
  }

  /**
   * A patch whose recorded icon address has been replaced by the icon's own
   * bytes.
   *
   * An extension records `chrome.runtime.getURL(...)` for `setIcon`, and that
   * address cannot be drawn where the app draws: the renderer is a different
   * session with no such extension in it, and an action icon is not a
   * web-accessible resource. An address the app cannot resolve becomes null,
   * which the pin reads as "draw the extension's manifest icon" instead of
   * showing a broken image.
   */
  private async drawableActivity(
    directory: string,
    extensionId: string,
    patch: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (typeof patch['iconUrl'] !== 'string') return patch
    const iconUrl = await readActionIconDataUrl(
      directory,
      extensionId,
      patch['iconUrl'],
      this.actionIcons
    )
    return { ...patch, iconUrl }
  }

  private publishActivityEntry(
    state: LoadedJar,
    extensionId: string,
    tabId: string | null,
    patch: Record<string, unknown>,
    at: number
  ): void {
    const activity = activityFromPatch(patch, at)
    if (!activity) return
    const key = `${extensionId}\u0000${tabId ?? ''}`
    const serialized = JSON.stringify(activity)
    if (state.published.get(key) === serialized) return
    state.published.set(key, serialized)
    this.host.publishActivity({
      boxId: state.boxId ?? '',
      extensionId,
      tabId,
      activity
    })
  }

  /**
   * The recorded context menus of every extension a jar runs.
   *
   * Read straight from the last mailbox rather than kept in a second structure:
   * the tree only changes when the extension rebuilds it, and the native menu
   * asks for it on the one click that needs it.
   */
  menuRecordsFor(
    projectId: string,
    boxId: string | null
  ): { extensionId: string; items: BrowserExtensionMenuRecord[] }[] {
    const state = this.loaded.get(browserPartitionFor(projectId, boxId))
    if (!state) return []
    const sections: { extensionId: string; items: BrowserExtensionMenuRecord[] }[] = []
    for (const record of this.desiredForJar(projectId, boxId)) {
      const mail = state.mail.get(record.id)
      if (!mail || mail.menus.length === 0) continue
      sections.push({ extensionId: record.id, items: mail.menus })
    }
    return sections
  }

  /** A recorded menu item was chosen: hand the click back to the worker. */
  dispatchMenuClick(
    projectId: string,
    boxId: string | null,
    extensionId: string,
    info: Record<string, unknown>,
    tab: Record<string, unknown>
  ): void {
    const bridge = this.loaded.get(browserPartitionFor(projectId, boxId))?.bridges.get(extensionId)
    bridge?.push({ kind: 'menu-click', info, tab })
  }

  // ─── Paths and progress ────────────────────────────────────────────────────

  private storeRoot(): string {
    return join(this.configRoot, BROWSER_EXTENSION_STORE_DIR)
  }

  private downloadRoot(): string {
    return join(this.storeRoot(), DOWNLOADS_DIR)
  }

  private extensionDirectory(extensionId: string): string {
    return join(this.storeRoot(), extensionId)
  }

  /** Gate progress so a long download cannot flood the renderer, while a phase
   *  change always goes through immediately: the phase is what the user reads.
   *
   * The gate is per install rather than one shared clock, because installs now
   * overlap: a shared one would let the install that reported last swallow the
   * other's lines entirely, and the panel would show one install frozen while two
   * were running. */
  private report(
    context: InstallContext,
    progress: {
      phase: BrowserExtensionProgress['phase']
      detail: string
      receivedBytes?: number
      totalBytes?: number
    }
  ): void {
    const now = Date.now()
    const previous = this.installProgress.get(context.installId)
    if (!previous || previous.phase !== progress.phase) {
      this.installProgress.set(context.installId, { at: now, phase: progress.phase })
    } else {
      if (now - previous.at < PROGRESS_INTERVAL_MS) return
      previous.at = now
    }
    this.host.reportProgress({
      installId: context.installId,
      label: context.label,
      webstoreId: context.webstoreId,
      phase: progress.phase,
      detail: progress.detail,
      receivedBytes: progress.receivedBytes ?? 0,
      totalBytes: progress.totalBytes ?? 0
    })
  }
}
