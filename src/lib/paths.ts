/**
 * OS-agnostic path helpers.
 *
 * Pure string logic — no `node:path` imports — so this module is safe to use
 * from the renderer, the main process, shared engines, and build scripts.
 *
 * The one rule this module exists to enforce: **the moment a path stops being
 * handed to the filesystem and starts being a string** (compared, split,
 * stored, embedded in generated code, prompt text, or a URL), it must be in
 * POSIX form. `node:path` results carry `\` separators on Windows, and
 * backslashes silently corrupt every non-filesystem consumer: `a\b`.split('/')
 * no longer segments, `..` traversal checks slip through `\`-segments, and
 * backslashes written into JS string literals collapse via legacy escapes
 * (the ERR_INVALID_MODULE_SPECIFIER class of bug).
 */

/** Convert a path to POSIX separators (backslashes become forward slashes). */
export function toPosixPath(path: string): string {
  return path.replaceAll('\\', '/')
}

/** Last non-empty segment of a POSIX or Windows path (`/a/b/` → `b`,
 *  `C:\dir\file.txt` → `file.txt`, `name` → `name`). */
export function posixBasename(path: string): string {
  const segments = toPosixPath(path).split('/').filter(Boolean)
  return segments[segments.length - 1] ?? ''
}

/** Whether a path is absolute in any mainstream form: POSIX (`/x`), UNC
 *  (`\\srv\share`, `//srv/share`), or Windows drive-letter (`C:\x`, `C:/x`). */
export function isAbsoluteishPath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/u.test(path)
}
