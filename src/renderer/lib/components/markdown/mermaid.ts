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
 * Mermaid owns global configuration, so renders are serialized. This prevents
 * simultaneous diagrams with different theme snapshots from racing. A failed
 * render is retried once with a fresh initialize: the first attempt can fail
 * transiently (cold-start import, render race), while a genuine syntax error
 * rethrows so the diagram can surface its message.
 */
export function renderMermaid(id: string, source: string, theme: MermaidTheme): Promise<string> {
  const render = renderQueue.then(async () => {
    const mermaid = await loadMermaid()
    configureMermaid(mermaid, theme)
    try {
      const { svg } = await mermaid.render(id, source)
      return sanitizeSvg(svg)
    } catch {
      configureMermaid(mermaid, theme)
      const { svg } = await mermaid.render(`${id}-retry`, source)
      return sanitizeSvg(svg)
    }
  })

  renderQueue = render.then(
    () => undefined,
    () => undefined
  )
  return render
}
