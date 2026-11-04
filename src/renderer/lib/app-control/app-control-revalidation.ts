import { logRendererError } from '$lib/system/renderer-logger'

/**
 * Renderer records an outside write leaves stale.
 *
 * An app-control call is a channel invoked from the renderer on the agent's
 * behalf, so the write itself happens in main and no store method ran: the panel
 * showing that record keeps what it read when it mounted, and the user is told
 * an action exists that the panel they are looking at does not show.
 *
 * Most shared records already answer this with a main-to-renderer event
 * (`thread:*`, `note:changed`, `config:changed`, `assistant:changed`,
 * `design:*`, `orchestration:changed`, `scope:boardChanged`). This registry
 * covers the records that do not: a store that caches one registers the channel
 * family it mirrors and how to re-read what it already holds, and app control
 * asks every matching store to do that after a write succeeds.
 *
 * Registering is per store rather than per channel, so a store that is never
 * opened costs nothing: its `refresh` is a no-op until it holds a record.
 */

export interface AppControlRevalidation {
  /** Channel families this store caches, as exact names or namespace prefixes
   *  (`oven:`, `project:`). */
  channels: readonly string[]
  /** Re-read the records this store already holds, and nothing when it holds
   *  none. Never throws: a failed refresh must not fail the agent's call. */
  refresh: () => void | Promise<void>
}

const registrations: AppControlRevalidation[] = []

/** Have one store re-read the records it holds when app control writes them. */
export function registerAppControlRevalidation(registration: AppControlRevalidation): void {
  registrations.push(registration)
}

/**
 * Channel shapes that change a stored record rather than read one or drive a
 * session, so a record a panel is showing may now be stale.
 *
 * Matched against the channel suffix, which is the app's naming convention:
 * `sticky-note:save`, `assistant:setPinned`, `scope:setWorktreeDefaults`.
 */
const MUTATING_SUFFIX =
  /:(?:save|create|update|delete|remove|rename|reorder|toggle|archive|restore|import|reset|clear|add|set|mark|apply|write|duplicate|trigger|rotate|attach|detach|install|uninstall|enable|disable|emit)(?:$|[A-Z:-])/u

/** Whether an app-control call to this channel may have changed a record. */
export function isMutatingAppControlChannel(channel: string): boolean {
  return MUTATING_SUFFIX.test(channel)
}

/**
 * Ask every store holding a record this channel writes to re-read it.
 *
 * Fire-and-forget by design: the call the agent made already succeeded, and a
 * slow or failed refresh must neither delay the answer nor turn into a failure
 * the agent would report as its own.
 */
export function revalidateAppControlRecords(channel: string): void {
  if (!isMutatingAppControlChannel(channel)) return
  for (const registration of registrations) {
    const owns = registration.channels.some(
      (family) => channel === family || channel.startsWith(family)
    )
    if (!owns) continue
    try {
      Promise.resolve(registration.refresh()).catch((error: unknown) => {
        logRendererError(
          `A record shown in this window could not be re-read after "${channel}"`,
          error
        )
      })
    } catch (error) {
      logRendererError(
        `A record shown in this window could not be re-read after "${channel}"`,
        error
      )
    }
  }
}
