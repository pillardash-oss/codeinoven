const PREFERRED_DESKTOP_KEY = 'codeinoven:preferred-remote-desktop'

/** Remember the desktop the user deliberately connected to for PWA restoration. */
export function savePreferredDesktop(desktopId: string, storage: Storage = localStorage): void {
  try {
    storage.setItem(PREFERRED_DESKTOP_KEY, desktopId)
  } catch {
    // A live session still works when private storage is unavailable.
  }
}

export function loadPreferredDesktop(storage: Storage = localStorage): string | null {
  try {
    const desktopId = storage.getItem(PREFERRED_DESKTOP_KEY)?.trim() ?? ''
    return desktopId || null
  } catch {
    return null
  }
}

export function clearPreferredDesktop(storage: Storage = localStorage): void {
  try {
    storage.removeItem(PREFERRED_DESKTOP_KEY)
  } catch {
    // Best-effort cleanup; no remote state is stored in this value.
  }
}
