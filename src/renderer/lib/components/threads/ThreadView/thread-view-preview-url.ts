/**
 * Resolve a preview path against the page's own origin.
 *
 * The join lives in a plain module: it is pure, it needs no reactive state, and
 * a controller that builds it should not hold a mutable `URL` of its own.
 */
export function previewUrl(previewPath: string, origin: string): string {
  return new URL(previewPath, `${origin}/`).toString()
}
