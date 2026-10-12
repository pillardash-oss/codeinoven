import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { resolveAppControl, setAppControlResponder } from './app-control-bridge'
import type { AppControlResponse } from '../../lib/app-control'

/**
 * The bridge's two renderer channels.
 *
 * `appControl:ready` is how a renderer claims the bridge: the app can have more
 * than one window, and a request with a side effect must run once, so main sends
 * every request to the window that announced itself last. `appControl:respond`
 * drains the call parked under the reply's request id.
 *
 * Registered once, on the pre-navigation surface, because the bridge can park a
 * call the moment a turn starts   before the lazy feature graph is up. An
 * unknown or already-expired request id is a no-op: the request's own timeout is
 * what fails a dropped answer, so a stale reply must not surface as an error.
 */
export function registerAppControlHandlers(): void {
  ipcMain.handle('appControl:ready', (event) => {
    setAppControlResponder(event.sender)
  })
  ipcMain.handle('appControl:respond', (_event, response: unknown) => {
    if (!isAppControlResponse(response)) return
    resolveAppControl(response)
  })
}

/** Whether a value is a well-formed reply from the renderer. */
function isAppControlResponse(value: unknown): value is AppControlResponse {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate['requestId'] === 'string' && typeof candidate['ok'] === 'boolean'
}
