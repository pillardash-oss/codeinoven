/**
 * SEC-01 — Presentation preview containment.
 *
 * The legacy `pptx-preview` renderer parsed untrusted deck bytes and injected
 * the resulting markup directly into the trusted renderer DOM via its own
 * `init(container, …)` + `preview(bytes)` path. That path has no sandbox
 * boundary and does not run behind DOMPurify, so untrusted PPTX bytes flowed
 * into the privileged renderer even when its transitive ECharts and UUID
 * resolved to patched versions. To contain the vulnerable presentation path the
 * interactive JS renderer is disabled outright, and PPTX attachments fall back
 * to the sanitized, sandboxed document-html iframe produced by the main
 * process.
 */

export type PptxPreviewMode = 'disabled' | 'safe'

export interface PptxPreviewPolicyInput {
  /** Resolved production ECharts version (transitive dependency of pptx-preview). */
  echartsVersion: string
  /** Resolved production UUID version. */
  uuidVersion: string
  /** True only when the renderer runs behind a sandbox/sanitization boundary. */
  rendererIsolated: boolean
}

function versionAtLeast(version: string, minimum: string): boolean {
  const parse = (value: string): number[] =>
    value.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const a = parse(version)
  const b = parse(minimum)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av !== bv) return av > bv
  }
  return true
}

/**
 * Decides whether the interactive PPTX JS renderer may be enabled.
 *
 * Enabling it requires BOTH a patched dependency graph (ECharts >= 6.1.0, UUID
 * >= 11.1.1) AND an isolation/sanitization boundary. Because the renderer
 * cannot run behind a sandbox, the trusted renderer always passes
 * `rendererIsolated: false`, so the mode is `'disabled'` regardless of resolved
 * versions.
 */
export function pptxPreviewMode(input: PptxPreviewPolicyInput): PptxPreviewMode {
  const versionsSafe =
    versionAtLeast(input.echartsVersion, '6.1.0') && versionAtLeast(input.uuidVersion, '11.1.1')
  return versionsSafe && input.rendererIsolated ? 'safe' : 'disabled'
}

/** The trusted renderer never enables the interactive PPTX renderer (SEC-01). */
export const PPTX_JS_PREVIEW_ENABLED = false
