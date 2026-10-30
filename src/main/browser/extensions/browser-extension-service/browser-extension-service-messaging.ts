import { missingExtensionCapabilities } from '../../../../lib/browser/browser-extension-capabilities'
import type { BrowserExtensionProgress } from '../../../../lib/ipc/browser'
import { Logger } from '../../../system/logger'
import { browserPartitionFor } from '../../browser-service/browser-validation'
import { type BrowserExtensionRecord } from '../browser-extension-registry'
import { PROGRESS_INTERVAL_MS } from '../browser-extension-service'
import type { InstallContext } from '../browser-extension-service'
import type { BrowserExtensionService } from '../browser-extension-service'

/** BrowserExtensionService messaging: one concern, moved verbatim from the composition root. */
export class BrowserExtensionServiceMessaging {
  constructor(private readonly host: BrowserExtensionService) {}

  /**
   * Keep an installed extension's capability report current.
   *
   * The report is a fact about this app's own surface, and that surface grows: a
   * namespace the preamble learns to implement (or a bridge that learns to carry)
   * is a capability the extension gets back. The list is computed at install time,
   * so without this an extension installed before the fix would keep claiming the
   * loss for the rest of its life.
   */
  async refreshCapabilityReport(record: BrowserExtensionRecord): Promise<void> {
    const missing = [...missingExtensionCapabilities(record.declaredPermissions)]
    const same =
      missing.length === record.missingCapabilities.length &&
      missing.every((capability, index) => record.missingCapabilities[index] === capability)
    if (same) return
    try {
      await this.host.registry.patch(record.id, { missingCapabilities: missing })
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

  /** Tell one extension's worker that its panel opened, for its own
   *  `chrome.sidePanel.onOpened`. */
  reportSidePanelOpened(
    projectId: string,
    boxId: string | null,
    extensionId: string,
    extensionTabId: number
  ): void {
    this.host.units['panels'].pushSidePanelCommand(projectId, boxId, extensionId, {
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
    this.host.units['panels'].pushSidePanelCommand(projectId, boxId, extensionId, {
      kind: 'side-panel-closed',
      tabId: extensionTabId
    })
  }

  /** A recorded menu item was chosen: hand the click back to the worker. */
  dispatchMenuClick(
    projectId: string,
    boxId: string | null,
    extensionId: string,
    info: Record<string, unknown>,
    tab: Record<string, unknown>
  ): void {
    const bridge = this.host.loaded
      .get(browserPartitionFor(projectId, boxId))
      ?.bridges.get(extensionId)
    bridge?.push({ kind: 'menu-click', info, tab })
  }

  /** Gate progress so a long download cannot flood the renderer, while a phase
   *  change always goes through immediately: the phase is what the user reads.
   *
   * The gate is per install rather than one shared clock, because installs now
   * overlap: a shared one would let the install that reported last swallow the
   * other's lines entirely, and the panel would show one install frozen while two
   * were running. */
  report(
    context: InstallContext,
    progress: {
      phase: BrowserExtensionProgress['phase']
      detail: string
      receivedBytes?: number
      totalBytes?: number
    }
  ): void {
    const now = Date.now()
    const previous = this.host.installProgress.get(context.installId)
    if (!previous || previous.phase !== progress.phase) {
      this.host.installProgress.set(context.installId, { at: now, phase: progress.phase })
    } else {
      if (now - previous.at < PROGRESS_INTERVAL_MS) return
      previous.at = now
    }
    this.host.host.reportProgress({
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
