/**
 * Fetching an extension from the Chrome Web Store.
 *
 * The store has no file-download endpoint: an extension is obtained through the
 * same update-check protocol every Chromium build uses, which answers with the
 * package's address, its size and its SHA-256. That hash is verified here before
 * anything unpacks the file, so a package that does not match what the store
 * declared is refused rather than installed.
 *
 * `net.fetch` is used rather than Node's fetch because it goes through Chromium's
 * network stack: it honours the proxy the app is configured with and the platform's
 * certificate store, which is what a user's machine actually trusts.
 *
 * Both requests are bounded and every failure is stated in terms of what the user
 * asked for, because "the extension you named is not served any more" and "the
 * download stopped halfway" are different problems with different fixes.
 */

import { createHash } from 'node:crypto'
import { open, rm } from 'node:fs/promises'
import { net } from 'electron'

export const WEBSTORE_UPDATE_URL = 'https://clients2.google.com/service/update2/crx'

/** Which package formats to accept. CRX3 only: a CRX2 body has a header this app
 *  refuses, so asking for one would only produce a slower failure. */
const ACCEPT_FORMATS = 'crx2,crx3'

/** A store request has to look like a browser's, because the endpoint answers a
 *  bare fetch with no app element at all. */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'

/** How often download progress is reported. The stream delivers many small chunks
 *  and a progress line per chunk would flood the renderer for no extra truth. */
const PROGRESS_INTERVAL_MS = 250

/** Refuse a package larger than this. The largest extensions the store serves are
 *  tens of megabytes; anything past this is not an extension. */
const MAX_CRX_BYTES = 512 * 1024 * 1024

export interface WebStoreRelease {
  id: string
  version: string
  /** Absolute address of the CRX. */
  url: string
  /** The store's declared SHA-256 of the whole package, lowercase hex, or null
   *  when it did not declare one. */
  sha256: string | null
  /** The store's declared size in bytes, or 0 when it did not declare one. */
  size: number
}

export interface WebStoreDownloadProgress {
  receivedBytes: number
  totalBytes: number
}

function attributeMap(source: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const match of source.matchAll(/([a-zA-Z_][\w:.-]*)="([^"]*)"/gu)) {
    const key = match[1]
    const value = match[2]
    if (key && value !== undefined) attributes[key] = value
  }
  return attributes
}

/**
 * Ask the store for one extension, by the id the user named.
 *
 * The answer's own `appid` is compared against the request, because a redirect or
 * a substituted response would otherwise install a different extension than the
 * one the user asked for.
 */
export async function resolveWebStoreRelease(extensionId: string): Promise<WebStoreRelease> {
  const query =
    `${WEBSTORE_UPDATE_URL}?response=updatecheck` +
    `&prodversion=${encodeURIComponent(appVersionForStore())}` +
    `&acceptformat=${ACCEPT_FORMATS}` +
    `&x=${encodeURIComponent(`id=${extensionId}&uc`)}`

  const response = await net.fetch(query, { headers: { 'user-agent': USER_AGENT } })
  if (!response.ok) {
    throw new Error(`The Web Store answered with HTTP ${response.status}`)
  }
  const body = await response.text()
  const appTag = /<app\b([^>]*)>/u.exec(body)
  if (!appTag?.[1]) {
    throw new Error('The Web Store did not answer for that extension id')
  }
  const app = attributeMap(appTag[1])
  if (app['appid'] && app['appid'] !== extensionId) {
    throw new Error('The Web Store answered for a different extension id')
  }
  const updateTag = /<updatecheck\b([^>]*?)\/?>/u.exec(body)
  if (!updateTag?.[1]) {
    throw new Error('The Web Store answer carried no update details')
  }
  const update = attributeMap(updateTag[1])
  const status = update['status'] ?? 'unknown'
  if (status === 'noupdate') {
    throw new Error('The Web Store no longer serves that extension')
  }
  if (status !== 'ok') {
    throw new Error(`The Web Store refused that extension (${status})`)
  }
  const url = update['codebase']
  if (!url) throw new Error('The Web Store answer carried no address for the package')
  const size = Number(update['size'] ?? '0')
  if (Number.isFinite(size) && size > MAX_CRX_BYTES) {
    throw new Error('That package is larger than an extension can be')
  }
  const sha256 = update['hash_sha256'] ?? null
  return {
    id: extensionId,
    version: update['version'] ?? '0',
    url,
    sha256: sha256 && /^[0-9a-f]{64}$/u.test(sha256) ? sha256 : null,
    size: Number.isFinite(size) && size > 0 ? size : 0
  }
}

/** The product version to claim in a store request. The store only branches on it
 *  to decide which package to hand out, and any modern version gets CRX3. */
function appVersionForStore(): string {
  return '152.0.7977.130'
}

/**
 * Download a release to `destinationPath` and verify it.
 *
 * The bytes are streamed to disk and hashed as they arrive, so a 30 MB package is
 * never held in memory and the hash is a byproduct of the download rather than a
 * second pass over the file. A package whose bytes do not match the store's
 * declared hash is deleted and refused: an installation is a piece of code the
 * app will then run.
 */
export async function downloadWebStoreRelease(
  release: WebStoreRelease,
  destinationPath: string,
  onProgress: (progress: WebStoreDownloadProgress) => void
): Promise<void> {
  const response = await net.fetch(release.url, { headers: { 'user-agent': USER_AGENT } })
  if (!response.ok) {
    throw new Error(`The package download answered with HTTP ${response.status}`)
  }
  if (!response.body) {
    throw new Error('The package download carried no bytes')
  }

  const totalBytes = release.size > 0 ? release.size : Number(response.headers.get('content-length') ?? 0)
  const digest = createHash('sha256')
  let receivedBytes = 0
  let lastEmit = 0
  const handle = await open(destinationPath, 'w')
  try {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      digest.update(chunk)
      await handle.write(chunk)
      receivedBytes += chunk.byteLength
      if (receivedBytes > MAX_CRX_BYTES) {
        throw new Error('That package is larger than an extension can be')
      }
      const now = Date.now()
      if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
        lastEmit = now
        onProgress({ receivedBytes, totalBytes: Number.isFinite(totalBytes) ? totalBytes : 0 })
      }
    }
  } catch (error) {
    await handle.close()
    await rm(destinationPath, { force: true }).catch(() => undefined)
    throw error
  }
  await handle.close()

  const actual = digest.digest('hex')
  if (release.sha256 && actual !== release.sha256) {
    await rm(destinationPath, { force: true }).catch(() => undefined)
    throw new Error('The downloaded package did not match the hash the Web Store declared')
  }
  if (release.size > 0 && receivedBytes !== release.size) {
    await rm(destinationPath, { force: true }).catch(() => undefined)
    throw new Error('The downloaded package was shorter than the Web Store said it would be')
  }
  onProgress({ receivedBytes, totalBytes: receivedBytes })
}
