import { join } from 'node:path'
import type { Session } from 'electron'
import { Logger } from '../../../system/logger'
import { browserJarFor, browserPartitionFor } from '../../browser-service/browser-validation'
import { COMPAT_BRIDGE_PAGE_FILE_NAME } from '../browser-extension-inject'
import { BrowserExtensionNativeMessaging } from '../browser-native-messaging'
import { nativeMessagingCommand } from '../browser-extension-bridge'
import type { BrowserDownloadExtensionEventName } from '../../browser-service/browser-downloads'
import { BrowserExtensionBridge } from '../browser-extension-bridge'
import { stripInstalledManifestPermissions } from '../browser-extension-manifest'
import {
  extensionRunsOnHost,
  extensionSourceDirectory,
  type BrowserExtensionRecord
} from '../browser-extension-registry'
import { DARK_READER_EXTENSION_ID } from '../../../../lib/browser/browser-darkreader-control'
import { materializeUserScriptFiles } from '../browser-extension-user-scripts'
import { DOWNLOADS_DIR, EXTENSION_READY_TIMEOUT_MS } from '../browser-extension-service'
import type { LoadedJar } from '../browser-extension-service'
import type { BrowserExtensionService } from '../browser-extension-service'

/** BrowserExtensionService lifecycle: one concern, moved verbatim from the composition root. */
export class BrowserExtensionServiceLifecycle {
  constructor(private readonly host: BrowserExtensionService) {}

  /**
   * Make one jar's loaded set match what the registry says it should be.
   *
   * Called before a page is created in a jar (awaited) and after any change to the
   * installed list (not awaited). Idempotent, and single-flight per partition: a
   * burst of shows for the same jar loads each extension once.
   */
  async ensureJarLoaded(projectId: string, boxId: string | null): Promise<void> {
    if (this.host.disposed) return
    await this.host.ready
    // Loaded as the jar it is, not as the context that reached for it: the
    // profile's default box is the global browser's own jar, and this pair is what
    // the loaded state remembers.
    const jar = browserJarFor(projectId, boxId)
    const partition = browserPartitionFor(jar.projectId, jar.boxId)
    const inFlight = this.host.loading.get(partition)
    if (inFlight) return inFlight
    const task = this.host.units['runtime']
      .reconcileJar(jar.projectId, jar.boxId, partition)
      .catch((error: unknown) => {
        Logger.error('Browser extensions could not be reconciled for a jar:', error)
      })
    this.host.loading.set(partition, task)
    try {
      await task
    } finally {
      this.host.loading.delete(partition)
    }
  }

  /** Release everything, at shutdown or when the window that owned the sessions
   *  is going away. */
  async dispose(): Promise<void> {
    this.host.disposed = true
    this.host.offscreenDocuments.dispose()
    if (this.host.updateCheckTimer) {
      clearInterval(this.host.updateCheckTimer)
      this.host.updateCheckTimer = null
    }
    // An install still waiting for a slot will never get one once the window is
    // going away, so its caller is answered instead of left pending forever.
    for (const job of this.host.installQueue.splice(0)) {
      this.host.installIds.delete(job.context.installId)
      if (job.context.webstoreId) this.host.installingWebStoreIds.delete(job.context.webstoreId)
      job.reject(new Error('The browser closed before the install started'))
    }
    for (const [partition, state] of [...this.host.loaded]) {
      for (const id of [...state.ids]) {
        this.stopBridge(state, id)
        this.host.units['runtime'].removeFromSession(state, id)
      }
      this.host.units['runtime'].detachWebRequest(partition)
      this.host.loaded.delete(partition)
    }
    this.host.loading.clear()
  }

  async loadIntoSession(state: LoadedJar, record: BrowserExtensionRecord): Promise<boolean> {
    const directory = extensionSourceDirectory(this.host.configRoot, record.id)
    try {
      await this.host.units['runtime'].restoreInterruptedSource(record.id)
      await this.host.units['installation'].refreshInstalledPreamble(directory, record)
      await this.host.units['messaging'].refreshCapabilityReport(record)
      await this.host.units['runtime'].refreshOptionsPath(directory, record)
      await this.host.units['panels'].refreshPopupAvailability(directory, record)
      await this.host.units['runtime'].applySiteRulesToManifest(directory, record)
      await this.makeManifestLoadable(directory)
      await this.loadExtensionWhenReady(state.session, directory, record.injected !== 'none')
      state.ids.add(record.id)
      this.startBridge(state, record)
      // A successful load answers any earlier failure, so the row stops claiming
      // the extension is broken when it is not.
      return this.host.registry.setLoadWarning(record.id, null)
    } catch (error) {
      const reason = error instanceof Error && error.message ? error.message : String(error)
      const warning = `It could not be loaded (${reason})`
      Logger.error(`Browser extension ${record.id} could not be loaded:`, error)
      return this.host.registry.setLoadWarning(record.id, warning)
    }
  }

