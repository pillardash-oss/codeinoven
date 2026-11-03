import type { AgentQuestionVisual } from '$shared/types'
import { projectFilePreviewUrl } from '$lib/file-preview'

/**
 * The picture an agent attached to a question or an option, prepared for the
 * one eye button that opens it.
 *
 * A visual is one of four media, in the order the shared contract resolves
 * them. HTML and SVG are drawn by the artifact renderer the conversation
 * already uses, so a question mockup looks exactly like an inline artifact;
 * a generated raster is an image URL the app's own scheme can serve or a data
 * URL; and a Mermaid diagram goes to the app's diagram renderer, which is the
 * fallback for a model that can draw nothing else.
 *
 * A relative path only ever names a file inside the project, resolved through
 * the same `appfile://` mount the file tree uses. Anything else is refused, so
 * a visual can never make the card load an arbitrary local file.
 */
export type QuestionVisualSource =
  | { kind: 'html'; code: string; caption?: string }
  | { kind: 'svg'; code: string; caption?: string }
  | { kind: 'image'; src: string; caption?: string }
  | { kind: 'mermaid'; code: string; caption?: string }

/** A picture URL the renderer's policy (and CSP) actually allows. */
function imageSource(
  value: string,
  projectId: string | null,
  threadId: string | null
): string | null {
  if (/^data:image\//iu.test(value)) return value
  if (/^appfile:\/\//iu.test(value)) return value
  // A project-relative path, which the file mount turns into a real `src`.
  if (/^\.?\//u.test(value) || /\.(?:png|jpe?g|gif|webp|avif|bmp)$/iu.test(value)) {
    if (!projectId) return null
    return projectFilePreviewUrl(
      projectId,
      value.replace(/^\.\//u, '').replace(/^\//u, ''),
      threadId ?? undefined
    )
  }
  // A remote or `file://` picture would be refused by the page's image policy,
  // so the card says nothing rather than drawing a broken image.
  return null
}

/** The medium to draw for one visual, or `null` when none can be drawn. */
export function questionVisualSource(
  visual: AgentQuestionVisual | undefined,
  projectId: string | null,
  threadId: string | null
): QuestionVisualSource | null {
  if (!visual) return null
  const caption = visual.caption?.trim() || undefined
  const html = visual.html?.trim()
  if (html) return { kind: 'html', code: html, ...(caption ? { caption } : {}) }
  const svg = visual.svg?.trim()
  if (svg) return { kind: 'svg', code: svg, ...(caption ? { caption } : {}) }
  const image = visual.image?.trim()
  if (image) {
    const src = imageSource(image, projectId, threadId)
    return src ? { kind: 'image', src, ...(caption ? { caption } : {}) } : null
  }
  const mermaid = visual.mermaid?.trim()
  if (mermaid) return { kind: 'mermaid', code: mermaid, ...(caption ? { caption } : {}) }
  return null
}
