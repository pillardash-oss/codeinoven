import { isBlockedFetchHost } from './local-development-url'

/**
 * Generated media as a design asset: which types a design may save, what they
 * are called, and which sources may be fetched to get them.
 *
 * A generation service answers with a URL rather than with a file, and those
 * URLs are usually short-lived signed links, so a design that references one is
 * broken as soon as the link expires. The job of this module is the decision
 * half of turning such a source into a file beside the design: which media type
 * a header, a filename or a URL names, what the file should be called, and
 * whether the source may be fetched at all. The fetching itself lives in
 * `src/main/design/design-media-service.ts`.
 *
 * Pure, with no `node:*` import, so the tool schema, the executor and a probe can
 * all read the same table.
 */

/** The three kinds of media a design can carry as a file. */
export type DesignMediaKind = 'image' | 'video' | 'audio'

/** One accepted media type and the ceilings its transfer is held to. */
export interface DesignMediaType {
  kind: DesignMediaKind
  /** Canonical media type, which is what the file is written as. */
  mime: string
  /** Extension the file is written with, without the dot. */
  extension: string
  /** A transfer larger than this is refused and its partial file removed. */
  maxBytes: number
  /** A transfer that has not finished by then is aborted. */
  timeoutMs: number
}

const MEBIBYTE = 1024 * 1024

/**
 * Per-kind ceilings. A generated still is small and must arrive quickly; a video
 * is the one asset a design may reasonably wait minutes for, and the byte ceiling
 * is what keeps a hostile or mistaken source from filling the disk.
 */
const KIND_LIMITS: Readonly<Record<DesignMediaKind, { maxBytes: number; timeoutMs: number }>> = {
  image: { maxBytes: 24 * MEBIBYTE, timeoutMs: 30_000 },
  audio: { maxBytes: 64 * MEBIBYTE, timeoutMs: 60_000 },
  video: { maxBytes: 256 * MEBIBYTE, timeoutMs: 180_000 }
}

/** Every accepted media type: canonical mime to kind and file extension. */
const MIME_TYPES: Readonly<Record<string, { kind: DesignMediaKind; extension: string }>> = {
  'image/png': { kind: 'image', extension: 'png' },
  'image/jpeg': { kind: 'image', extension: 'jpg' },
  'image/webp': { kind: 'image', extension: 'webp' },
  'image/avif': { kind: 'image', extension: 'avif' },
  'image/gif': { kind: 'image', extension: 'gif' },
  'image/svg+xml': { kind: 'image', extension: 'svg' },
  'video/mp4': { kind: 'video', extension: 'mp4' },
  'video/webm': { kind: 'video', extension: 'webm' },
  'video/quicktime': { kind: 'video', extension: 'mov' },
  'audio/mpeg': { kind: 'audio', extension: 'mp3' },
  'audio/wav': { kind: 'audio', extension: 'wav' },
  'audio/ogg': { kind: 'audio', extension: 'ogg' },
  'audio/mp4': { kind: 'audio', extension: 'm4a' },
  'audio/webm': { kind: 'audio', extension: 'weba' }
}

/**
 * Spellings a server or a URL uses for the same media type. A header is written
 * by the host and a filename is written by whoever built the link, so `image/jpg`
 * and `audio/x-wav` are both real and both have to land on one canonical type.
 */
const MIME_ALIASES: Readonly<Record<string, string>> = {
  'image/jpg': 'image/jpeg',
  'image/x-png': 'image/png',
  'image/vnd.microsoft.icon': 'image/png',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'audio/mp3': 'audio/mpeg',
  'audio/x-m4a': 'audio/mp4',
  'video/x-m4v': 'video/mp4'
}

/** Extension to canonical mime, for a URL path or a filename a source names. */
const EXTENSION_MIMES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(MIME_TYPES).map(([mime, type]) => [type.extension, mime])),
  // `.jpeg` is the same picture as `.jpg` and appears in URLs just as often.
  jpeg: 'image/jpeg'
}

/** Longest accepted source string. A generation URL is a link, not a payload. */
export const MAX_DESIGN_MEDIA_SOURCE_LENGTH = 4_096

/** Longest file name prefix taken from a name or a URL, before the extension. */
export const MAX_DESIGN_MEDIA_NAME_LENGTH = 48

/** How many numbered variations of one name are tried before a unique suffix. */
const MAX_NAME_ATTEMPTS = 50

/** Strip a header's parameters and case so it can be looked up. */
function normalizeMime(raw: string): string {
  return raw.split(';')[0]?.trim().toLowerCase() ?? ''
}

