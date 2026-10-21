import { render } from 'pele'

self.onmessage = (event: MessageEvent<{ id: string; source: string; fontFamily: string }>) => {
  try {
    const { svg } = render(event.data.source, {
      idPrefix: event.data.id,
      fontFamily: event.data.fontFamily,
      images: false,
      links: false,
      maxEdges: 500,
      outputLimit: 1_000_000
    })
    self.postMessage({ svg })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
