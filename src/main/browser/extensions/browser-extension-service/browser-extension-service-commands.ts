import { Logger } from '../../../system/logger'
import { type BrowserExtensionMailbox } from '../browser-extension-bridge'
import { compareBrowserExtensionVersions } from '../browser-extension-version'
import { resolveWebStoreUpdate } from '../browser-extension-webstore'
import { MAX_CONCURRENT_UPDATE_CHECKS } from '../browser-extension-service'
import type { LoadedJar } from '../browser-extension-service'
import type { BrowserExtensionService } from '../browser-extension-service'

/** BrowserExtensionService commands: one concern, moved verbatim from the composition root. */
export class BrowserExtensionServiceCommands {
  constructor(private readonly host: BrowserExtensionService) {}

  async runUpdateCheck(): Promise<void> {
    await this.host.ready
    if (this.host.disposed) return
    let changed = false
    const candidates = this.host.registry.list().filter((record) => record.source === 'webstore')

    for (let offset = 0; offset < candidates.length; offset += MAX_CONCURRENT_UPDATE_CHECKS) {
      if (this.host.disposed) return
      const batch = candidates.slice(offset, offset + MAX_CONCURRENT_UPDATE_CHECKS)
      await Promise.all(
        batch.map(async (record) => {
          if (!record.webstoreId || this.host.updatingIds.has(record.id)) return
          if (this.host.installingWebStoreIds.has(record.webstoreId)) return
          try {
            const release = await resolveWebStoreUpdate(record.webstoreId, record.version)
            const current = this.host.registry.get(record.id)
            if (
              !current ||
              current.version !== record.version ||
              this.host.updatingIds.has(record.id) ||
              this.host.disposed
            ) {
              return
            }
            const previousVersion = this.host.availableUpdateVersions.get(record.id) ?? null
            const nextVersion =
              release && compareBrowserExtensionVersions(current.version, release.version) === -1
                ? release.version
                : null
            if (previousVersion === nextVersion) return
            if (nextVersion) this.host.availableUpdateVersions.set(record.id, nextVersion)
            else this.host.availableUpdateVersions.delete(record.id)
            changed = true
          } catch (error: unknown) {
            Logger.dev('Browser extension update check failed:', {
              extensionId: record.id,
              error
            })
          }
        })
      )
    }

    if (changed && !this.host.disposed) this.host.host.publish()
  }

  /**
   * Act on the OS notifications a worker asked the app to raise.
   *
   * Only entries newer than the highest sequence already acted on are handled,
   * so the 500 ms poll re-reading the same snapshot never raises a card twice.
   * A restarted worker starts its sequence over with no memory, so its
   * bookkeeping is dropped with the generation reset in `onMailbox`.
   */
  handleNotifications(state: LoadedJar, extensionId: string, mail: BrowserExtensionMailbox): void {
    if (mail.notifications.length === 0) return
    const lastSeen = state.notificationSeq.get(extensionId) ?? 0
    let newest = lastSeen
    for (const entry of mail.notifications) {
      if (entry.seq <= lastSeen) continue
      newest = Math.max(newest, entry.seq)
      this.host.units['runtime'].applyNotification(state, extensionId, entry)
    }
    state.notificationSeq.set(extensionId, newest)
  }

  /** Hand one notification command back to the extension's own worker. */
  pushNotificationCommand(
    state: LoadedJar,
    extensionId: string,
    command: Record<string, unknown>
  ): void {
    state.bridges.get(extensionId)?.push(command)
  }
}
