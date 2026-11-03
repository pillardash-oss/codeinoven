import type { BrowserWindow } from 'electron'
import type { DisplayService } from './display-service'

/**
 * The display service, created the first time something asks for it.
 *
 * Mirroring is agent-initiated work, so its adapters and their imports must not be
 * part of what a launch pays for: this module is what `display-ipc` reaches for
 * inside its handlers, which keeps the whole capture graph out of the boot path
 * until a panel actually opens.
 */
let pending: Promise<DisplayService> | null = null
let instance: DisplayService | null = null
let windowGetter: (() => BrowserWindow | null) | null = null

/** Point the runtime at the window frames are for. Cheap: it stores a getter. */
export function bindDisplayWindow(getter: () => BrowserWindow | null): void {
  windowGetter = getter
}

/** The service, loading it on first use. */
export function displayService(): Promise<DisplayService> {
  if (instance) return Promise.resolve(instance)
  if (pending) return pending
  pending = import('./display-service')
    .then(({ DisplayService }) => {
      const created = new DisplayService({
        window: () => windowGetter?.() ?? null
      })
      instance = created
      return created
    })
    .finally(() => {
      pending = null
    })
  return pending
}

/** Stop every session and drop the service. Safe when nothing ever loaded. */
export async function disposeDisplayRuntime(): Promise<void> {
  const service = instance
  instance = null
  pending = null
  service?.dispose()
}
