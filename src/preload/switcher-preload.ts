import { contextBridge, ipcRenderer } from 'electron'
import type { NativeSwitcherPayload } from '../lib/ipc-contract'

/**
 * Narrow, overlay-only bridge for the native Ctrl+Tab switcher page.
 *
 * The overlay is a separate sandboxed WebContentsView loaded from our own
 * `switcher.html`. It must NOT receive the full application bridge — only the
 * handful of channels it needs to render rows and report input back to main,
 * which validates every call against the overlay's own sender identity.
 */
const switcherBridge = {
  /** Pull the current session payload on page load (covers a first open where
   *  the pushed event would have raced the page's script). */
  getData: (): Promise<NativeSwitcherPayload | null> =>
    ipcRenderer.invoke('switcher:pageGetData'),
  /** Receive a fresh session payload pushed from main on each subsequent open. */
  onData: (callback: (payload: NativeSwitcherPayload) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: NativeSwitcherPayload): void => {
      callback(payload)
    }
    ipcRenderer.on('switcher:data', handler)
    return () => {
      ipcRenderer.removeListener('switcher:data', handler)
    }
  },
  select: (threadId: string): void => ipcRenderer.send('switcher:pageSelect', threadId),
  highlight: (threadId: string): void => ipcRenderer.send('switcher:pageHighlight', threadId),
  close: (): void => ipcRenderer.send('switcher:pageClose')
} as const

contextBridge.exposeInMainWorld('switcherBridge', switcherBridge)

export type SwitcherBridge = typeof switcherBridge
