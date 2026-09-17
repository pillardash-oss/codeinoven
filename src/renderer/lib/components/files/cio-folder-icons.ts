/// <reference types="vite/client" />

/**
 * The CodeInOven mark that stands in for the `.cio` folder in every file surface.
 *
 * The artwork is the bare, tile-free oven+code mark, i.e. the vendored
 * `vendor-icons/icons/cio.svg` that `scripts/generate-brand-icons.ts` derives from
 * `src/renderer/static/icon-mark.svg`, and never the squircle-tile app icon
 * (`icon.svg` / `icon.png`): the tile pads the mark to ~58% of its canvas, which
 * is unreadable in a 13px tree row, and its dark plate fights the tree surface.
 * The tile-free mark is full height inside its 1254 viewBox, so it fills the row
 * slot the way every other file icon does.
 *
 * Ink strokes are `currentColor` rather than a baked colour, so the oven and code
 * strokes follow the surface the mark sits on (near-black on light, near-white on
 * dark, muted on an inactive tree row) while the flame wisps and the oven handle
 * keep the fixed brand orange. That only works for markup inlined into the app
 * DOM: an `<img>`-embedded SVG is a document of its own which can resolve neither
 * the app's `.dark` class nor `currentColor`, so `CIO_MARK_DATA_URI` bakes the
 * mid-tone ink that stays legible on either surface for `<img>` renderers.
 *
 * Nothing in the mark is redrawn here: the transform only drops the vendored
 * file's presentational wrappers and re-inks its strokes.
 */
import cioVendorMark from '../../vendor-icons/icons/cio.svg?raw'

/**
 * Ink baked into `CIO_MARK_DATA_URI`. One `<img>` cannot serve two themes, so
 * this is deliberately mid-tone: the light surface's `--color-dimmed`, which
 * still reads against the dark surface and the `--color-raised` badges.
 */
const IMG_INK = '#8b95a5'

/**
 * The vendored mark reduced to a self-contained, collision-free inline SVG. The
 * embedded `<style>` (which only re-inks `#cio-mark .ink`), the `<title>`, and
 * every `class`/`id` are dropped so the same markup can be injected into one
 * document any number of times, and the black ink becomes `currentColor`.
 */
const CIO_MARK_INLINE = cioVendorMark
  .replace(/<style>[\s\S]*?<\/style>/g, '')
  .replace(/<title>[\s\S]*?<\/title>/g, '')
  .replace(/\s+class="[^"]*"/g, '')
  .replace(/\s+id="[^"]*"/g, '')
  .replace(/fill="#000000"/g, 'fill="currentColor"')

/** The `1em` box the vendored mark ships with, swapped for explicit pixels when a
 *  caller sizes the mark itself instead of the font size around it. */
const EM_BOX = /\swidth="1em"\s+height="1em"/

const markupCache = new Map<string, string>()

/**
 * Inline markup for the CodeInOven mark. Without a `size` the mark keeps its
 * `1em` box, so a badge that sizes its icons by font size renders it; with a
 * `size` the mark is exactly that many pixels square.
 */
export function getCioMarkMarkup(size?: number): string {
  const cacheKey = size === undefined ? 'em' : String(size)
  const cached = markupCache.get(cacheKey)
  if (cached) return cached
  const sized =
    size === undefined
      ? CIO_MARK_INLINE
      : CIO_MARK_INLINE.replace(EM_BOX, ` width="${size}" height="${size}"`)
  const markup = sized.replace('<svg ', '<svg aria-hidden="true" focusable="false" ')
  markupCache.set(cacheKey, markup)
  return markup
}

/** `data:` URI form of the mark, for the `<img>` renderers that cannot resolve
 *  `currentColor` (see the module note above). */
export const CIO_MARK_DATA_URI = `data:image/svg+xml,${encodeURIComponent(
  CIO_MARK_INLINE.replaceAll('currentColor', IMG_INK)
)}`

/** Whether a folder name is the CodeInOven scratch folder that wears the app mark. */
export function isCioFolderName(name: string): boolean {
  return name.toLowerCase() === '.cio'
}
