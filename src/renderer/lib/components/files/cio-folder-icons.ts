/// <reference types="vite/client" />

/**
 * The CodeInOven app icon that stands in for the `.cio` folder in every file
 * surface.
 *
 * `.cio` is CodeInOven's own scratch directory, so it wears CodeInOven's own
 * icon rather than a folder glyph: the C/O Relay mark with its gold endpoint on
 * the flat obsidian app tile. The tile keeps the white mark readable; the
 * transparent vendor mark (`vendor-icons/icons/cio.svg`, derived from
 * `icon-mark.svg`) uses the surrounding surface for its ink contrast.
 *
 * The artwork below is generated from the master `src/renderer/static/icon.svg`
 * by `scripts/generate-brand-icons.ts`, not imported from it: the renderer
 * serves `src/renderer/static/` as its Vite `publicDir`, and importing a public
 * asset from JavaScript makes the dev server warn ("Assets in public directory
 * cannot be imported from JavaScript"). Rerun that script after a logo change.
 *
 * The generator removes the XML declaration and comments from the full-bleed
 * 1024-unit square master. The viewBox and artwork stay unchanged.
 *
 * SVG is the source of truth rather than `icon.png`: identical framing, 12 KB
 * instead of 132 KB, and crisp at every row size instead of resampled from
 * 1024px.
 *
 * Two renderings are exported because the consumers differ:
 *
 * - `CIO_ICON_DATA_URI`, an `<img>`-safe `data:` URI (tree rows, the file-search
 *   palette, and the async folder-icon resolvers);
 * - `getCioIconMarkup()`, raw markup for renderers that inject the icon into the
 *   app document (the composer's inline mention badges).
 */
import cioAppIcon from './cio-app-icon.svg?raw'

/** The generated, square app icon as a self-contained SVG. */
const CIO_ICON_SVG = cioAppIcon.trimEnd()

/**
 * `data:` URI form of the icon, for the `<img>` consumers. The artwork is
 * routed through its UTF-8 bytes because `btoa` only accepts latin-1 input, so a
 * future edit to the logo can never turn a non-ASCII character into a startup
 * crash.
 */
export const CIO_ICON_DATA_URI = (() => {
  let binary = ''
  for (const byte of new TextEncoder().encode(CIO_ICON_SVG)) binary += String.fromCharCode(byte)
  return `data:image/svg+xml;base64,${btoa(binary)}`
})()

/** Every call to `getCioIconMarkup` takes its own id namespace. */
/**
 * Raw markup form of the icon, for renderers that inject it into the app
 * document (the composer's inline mention badges).
 *
 * The source has no shared SVG ids or external assets. Keep the mark on the
 * square tile and size it to the inline slot.
 */
export function getCioIconMarkup(): string {
  return CIO_ICON_SVG.replace('width="1024" height="1024"', 'width="1em" height="1em"').replace(
    '<svg ',
    '<svg aria-hidden="true" focusable="false" '
  )
}

/** Whether a folder name is the CodeInOven scratch folder that wears the app icon. */
export function isCioFolderName(name: string): boolean {
  return name.toLowerCase() === '.cio'
}
