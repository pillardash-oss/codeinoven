import { createHash } from 'node:crypto'
import type { Hash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import type { WriteStream } from 'node:fs'
import { open, rm, truncate } from 'node:fs/promises'
import { Logger } from '../system/logger'

const DOWNLOAD_CHUNK_BYTES = 256 * 1024
const DOWNLOAD_MAX_ATTEMPTS = 6

/** Checksum algorithm + digest encoding a resumable download is verified against. */
export interface DownloadChecksum {
  algorithm: 'sha256' | 'sha512'
  encoding: 'hex' | 'base64'
  digest: string
}

export interface ResumableDownloadRequest {
  url: string
  destination: string
  /** Expected total byte count. When `0` the size checks are skipped and only the checksum is trusted. */
  expectedBytes: number
  checksum: DownloadChecksum
  signal: AbortSignal
  /** Bytes already safely on disk from an earlier interrupted download (possibly a previous app launch). */
  resumeFromBytes?: number
  /**
   * Abort an attempt that has not produced response headers within this many
   * milliseconds. Only the connection and header exchange are bounded   a slow
   * body is never cut short   so a source that black-holes the request fails
   * fast instead of stalling a caller that has another source to try. Omit for
   * no deadline.
   */
  responseTimeoutMs?: number
  onProgress?: (receivedSoFar: number) => void
}

/**
 * A download failure that retrying cannot fix (HTTP status, oversize payload,
 * checksum mismatch). Everything else   dropped connections, terminated
 * bodies, socket resets   is transient and worth resuming.
 */
export class PermanentDownloadError extends Error {}

/**
 * The source could not serve this download at all (an HTTP status failure, or no
 * response within the deadline). The bytes already on disk were never contradicted,
 * so a caller with another source keeps them and resumes there; only a checksum or
 * size violation means the bytes themselves are unusable.
 */
export class DownloadSourceError extends PermanentDownloadError {}

/**
 * Incremental digest of a download in progress. It is restartable because a
 * resumed transfer can be forced back to zero bytes (a server that ignores the
 * Range request), and the digest must then cover the file from the start   not
 * the discarded prefix plus the fresh body.
 */
class RunningHash {
  private hash: Hash
  private readonly checksum: DownloadChecksum

  constructor(checksum: DownloadChecksum) {
    this.checksum = checksum
    this.hash = createHash(checksum.algorithm)
  }

  /** Discard everything hashed so far (the bytes it covered are gone from disk too). */
  reset(): void {
    this.hash = createHash(this.checksum.algorithm)
  }

  update(chunk: Uint8Array): void {
    this.hash.update(chunk)
  }

  /** Digest of everything fed since the last reset, in the checksum's encoding. */
  read(): string {
    return this.hash.digest(this.checksum.encoding)
  }

  /** Feed the first `byteCount` bytes of a partial download into the running hash. */
  async feedPrefix(path: string, byteCount: number): Promise<void> {
    const handle = await open(path, 'r')
    try {
      const chunkSize = 1024 * 1024
      const buffer = Buffer.alloc(chunkSize)
      let offset = 0
      while (offset < byteCount) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(chunkSize, byteCount - offset),
          offset
        )
        if (bytesRead === 0) throw new Error('The partial download shrank between attempts.')
        this.update(buffer.subarray(0, bytesRead))
        offset += bytesRead
      }
    } finally {
      await handle.close()
    }
  }
}

function backoffDelay(attempt: number): number {
  return Math.min(30_000, 2 ** (attempt - 1) * 1_500)
}

/**
 * Download `url` to `destination` with retry and HTTP Range resume. A dropped
 * connection ("terminated", socket reset, timeout) never restarts from zero
 * while a partial file exists: the next attempt continues from the received
 * byte offset and the checksum is verified over the complete file. Kept bytes
 * that turn out not to belong to this file (a partial left by an older revision
 * of the artifact) are discarded and the file is fetched once from zero instead
 * of failing the download. Cancelling the signal aborts immediately with a
 * cancellation error.
 */
