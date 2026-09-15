import DOMPurify from 'dompurify'

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
 */
export function htmlPreviewFrame(html: string, baseHref?: string): string {
  const sanitized = DOMPurify.sanitize(html, {
    FORBID_ATTR: ['ping', 'srcdoc', 'formaction'],
    FORBID_TAGS: ['base', 'link', 'meta', 'script'],
    WHOLE_DOCUMENT: true
  })
  const head = `${baseHref ? `<base href="${baseHref}">` : ''}
    <style>
      :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { box-sizing: border-box; min-height: 100vh; margin: 0; padding: 1.25rem; color: #202124; background: #fff; line-height: 1.55; }
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
  const sanitized = DOMPurify.sanitize(html)
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