  /**
   * Load the extension, then wait until Electron has initialized the browser
   * state needed to start its background. The load promise only reports that the
   * extension was loaded; starting its bridge or navigating a page in between
   * that promise and `extension-ready` can race content-script registration.
   */
  async loadExtensionWhenReady(
    session: Session,
    directory: string,
    waitForReady: boolean
  ): Promise<void> {
    const extensions = session.extensions
    if (!waitForReady) {
      await extensions.loadExtension(directory, { allowFileAccess: false })
      return
    }

    const readyExtensionIds = new Set<string>()
    let loadedExtensionId: string | null = null
    let resolveReady: (() => void) | null = null
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve
    })
    const onReady = (_event: Electron.Event, extension: Electron.Extension): void => {
      readyExtensionIds.add(extension.id)
      if (loadedExtensionId === extension.id) resolveReady?.()
    }

    extensions.on('extension-ready', onReady)
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      const extension = await extensions.loadExtension(directory, { allowFileAccess: false })
      loadedExtensionId = extension.id
      if (readyExtensionIds.has(extension.id)) return

      const becameReady = await Promise.race([
        ready.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), EXTENSION_READY_TIMEOUT_MS)
        })
      ])
      if (!becameReady) {
        Logger.dev('Browser extension did not report readiness before its startup deadline:', {
          extensionId: extension.id,
          timeoutMs: EXTENSION_READY_TIMEOUT_MS
        })
      }
    } finally {
      if (timer !== null) clearTimeout(timer)
      extensions.off('extension-ready', onReady)
    }
  }

  /**
   * Whether an extension runs on one host. Blocked wins. Extension pages have
   * no host and always run, so setup flows never lock themselves out.
   */
  isExtensionEnabledOnHost(extensionId: string, host: string | null): boolean {
    const record = this.host.registry.get(extensionId)
    if (!record || !record.enabled) return false
    return extensionRunsOnHost(record, host)
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
  async makeManifestLoadable(directory: string): Promise<void> {
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

  async unloadEverywhere(extensionId: string): Promise<void> {
    for (const [partition, state] of [...this.host.loaded]) {
      if (!state.ids.has(extensionId)) continue
      this.stopBridge(state, extensionId)
      this.host.units['runtime'].removeFromSession(state, extensionId)
      state.ids.delete(extensionId)
      this.host.units['runtime'].syncWebRequest(partition, state)
      if (state.ids.size === 0) this.host.loaded.delete(partition)
    }
  }

  loadedFor(
    partition: string,
    session: Session,
    projectId: string,
    boxId: string | null
  ): LoadedJar {
    const existing = this.host.loaded.get(partition)
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
      actionPopupSeq: new Map(),
      published: new Map(),
      publishing: Promise.resolve()
    }
    this.host.loaded.set(partition, created)
    return created
  }

  /**
   * One download fact, delivered into every extension in that jar that asked to
   * watch downloads.
   *
   * The runtime compiles `chrome.downloads` out, so a listener written against it
   * waits forever unless the app feeds it. Each download arrives in the shapes the
   * API documents, but only at extensions that declared the `downloads` permission:
   * a download is the user's traffic, and an extension that never asked to see one
   * has no business being told about it.
   */
  onDownloadEvent(
    projectId: string,
    boxId: string | null,
    name: BrowserDownloadExtensionEventName,
    args: unknown[]
  ): void {
    const state = this.host.loaded.get(browserPartitionFor(projectId, boxId))
    if (!state || state.bridges.size === 0) return
    for (const [extensionId, bridge] of state.bridges) {
      if (!this.watchesDownloads(extensionId)) continue
      void bridge.push({ kind: 'downloads', name, args })
    }
  }

  /** Whether one installed extension declared the permission the download events
   *  belong to. The installed copy has the permission stripped to keep the
   *  runtime from refusing it, so the record's own reading of its manifest is the
   *  one that answers. */
  watchesDownloads(extensionId: string): boolean {
    return this.host.registry.get(extensionId)?.declaredPermissions.includes('downloads') ?? false
  }

  /**
   * Whether any extension loaded in one jar watches downloads.
   *
   * A watcher captures by cancelling, so the download manager asks this before it
   * opens a save dialog: a dialog for a file the extension is about to take over
   * is a dialog that closes by itself.
   */
  watchesDownloadsInJar(projectId: string, boxId: string | null): boolean {
    const state = this.host.loaded.get(browserPartitionFor(projectId, boxId))
    if (!state) return false
    for (const extensionId of state.bridges.keys()) {
      if (this.watchesDownloads(extensionId)) return true
    }
    return false
  }

  /** Open the channel into one extension's worker, beside its load. */
  startBridge(state: LoadedJar, record: BrowserExtensionRecord): void {
    if (state.bridges.has(record.id)) return
    // An extension with no background has no worker to talk to.
    if (record.injected === 'none') return
    const loaded = state.session.extensions.getExtension(record.id)
    const base =
      loaded && typeof loaded.url === 'string' && loaded.url
        ? loaded.url
        : `chrome-extension://${record.id}/`
    const pageUrl = `${base.endsWith('/') ? base : `${base}/`}${COMPAT_BRIDGE_PAGE_FILE_NAME}`
    // Electron refuses every `chrome.runtime.connectNative` call, so the app opens
    // the host itself (see `browser-native-messaging.ts`). The manager delivers a
    // host's messages back into the worker through this same bridge, and is
    // disposed with it.
    const nativeMessaging = new BrowserExtensionNativeMessaging({
      origin: `chrome-extension://${record.id}/`,
      lookupOptions: this.host.units['permissions'].nativeHostLookupOptions(),
      deliver: (delivery) => {
        const current = state.bridges.get(record.id)
        if (current) void current.push(nativeMessagingCommand(delivery))
      }
    })
    const bridge = new BrowserExtensionBridge({
      session: state.session,
      extensionId: record.id,
      pageUrl,
      nativeMessaging,
      installed: this.host.pendingInstalledEvents.get(record.id),
      onMailbox: (mail, restarted) =>
        this.host.units['runtime'].onMailbox(state, record.id, mail, restarted),
      onUnavailable: (reason) =>
        Logger.dev('Browser extension bridge unavailable:', { extensionId: record.id, reason }),
      // Sent after `startup` and after every restart, because a worker that has
      // just begun its life knows of no tab that was already open.
      tabReplay: () => this.host.host.tabReplay(state.projectId, state.boxId),
      policyReplay: () => {
        const policy = this.host.darkReaderPolicies.get(
          browserPartitionFor(state.projectId, state.boxId)
        )
        return record.id === DARK_READER_EXTENSION_ID && policy
          ? [{ kind: 'dark-reader-tab-policy', ...policy }]
          : []
      },
      // `chrome.userScripts.register` takes code and this runtime only registers
      // files, so the preamble asks for the write and waits for the answer.
      materializeUserScripts: (request) =>
        materializeUserScriptFiles(
          extensionSourceDirectory(this.host.configRoot, record.id),
          request
        ),
      // A capture extension stops the browser's own transfer to fetch the file
      // itself, so this is the one media type of extension call that reaches the
      // download manager rather than staying inside the extension's own jar.
      downloadCommand: (command) => this.host.host.downloadCommand(command),
      // The runtime compiles `chrome.cookies` out, so a capture that must send the
      // site's session reads it from the jar it runs in, through this answer.
      cookieRequest: (request) =>
        this.host.units['runtime'].answerCookieRequest(state, record.id, request),
      // `chrome.runtime.openOptionsPage` names a page the worker cannot raise; the
      // host opens it in the jar the extension is loaded in.
      extensionPageRequest: (request) => {
        // Its own page asks the worker about the desktop bridge as it loads, so
        // the worker is touched first, for the same reason the action popup is.
        this.host.wakeWorker(state.projectId, state.boxId, record.id)
        this.host.host.openExtensionPage(state.projectId, state.boxId, record.id, request.page)
        return Promise.resolve({})
      }
    })
    state.bridges.set(record.id, bridge)
    bridge.start()
  }

  /** Release one extension's channel and forget everything read through it. */
  stopBridge(state: LoadedJar, extensionId: string): void {
    const bridge = state.bridges.get(extensionId)
    if (bridge) {
      bridge.dispose()
      state.bridges.delete(extensionId)
    }
    state.mail.delete(extensionId)
    state.publishedGeneration.delete(extensionId)
    state.notificationSeq.delete(extensionId)
    state.sidePanelSeq.delete(extensionId)
    state.actionPopupSeq.delete(extensionId)
    this.host.units['queries'].dismissExtensionNotifications(extensionId)
    for (const key of [...state.published.keys()]) {
      if (key.startsWith(`${extensionId}\u0000`)) state.published.delete(key)
    }
  }

  downloadRoot(): string {
    return join(this.host.units['runtime'].storeRoot(), DOWNLOADS_DIR)
  }
}