export async function downloadFileResumable(request: ResumableDownloadRequest): Promise<number> {
  const { url, destination, expectedBytes, checksum, signal, onProgress } = request
  // Survives failed attempts: the number of bytes safely on disk. A failed
  // attempt truncates the file to this count before the next one resumes.
  const state = {
    received: Math.max(0, request.resumeFromBytes ?? 0),
    // How much of `received` came from an earlier attempt, so a digest mismatch
    // is only blamed on kept bytes while any are actually in play.
    resumedFrom: Math.max(0, request.resumeFromBytes ?? 0)
  }
  let lastCause: unknown = new Error('The download did not start.')
  // A digest mismatch over kept bytes is recoverable exactly once: those bytes
  // are thrown away and the next pass fetches the whole file, so a stale partial
  // can never turn a resumable download into a permanent failure the user has to
  // clear by hand.
  let discardedKeptBytes = false
  for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt += 1) {
    if (signal.aborted) throw new Error('Download cancelled.')
    // Streamed hash of the bytes already on disk so a resumed download can
    // still be checksum-verified as a whole at the end.
    const hash = new RunningHash(checksum)
    if (state.received > 0) {
      try {
        await hash.feedPrefix(destination, state.received)
      } catch (cause) {
        // The partial file vanished or shrank between attempts (cache
        // cleared, disk cleanup): a resume offset is no longer meaningful,
        // so discard it and restart the download from byte zero.
        Logger.dev(
          `Partial download at ${state.received} bytes is no longer usable; restarting from zero:`,
          cause
        )
        state.received = 0
        state.resumedFrom = 0
        await rm(destination, { force: true }).catch(() => undefined)
        // feedPrefix may have fed part of the prefix into the hash before
        // failing; rebuild it so the fresh download hashes a clean stream.
        hash.reset()
      }
    }
    try {
      // Everything is already on disk (an earlier attempt wrote the last byte
      // before it was stopped): verify it locally instead of asking the server
      // for an empty range.
      if (expectedBytes > 0 && state.received === expectedBytes) {
        if (hash.read() === checksum.digest) {
          onProgress?.(state.received)
          return state.received
        }
        if (!discardedKeptBytes) {
          discardedKeptBytes = true
          state.received = 0
          state.resumedFrom = 0
          await rm(destination, { force: true }).catch(() => undefined)
          throw new Error('The kept partial file did not match its checksum; downloading it again.')
        }
        throw new PermanentDownloadError(
          'The downloaded file does not match its expected checksum.'
        )
      }
      const received = await downloadRange(
        url,
        destination,
        expectedBytes,
        state,
        hash,
        signal,
        onProgress,
        request.responseTimeoutMs
      )
      const digest = hash.read()
      if (digest !== checksum.digest) {
        // Only a resumed download can reconsider its starting bytes; a file
        // fetched entirely in this pass that still mismatches is fatal.
        if (state.resumedFrom > 0 && !discardedKeptBytes) {
          discardedKeptBytes = true
          state.received = 0
          state.resumedFrom = 0
          await rm(destination, { force: true }).catch(() => undefined)
          throw new Error('The kept partial file did not match its checksum; downloading it again.')
        }
        throw new PermanentDownloadError(
          'The downloaded file does not match its expected checksum.'
        )
      }
      return received
    } catch (cause) {
      if (signal.aborted) throw new Error('Download cancelled.', { cause })
      if (cause instanceof PermanentDownloadError) throw cause
      lastCause = cause
      if (attempt === DOWNLOAD_MAX_ATTEMPTS) break
      Logger.dev(
        `Download interrupted at ${state.received} bytes (attempt ${attempt}/${DOWNLOAD_MAX_ATTEMPTS}); resuming:`,
        cause
      )
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, backoffDelay(attempt))
        timer.unref?.()
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            reject(new Error('Download cancelled.'))
          },
          { once: true }
        )
      })
    }
  }
  throw lastCause
}

/**
 * Fetch the download, bounding only the wait for response headers. A source
 * that never answers (dead host, black-holed connection) fails immediately as
 * permanent, so a caller with a fallback source does not sit through the
 * transient retry ladder; a caller cancellation still aborts at any point.
 */
