import { BrowserWindow } from 'electron'
import { sendToRenderer } from '../ipc/renderer-delivery'
import type { StorageEngine } from '../storage/storage-engine'

/**
 * The one-time start-at-login offer.
 *
 * Starting at login is off until the user asks for it, because it only has a
 * reason to exist once a routine is expected to run. The app therefore makes
 * the offer in the one moment that becomes true: right after a routine is given
 * its first how-to. The answer is stored with `launchAtLoginPrompted`, so the
 * offer is raised once in an install's life and never again, however many
 * routines are set up afterwards. Settings keeps the switch either way, and an
 * install that answered before this offer existed simply keeps its saved value.
 *
 * It only decides whether to raise the offer and pushes it to the renderer that
 * renders it; the login item itself is applied by
 * `BackgroundLifecycleService.applyLoginItem` from the saved config.
 */
export async function raiseStartAtLoginOffer(storage: StorageEngine): Promise<void> {
  const config = await storage.getConfig()
  if (config.launchAtLoginPrompted) return
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'app:startAtLoginPrompt')
  }
}
