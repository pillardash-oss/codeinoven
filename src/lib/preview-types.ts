/**
 * Media classification for previews. Extension mappings supply default MIME
 * types; any audio/video MIME type can stream without appearing in the table.
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
 * Images and documents retain decode/viewer limits. Audio and video stay on
 * disk and stream on demand, so their duration and total file size must not
 * impose an in-memory transfer limit. The safe-integer ceiling preserves exact
 * byte offsets for range requests.
 */
const KIND_MAX_BYTES: Readonly<Record<PreviewKind, number>> = {
  image: 32 * MIB,
  document: 64 * MIB,
  audio: Number.MAX_SAFE_INTEGER,
  video: Number.MAX_SAFE_INTEGER
}

/**
 * Default MIME types by extension, not an audio/video streaming allowlist.
 * Explicit audio/video MIME metadata works independently. One deliberate
 * omission:
 *
 * - `.tif`/`.tiff` resolve to a media type no renderer here displays, so serving
 *   them would promise a preview that cannot appear. They stay file downloads.
 *
 * `.svg` is served, and it is the one active format on this list. That is safe
 * only because of how it is used: `appfile://` answers every response with
 * `Content-Security-Policy: default-src 'none'; script-src 'none'` and
 * `X-Content-Type-Options: nosniff` (see `previewHeaders` in
 * `src/main/editor/file-preview-protocol.ts`), and the renderer only ever puts
 * it in an `<img>`, which never runs an SVG's scripts. Never navigate to an
 * `appfile://` SVG, mount it in an iframe, or open it as an object: that is
 * the line this table entry depends on staying on the right side of.
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
  // Active XML: `<img>` only, see the note above the table
  '.svg': { kind: 'image', mime: 'image/svg+xml' },
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
  '.mkv': { kind: 'video', mime: 'video/x-matroska' },
  '.avi': { kind: 'video', mime: 'video/x-msvideo' },
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
export function previewTypeForPath(path: string, mime?: string): PreviewType | null {
  // MIME metadata identifies media even for new formats and opaque stored IDs.
  // Only passive audio/video types may bypass extension classification.
  const mediaMime = mime?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaMime && /^(audio|video)\/[a-z0-9!#$&^_.+-]+$/u.test(mediaMime)) {
    return {
      extension: '.media',
      kind: mediaMime.startsWith('audio/') ? 'audio' : 'video',
      mime: mediaMime,
      maxBytes: Number.MAX_SAFE_INTEGER
    }
  }
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
