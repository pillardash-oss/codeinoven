import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import preambleSource from '../compat/cio-compat-preamble.js?raw'
import { missingExtensionCapabilities } from '../../../../lib/browser/browser-extension-capabilities'
import type { BrowserExtension, BrowserExtensionInstallInput } from '../../../../lib/ipc/browser'
import { Logger } from '../../../system/logger'
import { browserPartitionFor } from '../../browser-service/browser-validation'
import { prepareExtensionSource } from '../browser-extension-install-job'
import { ensureInjectionCurrent } from '../browser-extension-inject'
import type { BrowserExtensionMenuSection } from '../../browser-service/browser-context-menu'
import { extensionIdFromInput, isExtensionId } from '../browser-extension-crx'
import {
  downloadWebStoreRelease,
  resolveWebStoreRelease,
  type WebStoreRelease
} from '../browser-extension-webstore'
import { readManifestObject } from '../browser-extension-source'
import {
  BROWSER_EXTENSION_SOURCE_DIR,
  extensionSourceDirectory,
  type BrowserExtensionRecord
} from '../browser-extension-registry'
import { DARK_READER_EXTENSION_ID } from '../../../../lib/browser/browser-darkreader-control'
import {
  BITWARDEN_EXTENSION_ID,
  refreshBitwardenNotificationScripts
} from '../browser-extension-bitwarden'
import { MAX_CONCURRENT_INSTALLS, STAGING_DIR } from '../browser-extension-service'
import type { InstallContext, QueuedInstall } from '../browser-extension-service'
import type { BrowserExtensionService } from '../browser-extension-service'

