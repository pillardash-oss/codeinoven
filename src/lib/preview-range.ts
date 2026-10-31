/**
 * Byte-range math and response headers for one served preview.
 *
 * Two places answer a range request for a file the app is allowed to show: the
 * `appfile://` protocol in the main process, and the loopback media server that
 * streams audio and video from a worker thread. They were written once each and
 * had already started to differ in what they sent with a partial response, so
 * the arithmetic and the header set live here and both callers read them.
 *
 * Pure, with no `node:` import, so the worker and the main process can share it.
 */
import type { PreviewType } from './preview-types'

/** What a request's `Range` header narrows the response to. */
export interface ByteRange {
  start: number
  end: number
}

/**
 * The bytes one `Range` header asks for, or null when the header is unusable.
 *
 * A missing header is the whole file. `bytes=start-end`, `bytes=start-` and the
 * suffix form `bytes=-length` are all honoured because Chromium reaches for the
 * tail that way on a file whose index sits at the end.
 */
export function byteRange(value: string | null, size: number): ByteRange | null {
  if (!value) return { start: 0, end: size - 1 }
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim())
  if (!match || (!match[1] && !match[2])) return null
  const rawStart = match[1]
  const rawEnd = match[2]
  if (!rawStart) {
    const suffixLength = Number(rawEnd)
    if (!Number.isSafeInteger(suffixLength) || suffixLength < 1) return null
    return { start: Math.max(0, size - suffixLength), end: size - 1 }
  }
  const start = Number(rawStart)
  const requestedEnd = rawEnd ? Number(rawEnd) : size - 1
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return null
  }
  return { start, end: Math.min(requestedEnd, size - 1) }
}

/**
 * Headers for one served preview.
 *
 * `no-store` keeps a stale copy out of Chromium's cache: the file behind a URL
 * can be written again in place. The policy header is what makes the one active
 * format on the preview list (`.svg`) safe to serve at all, so it travels with
 * every response rather than only with the ones that need it.
 */
export function previewHeaders(
  file: Pick<PreviewType, 'extension' | 'mime'>,
  contentLength: number
): Headers {
  return new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Disposition': `inline; filename="preview${file.extension}"`,
    'Content-Length': String(contentLength),
    'Content-Security-Policy':
      "default-src 'none'; script-src 'none'; object-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'",
    'Content-Type': file.mime,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  })
}
