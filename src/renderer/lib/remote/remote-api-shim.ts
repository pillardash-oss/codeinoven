/**
 * Phone PWA `window.api` shim.
 *
 * The existing renderer stores (thread messages, provider catalog, settings,
 * workspace) read IPC through `window.api` (the Electron preload bridge). On
 * the phone there is no preload, so the PWA installs a compatible shim that
 * routes every `invoke`/`on` call over the encrypted remote WebSocket bridge to
 * the desktop gateway. This lets the whole desktop chat stack run unchanged on
 * the phone.
 */

import type { AppBridge } from '../../../preload/index'
import { remoteBridge } from './remote-bridge'

declare global {
  interface Window {
    api: AppBridge
  }
}

export function installRemoteApiShim(): void {
  if (typeof window === 'undefined') return
  if ('api' in window) return

  const bridge: AppBridge = {
    invoke: ((channel: string, ...args: unknown[]) =>
      remoteBridge.invoke(channel, ...args)) as AppBridge['invoke'],
    send: () => undefined,
    on: ((channel: string, callback: (...args: unknown[]) => void) =>
      remoteBridge.on(channel, callback)) as AppBridge['on'],
    config: {
      get: async () => ({}) as never,
      update: async () => ({}) as never
    } as AppBridge['config'],
    readFile: async () => new Uint8Array(0),
    getPathForFile: () => ''
  }

  ;(window as Window & { api?: AppBridge }).api = bridge
}
