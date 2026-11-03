import type { AgentQuestionVisual } from './types'

/**
 * The picture an agent attaches to a question or to one of its options.
 *
 * A decision about something that does not exist yet (a mark on the edge of a
 * card, a layout, a flow) cannot be informed by prose: the user is asked to
 * choose between things they cannot see. One field of the visual is set, in the
 * precedence order below, and the card offers it behind a single eye button.
 *
 * The caps are the app's artifact budget, because a visual is drawn by the same
 * renderers as an inline artifact: anything larger falls back to a diagram or
 * is dropped rather than handed to a renderer that refuses it.
 */

/** Largest HTML/SVG source accepted for a question visual. */
export const QUESTION_VISUAL_MAX_SOURCE_CHARS = 64_000

/** Largest prompt an agent may attach, whichever medium it chose. */
const FIELDS = ['html', 'svg', 'image', 'mermaid'] as const

/** Trimmed text, or `undefined` when there is none. */
function visualText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, limit)
}

/**
 * Normalize any payload an agent (or a provider) sent as a visual into the
 * shared contract, or `null` when it carries nothing drawable.
 *
 * An over-budget HTML or SVG source is dropped rather than truncated: half a
 * document is a broken picture, and a Mermaid diagram beside it is the honest
 * fallback.
 */
export function normalizeQuestionVisual(value: unknown): AgentQuestionVisual | null {
  if (typeof value === 'string') {
    const text = visualText(value, QUESTION_VISUAL_MAX_SOURCE_CHARS)
    if (!text) return null
    if (/^\s*<svg\b/iu.test(text)) return { svg: text }
    if (/^\s*<(?:!doctype|html)\b/iu.test(text)) return { html: text }
    // A bare data URL or a picture path is an image; anything else reads as a
    // diagram the agent wrote, which is the safest thing to draw it as.
    if (/^(?:data:image\/|https?:\/\/|\/|\.\/)/iu.test(text)) return { image: text }
    return { mermaid: text }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const caption = visualText(record['caption'], 160)
  for (const field of FIELDS) {
    const text = visualText(record[field], QUESTION_VISUAL_MAX_SOURCE_CHARS)
    if (text) return { [field]: text, ...(caption ? { caption } : {}) }
  }
  return null
}

/** True when the visual carries something the card can draw. */
export function hasQuestionVisual(visual: AgentQuestionVisual | undefined): boolean {
  if (!visual) return false
  return FIELDS.some((field) => (visual[field] ?? '').trim().length > 0)
}
