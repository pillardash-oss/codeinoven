import { dialog } from '../../../system/file-dialogs'
import { existsSync } from 'node:fs'
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { type Session } from 'electron'
import { MAX_PINNED_EXTENSIONS } from '../../../../lib/browser/browser-extension-pins'
import type { BrowserExtension } from '../../../../lib/ipc/browser'
import { Logger } from '../../../system/logger'
import { getNotificationService } from '../../../notifications/notification-service'
import { extensionJarIdFor } from '../../../../lib/browser/browser-extension-jar'
import { browserPartitionFor } from '../../browser-service/browser-validation'
import {
  type BrowserExtensionCookieRequest,
  type BrowserExtensionCookieResult,
  type BrowserExtensionMailbox,
  type BrowserExtensionNotificationRecord
} from '../browser-extension-bridge'
import { isExtensionId } from '../browser-extension-crx'
import { compareBrowserExtensionVersions } from '../browser-extension-version'
import { resolveWebStoreRelease, resolveWebStoreUpdate } from '../browser-extension-webstore'
import {
  EXTENSION_MANIFEST_NAME,
  extensionPageFileExists,
  extensionPageUrl,
  readActionIconDataUrl,
  readManifestRecord
} from '../browser-extension-source'
import {
  BROWSER_EXTENSION_SOURCE_DIR,
  extensionRunsInJar,
  extensionSourceDirectory,
  resolveBrowserExtensionStoreDir,
  toExtensionView,
  type BrowserExtensionRecord
} from '../browser-extension-registry'
import { toCookieQuery, toExtensionCookie } from '../browser-extension-cookies'
import {
  toWebRequestDetails,
  type BrowserExtensionWebRequestDetails,
  type BrowserExtensionWebRequestEventName,
  type BrowserExtensionWebRequestSource
} from '../browser-extension-web-request'
import { filterManifestForSiteRules } from '../../../../lib/browser/browser-extension-site-rules'
import { DARK_READER_EXTENSION_ID } from '../../../../lib/browser/browser-darkreader-control'
import type {
  BrowserExtensionTabEventName,
  BrowserExtensionWebNavigationEventName,
  LoadedJar
} from '../browser-extension-service'
import type { BrowserExtensionService } from '../browser-extension-service'

/** BrowserExtensionService runtime: one concern, moved verbatim from the composition root. */
export class BrowserExtensionServiceRuntime {
  constructor(private readonly host: BrowserExtensionService) {}

  /** Include the latest store version found by the background check. */
  toView(record: BrowserExtensionRecord): BrowserExtension {
    return toExtensionView(record, [], this.host.availableUpdateVersions.get(record.id) ?? null)
  }