async function fetchWithResponseDeadline(
  url: string,
  signal: AbortSignal,
  resumeFromBytes: number,
  responseTimeoutMs?: number
): Promise<Response> {
  const deadline = new AbortController()
  const timer =
    responseTimeoutMs === undefined || responseTimeoutMs <= 0
      ? null
      : setTimeout(() => {
          deadline.abort(new Error('The download source did not respond in time.'))
        }, responseTimeoutMs)
  try {
    return await fetch(url, {
      signal: AbortSignal.any([signal, deadline.signal]),
      redirect: 'follow',
      ...(resumeFromBytes > 0 ? { headers: { range: `bytes=${resumeFromBytes}-` } } : {})
    })
  } catch (cause) {
    if (deadline.signal.aborted && !signal.aborted) {
      throw new DownloadSourceError(
        `The download source did not respond within ${String(responseTimeoutMs)}ms.`,
        { cause }
      )
    }
    throw cause
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * One resumable transfer pass over HTTP: issues a plain GET for a fresh file
 * or a Range GET to continue an interrupted one, and streams the body to
 * disk while feeding the running hash. Throws a transient error on network
 * drops so the caller can resume; permanent protocol violations are fatal.
 */
async function downloadRange(
  url: string,
  destination: string,
  expectedBytes: number,
  state: { received: number; resumedFrom: number },
  hash: RunningHash,
  signal: AbortSignal,
  onProgress?: (receivedSoFar: number) => void,
  responseTimeoutMs?: number
): Promise<number> {
  let received = state.received
  let start = received
  const resuming = received > 0
  const response = await fetchWithResponseDeadline(
    url,
    signal,
    resuming ? received : 0,
    responseTimeoutMs
  )
  if (!response.ok || !response.body) {
    throw new DownloadSourceError(`Download failed with HTTP ${response.status}.`)
  }
  if (resuming && response.status !== 206) {
    // Server ignored the Range request; restart from zero rather than
    // corrupt the file by appending a full body to a partial prefix. The hash
    // has to be reset with it: the prefix it covered is gone from disk, and a
    // digest over prefix + full body would fail against the feed's checksum.
    received = 0
    state.received = 0
    state.resumedFrom = 0
    start = 0
    hash.reset()
    await rm(destination, { force: true })
  }
  let stream: WriteStream
  try {
    stream = createWriteStream(destination, {
      flags: resuming && received > 0 ? 'a' : 'w',
      mode: 0o600
    })
  } catch (cause) {
    throw new PermanentDownloadError('The download destination is not writable.', { cause })
  }
  const streamError = new Promise<never>((_resolve, reject) => stream.once('error', reject))
  try {
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      for (let offset = 0; offset < value.byteLength; offset += DOWNLOAD_CHUNK_BYTES) {
        const chunk = value.subarray(offset, offset + DOWNLOAD_CHUNK_BYTES)
        received += chunk.byteLength
        if (expectedBytes > 0 && received > expectedBytes) {
          throw new PermanentDownloadError('The downloaded file exceeds its expected byte count.')
        }
        hash.update(chunk)
        onProgress?.(received)
        if (!stream.write(chunk)) {
          await Promise.race([
            new Promise<void>((resolve) => stream.once('drain', resolve)),
            streamError
          ])
        }
      }
    }
    await Promise.race([new Promise<void>((resolve) => stream.end(resolve)), streamError])
  } catch (cause) {
    // Only the bytes the stream actually flushed to disk are safe. Truncate to
    // that boundary so the next attempt resumes from a consistent prefix.
    const flushed = Math.max(0, stream.bytesWritten)
    state.received = start + flushed
    // These bytes were written in this pass, so none of the kept prefix that
    // was discarded (if it was) can still be blamed for a digest mismatch.
    state.resumedFrom = start > 0 ? state.resumedFrom : 0
    if (flushed < received - start)
      await truncate(destination, state.received).catch(() => undefined)
    stream.destroy()
    throw cause
  }
  state.received = received
  if (expectedBytes > 0 && received !== expectedBytes)
    throw new Error(`Downloaded ${received} bytes; expected ${expectedBytes}.`)
  return received
}
