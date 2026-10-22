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
 * How tall an inline artifact picture may be drawn in the conversation.
 *
 * The same ceiling the inline picture and media figures carry (`max-h-96`): an
 * artifact is shown whole, and the expanded viewer is where it is seen big.
 */
const ARTIFACT_PICTURE_MAX_HEIGHT = '24rem'

/**
 * The shape an SVG artifact asks to be drawn in, or `null` when it states none.
 *
 * A `viewBox` answers whenever it exists: it is the coordinate system the
 * picture is drawn in, so it holds even when the root also carries a percentage
 * size. Non-relative `width`/`height` attributes are the fallback. A source that
 * states neither (a percentage size with no `viewBox`) has no shape of its own,
 * and the caller keeps the plain document viewport instead of guessing one.
 */
export function svgArtifactIntrinsicRatio(code: string): number | null {
  // A commented-out tag is not the root, and the first `<svg` in the text is not
  // always the element the picture is drawn with.
  const source = code.replace(/<!--[\s\S]*?-->/gu, '')
  const opening = /<svg\b[^>]*>/iu.exec(source)?.[0]
  if (!opening) return null
  const box = svgViewBoxRatio(svgAttribute(opening, 'viewBox'))
  if (box !== null) return box
  const width = svgLength(svgAttribute(opening, 'width'))
  const height = svgLength(svgAttribute(opening, 'height'))
  if (width === null || height === null || height <= 0) return null
  return usableRatio(width / height)
}

/**
 * The box an inline artifact picture is drawn in: the artifact's own shape, at
 * the largest size that fits both the message column and the height ceiling.
 *
 * `max-width` is what keeps the box honest when the ceiling is the binding
 * constraint, so a portrait composition is drawn at the width its own shape
 * gives it rather than inside a box wider than the picture.
 */
export function artifactPictureFrameStyle(ratio: number): string {
  return `aspect-ratio:${ratio};max-height:${ARTIFACT_PICTURE_MAX_HEIGHT};max-width:min(100%,calc(${ARTIFACT_PICTURE_MAX_HEIGHT} * ${ratio}));`
}

/** One attribute off an already-matched opening tag, in either quote style. */
function svgAttribute(opening: string, name: string): string | null {
  // The name has to start an attribute: a plain `width` lookup must not answer
  // with the tail of `stroke-width`.
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'iu')
  const match = pattern.exec(opening)
  return match?.[1] ?? match?.[2] ?? null
}

/** A length in the user unit or `px`; anything relative states no shape. */
function svgLength(value: string | null): number | null {
  if (value === null) return null
  const match = /^\s*(\d*\.?\d+)\s*(?:px)?\s*$/iu.exec(value)
  if (!match) return null
  return Number(match[1])
}

/** The shape a `viewBox` states (`minX minY width height`). */
function svgViewBoxRatio(value: string | null): number | null {
  if (value === null) return null
  const parts = value.trim().split(/[\s,]+/u)
  if (parts.length !== 4) return null
  const [minX, minY, width, height] = parts.map(Number)
  if ([minX, minY, width, height].some((part) => !Number.isFinite(part))) return null
  return usableRatio(width / height)
}

/** A ratio a box can be laid out at, rounded so the style string stays short. */
function usableRatio(ratio: number): number | null {
  if (!Number.isFinite(ratio) || ratio <= 0) return null
  return Number(ratio.toFixed(4))
}

/**
 * The box an artifact is mounted in when it is rendered inline for inspection.
 *
 * One stage class for both kinds: the inspector's own sheet styles it, and an
 * artifact's authored `html`/`body`/`:root` rules are rewritten to it so a
 * document that styles its own page still styles the box it is drawn in.
 */
export const ARTIFACT_STAGE_CLASS = 'cio-stage'

/** Id the stage carries, so a pick made on the stage itself stays resolvable. */
export const ARTIFACT_STAGE_ID = 'cio-artifact-stage'

/** What an HTML artifact becomes when it is rendered inline for picking. */
export interface HtmlArtifactDocument {
  /** The artifact's own style rules, scoped to the stage it is drawn in. */
  styles: string
  /** The artifact's body markup, sanitized. */
  markup: string
}

/**
 * Sanitize an HTML artifact for inline (shadow root) inspection.
 *
 * The preview draws an HTML artifact in a sandboxed `iframe`, where no element
 * can be picked. The inspector re-renders the same source inline instead, so the
 * policy is the preview's one (no scripts, no `<base>`/`<link>`/`<meta>`, no form
 * actions) with one addition the inline mount cannot borrow from a sandbox: a
 * form is dropped, because nothing here stops a submission from navigating the
 * app's own window. Only the mounting otherwise changes: the document's own
 * `<style>` rules are lifted to the shadow tree, because a shadow tree rather
 * than a document is what they now style, and they are rewritten so a rule aimed
 * at `html`, `body` or `:root` still reaches the stage box the artifact is
 * mounted in.
 */
