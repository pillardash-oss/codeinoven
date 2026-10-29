import { type BrowserWindow, type Session } from 'electron'
import type {
  BrowserExtension,
  BrowserExtensionActivity,
  BrowserExtensionActivityUpdate,
  BrowserExtensionInstallInput,
  BrowserExtensionProgress
} from '../../../lib/ipc/browser'
import { Logger } from '../../system/logger'
import { BrowserExtensionOffscreenDocuments } from './browser-extension-offscreen-documents'
import type { NativeHostLookupOptions } from './browser-native-host-manifest'
import type { BrowserDownloadExtensionEventName } from '../browser-service/browser-downloads'
import type { BrowserExtensionMenuSection } from '../browser-service/browser-context-menu'
import {
  BrowserExtensionBridge,
  type BrowserExtensionActionPopupRequest,
  type BrowserExtensionInstalledDetails,
  type BrowserExtensionMailbox
} from './browser-extension-bridge'
import {
  BrowserExtensionRegistry,
  type BrowserExtensionRegistryPersistence
} from './browser-extension-registry'
import {
  type DarkReaderTabAction,
  type DarkReaderTabState
} from '../../../lib/browser/browser-darkreader-control'
import { buildBrowserExtensionServiceUnits } from './browser-extension-service/browser-extension-service-units'

/** How often progress reaches the renderer. A download reports per chunk and the
 *  install worker per phase, so without a gate a large package would send hundreds
 *  of events that all say the same thing. */
export const PROGRESS_INTERVAL_MS = 200

/** Give Electron time to finish initializing extension browser state after load. */
export const EXTENSION_READY_TIMEOUT_MS = 5_000

/** How many installs run at once, and therefore how many downloads.
 *
 * Two is the point of the queue rather than a random number: a user installing
 * two extensions should not have to wait for the first to finish before the
 * second is even accepted, while a third download would only split the same
 * connection and disk between them. Everything else waits its turn. */
export const MAX_CONCURRENT_INSTALLS = 2

/** The browser checks for newer store versions on startup and every six hours. */
const EXTENSION_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Keep store checks small so many installed extensions do not flood the network. */
export const MAX_CONCURRENT_UPDATE_CHECKS = 2

/** Directories inside the store root that are not extensions. */
export const STAGING_DIR = '.staging'
export const DOWNLOADS_DIR = '.downloads'

/** The identity of one install, attached to every progress line it produces.
 *
 * Resolved once, when the install is accepted, so no two lines about the same
 * install can disagree about what they are describing. */
export interface InstallContext {
  /** The caller's id for this install, which is what ties a line to its click. */
  installId: string
  /** The Web Store id or folder path the install is for, named before the
   *  extension has an id of its own. */
  label: string
  /** The Web Store id this install is for, or null when it came from a folder. */
  webstoreId: string | null
}

/** One accepted install that may not have started yet. */
export interface QueuedInstall {
  input: BrowserExtensionInstallInput
  context: InstallContext
  resolve: (extension: BrowserExtension) => void
  reject: (error: unknown) => void
}

/** One jar whose session carries the five `webRequest` listeners the app feeds
 *  extensions from. Held apart from the loaded set because the listeners outlive
 *  one reconcile and must be detached exactly once: attaching twice would deliver
 *  every request twice, and an extension that counts requests would see double. */
interface WebRequestJar {
  session: Session
  /** The extensions loaded in this jar that declared `webRequest`, which is the
   *  only set their events are pushed into. */
  extensionIds: Set<string>
}

/** One jar with extensions loaded in it. The session is held, not looked up on
 *  demand: unloading must never be what creates a partition directory, and a
 *  lookup would also re-trigger the loading path it is trying to undo. */
export interface LoadedJar {
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
  /** Highest `action.openPopup()` request handled, per extension. */
  actionPopupSeq: Map<string, number>
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
  /** Drop documents before Chromium invalidates their extension contexts. */
  releaseViews(extensionId: string, projectId: string, boxId: string | null): void
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
  /** Apply a popup surface request for the tab named by the extension runtime. */
  openPopup(request: BrowserExtensionActionPopupOpenRequest): void
  /**
   * Open one of an extension's own pages in the jar it runs in.
   *
   * `chrome.runtime.openOptionsPage` has no implementation in this runtime: the
   * worker can name its options page but cannot raise a window, and the app is the
   * only side that owns one. The page is opened in a tab of the jar the extension
   * is loaded in, so it reads that jar's storage and answers its worker.
   */
  openExtensionPage(
    projectId: string,
    boxId: string | null,
    extensionId: string,
    page: 'options'
  ): void
  /**
   * Apply one `chrome.downloads` call an extension made.
   *
   * The extension service only carries the call: the downloads belong to the
   * app's download manager, which is the one place that can stop a transfer.
   */
  downloadCommand(command: { method: 'cancel' | 'pause' | 'resume' | 'erase'; id: number }): void
}

