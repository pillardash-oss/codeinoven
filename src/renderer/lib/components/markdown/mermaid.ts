import DOMPurify from 'dompurify'

export interface MermaidTheme {
  app: string
  border: string
  borderStrong: string
  elevated: string
  foreground: string
  muted: string
  overlay: string
  surface: string
  fontFamily: string
}

// One layout at a time bounds CPU and memory when a response contains many diagrams.
let renderQueue: Promise<unknown> = Promise.resolve()

export function renderMermaid(
  id: string,
  source: string,
  theme: MermaidTheme,
  signal?: AbortSignal
): Promise<string> {
  const render = renderQueue.then(() => {
    signal?.throwIfAborted()
    if (source.length > 50_000) throw new Error('Diagram exceeds 50000 characters.')
    return new Promise<string>((resolve, reject) => {
      const worker = new Worker(new URL('./pele-render-worker.ts', import.meta.url), {
        type: 'module'
      })
      let settled = false
      const finish = (error?: Error, svg?: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        worker.terminate()
        if (error) reject(error)
        else {
          try {
            resolve(
              DOMPurify.sanitize(svg ?? '', {
                USE_PROFILES: { svg: true, svgFilters: true },
                FORBID_TAGS: ['a', 'image', 'foreignObject']
              })
            )
          } catch (reason) {
            reject(reason)
          }
        }
      }
      const abort = (): void => finish(new DOMException('Diagram render cancelled', 'AbortError'))
      const timer = setTimeout(() => finish(new Error('Diagram rendering timed out.')), 5_000)
      signal?.addEventListener('abort', abort, { once: true })
      worker.onmessage = (event: MessageEvent<{ svg?: string; error?: string }>) => {
        finish(event.data.error ? new Error(event.data.error) : undefined, event.data.svg)
      }
      worker.onerror = () => finish(new Error('Diagram renderer could not be loaded.'))
      worker.postMessage({ id, source, fontFamily: theme.fontFamily })
    })
  })
  renderQueue = render.catch(() => undefined)
  return render
}