  /**
   * The options document one installed extension declares, as an address, when
   * it is enabled and runs in the jar asked for. Null when it declares none or
   * the jar does not run it.
   */
  optionsUrlFor(extensionId: string, projectId: string, boxId: string | null): string | null {
    const record = this.host.registry.get(extensionId)
    if (!record || !record.enabled) return null
    if (!extensionRunsInJar(record, extensionJarIdFor(projectId, boxId))) return null
    return extensionPageUrl(record.id, record.optionsPath)
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
    patch: {
      enabled?: boolean
      boxes?: string[]
      pinned?: boolean
      blockedHosts?: string[]
      allowedHosts?: string[]
    }
  ): Promise<BrowserExtension> {
    if (!isExtensionId(extensionId)) throw new TypeError('Browser extension ID is invalid')
    if (this.host.updatingIds.has(extensionId)) throw new Error('That extension is being updated')
    const current = this.host.registry.get(extensionId)
    if (!current) throw new Error('That extension is not installed')
    if (patch.pinned === true) {
      if (!current.popupPath) {
        throw new Error('That extension declares no popup to open from a pin')
      }
      const pinned = this.host.registry
        .list()
        .filter((record) => record.pinned && record.id !== extensionId)
      if (pinned.length >= MAX_PINNED_EXTENSIONS) {
        throw new Error(`Only ${MAX_PINNED_EXTENSIONS} extensions can be pinned at once`)
      }
    }
    const refreshDarkReader =
      extensionId === DARK_READER_EXTENSION_ID &&
      (patch.enabled !== undefined ||
        patch.blockedHosts !== undefined ||
        patch.allowedHosts !== undefined ||
        patch.boxes !== undefined)
    if (refreshDarkReader) {
      for (const state of this.host.loaded.values()) {
        const bridge = state.bridges.get(extensionId)
        if (bridge) await bridge.request({ kind: 'dark-reader-power', enabled: false })
      }
    }
    const record = await this.host.registry.patch(extensionId, patch)
    if (!record) throw new Error('That extension is not installed')
    if (patch.blockedHosts !== undefined || patch.allowedHosts !== undefined) {
      await this.host.units['lifecycle'].unloadEverywhere(extensionId)
    }
    await this.reconcileLiveJars()
    if (refreshDarkReader && record.enabled) {
      for (const state of this.host.loaded.values()) {
        const bridge = state.bridges.get(extensionId)
        if (bridge) await bridge.request({ kind: 'dark-reader-power', enabled: true })
      }
    }
    this.host.host.publish()
    return this.toView(record)
  }

  /** Reorder the installed extensions and publish their new order to renderers. */
  async reorder(orderedIds: string[]): Promise<void> {
    await this.host.ready
    await this.host.registry.reorder(orderedIds)
    this.host.host.publish()
  }

  /** Find newer Web Store releases without downloading or replacing anything. */
  checkForUpdates(): Promise<void> {
    if (this.host.disposed) return Promise.resolve()
    if (this.host.updateCheck) return this.host.updateCheck
    const pass = this.host.units['commands']
      .runUpdateCheck()
      .catch((error: unknown) => {
        Logger.dev('Browser extension update checks could not finish:', error)
      })
      .finally(() => {
        if (this.host.updateCheck === pass) this.host.updateCheck = null
      })
    this.host.updateCheck = pass
    return pass
  }

  /** Download and install the newest Web Store release after the user asks. */
  async updateFromWebStore(extensionId: string, repair = false): Promise<BrowserExtension> {
    if (!isExtensionId(extensionId)) throw new TypeError('Browser extension ID is invalid')
    await this.host.ready
    const original = this.host.registry.get(extensionId)
    if (!original || original.source !== 'webstore' || !original.webstoreId) {
      throw new Error('Only extensions installed from the Web Store can be updated here')
    }
    if (
      this.host.updatingIds.has(extensionId) ||
      this.host.installingWebStoreIds.has(extensionId)
    ) {
      throw new Error('That extension is already being installed or updated')
    }

    this.host.updatingIds.add(extensionId)
    let replaced = false
    try {
      const release = repair
        ? await resolveWebStoreRelease(original.webstoreId)
        : await resolveWebStoreUpdate(original.webstoreId, original.version)
      const versionOrder = release
        ? compareBrowserExtensionVersions(original.version, release.version)
        : null
      if (!release || (!repair && versionOrder !== -1)) {
        this.host.availableUpdateVersions.delete(extensionId)
        this.host.host.publish()
        return this.toView(original)
      }

      const updated = await this.host.units['installation'].installWebStoreUpdate(original, release)
      replaced = true
      this.host.availableUpdateVersions.delete(extensionId)
      this.host.host.publish()
      return this.toView(updated)
    } finally {
      this.host.updatingIds.delete(extensionId)
      if (!this.host.disposed) {
        await this.reconcileLiveJars().catch((error: unknown) => {
          Logger.error('Browser extensions could not be reloaded after an update:', error)
        })
        if (
          replaced &&
          extensionId === DARK_READER_EXTENSION_ID &&
          this.host.registry.get(extensionId)?.enabled
        ) {
          for (const state of this.host.loaded.values()) {
            const bridge = state.bridges.get(extensionId)
            if (bridge) await bridge.request({ kind: 'dark-reader-power', enabled: true })
          }
        }
      }
      this.host.pendingInstalledEvents.delete(extensionId)
    }
  }

