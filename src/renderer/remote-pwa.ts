import { mount } from 'svelte'
import RemotePwaApp from './lib/components/remote/RemotePwaApp.svelte'
import './app.css'

// Installable phone client: register the service worker (isolated to this
// origin), then mount the shared remote session UI.
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('./service-worker.js').catch(() => undefined)
}

const target = document.getElementById('app')
if (target) {
  mount(RemotePwaApp, { target })
}