export function sanitizedHtmlArtifactDocument(code: string): HtmlArtifactDocument {
  const sanitized = DOMPurify.sanitize(code, {
    FORBID_ATTR: ['ping', 'srcdoc', 'formaction'],
    FORBID_TAGS: ['base', 'link', 'meta', 'script', 'form'],
    WHOLE_DOCUMENT: true
  })
  // Parsing a whole document into a template drops the `html`/`head`/`body`
  // wrappers and keeps their children in document order, which is exactly the
  // split wanted here: rules first, markup after.
  const template = document.createElement('template')
  template.innerHTML = sanitized
  const styles: string[] = []
  for (const style of template.content.querySelectorAll('style')) {
    styles.push(scopeArtifactStyles(style.textContent ?? ''))
    style.remove()
  }
  // A title names the document being previewed. There is no document here, and
  // a stray element in the stage would only be a thing to point at.
  for (const title of template.content.querySelectorAll('title')) title.remove()
  return { styles: styles.join('\n'), markup: template.innerHTML }
}

/**
 * Rewrite a document's style rules for the stage they are mounted in.
 *
 * Only rule preludes are rewritten, never declarations, so a value that merely
 * contains the word `body` is left alone.
 */
function scopeArtifactStyles(css: string): string {
  return css.replace(/([^{}]+)\{/gu, (rule: string, prelude: string) => {
    // `@media`, `@font-face` and friends keep their own prelude.
    if (prelude.trimStart().startsWith('@')) return rule
    return `${scopeSelectorList(prelude)}{`
  })
}

function scopeSelectorList(prelude: string): string {
  return prelude
    .split(',')
    .map((selector) =>
      selector
        // The document root is the shadow host, exactly as for an inline SVG.
        .replace(/:root\b/gu, ':host')
        .replace(/(^|[\s>+~])html\b/gu, `$1.${ARTIFACT_STAGE_CLASS}`)
        .replace(/(^|[\s>+~])body\b(?=$|[\s.:#[>+~])/gu, `$1.${ARTIFACT_STAGE_CLASS}`)
        // `html body` names one box, not a box inside itself.
        .replace(/\.cio-stage \.cio-stage/gu, '.cio-stage')
    )
    .join(',')
}

/**
 * Sanitize SVG artifact source to the SVG profile.
 *
 * One policy for both renderings of an SVG artifact: the preview, which embeds
 * the result as an `<img>` data URL, and the inspector, which places it inline
 * in a shadow root so its elements can be picked. Scripts, foreign objects and
 * event handlers are stripped either way, so the sanitized markup is safe to
 * insert into the document.
 */
export function sanitizedSvgArtifact(code: string): string {
  return DOMPurify.sanitize(code.trim(), {
    USE_PROFILES: { svg: true, svgFilters: true }
  })
}

/**
 * Build a sandboxed `iframe srcdoc` document for an artifact.
 *
 * HTML goes through the shared `htmlPreviewFrame` sanitizer (scripts, forms
 * and remote references stripped) as a canvas, so the artifact owns the whole
 * frame; the caller always mounts with `sandbox=""`. SVG is sanitized to the SVG
 * profile and embedded as an `<img>` data URL, so embedded scripts can never
 * execute, and it is drawn whole inside the frame: a picture that states its own
 * shape is contained, and one that states none is a canvas authored to fill the
 * box it is given.
 */
export function buildArtifactSrcdoc(kind: ArtifactKind, code: string, themeStyles = ''): string {
  if (kind === 'html') return htmlPreviewFrame(code, undefined, themeStyles, { canvas: true })
  const sized = svgArtifactIntrinsicRatio(code) !== null
  const themedSvg = sanitizedSvgArtifact(code).replace(
    /<svg\b[^>]*>/iu,
    (opening) =>
      `${opening}<style>${themeStyles}svg{font-family:var(--font-app);color:var(--color-foreground);fill:currentColor;}</style>`
  )
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(themedSvg)}`
  // The picture is never scaled past the frame's edges, and no padding is
  // injected around it   the artifact's own canvas is the frame.
  const picture = sized
    ? 'max-width: 100%; max-height: 100%; width: auto; height: auto;'
    : 'width: 100%; height: 100%;'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
${themeStyles}
body { box-sizing: border-box; display: flex; height: 100vh; margin: 0; overflow: hidden; align-items: center; justify-content: center; background: var(--color-app); }
img { display: block; min-width: 0; min-height: 0; ${picture} }
</style>
</head>
<body><img src="${dataUrl}" alt="SVG artifact"></body>
</html>`
}
