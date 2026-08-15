import { APP_SLUG } from '$shared/brand'

const STORAGE_KEY = `${APP_SLUG}.wrapText.v1`

function load(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    // Storage unavailable — fall back to the default (no wrapping).
  }
  return false
}

/** Action-specific title for the wrap toggle, describing what clicking does. */
export function wrapToggleLabel(wrapped: boolean): string {
  return wrapped ? 'Unwrap text' : 'Wrap text'
}

/**
 * Shared "wrap text" preference applied to every code block and file viewer
 * across the app. Whatever the user last selected is applied everywhere and
 * persists across restarts.
 */
class WrapTextStore {
  wrapped = $state<boolean>(load())

  setWrapped(wrapped: boolean): void {
    this.wrapped = wrapped
    this.persist()
  }

  toggle(): void {
    this.setWrapped(!this.wrapped)
  }

  persist(): void {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(STORAGE_KEY, this.wrapped ? 'true' : 'false')
    } catch {
      // Wrap preference is optional; unavailable storage must not break the app.
    }
  }
}

export const wrapTextState = new WrapTextStore()
