import { createHash } from 'node:crypto'
import type { Hash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import type { WriteStream } from 'node:fs'
import { open, rm, truncate } from 'node:fs/promises'
import { Logger } from '../system/logger'

const DOWNLOAD_CHUNK_BYTES = 256 * 1024
const DOWNLOAD_MAX_ATTEMPTS = 6

/**
 * A download failure that retrying cannot fix (HTTP status, oversize payload,
 * checksum mismatch). Everything else — dropped connections, terminated
 * bodies, socket resets — is transient and worth resuming.
 */
class PermanentDownloadError extends Error {}

/** Feed the first `byteCount` bytes of a partial download into a running hash. */
async function hashPrefix(path: string, byteCount: number, hash: Hash): Promise<void> {
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
      hash.update(buffer.subarray(0, bytesRead))
      offset += bytesRead
    }
  } finally {
    await handle.close()
  }
}

function backoffDelay(attempt: number): number {
  return Math.min(30_000, 2 ** (attempt - 1) * 1_500)
}

/**
 * Download `url` to `destination` with retry and HTTP Range resume. A dropped
 * connection ("terminated", socket reset, timeout) never restarts from zero
 * while a partial file exists: the next attempt continues from the received
 * byte offset and the checksum is verified over the complete file. Cancelling
 * the signal aborts immediately with a cancellation error.
 */
export async function downloadFileResumable(
  url: string,
  destination: string,
  expectedBytes: number,
  expectedSha256: string,
  signal: AbortSignal,
  onProgress?: (receivedSoFar: number) => void
): Promise<number> {
  // Survives failed attempts: the number of bytes safely on disk. A failed
  // attempt truncates the file to this count before the next one resumes.
  const state = { received: 0 }
  let lastCause: unknown = new Error('The download did not start.')
  for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt += 1) {
    if (signal.aborted) throw new Error('Download cancelled.')
    // Streamed hash of the bytes already on disk so a resumed download can
    // still be checksum-verified as a whole at the end.
    const hash = createHash('sha256')
    if (state.received > 0) await hashPrefix(destination, state.received, hash)
    try {
      const received = await downloadRange(
        url,
        destination,
        expectedBytes,
        state,
        hash,
        signal,
        onProgress
      )
      const digest = hash.digest('hex')
      if (digest !== expectedSha256)
        throw new PermanentDownloadError('Downloaded model checksum does not match the catalog.')
      return received
    } catch (cause) {
      if (signal.aborted) throw new Error('Download cancelled.', { cause })
      if (cause instanceof PermanentDownloadError) throw cause
      lastCause = cause
      if (attempt === DOWNLOAD_MAX_ATTEMPTS) break
      Logger.dev(
        `Model download interrupted at ${state.received} bytes (attempt ${attempt}/${DOWNLOAD_MAX_ATTEMPTS}); resuming:`,
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
 * One resumable transfer pass over HTTP: issues a plain GET for a fresh file
 * or a Range GET to continue an interrupted one, and streams the body to
 * disk while feeding the running hash. Throws a transient error on network
 * drops so the caller can resume; permanent protocol violations are fatal.
 */
async function downloadRange(
  url: string,
  destination: string,
  expectedBytes: number,
  state: { received: number },
  hash: Hash,
  signal: AbortSignal,
  onProgress?: (receivedSoFar: number) => void
): Promise<number> {
  let received = state.received
  let start = received
  const resuming = received > 0
  const response = await fetch(url, {
    signal,
    redirect: 'follow',
    ...(resuming ? { headers: { range: `bytes=${received}-` } } : {})
  })
  if (!response.ok || !response.body) {
    throw new PermanentDownloadError(`Download failed with HTTP ${response.status}.`)
  }
  if (resuming && response.status !== 206) {
    // Server ignored the Range request; restart from zero rather than
    // corrupt the file by appending a full body to a partial prefix.
    received = 0
    state.received = 0
    start = 0
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
        if (received > expectedBytes) {
          throw new PermanentDownloadError('Downloaded model exceeds its catalog byte count.')
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
    if (flushed < received - start) await truncate(destination, state.received)
    stream.destroy()
    throw cause
  }
  state.received = received
  if (received !== expectedBytes)
    throw new Error(`Downloaded ${received} bytes; expected ${expectedBytes}.`)
  return received
}
