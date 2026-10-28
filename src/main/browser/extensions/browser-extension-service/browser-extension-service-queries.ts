import type { BrowserExtension } from '../../../../lib/ipc/browser'
import { getNotificationService } from '../../../notifications/notification-service'
import { browserJarFor, browserPartitionFor } from '../../browser-service/browser-validation'
import { type BrowserExtensionMailbox } from '../browser-extension-bridge'
import { isExtensionId } from '../browser-extension-crx'
import { extensionRunsInJar, extensionSourceDirectory } from '../browser-extension-registry'
import {
  DARK_READER_EXTENSION_ID,
  type DarkReaderTabAction,
  type DarkReaderTabState
} from '../../../../lib/browser/browser-darkreader-control'
import { activityFromPatch } from '../browser-extension-service'
import type { LoadedJar } from '../browser-extension-service'
import type { BrowserExtensionService } from '../browser-extension-service'

/** BrowserExtensionService queries: one concern, moved verbatim from the composition root. */
export class BrowserExtensionServiceQueries {
  constructor(private readonly host: BrowserExtensionService) {}

  /** Wait for the registry to have been read. */
  async whenReady(): Promise<void> {
    await this.host.ready
  }

  /** The installed extensions, as the renderer draws them. */
  list(): BrowserExtension[] {
    return this.host.registry.list().map((record) => this.host.units['runtime'].toView(record))
  }

  /**
   * Whether a `chrome-extension://` address names a file of an enabled
   * extension that runs in the jar asked for. Any path inside that extension is
   * allowed, because setup flows span more than the single options file: the
   * options page links to its own setup pages.
   */
  isExtensionPageAllowed(rawUrl: string, projectId: string, boxId: string | null): boolean {
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      return false
    }
    if (parsed.protocol !== 'chrome-extension:' || !isExtensionId(parsed.host)) return false
    const record = this.host.registry.get(parsed.host)
    if (!record || !record.enabled) return false
    return extensionRunsInJar(record, browserJarFor(projectId, boxId).boxId)
  }

  /**
   * A box was deleted. Its id never comes back, so every extension that named it
   * forgets it, and anything loaded for it is released before its storage goes.
   */
  async forgetBox(projectId: string, boxId: string): Promise<void> {
    const partition = browserPartitionFor(projectId, boxId)
    await this.host.units['runtime'].onJarEmptied(projectId, boxId, true)
    this.host.loaded.delete(partition)
    if (await this.host.registry.forgetBox(boxId)) this.host.host.publish()
  }

  async setDarkReaderTabScope(
    projectId: string,
    boxId: string | null,
    tabId: number,
    action: DarkReaderTabAction
  ): Promise<DarkReaderTabState> {
    const record = this.host.registry.get(DARK_READER_EXTENSION_ID)
    if (!record || !extensionRunsInJar(record, boxId)) {
      throw new Error('Dark Reader is not installed in this box')
    }
    const partition = browserPartitionFor(projectId, boxId)
    const previous = this.host.darkReaderPolicies.get(partition) ?? {
      onlyTabId: null,
      disabledTabIds: []
    }
    const policy = {
      onlyTabId: action === 'only-tab' ? tabId : previous.onlyTabId,
      disabledTabIds: previous.disabledTabIds.filter((id) => id !== tabId)
    }
    if (action === 'only-tab') policy.disabledTabIds = []
    if (!record.enabled && action === 'enable-tab') policy.onlyTabId = tabId
    if (action === 'disable-tab') policy.disabledTabIds.push(tabId)
    if (action === 'enable-tab' && policy.onlyTabId !== null) policy.onlyTabId = tabId
    if (action === 'reset-tabs') this.host.darkReaderPolicies.delete(partition)
    else this.host.darkReaderPolicies.set(partition, policy)
    if (!record.enabled) {
      if (action === 'disable-tab' || action === 'reset-tabs')
        return this.host.units['storage'].darkReaderTabState(projectId, boxId, tabId)
      await this.host.units['runtime'].update(record.id, { enabled: true })
    }
    await this.host.units['lifecycle'].ensureJarLoaded(projectId, boxId)
    const bridge = this.host.loaded.get(partition)?.bridges.get(record.id)
    if (!bridge) throw new Error('Dark Reader background is unavailable')
    await bridge.push({
      kind: 'dark-reader-tab-policy',
      ...(action === 'reset-tabs' ? { onlyTabId: null, disabledTabIds: [] } : policy),
      enable: action === 'only-tab' || action === 'enable-tab',
      refresh: action === 'reset-tabs'
    })
    return this.host.units['storage'].darkReaderTabState(projectId, boxId, tabId)
  }

  /** Drop every OS notification an extension still has raised. */
  dismissExtensionNotifications(extensionId: string): void {
    const raised = this.host.raisedNotifications.get(extensionId)
    if (!raised) return
    this.host.raisedNotifications.delete(extensionId)
    const service = getNotificationService()
    if (!service) return
    for (const id of raised) service.dismissExternal(id)
  }

  /**
   * One snapshot published, with every icon address it carries replaced by the
   * icon's own bytes.
   *
   * A snapshot older than the one already held is dropped: each mailbox carries
   * the whole action state, so the newer snapshot publishes everything this one
   * would have, and dropping it keeps a slow disk read from drawing stale state.
   */
  async publishSnapshot(
    state: LoadedJar,
    extensionId: string,
    mail: BrowserExtensionMailbox
  ): Promise<void> {
    if (state.mail.get(extensionId) !== mail) return
    const directory = extensionSourceDirectory(this.host.configRoot, extensionId)
    const global = await this.host.units['runtime'].drawableActivity(
      directory,
      extensionId,
      mail.actions.global
    )
    this.publishActivityEntry(state, extensionId, null, global, mail.at)
    for (const [tabId, patch] of Object.entries(mail.actions.tabs)) {
      const appTabId = this.host.host.resolveTabId(state.projectId, Number(tabId))
      if (!appTabId) continue
      const resolved = await this.host.units['runtime'].drawableActivity(
        directory,
        extensionId,
        patch
      )
      this.publishActivityEntry(state, extensionId, appTabId, resolved, mail.at)
    }
  }

  publishActivityEntry(
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
    this.host.host.publishActivity({
      boxId: state.boxId ?? '',
      extensionId,
      tabId,
      activity
    })
  }
}
