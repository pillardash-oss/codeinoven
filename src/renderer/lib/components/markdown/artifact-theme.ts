/// <reference types="vite/client" />
import { createSubscriber } from 'svelte/reactivity'
import appCss from '../../../app.css?raw'

// Discover names from the canonical stylesheet rather than copying a palette.
const tokenNames = [...new Set(appCss.match(/--[\w-]+(?=\s*:)/gu) ?? [])]
let cachedStyles: string | undefined

const subscribe = createSubscriber((update) => {
  let frame: number | undefined
  const observer = new MutationObserver(() => {
    if (frame !== undefined) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      cachedStyles = undefined
      update()
    })
  })
  observer.observe(document.documentElement, { attributes: true })
  observer.observe(document.body, { attributes: true })
  observer.observe(document.head, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true
  })
  return () => {
    observer.disconnect()
    if (frame !== undefined) cancelAnimationFrame(frame)
    cachedStyles = undefined
  }
})

/** One shared, batched subscription while artifact cards are mounted. */
export function artifactThemeStyles(): string {
  subscribe()
  if (cachedStyles !== undefined) return cachedStyles
  const root = getComputedStyle(document.documentElement)
  const body = getComputedStyle(document.body)
  const names = new Set(tokenNames)
  // Include runtime/custom-theme tokens as well as stylesheet declarations.
  for (let index = 0; index < body.length; index++) {
    const name = body.item(index)
    if (name.startsWith('--')) names.add(name)
  }
  const fontFaces: string[] = []
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) {
        if (rule instanceof CSSFontFaceRule) fontFaces.push(rule.cssText)
      }
    } catch {
      // Cross-origin stylesheets cannot be inspected. App fonts are bundled.
    }
  }
  const declarations = [...names]
    .map((name) => `${name}:${body.getPropertyValue(name).trim()};`)
    .join('')
  const scheme = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  // Escape the style end-tag boundary, including values from custom themes.
  cachedStyles =
    `${fontFaces.join('')}:root{${declarations}color-scheme:${scheme};font-size:${root.fontSize};}
body{font-family:${body.fontFamily};font-weight:${body.fontWeight};color:var(--color-foreground);background:var(--color-app);line-height:${body.lineHeight};}
code,pre{font-family:var(--font-mono);}
*{border-color:var(--color-border);}`.replace(/</gu, '\\3c ')
  return cachedStyles
}