/** The last path segment's extension, lowercased, or an empty string. */
function extensionOfPathname(pathname: string): string {
  const last = pathname.split('/').pop() ?? ''
  const dot = last.lastIndexOf('.')
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : ''
}

/** The accepted media type a header or filename names, or null. */
export function designMediaTypeForMime(raw: string): DesignMediaType | null {
  const normalized = normalizeMime(raw)
  const mime = MIME_ALIASES[normalized] ?? normalized
  const type = MIME_TYPES[mime]
  return type
    ? { kind: type.kind, mime, extension: type.extension, ...KIND_LIMITS[type.kind] }
    : null
}

/** The accepted media type an extension names, with or without its dot. */
export function designMediaTypeForExtension(raw: string): DesignMediaType | null {
  const extension = raw.trim().toLowerCase().replace(/^\./u, '')
  const mime = EXTENSION_MIMES[extension]
  return mime ? designMediaTypeForMime(mime) : null
}

/** The accepted media type a URL's path names, or null. */
export function designMediaTypeForUrl(raw: string): DesignMediaType | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const extension = extensionOfPathname(url.pathname)
  return extension.length === 0 ? null : designMediaTypeForExtension(extension)
}

/** A source is usable, or it is not and this says why in the agent's terms. */
export type DesignMediaSourceCheck = { ok: true; url: URL } | { ok: false; reason: string }

/**
 * Whether a source may be fetched, and the URL to fetch.
 *
 * HTTPS only, no credentials, and never a host on this machine or the local
 * network: the source is a link a model wrote, so a literal `https://127.0.0.1/`
 * or a link-local metadata address must fail here rather than reach the network.
 * Every redirect hop is checked again by the caller, because a public host may
 * redirect to an internal one.
 */
export function checkDesignMediaSource(raw: string): DesignMediaSourceCheck {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'source is empty' }
  if (trimmed.length > MAX_DESIGN_MEDIA_SOURCE_LENGTH) {
    return {
      ok: false,
      reason: `source is longer than ${MAX_DESIGN_MEDIA_SOURCE_LENGTH} characters`
    }
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { ok: false, reason: 'source is not a URL' }
  }
  if (url.protocol !== 'https:') {
    return {
      ok: false,
      reason: `source must be an https URL, and this one uses "${url.protocol}"`
    }
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'source must not carry credentials' }
  }
  if (isBlockedFetchHost(url)) {
    return {
      ok: false,
      reason: 'source must be a public host, and this one is on this machine or the local network'
    }
  }
  // A public host is spelled with dots; a single label is an intranet name, which
  // resolves on the local network only, so it is refused here rather than left to
  // DNS. IP literals are already covered by the check above.
  if (!url.hostname.includes('.') && !url.hostname.includes(':')) {
    return {
      ok: false,
      reason: 'source host must be a public name, and this one is a single label with no domain'
    }
  }
  return { ok: true, url }
}

/** One file name prefix, lowercased and reduced to what a path can hold. */
export function sanitizeDesignMediaName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, MAX_DESIGN_MEDIA_NAME_LENGTH)
    .replace(/-+$/u, '')
  return cleaned.length > 0 ? cleaned : 'asset'
}

/** The name a source suggests, taken from its last path segment. */
export function designMediaNameFromUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return ''
  }
  const last = (url.pathname.split('/').pop() ?? '').replace(/\.[a-z0-9]+$/iu, '')
  return last.length === 0 ? '' : sanitizeDesignMediaName(last)
}

/**
 * A file name for one saved asset that no existing file in the folder holds.
 *
 * The caller's own name wins, then the source URL's, then a plain `asset`; a
 * number is appended rather than overwriting, so saving two generated images
 * under one name keeps both.
 */
export function designMediaFileName(input: {
  name?: string | undefined
  source: string
  type: DesignMediaType
  taken: ReadonlySet<string>
}): string {
  const requested = input.name?.trim() ?? ''
  const base =
    requested.length > 0
      ? sanitizeDesignMediaName(requested)
      : designMediaNameFromUrl(input.source) || 'asset'
  const first = `${base}.${input.type.extension}`
  if (!input.taken.has(first)) return first
  for (let index = 2; index <= MAX_NAME_ATTEMPTS; index += 1) {
    const candidate = `${base}-${index}.${input.type.extension}`
    if (!input.taken.has(candidate)) return candidate
  }
  return `${base}-${Date.now()}.${input.type.extension}`
}
