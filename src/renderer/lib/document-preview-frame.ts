import DOMPurify from 'dompurify'

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
