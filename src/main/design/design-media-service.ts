import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Logger } from '../system/logger'
import {
  checkDesignMediaSource,
  designMediaFileName,
  designMediaTypeForMime,
  designMediaTypeForUrl,
  type DesignMediaKind,
  type DesignMediaType
} from '../../lib/design-media'

/**
 * Bring generated media into a project folder as a real file.
 *
 * A generation service answers with a URL, and those URLs are usually
 * short-lived signed links, so a design that references one is broken as soon as
 * the link expires. This service is what turns such a source into a file beside
 * the design's entry file, so the markup references `./hero.mp4` and keeps
 * working after the link is gone.
 *
 * The source is a link a model wrote, so it is treated as untrusted input: HTTPS
 * only, never a host on this machine or the local network, every redirect hop
 * re-checked, a hard byte ceiling and a deadline per hop, and nothing is kept
 * unless the whole transfer completes.
 */

/** How many redirects one source may take before it is refused. */
const MAX_REDIRECTS = 5

/** Suffix the transfer is written under until it is complete and renamed. */
const PART_SUFFIX = '.part'

/** Media types a server may name when it is really serving bytes of any kind. */
const GENERIC_BINARY_MIMES = new Set([
  'application/octet-stream',
  'application/binary',
  'binary/octet-stream'
])

/** What a server without a content type is given before its bytes run out. */
const DEFAULT_TIMEOUT_MS = 60_000

export interface SaveDesignMediaRequest {
  /** Absolute folder the file lands in. The caller owns path validation. */
  directory: string
  /** The https link a generation service answered with. */
  source: string
  /** File name without an extension. Taken from the source when absent. */
  name?: string | undefined
}

export interface SavedDesignMedia {
  filename: string
  /** Absolute path of the written file. */
  path: string
  kind: DesignMediaKind
  mime: string
  bytes: number
  /** The URL that actually served the bytes, after any redirect. */
  source: string
}

/** A media type resolved from the response, or the reason there is none. */
type ResolvedType = { ok: true; type: DesignMediaType } | { ok: false; reason: string }

/**
 * Read the media type from the response, then from the URL.
 *
 * The URL is only consulted when the server named nothing, or named bytes of an
 * unspecified kind. A server that says `text/html` is serving an error page, and
 * writing that as a `.mp4` would hand the design a broken asset instead of a
 * failure it can report.
 */
function resolveMediaType(response: Response, url: URL): ResolvedType {
  const declared = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase()
  if (declared) {
    const byHeader = designMediaTypeForMime(declared)
    if (byHeader) return { ok: true, type: byHeader }
    if (!GENERIC_BINARY_MIMES.has(declared)) {
      return {
        ok: false,
        reason: `the source served "${declared}", which is not an accepted media type`
      }
    }
  }
  const byUrl = designMediaTypeForUrl(url.href)
  if (byUrl) return { ok: true, type: byUrl }
  return {
    ok: false,
    reason:
      'the source named no media type and its URL has no media extension, so there is nothing that says what the file is'
  }
}

/** Fetch the source, following redirects itself so every hop is checked. */
async function openSource(start: URL): Promise<{ response: Response; url: URL }> {
  let url = start
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      headers: { accept: 'image/*,video/*,audio/*;q=0.9,*/*;q=0.8' }
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => undefined)
      if (!location) {
        throw new Error(`The source redirected with HTTP ${response.status} and no location.`)
      }
      const next = checkDesignMediaSource(new URL(location, url).href)
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
  type: DesignMediaType
): Promise<number> {
  let stream: WriteStream
  try {
    stream = createWriteStream(destination, { flags: 'w' })
  } catch (cause) {
    throw new Error(`The design folder is not writable: ${destination}`, { cause })
  }
  const streamError = new Promise<never>((_resolve, reject) => stream.once('error', reject))
  const reader = body.getReader()
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > type.maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error(
          `The source is larger than the ${Math.round(type.maxBytes / (1024 * 1024))} MB ceiling for ${type.kind} files.`
        )
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
 * Save one generated asset into a folder and report what was written.
 *
 * Nothing lands under the final name unless the whole transfer succeeded: the
 * bytes go to `<name>.<extension>.part` and are renamed, so a design folder never
 * gains a truncated video that looks like a complete one.
 */
export async function saveDesignMedia(request: SaveDesignMediaRequest): Promise<SavedDesignMedia> {
  const checked = checkDesignMediaSource(request.source)
  if (!checked.ok) throw new Error(`The media source is unusable: ${checked.reason}.`)

  await mkdir(request.directory, { recursive: true })
  const { response, url } = await openSource(checked.url)
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`The source answered with HTTP ${response.status}.`)
  }
  if (!response.body) throw new Error('The source returned no body.')

  const resolved = resolveMediaType(response, url)
  if (!resolved.ok) {
    await response.body.cancel().catch(() => undefined)
    throw new Error(`The source is not a usable media file: ${resolved.reason}.`)
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
    bytes = await writeBody(response.body, part, type)
  } catch (error) {
    await rm(part, { force: true }).catch(() => undefined)
    Logger.dev('Design media save failed', {
      source: url.href,
      error: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
  await rename(part, target)

  return { filename, path: target, kind: type.kind, mime: type.mime, bytes, source: url.href }
}
