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

let mermaidPromise: Promise<(typeof import('mermaid'))['default']> | undefined
let renderQueue = Promise.resolve()

function loadMermaid(): Promise<(typeof import('mermaid'))['default']> {
  mermaidPromise ??= import('mermaid')
    .then((module) => module.default)
    .catch((error) => {
      // A single transient dynamic-import failure (cold-start chunk fetch, race
      // under memory pressure) must not poison every later diagram in the
      // session — clear the cached promise so the next render retries the import.
      mermaidPromise = undefined
      throw error
    })
  return mermaidPromise
}

function configureMermaid(
  mermaid: (typeof import('mermaid'))['default'],
  theme: MermaidTheme
): void {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: 'base',
    fontFamily: theme.fontFamily,
    flowchart: { htmlLabels: false },
    themeVariables: {
      background: theme.app,
      primaryColor: theme.surface,
      primaryTextColor: theme.foreground,
      primaryBorderColor: theme.borderStrong,
      secondaryColor: theme.elevated,
      tertiaryColor: theme.overlay,
      lineColor: theme.muted,
      textColor: theme.foreground,
      mainBkg: theme.surface,
      nodeBorder: theme.borderStrong,
      clusterBkg: theme.elevated,
      clusterBorder: theme.border,
      titleColor: theme.foreground,
      edgeLabelBackground: theme.app,
      actorBkg: theme.surface,
      actorBorder: theme.borderStrong,
      actorTextColor: theme.foreground,
      signalColor: theme.foreground,
      signalTextColor: theme.foreground,
      labelBoxBkgColor: theme.surface,
      labelBoxBorderColor: theme.borderStrong,
      labelTextColor: theme.foreground
    }
  })
}

function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    ADD_TAGS: ['foreignObject'],
    HTML_INTEGRATION_POINTS: { foreignobject: true }
  })
}

/**
 * A stalled step (cold dynamic-import fetch, dagre layout on a pathological
 * graph) must never block the shared render queue — every later diagram in the
 * session would otherwise wait behind it forever. Racing a timeout turns a
 * stall into a rejection, so the queue always keeps draining and the diagram
 * surfaces the failure instead of spinning indefinitely.
 */
const RENDER_TIMEOUT_MS = 30_000

function withTimeout<T>(promise: Promise<T>, id: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Mermaid render timed out after ${RENDER_TIMEOUT_MS}ms (${id})`)),
      RENDER_TIMEOUT_MS
    )
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * Mermaid resolving with an empty SVG is a silent failure: the component would
 * show a dead shell with no spinner, no error, and no way to recover. Treat it
 * as a render failure so the caller can retry and surface a real message.
 */
function assertSvg(svg: string, id: string): string {
  if (svg.trim() === '') {
    throw new Error(`Mermaid produced no SVG output (${id})`)
  }
  return svg
}

/**
 * Mermaid owns global configuration, so renders are serialized. This prevents
 * simultaneous diagrams with different theme snapshots from racing. A failed
 * or empty render is retried once with a fresh initialize: the first attempt
 * can fail transiently (cold-start import, render race), while a genuine
 * syntax error rethrows so the diagram can surface its message.
 */
export function renderMermaid(id: string, source: string, theme: MermaidTheme): Promise<string> {
  const render = renderQueue.then(async () => {
    const mermaid = await withTimeout(loadMermaid(), id)
    try {
      const svg = await renderOnce(mermaid, id, source, theme)
      return assertSvg(svg, id)
    } catch {
      const svg = await renderOnce(mermaid, `${id}-retry`, source, theme)
      return assertSvg(svg, `${id}-retry`)
    }
  })

  renderQueue = render.then(
    () => undefined,
    () => undefined
  )
  return render
}

async function renderOnce(
  mermaid: (typeof import('mermaid'))['default'],
  id: string,
  source: string,
  theme: MermaidTheme
): Promise<string> {
  configureMermaid(mermaid, theme)
  const { svg } = await withTimeout(mermaid.render(id, source), id)
  return sanitizeSvg(svg)
}
