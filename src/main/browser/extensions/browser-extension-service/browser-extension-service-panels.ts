import { Logger } from '../../../system/logger'
import { extensionJarIdFor } from '../../../../lib/browser/browser-extension-jar'
import { browserPartitionFor } from '../../browser-service/browser-validation'
import {
  type BrowserExtensionActionPopupRequest,
  type BrowserExtensionMailbox,
  type BrowserExtensionSidePanelMailbox,
  type BrowserExtensionSidePanelOption,
  type BrowserExtensionSidePanelRequest
} from '../browser-extension-bridge'
import {
  extensionPageFileExists,
  extensionPopupUrl,
  readManifestRecord
} from '../browser-extension-source'
import { extensionRunsInJar, type BrowserExtensionRecord } from '../browser-extension-registry'
import type { LoadedJar } from '../browser-extension-service'
import type { BrowserExtensionService } from '../browser-extension-service'

/** BrowserExtensionService panels: one concern, moved verbatim from the composition root. */
export class BrowserExtensionServicePanels {
  constructor(private readonly host: BrowserExtensionService) {}

  /**
   * The popup document one installed extension declares, as an address, when it
   * is enabled and runs in the jar asked for.
   *
   * Null for everything else, which is what every caller checks before it can
   * host one: an extension the jar does not run is not loaded there, so its own
   * page would have no extension behind it.
   */
  popupUrlFor(extensionId: string, projectId: string, boxId: string | null): string | null {
    const record = this.host.registry.get(extensionId)
    if (!record || !record.enabled) return null
    if (!extensionRunsInJar(record, extensionJarIdFor(projectId, boxId))) return null
    return extensionPopupUrl(record.id, record.popupPath)
  }

  /**
   * Stop offering a popup whose file is missing from the installed copy.
   *
   * A package can declare `action.default_popup` without shipping the file, and
   * a copy on disk can lose it. The first notice today is the popup load itself,
   * which fails with `ERR_FILE_NOT_FOUND` after the rail already opened a popup
   * for it. Clearing the offer here turns that into a row warning instead, and a
   * reinstall restores the popup because the worker reports it again.
   */
  async refreshPopupAvailability(directory: string, record: BrowserExtensionRecord): Promise<void> {
    try {
      const manifest = await readManifestRecord(directory)
      if (manifest.popupPath && (await extensionPageFileExists(directory, manifest.popupPath))) {
        if (record.popupPath !== manifest.popupPath) {
          const patched = await this.host.registry.patch(record.id, {
            popupPath: manifest.popupPath
          })
          if (patched) record.popupPath = patched.popupPath
          this.host.host.publish()
        }
        return
      }
      if (!record.popupPath) return
      const patched = await this.host.registry.patch(record.id, { popupPath: null })
      if (patched) {
        record.popupPath = patched.popupPath
        await this.host.registry.warn(
          record.id,
          'Its popup page is missing from the installed copy, so it has no popup to open.'
        )
        this.host.host.publish()
      }
    } catch (error) {
      Logger.dev('Browser extension popup availability could not be refreshed:', {
        extensionId: record.id,
        error
      })
    }
  }

  /**
   * Act on the side-panel requests a worker queued.
   *
   * Only entries newer than the highest sequence already acted on are handled, so
   * the 500 ms poll re-reading the same snapshot never raises a panel twice. A
   * restarted worker starts its sequence over with no memory, so its bookkeeping
   * is dropped with the generation reset in `onMailbox`.
   */
  handleSidePanelRequests(
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

  /** Apply popup requests the worker routed through the app bridge. */
  handleActionPopupRequests(
    state: LoadedJar,
    extensionId: string,
    requests: BrowserExtensionActionPopupRequest[]
  ): void {
    if (requests.length === 0) return
    const lastSeen = state.actionPopupSeq.get(extensionId) ?? 0
    let newest = lastSeen
    for (const request of requests) {
      if (request.seq <= lastSeen) continue
      newest = Math.max(newest, request.seq)
      this.host.host.openPopup({
        projectId: state.projectId,
        boxId: state.boxId,
        extensionId,
        extensionTabId: request.tabId,
        kind: request.kind,
        ...(request.url ? { url: request.url } : {})
      })
    }
    state.actionPopupSeq.set(extensionId, newest)
  }

  /** One side-panel request: raise the panel for its tab, or close it. */
  applySidePanelRequest(
    state: LoadedJar,
    extensionId: string,
    sidePanel: BrowserExtensionSidePanelMailbox,
    entry: BrowserExtensionSidePanelRequest
  ): void {
    if (entry.kind === 'close') {
      this.host.host.closeSidePanel(extensionId, entry.tabId ?? null)
      return
    }
    const record = this.host.registry.get(extensionId)
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
    this.host.host.openSidePanel({
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
  resolveSidePanelPath(
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
    const sidePanel = this.host.loaded
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
    const record = this.host.registry.get(extensionId)
    return { extensionName: record?.name ?? extensionId, path, url }
  }

  /** Hand one side-panel command back to the extension's own worker. */
  pushSidePanelCommand(
    projectId: string,
    boxId: string | null,
    extensionId: string,
    command: Record<string, unknown>
  ): void {
    this.host.loaded
      .get(browserPartitionFor(projectId, boxId))
      ?.bridges.get(extensionId)
      ?.push(command)
  }
}
