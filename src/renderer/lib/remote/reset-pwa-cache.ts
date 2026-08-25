/**
 * Shared recovery for an installed PWA that is serving stale chunk hashes.
 *
 * The phone client is a code-split bundle. When the desktop rebuilds, every
 * hashed chunk name changes; an installed PWA that still holds the previous
 * shell (or a partially updated precache) keeps requesting hashes that no
 * longer exist on disk. Those requests 404 and the lazy `import()` rejects.
 * Re-running the import cannot help — the page is asking for a dead hash — so
 * the only recovery is to drop the service-worker registrations and every
 * cached response for this origin, then reload the freshly-served shell.
 */
export async function resetPwaCacheAndReload(): Promise<void> {
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
