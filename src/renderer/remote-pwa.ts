import { mount } from 'svelte'
import { installRemoteApiShim } from './lib/remote/remote-api-shim'
import { remoteLog } from './lib/remote/logger'

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

/**
 * Drop every cached response and service worker for this origin, then reload.
 *
 * A phone that cached an older build can hold references to chunk hashes the
 * desktop no longer has on disk. Clearing the cache is the one recovery the
 * user can perform from the phone itself.
 */
async function resetAndReload(): Promise<void> {
  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations()
      await Promise.all(registrations.map((registration) => registration.unregister()))
    }
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map((key) => caches.delete(key)))
    }
  } catch {
    // best-effort — reload regardless
  }
  location.reload()
}

/**
 * Render the reason the client could not start.
 *
 * The UI mounts from a dynamic import, so a single unreachable chunk rejects
 * the promise and leaves the page completely blank with the error buried in the
 * console — invisible on a phone. Showing the failure makes it diagnosable and
 * gives the user a way out.
 */
function showBootFailure(reason: unknown): void {
  const target = document.getElementById('app')
  const message = reason instanceof Error ? reason.message : String(reason)
  remoteLog.error(`Remote client failed to start: ${message}`)
  if (!target) return

  target.textContent = ''
  const panel = document.createElement('div')
  panel.setAttribute(
    'style',
    'display:flex;flex-direction:column;gap:12px;align-items:flex-start;padding:24px;font:15px/1.5 system-ui,sans-serif;color:#e5e7eb;background:#0b0f19;min-height:100vh;box-sizing:border-box'
  )

  const heading = document.createElement('h1')
  heading.textContent = 'Could not start the remote client'
  heading.setAttribute('style', 'margin:0;font-size:18px;font-weight:600')

  const detail = document.createElement('p')
  detail.textContent = message
  detail.setAttribute(
    'style',
    'margin:0;color:#9ca3af;font-size:13px;word-break:break-word;font-family:ui-monospace,monospace'
  )

  const hint = document.createElement('p')
  hint.textContent =
    'This usually means the desktop app rebuilt while this page was cached. Reset clears the cached copy and reloads.'
  hint.setAttribute('style', 'margin:0;color:#9ca3af;font-size:13px')

  const reset = document.createElement('button')
  reset.type = 'button'
  reset.textContent = 'Reset and reload'
  reset.setAttribute(
    'style',
    'appearance:none;border:0;border-radius:8px;padding:12px 18px;background:#2563eb;color:#fff;font-size:15px;font-weight:600;min-height:44px'
  )
  reset.addEventListener('click', () => {
    void resetAndReload()
  })

  panel.append(heading, detail, hint, reset)
  target.append(panel)
}

void import('./lib/components/remote/RemotePwaApp.svelte')
  .then(({ default: RemotePwaApp }) => {
    const target = document.getElementById('app')
    if (target) {
      mount(RemotePwaApp, { target })
    }
  })
  .catch(showBootFailure)
