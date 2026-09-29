/**
 * Browser extensions: what is installed, and which jars load them.
 *
 * An extension is a piece of third-party code the app runs inside a box's session,
 * so three rules shape this service:
 *
 *   1. **Installation is an app-owned folder, never the user's.** The package is
 *      unpacked into `browser/extensions/<id>/source` and every load points there,
 *      so the app can re-apply its compatibility layer on an update and can delete
 *      an extension completely.
 *   2. **An extension is loaded per jar, not app-wide.** Chromium has no
 *      cross-session extension, so each box that enables one gets its own copy with
 *      its own storage. That is the point of containing an extension: two boxes can
 *      run different extensions, or the same one with separate state.
 *   3. **It costs a renderer per jar it lives in, so it is unloaded the moment its
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
import type {
  BrowserExtension,
  BrowserExtensionInstallInput,
  BrowserExtensionProgress
} from '../../../lib/ipc/browser'
import { Logger } from '../../system/logger'
import { browserPartitionFor } from '../browser-service/browser-validation'
import { prepareExtensionSource } from './browser-extension-install-job'
import { extensionIdFromInput, isExtensionId } from './browser-extension-crx'
import { downloadWebStoreRelease, resolveWebStoreRelease } from './browser-extension-webstore'
import { EXTENSION_MANIFEST_NAME } from './browser-extension-source'
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

/** How often progress reaches the renderer. A download reports per chunk and the
 *  install worker per phase, so without a gate a large package would send hundreds
 *  of events that all say the same thing. */
const PROGRESS_INTERVAL_MS = 200

/** Directories inside the store root that are not extensions. */
const STAGING_DIR = '.staging'
const DOWNLOADS_DIR = '.downloads'

/** One jar with extensions loaded in it. The session is held, not looked up on
 *  demand: unloading must never be what creates a partition directory, and a
 *  lookup would also re-trigger the loading path it is trying to undo. */
interface LoadedJar {
  session: Session
  ids: Set<string>
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
  /** Report one install step to the renderer. */
  reportProgress(progress: BrowserExtensionProgress): void
  /** The installed list changed. */
  publish(): void
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
  private installing = false
  private disposed = false
  private lastProgressAt = 0
  private lastPhase: BrowserExtensionProgress['phase'] | null = null

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
   * Install one extension.
   *
   * Installs are serialized: the staging folder, the download folder and the
   * progress stream are all singular, and two concurrent installs would report
   * each other's steps and race the same paths.
   */
  async install(input: BrowserExtensionInstallInput): Promise<BrowserExtension> {
    if (this.installing) throw new Error('Another extension is still installing')
    this.installing = true
    try {
      return await this.runInstall(input)
    } finally {
      this.installing = false
    }
  }

  /** Uninstall an extension: stop it everywhere, then delete its files. */
  async uninstall(extensionId: string): Promise<void> {
    if (!isExtensionId(extensionId)) throw new TypeError('Browser extension ID is invalid')
    const record = this.registry.get(extensionId)
    if (!record) return
    await this.unloadEverywhere(extensionId)
    await rm(this.extensionDirectory(extensionId), { recursive: true, force: true })
    await this.registry.remove(extensionId)
    this.host.publish()
  }

  /** Enable or disable one extension, and choose the jars it runs in. */
  async update(
    extensionId: string,
    patch: { enabled?: boolean; boxes?: string[] }
  ): Promise<BrowserExtension> {
    if (!isExtensionId(extensionId)) throw new TypeError('Browser extension ID is invalid')
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
    for (const id of [...state.ids]) this.removeFromSession(state.session, id)
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
    for (const [partition, state] of [...this.loaded]) {
      for (const id of [...state.ids]) this.removeFromSession(state.session, id)
      this.loaded.delete(partition)
    }
    this.loading.clear()
  }

  // ─── Install ───────────────────────────────────────────────────────────────

  private async runInstall(input: BrowserExtensionInstallInput): Promise<BrowserExtension> {
    const label = input.value.trim() || 'extension'
    this.report({ label, phase: 'resolving', detail: 'Finding the extension' })

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
        crxPath = join(this.downloadRoot(), `${webstoreId}.crx`)
        this.report({
          label,
          phase: 'downloading',
          detail: `Downloading version ${release.version}`,
          totalBytes: release.size
        })
        await downloadWebStoreRelease(release, crxPath, (progress) => {
          this.report({
            label,
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
          this.report({
            label,
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
      this.report({ label, phase: 'registering', detail: 'Installing' })

      // Move the prepared tree to its final home. A rename, not a copy: it is the
      // same filesystem and the source folder may be tens of megabytes.
      const extensionDir = this.extensionDirectory(id)
      await rm(extensionDir, { recursive: true, force: true })
      await mkdir(extensionDir, { recursive: true })
      await rename(stagingSource, join(extensionDir, BROWSER_EXTENSION_SOURCE_DIR))

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
      this.report({ label, phase: 'done', detail: `Installed ${result.name}` })
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

  private async reconcileJar(
    projectId: string,
    boxId: string | null,
    partition: string
  ): Promise<void> {
    const desired = this.registry
      .list()
      .filter((record) => record.enabled && extensionRunsInJar(record, boxId))
    const desiredIds = new Set(desired.map((record) => record.id))
    const current = this.loaded.get(partition)?.ids ?? new Set<string>()
    const toUnload = [...current].filter((id) => !desiredIds.has(id))
    const toLoad = desired.filter((record) => !current.has(record.id))
    if (toUnload.length === 0 && toLoad.length === 0) return

    // Only now is a session asked for, which is what creates its profile directory.
    // A jar nobody enables anything in never reaches this line.
    const session = this.host.sessionFor(projectId, boxId)
    const state = this.loadedFor(partition, session)
    for (const id of toUnload) this.removeFromSession(session, id)
    for (const id of toUnload) state.ids.delete(id)
    if (toLoad.length === 0) return

    let changed = false
    for (const record of toLoad) {
      if (await this.loadIntoSession(session, partition, record)) changed = true
    }
    if (changed) this.host.publish()
  }

  private async loadIntoSession(
    session: Session,
    partition: string,
    record: BrowserExtensionRecord
  ): Promise<boolean> {
    const directory = extensionSourceDirectory(this.configRoot, record.id)
    try {
      await session.extensions.loadExtension(directory, { allowFileAccess: false })
      this.loadedFor(partition, session).ids.add(record.id)
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
      this.removeFromSession(state.session, extensionId)
      state.ids.delete(extensionId)
      if (state.ids.size === 0) this.loaded.delete(partition)
    }
  }

  private loadedFor(partition: string, session: Session): LoadedJar {
    const existing = this.loaded.get(partition)
    if (existing) return existing
    const created: LoadedJar = { session, ids: new Set() }
    this.loaded.set(partition, created)
    return created
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
   *  change always goes through immediately: the phase is what the user reads. */
  private report(progress: {
    label: string
    phase: BrowserExtensionProgress['phase']
    detail: string
    receivedBytes?: number
    totalBytes?: number
  }): void {
    const now = Date.now()
    const phaseChanged = progress.phase !== this.lastPhase
    if (!phaseChanged && now - this.lastProgressAt < PROGRESS_INTERVAL_MS) return
    this.lastProgressAt = now
    this.lastPhase = progress.phase
    this.host.reportProgress({
      label: progress.label,
      phase: progress.phase,
      detail: progress.detail,
      receivedBytes: progress.receivedBytes ?? 0,
      totalBytes: progress.totalBytes ?? 0
    })
  }
}
