/**
 * The global browser's durable tab list, owned by the main process.
 *
 * The list lives under the config root as an atomically written JSON file. It is
 * app-owned state, so it follows the same rule as every other durable record:
 * the main process owns the file, the renderer reads and writes it through the
 * IPC contract, and the payload is validated on both sides.
 *
 * This is the fix for a real loss: the list used to live only in the renderer's
 * `localStorage`, which is scoped to the renderer origin and silently becomes an
 * empty, process-local storage whenever another app instance already holds the
 * profile's storage database. A second instance then read no tabs and persisted
 * none, and the user's tabs were gone on the next launch with no error raised.
 */

import { dirname, join } from 'node:path'
import {
  GLOBAL_BROWSER_TABS_STATE_RELATIVE_PATH,
  globalBrowserTabsSnapshotPayload,
  parseGlobalBrowserTabsSnapshot,
  type GlobalBrowserTabsSnapshot
} from '../../lib/browser/global-browser-tabs'
import { ensureDir, getConfigRoot, readJson, writeJson } from '../../lib/utils'
import { Logger } from '../system/logger'

export class GlobalBrowserTabsStore {
  private get filePath(): string {
    return join(getConfigRoot(), GLOBAL_BROWSER_TABS_STATE_RELATIVE_PATH)
  }

  /** The stored tab list, or null when nothing has ever been stored. A corrupt
   *  file reads as "nothing stored" rather than failing the launch: the renderer
   *  then rewrites it from the list it is holding. */
  async load(): Promise<GlobalBrowserTabsSnapshot | null> {
    let stored: unknown
    try {
      stored = await readJson<unknown>(this.filePath)
    } catch (error) {
      Logger.error('Global browser tab list could not be read', error)
      return null
    }
    return stored === null ? null : parseGlobalBrowserTabsSnapshot(stored)
  }

  /**
   * Store a tab list the renderer sent, bounded and repaired before it is
   * written. The renderer is not trusted to keep the file well-formed, and a
   * repaired field must never cost the user a tab.
   */
  async save(value: unknown): Promise<void> {
    const snapshot = parseGlobalBrowserTabsSnapshot(value)
    const path = this.filePath
    await ensureDir(dirname(path))
    await writeJson(path, globalBrowserTabsSnapshotPayload(snapshot))
  }
}
