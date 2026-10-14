/**
 * Extensions the app serves inline: the media type each is served as, how it is
 * presented, and the size ceiling its transfer is held to.
 *
 * One table with two callers, because they must never disagree:
 *
 * - `appfile://` (`src/main/editor/file-preview-protocol.ts`) streams the file
 *   to the renderer, with Range support so a video can be scrubbed.
 * - the inline artifact pipeline (`src/main/chat/inline-artifact-service.ts`)
 *   publishes it as a message part in a conversation.
 *
 * They were separate lists once and drifted. A generated `audio/webm` file,
 * which `src/lib/design-media.ts` writes as `.weba`, was saved happily and then
 * refused for inline delivery, while `.oga`, `.aac`, `.opus`, `.m4v`, `.mpeg`,
 * `.mpg` and `.ogv` streamed fine but were missing from the render list. The
 * format list in the artifact capability docs is derived from this table for the
 * same reason: prose that repeats a gate is prose that falls out of step with it.
 *
 * Pure, with no `node:*` import, so the main process, the shared docs and a
 * probe all read the same declaration.
 */

/** How a served file is presented in the renderer. */
export type PreviewKind = 'image' | 'audio' | 'video' | 'document'

/** One servable type: its extension, how it presents, and its ceiling. */
export interface PreviewType {
  /** Extension with its dot, lowercased. Always the table key as well. */
  extension: string
  kind: PreviewKind
  /** Canonical media type, which is what the file is served as. */
  mime: string
  /** A larger file is refused before a byte is streamed or published. */
  maxBytes: number
}

const MIB = 1024 * 1024

/**
 * Per-kind ceilings. A still must arrive quickly; a recording is the one file a
 * user may reasonably wait for, and the byte ceiling is what keeps a mistaken or
 * hostile file from filling the disk. A document with its own viewer sits
 * between them.
 */
const KIND_MAX_BYTES: Readonly<Record<PreviewKind, number>> = {
  image: 32 * MIB,
  document: 64 * MIB,
  audio: 512 * MIB,
  video: 512 * MIB
}

/**
 * Extension to kind and canonical type. Anything absent here has no inline
 * presentation at all. Two deliberate omissions:
 *
 * - `.svg` is `image/svg+xml` and is never served through the privileged
 *   `appfile://` scheme, because project-controlled active XML must not run in a
 *   custom-scheme document. It renders from a blob URL instead.
 * - `.tif`/`.tiff` resolve to a media type no renderer here displays, so serving
 *   them would promise a preview that cannot appear. They stay file downloads.
 */
const PREVIEW_MEDIA: Readonly<Record<string, { kind: PreviewKind; mime: string }>> = {
  // Images
  '.png': { kind: 'image', mime: 'image/png' },
  '.jpg': { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.gif': { kind: 'image', mime: 'image/gif' },
  '.webp': { kind: 'image', mime: 'image/webp' },
  '.avif': { kind: 'image', mime: 'image/avif' },
  '.ico': { kind: 'image', mime: 'image/x-icon' },
  '.bmp': { kind: 'image', mime: 'image/bmp' },
  // A document with a viewer of its own
  '.pdf': { kind: 'document', mime: 'application/pdf' },
  // Audio
  '.mp3': { kind: 'audio', mime: 'audio/mpeg' },
  '.wav': { kind: 'audio', mime: 'audio/wav' },
  '.ogg': { kind: 'audio', mime: 'audio/ogg' },
  '.oga': { kind: 'audio', mime: 'audio/ogg' },
  '.m4a': { kind: 'audio', mime: 'audio/mp4' },
  '.flac': { kind: 'audio', mime: 'audio/flac' },
  '.aac': { kind: 'audio', mime: 'audio/aac' },
  '.opus': { kind: 'audio', mime: 'audio/opus' },
  // The extension a generated `audio/webm` is saved as
  '.weba': { kind: 'audio', mime: 'audio/webm' },
  // Video
  '.mp4': { kind: 'video', mime: 'video/mp4' },
  '.m4v': { kind: 'video', mime: 'video/x-m4v' },
  '.webm': { kind: 'video', mime: 'video/webm' },
  '.mov': { kind: 'video', mime: 'video/quicktime' },
  '.mpeg': { kind: 'video', mime: 'video/mpeg' },
  '.mpg': { kind: 'video', mime: 'video/mpeg' },
  '.ogv': { kind: 'video', mime: 'video/ogg' }
}

/** Every servable type by extension, resolved once at module load. */
export const PREVIEW_TYPES: Readonly<Record<string, PreviewType>> = Object.freeze(
  Object.fromEntries(
    Object.entries(PREVIEW_MEDIA).map(([extension, media]): [string, PreviewType] => [
      extension,
      { extension, kind: media.kind, mime: media.mime, maxBytes: KIND_MAX_BYTES[media.kind] }
    ])
  )
)

/**
 * Type for a path's extension, or null when nothing serves it. A dot in a
 * directory segment is never an extension, so `dist.v2/README` resolves to
 * nothing rather than to `.v2`, the same rule `mimeTypeForPath` follows.
 */
export function previewTypeForPath(path: string): PreviewType | null {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const dot = path.lastIndexOf('.')
  if (dot <= slash || dot === path.length - 1) return null
  return PREVIEW_TYPES[path.slice(dot).toLowerCase()] ?? null
}

/**
 * Extensions of one kind in table order, upper-case and without the dot, for
 * prose that must not drift from the gate enforcing it.
 */
export function previewExtensionsForKind(kind: PreviewKind): string {
  return Object.values(PREVIEW_TYPES)
    .filter((type) => type.kind === kind)
    .map((type) => type.extension.slice(1).toUpperCase())
    .join(', ')
}