/** One extension popup request carried from the worker to the browser host. */
export interface BrowserExtensionActionPopupOpenRequest {
  projectId: string
  boxId: string | null
  extensionId: string
  extensionTabId: number
  kind: BrowserExtensionActionPopupRequest['kind']
  url?: string
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
export function activityFromPatch(
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
  /**
   * One owner per concern. Each unit holds this engine and nothing else, so they
   * are safe to build first: none of them reads a field at construction.
   */
  readonly units = buildBrowserExtensionServiceUnits(this)
  readonly registry: BrowserExtensionRegistry
  /** The one registry read, awaited by everything that depends on it. Nothing
   *  loads an extension before it resolves. */
  readonly ready: Promise<void>
  /** partition -> the extension ids loaded in it. */
  readonly loaded = new Map<string, LoadedJar>()
  /** partition -> the session whose webRequest listeners this service attached.
   *  Empty for every jar where nothing declared `webRequest`, which is also the
   *  state in which no listener exists and no request costs anything. */
  readonly webRequestJars = new Map<string, WebRequestJar>()
  /** partition -> an in-flight reconcile, so two shows cannot race a load. */
  readonly loading = new Map<string, Promise<void>>()
  /** Installs accepted but not started, oldest first. */
  readonly installQueue: QueuedInstall[] = []
  /** How many installs are running right now. Never more than
   *  {@link MAX_CONCURRENT_INSTALLS}. */
  runningInstalls = 0
  /** Every install that is queued or running, so a caller cannot name one that is
   *  already in flight and have its progress attributed to it. */
  readonly installIds = new Set<string>()
  /** Store ids accepted by an install, so an update cannot replace the same files. */
  readonly installingWebStoreIds = new Set<string>()
  /** Store versions found by the most recent successful check, held for the panel. */
  readonly availableUpdateVersions = new Map<string, string>()
  /** Updates in progress, keyed by extension id. */
  readonly updatingIds = new Set<string>()
  /** Install/update events awaiting delivery into live extension workers. */
  readonly pendingInstalledEvents = new Map<string, BrowserExtensionInstalledDetails>()
  /** One recovery pass per extension if a process stopped during a directory swap. */
  readonly recoveringSources = new Map<string, Promise<void>>()
  /** One scheduled check at a time, even when startup and the app updater overlap. */
  updateCheck: Promise<void> | null = null
  updateCheckTimer: ReturnType<typeof setInterval> | null = null
  /** Per-install progress gating, keyed by install id: two installs reporting at
   *  the same moment must not suppress each other's lines the way one shared
   *  clock would. */
  readonly installProgress = new Map<
    string,
    { at: number; phase: BrowserExtensionProgress['phase'] }
  >()
  /** Icons an extension set on its action, by absolute path. Shared across jars:
   *  the bytes belong to the extension's own folder, not to a session. */
  readonly actionIcons = new Map<string, string | null>()
  /** The namespaced OS notification ids each extension currently has raised, so
   *  a `clearAll` can dismiss exactly that extension's cards. */
  readonly raisedNotifications = new Map<string, Set<string>>()
  /** Keeps every extension offscreen document focused, so the APIs that need a
   *  focused document   the clipboard, for one   work from one. */
  readonly offscreenDocuments = new BrowserExtensionOffscreenDocuments()
  disposed = false

  constructor(
    readonly configRoot: string,
    persistence: BrowserExtensionRegistryPersistence,
    readonly host: BrowserExtensionHost
  ) {
    this.registry = new BrowserExtensionRegistry(persistence)
    // Started, not awaited: a corrupt registry must not stop the app from
    // starting, and every path that needs the list awaits this promise.
    this.ready = this.registry.load().catch((error: unknown) => {
      Logger.error('Browser extension registry could not be read:', error)
    })
    void this.ready.then(() => {
      if (this.disposed) return
      void this.checkForUpdates()
      this.updateCheckTimer = setInterval(
        () => void this.checkForUpdates(),
        EXTENSION_UPDATE_CHECK_INTERVAL_MS
      )
    })
  }
  async whenReady(): Promise<void> {
    return this.units['queries'].whenReady()
  }
  list(): BrowserExtension[] {
    return this.units['queries'].list()
  }
  popupUrlFor(extensionId: string, projectId: string, boxId: string | null): string | null {
    return this.units['panels'].popupUrlFor(extensionId, projectId, boxId)
  }
  optionsUrlFor(extensionId: string, projectId: string, boxId: string | null): string | null {
    return this.units['runtime'].optionsUrlFor(extensionId, projectId, boxId)
  }
  isExtensionPageAllowed(rawUrl: string, projectId: string, boxId: string | null): boolean {
    return this.units['queries'].isExtensionPageAllowed(rawUrl, projectId, boxId)
  }
  async install(input: BrowserExtensionInstallInput): Promise<BrowserExtension> {
    return this.units['installation'].install(input)
  }
  async uninstall(extensionId: string): Promise<void> {
    return this.units['installation'].uninstall(extensionId)
  }
  async update(
    extensionId: string,
    patch: {
      enabled?: boolean
      boxes?: string[]
      pinned?: boolean
      blockedHosts?: string[]
      allowedHosts?: string[]
    }
  ): Promise<BrowserExtension> {
    return this.units['runtime'].update(extensionId, patch)
  }
  async reorder(orderedIds: string[]): Promise<void> {
    return this.units['runtime'].reorder(orderedIds)
  }
  checkForUpdates(): Promise<void> {
    return this.units['runtime'].checkForUpdates()
  }
  async updateFromWebStore(extensionId: string, repair = false): Promise<BrowserExtension> {
    return this.units['runtime'].updateFromWebStore(extensionId, repair)
  }
  async pickFolder(): Promise<string | null> {
    return this.units['runtime'].pickFolder()
  }
  async ensureJarLoaded(projectId: string, boxId: string | null): Promise<void> {
    return this.units['lifecycle'].ensureJarLoaded(projectId, boxId)
  }
  async onJarEmptied(projectId: string, boxId: string | null, force = false): Promise<void> {
    return this.units['runtime'].onJarEmptied(projectId, boxId, force)
  }
  async forgetBox(projectId: string, boxId: string): Promise<void> {
    return this.units['queries'].forgetBox(projectId, boxId)
  }
  /** A project was deleted, so the extensions installed for its own browser go. */
  async forgetProject(projectId: string): Promise<boolean> {
    return this.units['queries'].forgetProject(projectId)
  }
  async dispose(): Promise<void> {
    return this.units['lifecycle'].dispose()
  }

  readonly darkReaderPolicies = new Map<
    string,
    { onlyTabId: number | null; disabledTabIds: number[] }
  >()
  darkReaderTabState(projectId: string, boxId: string | null, tabId: number): DarkReaderTabState {
    return this.units['storage'].darkReaderTabState(projectId, boxId, tabId)
  }
  async setDarkReaderTabScope(
    projectId: string,
    boxId: string | null,
    tabId: number,
    action: DarkReaderTabAction
  ): Promise<DarkReaderTabState> {
    return this.units['queries'].setDarkReaderTabScope(projectId, boxId, tabId, action)
  }
  isExtensionEnabledOnHost(extensionId: string, host: string | null): boolean {
    return this.units['lifecycle'].isExtensionEnabledOnHost(extensionId, host)
  }
  async ensureExtensionPagesAvailable(extensionId: string): Promise<void> {
    return this.units['runtime'].ensureExtensionPagesAvailable(extensionId)
  }
  onTabEvent(
    projectId: string,
    boxId: string | null,
    name: BrowserExtensionTabEventName,
    args: unknown[]
  ): void {
    return this.units['runtime'].onTabEvent(projectId, boxId, name, args)
  }
  onWebNavigationEvent(
    projectId: string,
    boxId: string | null,
    name: BrowserExtensionWebNavigationEventName,
    details: Record<string, unknown>
  ): void {
    return this.units['runtime'].onWebNavigationEvent(projectId, boxId, name, details)
  }
  onDownloadEvent(
    projectId: string,
    boxId: string | null,
    name: BrowserDownloadExtensionEventName,
    args: unknown[]
  ): void {
    return this.units['lifecycle'].onDownloadEvent(projectId, boxId, name, args)
  }
  watchesDownloadsInJar(projectId: string, boxId: string | null): boolean {
    return this.units['lifecycle'].watchesDownloadsInJar(projectId, boxId)
  }

  /**
   * Where a native messaging host manifest is looked for on this machine.
   *
   * Chromium reads a per-product directory and this app's own user-data directory
   * (see `nativeHostSearchDirectories`); the values are constant for the life of the
   * process, so they are computed once.
   */
  nativeLookupOptionsCache: NativeHostLookupOptions | null = null
  sidePanelForActionClick(
    projectId: string,
    boxId: string | null,
    extensionId: string,
    extensionTabId: number
  ): { extensionName: string; path: string; url: string } | null {
    return this.units['panels'].sidePanelForActionClick(
      projectId,
      boxId,
      extensionId,
      extensionTabId
    )
  }
  reportSidePanelOpened(
    projectId: string,
    boxId: string | null,
    extensionId: string,
    extensionTabId: number
  ): void {
    return this.units['messaging'].reportSidePanelOpened(
      projectId,
      boxId,
      extensionId,
      extensionTabId
    )
  }
  reportSidePanelClosed(
    projectId: string,
    boxId: string | null,
    extensionId: string,
    extensionTabId: number
  ): void {
    return this.units['messaging'].reportSidePanelClosed(
      projectId,
      boxId,
      extensionId,
      extensionTabId
    )
  }
  menuRecordsFor(projectId: string, boxId: string | null): BrowserExtensionMenuSection[] {
    return this.units['installation'].menuRecordsFor(projectId, boxId)
  }
  dispatchMenuClick(
    projectId: string,
    boxId: string | null,
    extensionId: string,
    info: Record<string, unknown>,
    tab: Record<string, unknown>
  ): void {
    return this.units['messaging'].dispatchMenuClick(projectId, boxId, extensionId, info, tab)
  }
}
