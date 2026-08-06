import { mount } from 'svelte'
import { installRemoteApiShim } from './lib/remote/remote-api-shim'

// Installable phone client: register the service worker (isolated to this
// origin), then mount the remote session UI.
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('./service-worker.js').catch(() => undefined)
}

// The shared renderer stores read IPC through `window.api`. On the phone there
// is no Electron preload, so install a shim that routes every call over the
// encrypted remote WebSocket bridge BEFORE any store module is constructed
// (stores subscribe to events at module evaluation time).
installRemoteApiShim()

void import('./lib/components/remote/RemotePwaApp.svelte').then(({ default: RemotePwaApp }) => {
  const target = document.getElementById('app')
  if (target) {
    mount(RemotePwaApp, { target })
  }
})
