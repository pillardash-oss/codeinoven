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
  mermaidPromise ??= import('mermaid').then((module) => module.default)
  return mermaidPromise
}

/**
 * Mermaid owns global configuration, so renders are serialized. This prevents
 * simultaneous diagrams with different theme snapshots from racing.
 */
export function renderMermaid(id: string, source: string, theme: MermaidTheme): Promise<string> {
  const render = renderQueue.then(async () => {
    const mermaid = await loadMermaid()
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

    const { svg } = await mermaid.render(id, source)
    return DOMPurify.sanitize(svg, {
      USE_PROFILES: { html: true, svg: true, svgFilters: true },
      ADD_TAGS: ['foreignObject'],
      HTML_INTEGRATION_POINTS: { foreignobject: true }
    })
  })

  renderQueue = render.then(
    () => undefined,
    () => undefined
  )
  return render
}
