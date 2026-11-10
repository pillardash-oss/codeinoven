/**
 * The one inline tag chip every surface draws.
 *
 * A tag reads as its mark plus its name, whether it sits in the composer's
 * editable line or in a sent message, and both of those are generated HTML
 * strings rather than a component tree (`ComposerTagBadge.svelte` covers the
 * menu rows, which are real components). This module owns the chip's markup so
 * a fix here lands on every surface at once instead of being copied per render
 * path.
 *
 * ## Vertical alignment
 *
 * The chip is an inline-flex box inside a line of prose, and the prose baseline
 * is what decides whether the tag reads as sitting on the line or floating
 * above it. Two rules give that, and both matter:
 *
 * - `items-baseline` makes the chip's own baseline the label's baseline. With
 *   `items-center` the box baseline came from the first item (the mark, a
 *   replaced element whose baseline is its bottom edge), so the label was
 *   pushed up inside a taller box and the whole tag read high.
 * - `self-center` on the mark keeps the icon visually centered in the chip even
 *   though it does not contribute a baseline.
 *
 * Together the words sit on the surrounding baseline and the box stays centered
 * on it, which is what "vertically centered" means for an inline chip.
 */

/** Escape a value that lands in markup this module builds. */
export function escapeInlineTagText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * The chip's structural classes: shape, surface, spacing and the baseline rules
 * above. Sizing and typography stay per surface, because a composer badge and a
 * sent-message chip scale with different text.
 */
const CHIP_CLASS =
  'inline-flex max-w-full items-baseline gap-1 border border-border bg-elevated px-1.5 py-0.5 align-baseline leading-none'

/** The mark keeps its own centering; it never becomes the chip's baseline. */
const MARK_CLASS = 'inline-flex shrink-0 self-center'

/** The label is the chip's baseline source, so it truncates rather than wraps. */
const LABEL_CLASS = 'max-w-48 truncate font-medium'

export interface InlineTagChipOptions {
  /** Visible name, escaped here. */
  label: string
  /** Hover title, escaped here. */
  title: string
  /** Mark markup: an `<img>` or an inline `<svg>`, escaped by its owner. */
  markHtml?: string
  /** Assistant accent, drawn as the chip's inset left edge. */
  accentColor?: string
  /**
   * Accessible name of the chip as a control. Set only when the chip opens
   * something: it makes the chip focusable and clickable, like a link in prose.
   */
  actionLabel?: string
  /** Escaped `data-*` hooks the surface reads the chip back through. */
  attributes?: Readonly<Record<string, string | true>>
  /** Surface-specific sizing and typography. */
  className?: string
  /** Surface-specific label classes, on top of truncation. */
  labelClassName?: string
  /** Surface-specific mark classes, on top of centering. */
  markClassName?: string
}

/**
 * One chip as markup.
 *
 * Callers hand over the plain label and title; escaping happens once, here.
 */
export function inlineTagChipHtml(options: InlineTagChipOptions): string {
  const chipClass = [CHIP_CLASS, options.className].filter(Boolean).join(' ')
  const labelClass = [LABEL_CLASS, options.labelClassName].filter(Boolean).join(' ')
  const markClass = [MARK_CLASS, options.markClassName].filter(Boolean).join(' ')
  const mark = options.markHtml ? `<span class="${markClass}">${options.markHtml}</span>` : ''
  const accent = options.accentColor
    ? ` style="border-left:2px solid ${escapeInlineTagText(options.accentColor)}"`
    : ''
  const control = options.actionLabel
    ? ` cursor-pointer role="button" tabindex="0" aria-label="${escapeInlineTagText(options.actionLabel)}"`
    : ''
  const attributes = Object.entries(options.attributes ?? {})
    .map(([name, value]) =>
      value === true ? ` ${name}` : ` ${name}="${escapeInlineTagText(value)}"`
    )
    .join('')
  return `<span class="${chipClass}"${accent} title="${escapeInlineTagText(options.title)}"${control}${attributes}>${mark}<span class="${labelClass}">${escapeInlineTagText(options.label)}</span></span>`
}
