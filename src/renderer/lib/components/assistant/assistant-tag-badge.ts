import type { ComposerAssistantTag } from '../chats/composer-mentions'

/**
 * Inline SVG for an assistant tag's badge.
 *
 * A tag drawn as `@thread:<id>` tells the reader nothing, so the composer draws
 * the same mark the assistant tab draws and lets the label carry the name. This
 * is AssistantIcon's rail tier as markup, because an inline badge is an HTML
 * string rather than a component: the plush body, no ear tufts (they are specks
 * at badge size), the same optical scale and stroke weight, and the inside mark
 * that names the job.
 *
 * Keep this in step with `AssistantIcon.svelte` whenever a mark changes.
 */

/** The rail tier's optical fit, copied from `AssistantIcon.svelte`. */
const OPTICAL_TRANSFORM = 'translate(-2.64 -2.64) scale(1.22)'
/** The rail tier's 1.8 stroke, divided back out of the optical scale. */
const OPTICAL_STROKE = '1.475'

const MARK_PATHS: Record<ComposerAssistantTag['mark'], string> = {
  /** An assistant itself: the plush with its two dots, drawn without the mouth
   *  the largest tier adds (there is no room for a third dot at badge size). */
  mark: '<circle cx="9.4" cy="12.4" r="1.5" fill="currentColor" stroke="none"/><circle cx="14.6" cy="12.4" r="1.5" fill="currentColor" stroke="none"/>',
  /** A repeat ring: this happens again and again on a clock. */
  assistant:
    '<path d="M8.6 12.6a3.6 3.6 0 1 0 1.3-2.8"/><path d="M8.4 8.6v2.6h2.6"/>',
  /** Two soft lines: a piece of work that was asked for. */
  task: '<path d="M8.6 10.6h6.8"/><path d="M8.6 14h4.4"/>',
  /** A soft play mark: one execution of a task, on its own thread. */
  run: '<path d="M10.6 9.4l4.6 3.1-4.6 3.1z"/>',
  /** A page: the instructions the assistant is told to follow. */
  knowledge:
    '<path d="M8.4 9.6h7.2"/><path d="M8.4 12.6h7.2"/><path d="M8.4 15.6h4"/>'
}

export function assistantTagBadgeSvg(mark: ComposerAssistantTag['mark']): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="${OPTICAL_STROKE}" aria-hidden="true"><g transform="${OPTICAL_TRANSFORM}"><rect x="4.2" y="6.4" width="15.6" height="12.4" rx="6"/>${MARK_PATHS[mark]}</g></svg>`
}
