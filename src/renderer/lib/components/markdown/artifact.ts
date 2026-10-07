import DOMPurify from 'dompurify'
import { htmlPreviewFrame } from '../../document-preview-frame'

/**
 * Inline artifact fences.
 *
 * Agents emit these only when the user asks for a rendered visual (or a
 * diagram is materially clearer as HTML/SVG than Mermaid):
 *
 *   ```artifact-html ... ```   a self-contained HTML document fragment
 *   ```artifact-svg ... ```     raw SVG markup
 *
 * Plain `html` and `svg` fences keep rendering as code blocks   the
 * `artifact-` prefix is the explicit opt-in, so existing output is unchanged.
 */
export type ArtifactKind = 'html' | 'svg'

const FENCE_LANGUAGE_TO_KIND: Record<string, ArtifactKind> = {
  'artifact-html': 'html',
  'artifact-svg': 'svg'
}

/** Largest artifact source accepted for preview; larger falls back to code. */
export const ARTIFACT_MAX_SOURCE_CHARS = 64_000

/** Map an already lowercased fence language to its artifact kind, if any. */
export function artifactKindForLang(lang: string | undefined): ArtifactKind | null {
  if (!lang) return null
  return FENCE_LANGUAGE_TO_KIND[lang] ?? null
}

/** True when the source is empty or exceeds the preview budget. */
export function artifactNeedsCodeFallback(code: string): boolean {
  return code.trim().length === 0 || code.length > ARTIFACT_MAX_SOURCE_CHARS
}

/**
 * Build a sandboxed `iframe srcdoc` document for an artifact.
 *
 * HTML goes through the shared `htmlPreviewFrame` sanitizer (scripts, forms
 * and remote references stripped); the caller always mounts with
 * `sandbox=""`. SVG is sanitized to the SVG profile and embedded as an
 * `<img>` data URL, so embedded scripts can never execute.
 */
export function buildArtifactSrcdoc(kind: ArtifactKind, code: string): string {
  if (kind === 'html') return htmlPreviewFrame(code)
  const svg = DOMPurify.sanitize(code.trim(), {
    USE_PROFILES: { svg: true, svgFilters: true }
  })
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
:root { color-scheme: light; }
body { box-sizing: border-box; display: flex; min-height: 100vh; margin: 0; padding: 1.25rem; align-items: center; justify-content: center; background: #fff; }
img { max-width: 100%; height: auto; }
</style>
</head>
<body><img src="${dataUrl}" alt="SVG artifact"></body>
</html>`
}
