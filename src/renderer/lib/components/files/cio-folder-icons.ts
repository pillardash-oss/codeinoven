/// <reference types="vite/client" />

/**
 * The CodeInOven app icon that stands in for the `.cio` folder in every file
 * surface.
 *
 * `.cio` is CodeInOven's own scratch directory, so it wears CodeInOven's own
 * icon rather than a folder glyph — the whole app icon, squircle tile included.
 * The tile's gradient, top gloss, ember glow and rim light are the depth of the
 * brand, and the plate is also what keeps the mark's white ink readable: the
 * flat, tile-free vendor mark (`vendor-icons/icons/cio.svg`, derived from
 * `icon-mark.svg`) drops all of it and renders as bare strokes.
 *
 * The artwork below is generated from the master `src/renderer/static/icon.svg`
 * by `scripts/generate-brand-icons.ts`, not imported from it: the renderer
 * serves `src/renderer/static/` as its Vite `publicDir`, and importing a public
 * asset from JavaScript makes the dev server warn ("Assets in public directory
 * cannot be imported from JavaScript"). Rerun that script after a logo change.
 *
 * The generator's only edit to the artwork is its framing. `icon.svg` draws the
 * 800-unit tile inside a 1024-unit canvas, so a fifth of the box would be
 * transparent padding in a file-tree row; the viewBox is tightened to the tile
 * so the icon fills its slot the way every other file icon does. No path,
 * colour, gradient or transform is touched.
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

/** The generated, tile-framed app icon as a self-contained SVG. */
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
let inlineInstance = 0

/**
 * Raw markup form of the icon, for renderers that inject it into the app
 * document (the composer's inline mention badges).
 *
 * The file tree embeds the icon as an `<img>` instead: the icon defines
 * gradients and a clip path, and SVG ids are document-global, so two inlined
 * copies sharing them would both resolve to whichever copy comes first and lose
 * their fills as soon as that copy unmounts — which the tree does as it recycles
 * rows while scrolling. Each call therefore namespaces every id and `url(#…)`
 * reference.
 */
export function getCioIconMarkup(): string {
  const namespace = `cio-icon-${++inlineInstance}-`
  return CIO_ICON_SVG.replace(' width="800" height="800"', ' width="1em" height="1em"')
    .replace(/id="([^"]+)"/g, (_match, id: string) => `id="${namespace}${id}"`)
    .replace(/url\(#([^)]+)\)/g, (_match, id: string) => `url(#${namespace}${id})`)
    .replace('<svg ', '<svg aria-hidden="true" focusable="false" ')
}

/** Whether a folder name is the CodeInOven scratch folder that wears the app icon. */
export function isCioFolderName(name: string): boolean {
  return name.toLowerCase() === '.cio'
}
