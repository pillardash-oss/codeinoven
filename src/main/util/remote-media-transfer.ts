import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Logger } from '../system/logger'
import {
  designMediaFileName,
  designMediaTypeForMime,
  designMediaTypeForUrl,
  type DesignMediaKind,
  type DesignMediaType
} from '../../lib/design-media'

/**
 * Bring a remote media link into a folder as a real file.
 *
 * Two callers need exactly this: the design studio turns a generation service's
 * (short-lived, signed) link into `./hero.mp4` beside the design, and the chat
 * composer turns a link the user dragged out of a page into an attachment. Both
 * are links named by something other than the user, so both are treated as
 * untrusted input: the scheme and every redirect hop are checked, the transfer
 * has a deadline, a byte ceiling and nothing is kept unless it completed.
 *
 * What differs between the two is policy, not plumbing, so the policy is what a
 * caller supplies: which sources may be fetched at all, how many bytes its kind
 * of media may run to, and how it words a refusal. The transfer, the redirect
 * loop, the media-type decision and the atomic rename live here once.
 */

/** How many redirects one source may take before it is refused. */
const MAX_REDIRECTS = 5

/** Deadline for one hop, so a silent host cannot hold a transfer open. */
const HOP_TIMEOUT_MS = 60_000

/** Suffix a transfer is written under until it is complete and renamed. */
const PART_SUFFIX = '.part'

/** Media types a server may name when it is really serving bytes of any kind. */
const GENERIC_BINARY_MIMES = new Set([
  'application/octet-stream',
  'application/binary',
  'binary/octet-stream'
])

/** A source is usable, or it is not and this says why in the caller's terms. */
export type RemoteMediaSourceCheck = { ok: true; url: URL } | { ok: false; reason: string }

/** A media type resolved from a response, or the reason there is none. */
export type RemoteMediaTypeCheck =
  { ok: true; type: DesignMediaType } | { ok: false; reason: string }

/**
 * What one caller decides and words for itself.
 *
 * Every member is a decision, never a step: the same transfer runs underneath all
 * of them, so a second caller cannot end up with a second (and subtly different)
 * redirect check or byte ceiling.
 */
export interface RemoteMediaPolicy {
  /** Whether this source may be fetched at all, and the URL to fetch. */
  checkSource(raw: string): RemoteMediaSourceCheck
  /** Bytes the resolved type is allowed to run to. */
  maxBytes(type: DesignMediaType): number
  /** How a body past that ceiling is refused. */
  overLimitError(type: DesignMediaType, maxBytes: number): Error
  /** How a folder that cannot be written is reported. */
  notWritableError(destination: string, cause: unknown): Error
}

export interface SaveRemoteMediaRequest {
  /** Absolute folder the file lands in. The caller owns path validation. */
  directory: string
  /** The link that names the media. */
  source: string
  /** File name without an extension. Taken from the source when absent. */
  name?: string | undefined
  policy: RemoteMediaPolicy
}

export interface SavedRemoteMedia {
  filename: string
  /** Absolute path of the written file. */
  path: string
  kind: DesignMediaKind
  mime: string
  bytes: number
  /** The URL that actually served the bytes, after any redirect. */
  source: string
}

/**
 * Read the media type from the response, then from the URL.
 *
 * The URL is only consulted when the server named nothing, or named bytes of an
 * unspecified kind. A server that says `text/html` is serving an error page, and
 * writing that as a `.mp4` would hand the caller a broken asset instead of a
 * failure it can report.
 */
export function resolveRemoteMediaType(
  contentType: string | null,
  source: string
): RemoteMediaTypeCheck {
  const declared = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (declared.length > 0) {
    const byHeader = designMediaTypeForMime(declared)
    if (byHeader) return { ok: true, type: byHeader }
    if (!GENERIC_BINARY_MIMES.has(declared)) {
      return { ok: false, reason: `the server served "${declared}"` }
    }
  }
  const byUrl = designMediaTypeForUrl(source)
  if (byUrl) return { ok: true, type: byUrl }
  return {
    ok: false,
    reason: 'nothing in the response or the link says what kind of file it is'
  }
}

/** Fetch the source, following redirects itself so every hop is checked. */
async function openSource(
  start: URL,
  policy: RemoteMediaPolicy
): Promise<{ response: Response; url: URL }> {
  let url = start
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(HOP_TIMEOUT_MS),
      headers: { accept: 'image/*,video/*,audio/*;q=0.9,*/*;q=0.8' }
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => undefined)
      if (!location) {
        throw new Error(`The source redirected with HTTP ${response.status} and no location.`)
      }
      const next = policy.checkSource(new URL(location, url).href)
      if (!next.ok) {
        throw new Error(`The source redirected to a URL that cannot be fetched: ${next.reason}.`)
      }
      url = next.url
      continue
    }
    return { response, url }
  }
  throw new Error(`The source redirected more than ${MAX_REDIRECTS} times.`)
}

/** Write the response body to `destination`, refusing a body past the ceiling. */
async function writeBody(
  body: ReadableStream<Uint8Array>,
  destination: string,
  type: DesignMediaType,
  policy: RemoteMediaPolicy
): Promise<number> {
  const maxBytes = policy.maxBytes(type)
  let stream: WriteStream
  try {
    stream = createWriteStream(destination, { flags: 'w' })
  } catch (cause) {
    throw policy.notWritableError(destination, cause)
  }
  const streamError = new Promise<never>((_resolve, reject) => stream.once('error', reject))
  const reader = body.getReader()
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw policy.overLimitError(type, maxBytes)
      }
      if (!stream.write(value)) {
        await Promise.race([
          new Promise<void>((resolve) => stream.once('drain', resolve)),
          streamError
        ])
      }
    }
    await Promise.race([new Promise<void>((resolve) => stream.end(resolve)), streamError])
    return bytes
  } catch (cause) {
    await reader.cancel().catch(() => undefined)
    stream.destroy()
    throw cause
  }
}

/**
 * Save one remote media link into a folder and report what was written.
 *
 * Nothing lands under the final name unless the whole transfer succeeded: the
 * bytes go to `<name>.<extension>.part` and are renamed, so the caller's folder
 * never gains a truncated video that looks like a complete one.
 */
export async function saveRemoteMedia(request: SaveRemoteMediaRequest): Promise<SavedRemoteMedia> {
  const { policy } = request
  const checked = policy.checkSource(request.source)
  if (!checked.ok) throw new Error(`The media source is unusable: ${checked.reason}.`)

  await mkdir(request.directory, { recursive: true })
  const { response, url } = await openSource(checked.url, policy)
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`The source answered with HTTP ${response.status}.`)
  }
  if (!response.body) throw new Error('The source returned no body.')

  const resolved = resolveRemoteMediaType(response.headers.get('content-type'), url.href)
  if (!resolved.ok) {
    await response.body.cancel().catch(() => undefined)
    throw new Error(`The source is not an image, video or audio file: ${resolved.reason}.`)
  }
  const type = resolved.type

  const taken = new Set(await readdir(request.directory).catch(() => [] as string[]))
  const filename = designMediaFileName({
    name: request.name,
    source: url.href,
    type,
    taken
  })
  const target = join(request.directory, filename)
  const part = `${target}${PART_SUFFIX}`
  let bytes: number
  try {
    bytes = await writeBody(response.body, part, type, policy)
  } catch (error) {
    await rm(part, { force: true }).catch(() => undefined)
    Logger.dev('Remote media save failed', {
      source: url.href,
      error: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
  await rename(part, target)

  return { filename, path: target, kind: type.kind, mime: type.mime, bytes, source: url.href }
}
