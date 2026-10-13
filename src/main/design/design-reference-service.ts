import { BrowserWindow } from 'electron'

let extracting = false

/** Measure a bounded sample in a disposable renderer, without touching user browser sessions. */
export async function extractDesignReference(rawUrl: unknown): Promise<unknown> {
  if (typeof rawUrl !== 'string' || rawUrl.length > 4096)
    throw new Error('Reference URL is required')
  const url = new URL(rawUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Reference must be an HTTP or HTTPS URL without credentials')
  if (extracting) throw new Error('Another reference measurement is running')
  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'design-reference'
    }
  })
  extracting = true
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const denyDownload = (event: Electron.Event): void => event.preventDefault()
  window.webContents.session.on('will-download', denyDownload)
  window.webContents.on('will-navigate', (event, destination) => {
    if (!/^https?:\/\//iu.test(destination)) event.preventDefault()
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        await window.loadURL(url.href)
        return window.webContents.executeJavaScript(`(() => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
          const palette = new Map();
          const typography = new Map();
          const components = [];
          const logos = [];
          let measured = 0;
          for (let i = 0; i < 2400 && measured < 240; i++) {
            const element = walker.nextNode();
            if (!element) break;
            if (logos.length < 6 && element.matches('header img,nav img,img[alt*="logo" i]')) logos.push({ src: element.currentSrc, alt: element.alt });
            if (!element.matches('header,nav,main,h1,h2,h3,p,a,button,input,section,article')) continue;
            const rect = element.getBoundingClientRect();
            if (!rect.width || !rect.height) continue;
            measured++;
            const style = getComputedStyle(element);
            for (const color of [style.color, style.backgroundColor, style.borderColor]) {
              if (color === 'rgba(0, 0, 0, 0)' || color === 'transparent') continue;
              palette.set(color, (palette.get(color) || 0) + Math.min(rect.width * rect.height, 1296000));
            }
            const font = [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight].join('|');
            typography.set(font, (typography.get(font) || 0) + 1);
            if (components.length < 20 && element.matches('button,input,nav,h1,h2')) components.push({ tag: element.tagName.toLowerCase(), text: element.textContent.trim().slice(0,120), font: style.fontFamily, fontSize: style.fontSize, weight: style.fontWeight, padding: style.padding, gap: style.gap, radius: style.borderRadius, color: style.color, background: style.backgroundColor });
          }
          return { url: location.href, title: document.title, viewport: { width: innerWidth, height: innerHeight }, palette: [...palette].sort((a,b) => b[1]-a[1]).slice(0,12).map(([color,weight]) => ({ color,weight })), typography: [...typography].sort((a,b) => b[1]-a[1]).slice(0,12).map(([font,count]) => ({ font,count })), components, logos };
        })()`)
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Reference measurement timed out')), 30_000)
      })
    ])
  } finally {
    clearTimeout(timer)
    window.webContents.session.removeListener('will-download', denyDownload)
    window.destroy()
    extracting = false
  }
}
