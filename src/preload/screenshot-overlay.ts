import { contextBridge, ipcRenderer } from 'electron'
import {
  SCREENSHOT_OVERLAY_CHANNELS as CHANNELS,
  type ScreenshotOverlayBridge
} from '../lib/screenshot/overlay-bridge'

/**
 * The region-selection overlay's whole bridge.
 *
 * The overlay holds a picture of everything on screen, so it gets these five
 * calls and not the app's preload.
 */
const bridge: ScreenshotOverlayBridge = {
  frame: () => ipcRenderer.invoke(CHANNELS.frame),
  ready: () => ipcRenderer.send(CHANNELS.ready),
  select: (selection) => ipcRenderer.send(CHANNELS.select, selection),
  cancel: () => ipcRenderer.send(CHANNELS.cancel),
  fail: (reason) => ipcRenderer.send(CHANNELS.fail, reason)
}

contextBridge.exposeInMainWorld('screenshotOverlay', bridge)
