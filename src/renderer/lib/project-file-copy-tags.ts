/**
 * The text a file-tree copy puts on the clipboard.
 *
 * One copy serves two readers at once: an in-app composer, which turns an
 * `@relative/path` token into a file reference, and every other app, which
 * wants the files themselves (carried separately as file URLs). The tags are
 * therefore written verbatim, one per line, and this module is the single place
 * that format is produced or recognized.
 */

/** The `@tag` line each copied project path contributes, in order. */
export function projectFileCopyTags(paths: readonly string[]): string {
  return paths.map((path) => `@${path}`).join('\n')
}

/**
 * Whether `text` is exactly the tag list a copy of `paths` wrote.
 *
 * A paste of copied files also carries the files themselves, so a composer
 * cannot tell a same-project copy (where the tags are the point) from a copy
 * made in another project (where the files are) unless the tag text still
 * matches the copy the app remembers. Anything else - a Finder copy, an edited
 * paste, a clipboard the user replaced since - is not this copy.
 */
export function matchesProjectFileCopy(paths: readonly string[], text: string): boolean {
  return paths.length > 0 && text.trim() === projectFileCopyTags(paths)
}
