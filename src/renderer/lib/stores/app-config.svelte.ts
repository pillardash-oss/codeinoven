import type { AppConfig, GitPullPreference } from '$shared/types'

/** Fallback used until the persisted config loads (mirrors App.svelte defaults). */
const DEFAULT_MAX_DIFF_LINES = 100
const DEFAULT_FONT_FAMILY = 'jetbrains-mono'
const DEFAULT_APP_FONT_SIZE = 15
const DEFAULT_ZOOM_LEVEL = 1

/** Font stacks for the family ids offered in Appearance settings. Keep in
 *  sync with FONT_FAMILIES in src/main/ipc/ipc-handlers.ts. */
const FONT_STACKS: Record<string, string> = {
  'jetbrains-mono':
    "'JetBrains Mono Variable', 'JetBrainsMono Nerd Font', ui-monospace, 'SFMono-Regular', Menlo, monospace",
  satoshi: "'Satoshi', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  system: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  'sf-mono': "'SF Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace",
  menlo: "Menlo, ui-monospace, monospace",
  monaco: "Monaco, ui-monospace, monospace",
  'fira-code': "'Fira Code', 'JetBrains Mono Variable', ui-monospace, monospace"
}

let maxDiffLines = $state(DEFAULT_MAX_DIFF_LINES)
let openLocalhostInCioBrowser = $state(true)
let defaultPullStrategy = $state<GitPullPreference>('ask')
let fontFamily = $state(DEFAULT_FONT_FAMILY)
let appFontSize = $state(DEFAULT_APP_FONT_SIZE)
let zoomLevel = $state(DEFAULT_ZOOM_LEVEL)

/** Push the persisted appearance preferences onto the document: the app font
 *  stack as a CSS variable and the base font size on the root element (all
 *  rem-based Tailwind text scales from it). Zoom itself is a window-level
 *  Electron zoomFactor owned by the main process. */
function applyAppearance(): void {
  const root = document.documentElement
  root.style.setProperty('--font-app', FONT_STACKS[fontFamily] ?? FONT_STACKS['jetbrains-mono'])
  root.style.fontSize = `${appFontSize}px`
  void zoomLevel // zoom is applied by the main process via setZoomFactor
}

/**
 * Reactive slice of the app config for deep components (diff viewers) that do
 * not receive the config via props. App.svelte syncs it whenever the persisted
 * config loads or is patched.
 */
export const appConfigState = {
  get maxDiffLines(): number {
    return maxDiffLines
  },
  get openLocalhostInCioBrowser(): boolean {
    return openLocalhostInCioBrowser
  },
  get defaultPullStrategy(): GitPullPreference {
    return defaultPullStrategy
  },
  get fontFamily(): string {
    return fontFamily
  },
  get appFontSize(): number {
    return appFontSize
  },
  get zoomLevel(): number {
    return zoomLevel
  },
  sync(config: AppConfig): void {
    maxDiffLines = config.maxDiffLines
    openLocalhostInCioBrowser = config.openLocalhostInCioBrowser
    defaultPullStrategy = config.defaultPullStrategy
    fontFamily = config.fontFamily
    appFontSize = config.appFontSize
    zoomLevel = config.zoomLevel
    applyAppearance()
  }
}

/** Options for the Appearance font-family picker. */
export const FONT_FAMILY_OPTIONS: Array<{ id: string; label: string }> = [
  { id: 'jetbrains-mono', label: 'JetBrains Mono (default)' },
  { id: 'satoshi', label: 'Satoshi' },
  { id: 'system', label: 'System default' },
  { id: 'sf-mono', label: 'SF Mono' },
  { id: 'menlo', label: 'Menlo' },
  { id: 'monaco', label: 'Monaco' },
  { id: 'fira-code', label: 'Fira Code' }
]

/** Zoom levels offered in Appearance settings, as percentages. */
export const ZOOM_LEVEL_OPTIONS: Array<{ id: number; label: string }> = [
  { id: 0.5, label: '50%' },
  { id: 0.67, label: '67%' },
  { id: 0.75, label: '75%' },
  { id: 0.8, label: '80%' },
  { id: 0.9, label: '90%' },
  { id: 1, label: '100%' },
  { id: 1.1, label: '110%' },
  { id: 1.25, label: '125%' },
  { id: 1.5, label: '150%' },
  { id: 1.75, label: '175%' },
  { id: 2, label: '200%' }
]
