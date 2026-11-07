import { Capacitor } from '@capacitor/core'
import { StatusBar, Style } from '@capacitor/status-bar'

/**
 * The system bars are drawn over the app, so the app owns their icon colour.
 *
 * The shell reads its theme from classes on the document (the same switch the
 * Settings screen flips), and the status bar has to follow it: dark glyphs on the
 * light ground, light glyphs on the dark one. In a browser this is a no-op.
 */

export function isNative(): boolean {
  const platform = Capacitor.getPlatform()
  return platform === 'ios' || platform === 'android'
}

function darkGround(): boolean {
  const root = document.documentElement
  if (root.classList.contains('dark')) return true
  if (root.classList.contains('light')) return false
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

export async function syncSystemBars(): Promise<void> {
  if (!isNative()) return
  try {
    await StatusBar.setOverlaysWebView({ overlay: true })
    await StatusBar.setStyle({ style: darkGround() ? Style.Dark : Style.Light })
  } catch {
    // An older shell without the plugin still draws its own bars; nothing to do.
  }
}