/** BrowserExtensionService installation: one concern, moved verbatim from the composition root. */
export class BrowserExtensionServiceInstallation {
  constructor(private readonly host: BrowserExtensionService) {}

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
    if (this.host.disposed) throw new Error('The browser is shutting down')
    if (this.host.installIds.has(input.installId)) {
      throw new Error('That install is already running')
    }
    const webstoreId = input.source === 'webstore' ? extensionIdFromInput(input.value) : null
    if (
      webstoreId &&
      (this.host.installingWebStoreIds.has(webstoreId) || this.host.updatingIds.has(webstoreId))
    ) {
      throw new Error('That extension is already being installed or updated')
    }
    const context: InstallContext = {
      installId: input.installId,
      label: input.value.trim() || 'extension',
      // Resolved here rather than after the download so the very first line about
      // this install can be matched to the store page that asked for it.
      webstoreId: input.source === 'webstore' ? extensionIdFromInput(input.value) : null
    }
    this.host.installIds.add(context.installId)
    if (context.webstoreId) this.host.installingWebStoreIds.add(context.webstoreId)
    return new Promise<BrowserExtension>((resolve, reject) => {
      this.host.installQueue.push({ input, context, resolve, reject })
      // Reported before anything starts, so a queued install shows up in the panel
      // in the same breath as the click that asked for it.
      this.host.units['messaging'].report(context, {
        phase: 'queued',
        detail: `Waiting for the ${this.host.runningInstalls === 1 ? 'install' : 'installs'} already running`
      })
      this.startQueuedInstalls()
    })
  }

  /** Hand the free slots to the installs waiting for them. */
  startQueuedInstalls(): void {
    while (this.host.runningInstalls < MAX_CONCURRENT_INSTALLS) {
      const job = this.host.installQueue.shift()
      if (!job) return
      this.host.runningInstalls += 1
      void this.runQueuedInstall(job)
    }
  }

  /** Run one install, answer its caller, then release its slot for the next. */
  async runQueuedInstall(job: QueuedInstall): Promise<void> {
    try {
      job.resolve(await this.runInstall(job.input, job.context))
    } catch (error: unknown) {
      const reason = error instanceof Error && error.message ? error.message : String(error)
      // A failure is a phase, not just a rejected promise: an install started from
      // the browser chrome has a progress line and no dialog of its own to fail in.
      this.host.units['messaging'].report(job.context, { phase: 'failed', detail: reason })
      job.reject(error)
    } finally {
      this.host.runningInstalls -= 1
      this.host.installIds.delete(job.context.installId)
      if (job.context.webstoreId) this.host.installingWebStoreIds.delete(job.context.webstoreId)
      this.host.installProgress.delete(job.context.installId)
      this.startQueuedInstalls()
    }
  }

  /** Uninstall an extension: stop it everywhere, then delete its files. */
  async uninstall(extensionId: string): Promise<void> {
    if (!isExtensionId(extensionId)) throw new TypeError('Browser extension ID is invalid')
    if (
      this.host.updatingIds.has(extensionId) ||
      this.host.installingWebStoreIds.has(extensionId)
    ) {
      throw new Error('That extension is being installed or updated')
    }
    const record = this.host.registry.get(extensionId)
    if (!record) return
    await this.host.units['lifecycle'].unloadEverywhere(extensionId)
    await rm(this.host.units['runtime'].extensionDirectory(extensionId), {
      recursive: true,
      force: true
    })
    // Its icons went with the folder. Held bytes would outlive the files they
    // came from and be drawn for whatever is installed under the same id next.
    this.host.actionIcons.clear()
    await this.host.registry.remove(extensionId)
    this.host.availableUpdateVersions.delete(extensionId)
    this.host.host.publish()
  }

  // ─── Install ───────────────────────────────────────────────────────────────

  async runInstall(
    input: BrowserExtensionInstallInput,
    context: InstallContext
  ): Promise<BrowserExtension> {
    this.host.units['messaging'].report(context, {
      phase: 'resolving',
      detail: 'Finding the extension'
    })

    const stagingRoot = join(this.host.units['runtime'].storeRoot(), STAGING_DIR, randomUUID())
    const stagingSource = join(stagingRoot, BROWSER_EXTENSION_SOURCE_DIR)
    let crxPath: string | null = null
    let folderPath: string | null = null
    let webstoreId: string | null = null

    try {
      if (input.source === 'webstore') {
        webstoreId = extensionIdFromInput(input.value)
        if (!webstoreId) throw new Error('That is not a Chrome Web Store id or link')
        const release = await resolveWebStoreRelease(webstoreId)
        await mkdir(this.host.units['lifecycle'].downloadRoot(), { recursive: true })
        // Named for the install rather than for the id: two installs of the same
        // extension may be in flight, and one finishing must not delete bytes the
        // other is still reading.
        crxPath = join(
          this.host.units['lifecycle'].downloadRoot(),
          `${webstoreId}-${randomUUID()}.crx`
        )
        this.host.units['messaging'].report(context, {
          phase: 'downloading',
          detail: `Downloading version ${release.version}`,
          totalBytes: release.size
        })
        await downloadWebStoreRelease(release, crxPath, (progress) => {
          this.host.units['messaging'].report(context, {
            phase: 'downloading',
            detail: `Downloading version ${release.version}`,
            receivedBytes: progress.receivedBytes,
            totalBytes: progress.totalBytes
          })
        })
      } else {
        folderPath = await this.host.units['runtime'].resolveFolder(input.value)
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
          this.host.units['messaging'].report(context, {
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
      const previousRecord = this.host.registry.get(id)
      this.host.units['messaging'].report(context, { phase: 'registering', detail: 'Installing' })

      // Move the prepared tree to its final home. A rename, not a copy: it is the
      // same filesystem and the source folder may be tens of megabytes.
      const extensionDir = this.host.units['runtime'].extensionDirectory(id)
      await rm(extensionDir, { recursive: true, force: true })
      await mkdir(extensionDir, { recursive: true })
      await rename(stagingSource, join(extensionDir, BROWSER_EXTENSION_SOURCE_DIR))
      // An install can replace an existing copy's files in place, and every icon
      // held in memory belongs to the tree that was just replaced.
      this.host.actionIcons.clear()

      const warnings: string[] = []
      if (result.skippedLinks > 0) {
        warnings.push(`${result.skippedLinks} symbolic links in the folder were skipped`)
      }
      if (result.popupMissing) {
        warnings.push('Its popup page is missing from the package, so it has no popup to open.')
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
        optionsPath: result.optionsPath,
        blockedHosts: [],
        allowedHosts: [],
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
      await this.host.registry.upsert(record)
      this.host.pendingInstalledEvents.set(
        id,
        previousRecord
          ? { reason: 'update', previousVersion: previousRecord.version }
          : { reason: 'install' }
      )
      this.host.availableUpdateVersions.delete(id)
      this.host.units['messaging'].report(context, {
        phase: 'done',
        detail: `Installed ${result.name}`
      })
      try {
        await this.host.units['runtime'].reconcileLiveJars()
      } finally {
        this.host.pendingInstalledEvents.delete(id)
      }
      this.host.host.publish()
      return this.host.units['runtime'].toView(record)
    } finally {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
      if (crxPath) await rm(crxPath, { force: true }).catch(() => undefined)
    }
  }

  async installWebStoreUpdate(
    original: BrowserExtensionRecord,
    release: WebStoreRelease
  ): Promise<BrowserExtensionRecord> {
    const stagingRoot = join(this.host.units['runtime'].storeRoot(), STAGING_DIR, randomUUID())
    const stagingSource = join(stagingRoot, BROWSER_EXTENSION_SOURCE_DIR)
    const backupSource = join(
      this.host.units['runtime'].extensionDirectory(original.id),
      `${BROWSER_EXTENSION_SOURCE_DIR}.previous`
    )
    const extensionSource = extensionSourceDirectory(this.host.configRoot, original.id)
    const crxPath = join(
      this.host.units['lifecycle'].downloadRoot(),
      `${original.id}-${randomUUID()}.crx`
    )
    let previousMoved = false
    let replacementMoved = false
    let recordCommitted = false

    try {
      await this.host.units['runtime'].restoreInterruptedSource(original.id)
      await mkdir(this.host.units['lifecycle'].downloadRoot(), { recursive: true })
      await downloadWebStoreRelease(release, crxPath, () => undefined)
      const result = await prepareExtensionSource(
        {
          destinationDir: stagingSource,
          crxPath,
          folderPath: null,
          expectedId: original.webstoreId,
          preamble: preambleSource
        },
        () => undefined
      )
      if (result.id !== original.id || result.version !== release.version) {
        throw new Error('The downloaded package did not match the Web Store update')
      }

      const current = this.host.registry.get(original.id)
      if (!current || current.version !== original.version) {
        throw new Error('The installed extension changed before its update could be applied')
      }

      // Let any extension load already in progress finish. New loads skip this id
      // until the replacement has been registered, so no worker sees half a tree.
      await Promise.all([...this.host.loading.values()].map((task) => task.catch(() => undefined)))
      if (original.id === DARK_READER_EXTENSION_ID) {
        for (const state of this.host.loaded.values()) {
          const bridge = state.bridges.get(original.id)
          if (bridge) await bridge.request({ kind: 'dark-reader-power', enabled: false })
        }
      }
      await this.host.units['lifecycle'].unloadEverywhere(original.id)

      const warnings: string[] = []
      if (result.popupMissing) {
        warnings.push('Its popup page is missing from the package, so it has no popup to open.')
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

      await rename(extensionSource, backupSource)
      previousMoved = true
      await rename(stagingSource, extensionSource)
      replacementMoved = true

      const updated: BrowserExtensionRecord = {
        ...current,
        name: result.name,
        version: result.version,
        description: result.description,
        popupPath: result.popupPath,
        optionsPath: result.optionsPath,
        pinned: current.pinned && result.popupPath !== null,
        iconDataUrl: result.iconDataUrl,
        declaredPermissions: result.declaredPermissions,
        ruleResources: result.ruleResources,
        manifestVersion: result.manifestVersion,
        missingCapabilities: [...missingExtensionCapabilities(result.declaredPermissions)],
        warnings,
        injected: result.injected,
        sourceHash: result.sourceHash
      }
      await this.host.registry.upsert(updated)
      this.host.pendingInstalledEvents.set(original.id, {
        reason: 'update',
        previousVersion: original.version
      })
      recordCommitted = true
      this.host.actionIcons.clear()
      await rm(backupSource, { recursive: true, force: true }).catch(() => undefined)
      return updated
    } catch (error: unknown) {
      if (previousMoved && !recordCommitted) {
        try {
          if (replacementMoved) {
            await rm(extensionSource, { recursive: true, force: true })
          }
          await this.host.units['runtime'].restoreInterruptedSource(original.id)
          await this.host.registry.upsert(original)
        } catch (rollbackError: unknown) {
          Logger.error('Browser extension update could not restore its previous files:', {
            extensionId: original.id,
            rollbackError
          })
        }
      }
      throw error
    } finally {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
      await rm(crxPath, { force: true }).catch(() => undefined)
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
  async refreshInstalledPreamble(directory: string, record: BrowserExtensionRecord): Promise<void> {
    if (record.injected === 'none') return
    try {
      if (record.id === BITWARDEN_EXTENSION_ID) {
        await refreshBitwardenNotificationScripts(directory)
      }
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
   * The recorded context menus of every extension a jar runs.
   *
   * Read straight from the last mailbox rather than kept in a second structure:
   * the tree only changes when the extension rebuilds it, and the native menu
   * asks for it on the one click that needs it.
   *
   * Each section carries the icon the extension published, which the registry
   * already holds in memory, so a right-click never reads an icon off disk.
   */
  menuRecordsFor(projectId: string, boxId: string | null): BrowserExtensionMenuSection[] {
    const state = this.host.loaded.get(browserPartitionFor(projectId, boxId))
    if (!state) return []
    const sections: BrowserExtensionMenuSection[] = []
    for (const record of this.host.units['runtime'].desiredForJar(projectId, boxId)) {
      const mail = state.mail.get(record.id)
      if (!mail || mail.menus.length === 0) continue
      sections.push({ extensionId: record.id, iconDataUrl: record.iconDataUrl, items: mail.menus })
    }
    return sections
  }
}
