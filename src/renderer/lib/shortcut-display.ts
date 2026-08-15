/**
 * Display helpers for keyboard shortcuts. The app's action model stores
 * platform-neutral modifier names ("Ctrl", "Alt", "Shift"); on macOS these are
 * rendered with the command (⌘), option (⌥) and shift (⇧) symbols.
 */

const MAC_KEY_SYMBOLS: Record<string, string> = {
  Ctrl: '⌘',
  Meta: '⌘',
  Alt: '⌥',
  Shift: '⇧'
}

/** Best-effort macOS detection, preferring the Electron bridge when present. */
export function isMacPlatform(): boolean {
  if (typeof window === 'undefined') return false
  const bridge = window as { api?: { windowInfo?: { platform?: string } } }
  const platform = bridge.api?.windowInfo?.platform
  if (platform) return platform === 'darwin'
  return navigator.platform?.toUpperCase().includes('MAC') ?? false
}

/** Render a single shortcut key for the current platform, e.g. "Ctrl" → "⌘". */
export function displayShortcutKey(key: string): string {
  if (!isMacPlatform()) return key
  return MAC_KEY_SYMBOLS[key] ?? key
}

/** Render a whitespace-separated shortcut label, e.g. "Ctrl K" → "⌘ K". */
export function displayShortcutLabel(label: string): string {
  if (!isMacPlatform()) return label
  return label.replace(/\bCtrl\b/g, MAC_KEY_SYMBOLS['Ctrl'])
}
