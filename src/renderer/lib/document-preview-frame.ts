import DOMPurify from 'dompurify'

/**
 * Escape markup-shaped text inside a document's `<style>` blocks.
 *
 * DOMPurify treats a literal-text element as a cross-site-scripting hazard when
 * its text contains anything that reads like a tag (its probe is `<` followed by
 * a word character, `/` or `!`), and it refuses the whole element rather than
 * the offending character. A stylesheet whose comment merely names an element,
 * as in `/* theme switching sets data-theme on the <html> element *\/`, is
 * therefore dropped entire: every token it declared disappears with it and the
 * preview renders with each `var(--token)` unresolved, which reads as a broken
 * artifact rather than as a stripped comment.
 *
 * `\3c ` is CSS's own escape for `<`, so rewriting that one character inside
 * the block leaves the stylesheet exactly as authored, comments included, while
 * nothing tag-shaped remains for the sanitizer to trip on.
 */
export function escapeStyleMarkup(html: string): string {
  return html.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/giu,
    (_block: string, opening: string, css: string, closing: string) =>
      `${opening}${css.replace(/</gu, '\\3c ')}${closing}`
  )
}

/** The only tags DOMPurify's SVG profile lacks for a reference drawing. */
export const SVG_REFERENCE_TAGS = ['use']

/** A `<use>` target that stays inside the document that draws it. */
const LOCAL_SVG_REFERENCE = /^#[\w:.-]+$/u

/**
 * Drop every `<use>` that points outside the document it is drawn in.
 *
 * DOMPurify carries no `use` in its SVG allowlist, so every reference drawing
 * was removed and a logo board of `<symbol>` plus `<use>` rendered as empty
 * boxes. The tag is allowed instead (`SVG_REFERENCE_TAGS`) and the hazard it was
 * removed for is closed here: a `<use>` may name a fragment in the same
 * document, never a remote file, which would fetch a URL into a surface the app
 * renders itself.
 *
 * @return true when anything was dropped, so a caller can skip re-serializing.
 */
function dropRemoteSvgUses(root: ParentNode): boolean {
  let dropped = false
  for (const use of root.querySelectorAll('use')) {
    const href = use.getAttribute('href') ?? use.getAttribute('xlink:href')
    if (href !== null && LOCAL_SVG_REFERENCE.test(href.trim())) continue
    use.remove()
    dropped = true
  }
  return dropped
}

/** Localize the `<use>` references of a whole HTML document. */
export function localizeDocumentSvgUses(html: string): string {
  if (!html.includes('<use')) return html
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  if (!dropRemoteSvgUses(parsed)) return html
  return `<!doctype html>\n${parsed.documentElement.outerHTML}`
}

/** Localize the `<use>` references of a markup fragment, such as an SVG file. */
export function localizeFragmentSvgUses(markup: string): string {
  if (!markup.includes('<use')) return markup
  const template = document.createElement('template')
  template.innerHTML = markup
  return dropRemoteSvgUses(template.content) ? template.innerHTML : markup
}

/** How a preview document is laid out inside the frame it is given. */
export interface HtmlPreviewFrameOptions {
  /**
   * Draw the document as a canvas: the body fills the frame's box exactly, with
   * no minimum height and no padding injected around it.
   */
  canvas?: boolean
}

/**
 * Wrap a project HTML file in a sandboxed `<iframe srcdoc>` preview page.
 *
 * HTML files are project-controlled active content, so they are never loaded as
 * a real document: the markup is sanitized with DOMPurify, which drops scripts,
 * event handlers, and `<meta>`/`<base>`/`<link>` (so nothing repoints the
 * document or pulls in another stylesheet), and the caller mounts the result
 * with `sandbox=""`. The document keeps its own head and markup, so its own
 * `<style>` rules still apply and override the neutral surface injected here,
 * because those rules come later in the cascade.
 *
 * The leading doctype is not decoration: `srcdoc` without one renders in quirks
 * mode, which changes box sizing and unit interpretation for the whole preview.
 *
 * `baseHref` (only ever built by `projectFilePreviewUrl()`, whose segments are
 * percent-encoded) resolves relative image and media URLs against the project
 * through the `appfile://` origin. That scheme deliberately serves media only,
 * so project stylesheets and scripts still never load.
 *
 * `canvas` says the document fills the frame as a canvas instead of reading as a
 * page of prose: the body takes exactly the frame's box with nothing injected
 * around it, so a composition authored at `100vh` is neither pushed past the
 * frame's bottom edge nor wrapped in a scrollbar by the host.
 */
export function htmlPreviewFrame(
  html: string,
  baseHref?: string,
  themeStyles?: string,
  options: HtmlPreviewFrameOptions = {}
): string {
  const sanitized = localizeDocumentSvgUses(
    DOMPurify.sanitize(escapeStyleMarkup(html), {
      FORBID_ATTR: ['ping', 'srcdoc', 'formaction'],
      FORBID_TAGS: ['base', 'link', 'meta', 'script'],
      WHOLE_DOCUMENT: true,
      ADD_TAGS: SVG_REFERENCE_TAGS
    })
  )
  const body = options.canvas
    ? 'body { box-sizing: border-box; height: 100%; margin: 0; }'
    : `body { box-sizing: border-box; min-height: 100vh; margin: 0; padding: 1.25rem; ${themeStyles === undefined ? 'color: #202124; background: #fff; line-height: 1.55;' : ''} }`
  const head = `${baseHref ? `<base href="${baseHref}">` : ''}
    <style>
      ${themeStyles ?? ':root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }'}
      ${options.canvas ? 'html { height: 100%; }' : ''}
      ${body}
      img, video { max-width: 100%; height: auto; }
    </style>`
  // DOMPurify serializes a parsed document, so the output always carries the
  // parser-synthesized `<head>`; injecting there keeps this policy ahead of the
  // document's own styles in the cascade.
  const withHead = sanitized.replace(/<head[^>]*>/iu, (opening: string) => `${opening}${head}`)
  return `<!doctype html>\n${withHead}`
}

/**
 * Wrap converted document HTML (DOCX, DOC, ODT, PPTX, XLSX, …) in a styled
 * standalone page for a sandboxed `<iframe srcdoc>` preview. The input is
 * sanitized here, so callers may pass raw converter output (e.g. from
 * `file:readDocumentPreview`) directly. The light "paper" surface matches the
 * chat-attachment document preview so previews look identical everywhere.
 */
export function documentPreviewFrame(html: string): string {
  const sanitized = localizeFragmentSvgUses(
    DOMPurify.sanitize(escapeStyleMarkup(html), { ADD_TAGS: SVG_REFERENCE_TAGS })
  )
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { box-sizing: border-box; max-width: 52rem; min-height: calc(100vh - 4rem); margin: 2rem auto; padding: 3.5rem 4rem; color: #202124; background: #fff; box-shadow: 0 8px 30px rgb(0 0 0 / 14%); line-height: 1.55; }
      h1, h2, h3, h4, h5, h6 { line-height: 1.25; }
      img { max-width: 100%; height: auto; }
      table { width: 100%; border-collapse: collapse; }
      th, td { border: 1px solid #d5d7da; padding: .45rem .6rem; vertical-align: top; }
      li + li { margin-top: .35rem; }
      a { color: #0969da; }
      @media (max-width: 700px) { body { margin: 0; padding: 1.5rem; box-shadow: none; } }
    </style>
  </head>
  <body>${sanitized}</body>
</html>`
}
