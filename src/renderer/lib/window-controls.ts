import { hasCaptionOverlay } from '$shared/traffic-light'
import { logRendererError } from './system/renderer-logger'

let pendingFrame: number | undefined
let lastAppearance = ''

/** Sync the native caption buttons only when app appearance changes. */
export function syncWindowControls(): void {
  if (typeof window === 'undefined') return
  if (!hasCaptionOverlay(window.api?.windowInfo.platform)) return
  if (pendingFrame !== undefined) return
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = undefined
    const style = getComputedStyle(document.documentElement)
    const symbolColor = style.getPropertyValue('--color-foreground').trim()
    const height = Number.parseFloat(style.fontSize) * 3
    if (!/^#[\da-f]{6}$/i.test(symbolColor) || !Number.isFinite(height)) return
    const appearance = `${symbolColor}:${height}:${window.devicePixelRatio}`
    if (appearance === lastAppearance) return
    lastAppearance = appearance
    void window.api.invoke('app:setWindowControls', symbolColor, height).catch((error: unknown) => {
      lastAppearance = ''
      logRendererError('Could not synchronize native window controls', error)
    })
  })
}
