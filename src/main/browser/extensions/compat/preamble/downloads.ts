/**
 * ── downloads ───────────────────────────────────────────────────────────────
 * The runtime compiles `chrome.downloads` out of the extension runtime, so a
 * download manager extension (AB Download Manager, and every other tool that
 * captures downloads) cannot see a download this browser starts, let alone take
 * it over. The app's download manager owns them all instead and hands every fact
 * here through the bridge, in the shapes the API documents, with a numeric id the
 * extension passes back to stop the browser's copy.
 *
 * Real here: the four events, and `cancel`, `pause`, `resume` and `erase`. Not
 * real: `search`, `download`, `open`, `show` and `removeFile`, which the app has
 * no answer for   they keep the quiet shapes they had before, so an extension that
 * calls one for a download it started itself does not throw.
 *
 * The events and the command sender are exported because both outlive install: the
 * bridge command hub fires `downloadEvents` at the extension's listeners, and the
 * members above post through {@link sendDownloadCommand} long after this module ran.
 */
import { answering, noop, roots, state } from './context.ts'
import type { ChromeNamespace } from './context.ts'
import { currentBridgePort, setBridgePort } from './bridge.ts'
import { makeRealEvent } from './events.ts'
import type { RealEvent } from './events.ts'

/** The commands main acts on: a download the app owns, named by the extension's id. */
export type DownloadCommandMethod = 'cancel' | 'pause' | 'resume' | 'erase'

/** `chrome.downloads`, in the members this app answers. */
export interface DownloadsMembers {
  cancel: (id: unknown) => void
  pause: (id: unknown) => void
  resume: (id: unknown) => void
  erase: (id: unknown) => void
  search: (...args: unknown[]) => Promise<unknown>
  download: (...args: unknown[]) => Promise<unknown>
  open: () => void
  show: () => void
  removeFile: () => void
  acceptDanger: () => void
  drag: () => void
  setShelfEnabled: () => void
}

/** The four events the app fires, by the API's own names. */
export const downloadEvents: Record<string, RealEvent> = {}

/** Ask main to act on a download it owns; the id is the one it handed the extension. */
export function sendDownloadCommand(method: DownloadCommandMethod, id: unknown): void {
  const bridgePort = currentBridgePort()
  if (!Number.isSafeInteger(id) || !bridgePort) return
  try {
    bridgePort.postMessage({ kind: 'download-request', method, id })
  } catch (error) {
    state.errors.push('download-bridge: ' + String(error))
    setBridgePort(null)
  }
}

export const downloadsMembers: DownloadsMembers = {
  cancel: (id) => sendDownloadCommand('cancel', id),
  pause: (id) => sendDownloadCommand('pause', id),
  resume: (id) => sendDownloadCommand('resume', id),
  erase: (id) => sendDownloadCommand('erase', id),
  search: answering([]),
  download: answering(-1),
  open: noop,
  show: noop,
  removeFile: noop,
  acceptDanger: noop,
  drag: noop,
  setShelfEnabled: noop
}

/**
 * Install the real namespace on every root, replacing whatever the runtime has.
 *
 * Replaced rather than ensured: `downloads` is not one of the namespaces
 * `installNamespaces` stubs, so an existing object here is the runtime's own and the
 * app's download manager is the only side that can report a download.
 */
export function installDownloads(): void {
  for (const name of ['onCreated', 'onChanged', 'onErased', 'onDeterminingFilename']) {
    downloadEvents[name] = makeRealEvent()
  }
  for (const root of roots) {
    if (!root) continue
    try {
      const existing = root['downloads']
      const api: ChromeNamespace =
        existing && typeof existing === 'object' ? (existing as ChromeNamespace) : {}
      for (const key of Object.keys(downloadsMembers)) {
        try {
          Object.defineProperty(api, key, {
            value: downloadsMembers[key as keyof DownloadsMembers],
            configurable: true,
            writable: true
          })
        } catch (error) {
          state.errors.push('downloads.' + key + ': ' + String(error))
        }
      }
      for (const key of Object.keys(downloadEvents)) {
        try {
          Object.defineProperty(api, key, {
            value: downloadEvents[key],
            configurable: true,
            writable: true
          })
        } catch (error) {
          state.errors.push('downloads.' + key + ': ' + String(error))
        }
      }
      if (!existing) {
        Object.defineProperty(root, 'downloads', { value: api, configurable: true, writable: true })
      }
      state.downloadsBridge = 'installed'
    } catch (error) {
      state.errors.push('downloads: ' + String(error))
    }
  }
}