  /** Ask the user for an unpacked extension folder. */
  async pickFolder(): Promise<string | null> {
    const window = this.host.host.window()
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
   * Release a jar's extensions, because it has no live page left.
   *
   * This is the memory half of containment: a box the user closed keeps its
   * cookies on disk, but it does not keep a renderer per extension loaded into it.
   */
  async onJarEmptied(projectId: string, boxId: string | null, force = false): Promise<void> {
    if (this.host.disposed) return
    const partition = browserPartitionFor(projectId, boxId)
    // A load already in flight would otherwise finish after this and leave the jar
    // loaded with nothing to show for it.
    const inFlight = this.host.loading.get(partition)
    if (inFlight) await inFlight.catch(() => undefined)
    if (
      !force &&
      this.host.host
        .liveJars()
        .some((jar) => browserPartitionFor(jar.projectId, jar.boxId) === partition)
    )
      return
    const state = this.host.loaded.get(partition)
    if (!state) return
    for (const id of [...state.ids]) {
      this.host.units['lifecycle'].stopBridge(state, id)
      this.removeFromSession(state, id)
    }
    this.detachWebRequest(partition)
    this.host.loaded.delete(partition)
  }

  /** A picked folder has to be one the app can actually read an extension from, and
   *  never one inside the app's own store, which would nest an install in itself. */
  async resolveFolder(rawPath: string): Promise<string> {
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

  async reconcileLiveJars(): Promise<void> {
    for (const jar of this.host.host.liveJars()) {
      await this.host.units['lifecycle'].ensureJarLoaded(jar.projectId, jar.boxId)
    }
  }

  /**
   * The extensions one jar should be running, given what is installed.
   *
   * A jar is a session, so this is a question about one: a box's set is the box's,
   * not the caller's, because a box is one identity of the profile and the
   * extensions the user placed in it are loaded while any context uses that box.
   * The profile's own jar answers the same way for the same reason.
   *
   * A context's own jar loads the extensions placed in that context, and nothing
   * else. That is what keeps an extension installed beside one project's
   * conversation inside that project: it is loaded while one of its tabs is open,
   * it survives every tab being closed, and it never appears in another project's
   * thread browser. The jar id carries the context, so a project's jar can no
   * longer read as "every context's own jar".
   */
  desiredForJar(projectId: string, boxId: string | null): BrowserExtensionRecord[] {
    const jarId = extensionJarIdFor(projectId, boxId)
    return this.host.registry
      .list()
      .filter((record) => record.enabled && extensionRunsInJar(record, jarId))
  }

  async reconcileJar(projectId: string, boxId: string | null, partition: string): Promise<void> {
    const desired = this.desiredForJar(projectId, boxId)
    const desiredIds = new Set(desired.map((record) => record.id))
    const current = this.host.loaded.get(partition)?.ids ?? new Set<string>()
    const toUnload = [...current].filter((id) => !desiredIds.has(id))
    const toLoad = desired.filter(
      (record) => !current.has(record.id) && !this.host.updatingIds.has(record.id)
    )
    if (toUnload.length === 0 && toLoad.length === 0) {
      // Nothing loaded changed, but an update can rewrite what a loaded extension
      // declared, and the traffic listeners follow that declaration.
      const existing = this.host.loaded.get(partition)
      if (existing) this.syncWebRequest(partition, existing)
      return
    }

    // Only now is a session asked for, which is what creates its profile directory.
    // A jar nobody enables anything in never reaches this line.
    const session = this.host.host.sessionFor(projectId, boxId)
    const state = this.host.units['lifecycle'].loadedFor(partition, session, projectId, boxId)
    for (const id of toUnload) {
      this.host.units['lifecycle'].stopBridge(state, id)
      this.removeFromSession(state, id)
    }
    for (const id of toUnload) state.ids.delete(id)
    this.syncWebRequest(partition, state)
    if (toLoad.length === 0) return

    let changed = false
    for (const record of toLoad) {
      if (await this.host.units['lifecycle'].loadIntoSession(state, record)) changed = true
    }
    this.syncWebRequest(partition, state)
    if (changed) this.host.host.publish()
  }

  /** Restore the old source if a process stopped halfway through an update swap. */
  async restoreInterruptedSource(extensionId: string): Promise<void> {
    const existing = this.host.recoveringSources.get(extensionId)
    if (existing) return existing

    const source = extensionSourceDirectory(this.host.configRoot, extensionId)
    const backup = join(
      this.extensionDirectory(extensionId),
      `${BROWSER_EXTENSION_SOURCE_DIR}.previous`
    )
    const recovery = (async () => {
      const [sourceExists, backupExists] = await Promise.all([
        stat(source).then(
          () => true,
          () => false
        ),
        stat(backup).then(
          () => true,
          () => false
        )
      ])
      if (!backupExists) return
      if (!sourceExists) {
        await rename(backup, source)
        Logger.dev('Recovered a browser extension interrupted during update:', { extensionId })
      } else {
        await rm(backup, { recursive: true, force: true })
      }
    })()
    this.host.recoveringSources.set(extensionId, recovery)
    try {
      await recovery
    } finally {
      this.host.recoveringSources.delete(extensionId)
    }
  }

  /**
   * Fill in the options page for an extension installed before it was tracked.
   * Reads the installed manifest once and patches the record when it names an
   * options document the record does not have yet.
   */
  async refreshOptionsPath(directory: string, record: BrowserExtensionRecord): Promise<void> {
    if (record.optionsPath) return
    try {
      const manifest = await readManifestRecord(directory)
      if (!manifest.optionsPath) return
      const patched = await this.host.registry.patch(record.id, {
        optionsPath: manifest.optionsPath
      })
      if (patched) {
        record.optionsPath = patched.optionsPath
        this.host.host.publish()
      }
    } catch (error) {
      Logger.dev('Browser extension options path could not be refreshed:', {
        extensionId: record.id,
        error
      })
    }
  }

  /**
   * Apply per-site rules to an installed copy before Chromium loads it.
   *
   * Reads from a preserved original manifest so unblocking restores the exact
   * bytes the extension shipped. Blocked hosts are appended to each content
   * script's `exclude_matches`. A non-empty allowlist intersects each content
   * script's `matches` with the allowed hosts. Host permissions keep `<all_urls>`
   * because that grant has no exclude mechanism; content scripts carry the block.
   */
  async applySiteRulesToManifest(directory: string, record: BrowserExtensionRecord): Promise<void> {
    const manifestPath = join(directory, EXTENSION_MANIFEST_NAME)
    const originalPath = join(directory, 'cio-original-manifest.json')
    try {
      const hasRules = record.blockedHosts.length > 0 || record.allowedHosts.length > 0
      if (!hasRules) {
        if (!existsSync(originalPath)) return
        const original = await readFile(originalPath, 'utf8')
        const current = await readFile(manifestPath, 'utf8').catch(() => null)
        if (current !== null && current !== original) {
          await writeFile(manifestPath, original)
        }
        return
      }
      if (!existsSync(originalPath)) {
        const current = await readFile(manifestPath, 'utf8')
        await writeFile(originalPath, current)
      }
      const originalText = await readFile(originalPath, 'utf8')
      const original = JSON.parse(originalText) as Record<string, unknown>
      const filtered = filterManifestForSiteRules(
        original,
        record.blockedHosts,
        record.allowedHosts
      )
      if (filtered === null) return
      await writeFile(manifestPath, `${JSON.stringify(filtered, null, 2)}\n`)
    } catch (error) {
      Logger.dev('Browser extension site rules could not be applied:', {
        extensionId: record.id,
        error
      })
    }
  }

  /** Repair a damaged store copy before opening it, preserving its settings. */
  async ensureExtensionPagesAvailable(extensionId: string): Promise<void> {
    await this.host.ready
    const record = this.host.registry.get(extensionId)
    if (!record) throw new Error('That extension is not installed')
    const directory = extensionSourceDirectory(this.host.configRoot, extensionId)
    const manifest = await readManifestRecord(directory)
    const pages = [manifest.popupPath, manifest.optionsPath].filter(
      (path): path is string => path !== null
    )
    const available = await Promise.all(
      pages.map((path) => extensionPageFileExists(directory, path))
    )
    if (available.some((exists) => !exists)) {
      if (record.source !== 'webstore')
        throw new Error('The extension package is missing its settings or popup page')
      await this.updateFromWebStore(extensionId, true)
    }
    await this.host.units['panels'].refreshPopupAvailability(
      directory,
      this.host.registry.get(extensionId) ?? record
    )
  }

  removeFromSession(state: LoadedJar, extensionId: string): void {
    this.host.host.releaseViews(extensionId, state.projectId, state.boxId)
    try {
      state.session.extensions.removeExtension(extensionId)
    } catch (error) {
      Logger.dev('Browser extension could not be unloaded:', { extensionId, error })
    }
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
    if (name === 'onRemoved' && typeof args[0] === 'number') {
      const partition = browserPartitionFor(projectId, boxId)
      const policy = this.host.darkReaderPolicies.get(partition)
      if (policy?.onlyTabId === args[0]) {
        this.host.darkReaderPolicies.delete(partition)
        void this.host.loaded.get(partition)?.bridges.get(DARK_READER_EXTENSION_ID)?.push({
          kind: 'dark-reader-tab-policy',
          onlyTabId: null,
          disabledTabIds: [],
          refresh: true
        })
      } else if (policy)
        policy.disabledTabIds = policy.disabledTabIds.filter((id) => id !== args[0])
    }
    const state = this.host.loaded.get(browserPartitionFor(projectId, boxId))
    if (!state || state.bridges.size === 0) return
    for (const bridge of state.bridges.values()) void bridge.push({ kind: 'tab', name, args })
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
    const state = this.host.loaded.get(browserPartitionFor(projectId, boxId))
    if (!state || state.bridges.size === 0) return
    for (const bridge of state.bridges.values()) {
      void bridge.push({ kind: 'web-navigation', name, args: [details] })
    }
  }

  /** Whether one installed extension declared the permission its traffic events
   *  belong to. Like `downloads`, the name is stripped from the installed copy so
   *  the runtime does not warn about it, so the record's own reading of its
   *  manifest is the one that answers here. */
  watchesWebRequests(extensionId: string): boolean {
    return this.host.registry.get(extensionId)?.declaredPermissions.includes('webRequest') ?? false
  }

  /**
   * Keep one jar's `webRequest` listeners in step with what is loaded in it.
   *
   * Chromium compiles `chrome.webRequest` out, so its events never fire and an
   * extension that captures downloads cannot see a response arrive. The session's
   * own listeners are the only observation the app has, and they are attached for
   * a jar only while something loaded in it declared `webRequest`: a jar whose
   * extensions never asked costs nothing at all, and one where the last watcher
   * was unloaded is detached rather than left forwarding into no bridge.
   *
   * The set is recomputed on every reconcile rather than appended to, because an
   * update can rewrite an extension's declared permissions while its id stays the
   * same.
   */
  syncWebRequest(partition: string, state: LoadedJar): void {
    const extensionIds = new Set([...state.ids].filter((id) => this.watchesWebRequests(id)))
    const attached = this.host.webRequestJars.get(partition)
    if (extensionIds.size === 0) {
      if (attached) this.detachWebRequest(partition)
      return
    }
    if (attached && attached.session === state.session) {
      attached.extensionIds = extensionIds
      return
    }
    if (attached) this.detachWebRequest(partition)
    this.attachWebRequest(partition, state.session, extensionIds)
  }

  /**
   * Put the five traffic listeners on one jar's session.
   *
   * Only the events Chrome documents are wired, and only for as long as a watcher
   * is loaded: every request in the jar passes through these, so the work done per
   * event is one map lookup and a bridge push per interested extension. The
   * mapping from Electron's details to Chrome's happens inside the forward, so a
   * jar with no interested bridge never builds one.
   */
  attachWebRequest(partition: string, session: Session, extensionIds: Set<string>): void {
    this.host.webRequestJars.set(partition, { session, extensionIds })
    const filter = { urls: ['*://*/*'] }
    session.webRequest.onSendHeaders(filter, (details) =>
      this.forwardWebRequest(partition, 'onSendHeaders', details)
    )
    session.webRequest.onHeadersReceived(filter, (details, done) => {
      this.forwardWebRequest(partition, 'onHeadersReceived', details)
      // The listener holds the request until the callback answers, so the pass
      // through is given back immediately after it has been reported.
      done({})
    })
    session.webRequest.onResponseStarted(filter, (details) =>
      this.forwardWebRequest(partition, 'onResponseStarted', details)
    )
    session.webRequest.onCompleted(filter, (details) =>
      this.forwardWebRequest(partition, 'onCompleted', details)
    )
    session.webRequest.onErrorOccurred(filter, (details) =>
      this.forwardWebRequest(partition, 'onErrorOccurred', details)
    )
  }

  /** Take the five listeners off one jar's session, once, so a re-reconcile that
   *  reloads nothing cannot leave a second copy behind. `null` clears every
   *  listener on that event, which is why these five belong to this service and
   *  nothing else in the app registers them. */
  detachWebRequest(partition: string): void {
    const attached = this.host.webRequestJars.get(partition)
    if (!attached) return
    this.host.webRequestJars.delete(partition)
    try {
      attached.session.webRequest.onSendHeaders(null)
      attached.session.webRequest.onHeadersReceived(null)
      attached.session.webRequest.onResponseStarted(null)
      attached.session.webRequest.onCompleted(null)
      attached.session.webRequest.onErrorOccurred(null)
    } catch (error: unknown) {
      // A session already torn down has nothing left to detach from.
      Logger.dev('Browser extension webRequest listeners could not be detached:', {
        partition,
        error
      })
    }
  }

  /** Hand one traffic fact to every extension in the jar that asked to watch it,
   *  in the details shape `chrome.webRequest` documents. */
  forwardWebRequest(
    partition: string,
    name: BrowserExtensionWebRequestEventName,
    source: BrowserExtensionWebRequestSource
  ): void {
    const state = this.host.loaded.get(partition)
    const attached = this.host.webRequestJars.get(partition)
    if (!state || !attached || state.bridges.size === 0) return
    let details: BrowserExtensionWebRequestDetails | null = null
    for (const [extensionId, bridge] of state.bridges) {
      if (!attached.extensionIds.has(extensionId)) continue
      details ??= toWebRequestDetails(name, source)
      void bridge.push({ kind: 'web-request', name, details })
    }
  }

  /**
   * Answer one `chrome.cookies` query from the jar the extension runs in.
   *
   * The namespace is compiled out, so a download manager that needs the site's
   * session to fetch a captured file asks the preamble and waits for this. The
   * answer can only come from the extension's own jar: a jar is one identity, and
   * reading another one's cookies would hand code in one box the session of
   * another. A jar that is no longer loaded answers an empty list rather than
   * being read after it was released.
   */
  async answerCookieRequest(
    state: LoadedJar,
    extensionId: string,
    request: BrowserExtensionCookieRequest
  ): Promise<BrowserExtensionCookieResult> {
    const partition = browserPartitionFor(state.projectId, state.boxId)
    if (
      this.host.disposed ||
      this.host.loaded.get(partition) !== state ||
      !state.ids.has(extensionId)
    ) {
      return { cookies: [] }
    }
    const cookies = await state.session.cookies.get(toCookieQuery(request.filter))
    return { cookies: cookies.map(toExtensionCookie) }
  }

  /**
   * One snapshot from a worker, turned into what the app draws.
   *
   * A restarted worker is a fresh life with no memory of the last one, so its
   * first snapshot is announced as a reset: the renderer drops every entry it
   * held for that extension before the new life's entries arrive, instead of
   * merging a new badge into a dead life's icon.
   */
  onMailbox(
    state: LoadedJar,
    extensionId: string,
    mail: BrowserExtensionMailbox,
    restarted: boolean
  ): void {
    state.mail.set(extensionId, mail)
    if (restarted) {
      this.host.host.publishActivity({
        boxId: extensionJarIdFor(state.projectId, state.boxId),
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
      state.actionPopupSeq.delete(extensionId)
    }
    state.publishedGeneration.set(extensionId, mail.generation)
    this.host.units['commands'].handleNotifications(state, extensionId, mail)
    this.host.units['panels'].handleSidePanelRequests(state, extensionId, mail)
    this.host.units['panels'].handleActionPopupRequests(state, extensionId, mail.actionPopups)
    // Publishing resolves each icon's bytes, so it is queued per jar: two
    // snapshots landing out of order would draw the older state over the newer.
    state.publishing = state.publishing
      .then(() => this.host.units['queries'].publishSnapshot(state, extensionId, mail))
      .catch((error: unknown) =>
        Logger.dev('Browser extension activity could not be published:', {
          extensionId,
          error
        })
      )
  }

  /**
   * One notification request: raise, replace or dismiss the card it names.
   *
   * The extension's own id is kept for the click that comes back to it, while
   * the OS card is keyed by an id namespaced with the extension so two
   * extensions cannot collide. A click or a user close is pushed straight into
   * the worker that raised the card, from the jar whose bridge it is.
   */
  applyNotification(
    state: LoadedJar,
    extensionId: string,
    entry: BrowserExtensionNotificationRecord
  ): void {
    const service = getNotificationService()
    const namespacedId = `${extensionId}:${entry.id}`
    const raised = this.host.raisedNotifications.get(extensionId) ?? new Set<string>()
    this.host.raisedNotifications.set(extensionId, raised)
    switch (entry.kind) {
      case 'create':
      case 'update': {
        const record = this.host.registry.get(extensionId)
        raised.add(namespacedId)
        service?.notifyExternal({
          id: namespacedId,
          title: entry.options?.title?.trim() || record?.name || 'Extension',
          message: entry.options?.message ?? '',
          silent: entry.options?.silent === true,
          onClick: (): void =>
            this.host.units['commands'].pushNotificationCommand(state, extensionId, {
              kind: 'notification-click',
              id: entry.id
            }),
          onClose: (): void => {
            raised.delete(namespacedId)
            this.host.units['commands'].pushNotificationCommand(state, extensionId, {
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
  async drawableActivity(
    directory: string,
    extensionId: string,
    patch: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (typeof patch['iconUrl'] !== 'string') return patch
    const iconUrl = await readActionIconDataUrl(
      directory,
      extensionId,
      patch['iconUrl'],
      this.host.actionIcons
    )
    return { ...patch, iconUrl }
  }

  // ─── Paths and progress ────────────────────────────────────────────────────

  storeRoot(): string {
    return join(this.host.configRoot, resolveBrowserExtensionStoreDir())
  }

  extensionDirectory(extensionId: string): string {
    return join(this.storeRoot(), extensionId)
  }
}
