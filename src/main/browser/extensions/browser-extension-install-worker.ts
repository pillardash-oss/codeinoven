/**
 * The extension install worker.
 *
 * Unpacking a package and rewriting its background entry is CPU and disk work
 * measured in hundreds of milliseconds to seconds for a real extension, and the
 * Electron main process has to stay answerable while it runs: main is what draws
 * every window and services every other IPC call. So the work runs here, in a
 * `worker_threads` Worker, and reports progress back as it goes. Nothing in here
 * touches Electron.
 *
 * The steps, in order, and why each one is where it is:
 *
 *   1. Unpack, or copy, into the app-owned source folder.
 *   2. Establish the identity (the publisher's key from the CRX, the manifest's
 *      own key, or a freshly generated one) and pin it into the manifest. Nothing
 *      can load the extension before this, because the id derives from the key.
 *   3. Install the compatibility preamble, which has to happen before Chromium
 *      ever parses the background entry.
 *   4. Read the finished manifest back for the summary, hash the source, and
 *      report what the extension declared that this runtime cannot give it.
 */

import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import type { BrowserExtensionInjection, BrowserExtensionProgress } from '../../../lib/ipc/browser'
import { injectCompatibilityPreamble } from './browser-extension-inject'
import { deriveExtensionId, isExtensionId, readCrxHeader } from './browser-extension-crx'
import {
  extensionPageFileExists,
  extractZipToDirectory,
  generateExtensionKey,
  hashExtensionDirectory,
  readManifestIconDataUrl,
  readManifestObject,
  readManifestRecord,
  summariseExtensionSource,
  writeManifest,
  type ExtensionSourceSummary
} from './browser-extension-source'

export interface ExtensionPrepareRequest {
  /** The app-owned source folder to build. Emptied first: it is never merged into. */
  destinationDir: string
  /** A CRX to unpack, or null when a folder is being installed. */
  crxPath: string | null
  /** A folder to copy, or null when a CRX is being installed. */
  folderPath: string | null
  /** The official id the Web Store declared. Verified against the package, so a
   *  substituted download cannot install as a different extension. */
  expectedId: string | null
  /** The compatibility preamble to install into the extension's background. */
  preamble: string
}

export interface ExtensionPrepareResult extends ExtensionSourceSummary {
  /** The pinned public key, base64 SPKI, exactly as the manifest now carries it. */
  publicKeyBase64: string
  /** Fingerprint of the extension's own files, ignoring what Chromium generates. */
  sourceHash: string
  /** Best available icon as a data URL, or null when the extension declares none. */
  iconDataUrl: string | null
  injected: BrowserExtensionInjection
  /** Extension-root-relative background entry, or null. */
  entry: string | null
  /** Symbolic links skipped while copying a folder. */
  skippedLinks: number
  /** True when the manifest declared a popup whose file was not in the package.
   *  The summary's `popupPath` is already null in that case; this flag is what
   *  lets the service warn about it instead of silently dropping the popup. */
  popupMissing: boolean
}

export type ExtensionPrepareMessage =
  | {
      type: 'progress'
      phase: BrowserExtensionProgress['phase']
      detail: string
      receivedBytes: number
      totalBytes: number
    }
  | { type: 'result'; result: ExtensionPrepareResult }
  | { type: 'error'; message: string }

const request = workerData as ExtensionPrepareRequest
const port = parentPort

function report(
  phase: BrowserExtensionProgress['phase'],
  detail: string,
  receivedBytes = 0,
  totalBytes = 0
): void {
  const message: ExtensionPrepareMessage = {
    type: 'progress',
    phase,
    detail,
    receivedBytes,
    totalBytes
  }
  port?.postMessage(message)
}

/**
 * Copy an unpacked folder, skipping symbolic links.
 *
 * A picked folder is the user's own, so a link in it is their choice; but a link
 * that points outside the folder would hand the extension's runtime bytes from
 * somewhere the user never offered, and an extension's files are code. Skipping
 * them is the safe reading, and the count is reported rather than hidden.
 */
async function copyDirectory(source: string, destination: string): Promise<number> {
  let skippedLinks = 0
  async function walk(from: string, to: string): Promise<void> {
    await mkdir(to, { recursive: true })
    const entries = await readdir(from, { withFileTypes: true })
    for (const entry of entries) {
      const fromPath = join(from, entry.name)
      const toPath = join(to, entry.name)
      if (entry.isSymbolicLink()) {
        skippedLinks += 1
        continue
      }
      if (entry.isDirectory()) {
        await walk(fromPath, toPath)
        continue
      }
      if (!entry.isFile()) continue
      await cp(fromPath, toPath)
    }
  }
  await walk(source, destination)
  return skippedLinks
}

/** Whether a manifest `key` is usable base64 that derives a well-formed id. */
function isValidBase64Key(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 8192) return false
  try {
    return isExtensionId(deriveExtensionId(Buffer.from(value, 'base64')))
  } catch {
    return false
  }
}

async function prepare(): Promise<ExtensionPrepareResult> {
  await rm(request.destinationDir, { recursive: true, force: true })
  await mkdir(request.destinationDir, { recursive: true })

  let publicKeyBase64 = ''
  let skippedLinks = 0

  if (request.crxPath) {
    report('unpacking', 'Reading the package')
    const header = await readCrxHeader(request.crxPath, request.expectedId)
    if (!header.publicKey) {
      throw new Error('The package carried no publisher key, so its identity cannot be pinned')
    }
    const publishedId = deriveExtensionId(header.publicKey)
    if (request.expectedId && publishedId !== request.expectedId) {
      throw new Error(
        'The package is signed by a different publisher than the id it was fetched for'
      )
    }
    publicKeyBase64 = header.publicKey.toString('base64')
    const fileBytes = await readFile(request.crxPath)
    report('unpacking', 'Unpacking the package', 0, fileBytes.byteLength)
    const entryCount = await extractZipToDirectory(
      fileBytes.subarray(header.payloadOffset),
      request.destinationDir,
      (written) => {
        if (written % 64 === 0) {
          report('unpacking', `Unpacked ${written} files`, 0, fileBytes.byteLength)
        }
      }
    )
    report('unpacking', `Unpacked ${entryCount} files`)
  } else if (request.folderPath) {
    report('unpacking', 'Copying the folder')
    skippedLinks = await copyDirectory(request.folderPath, request.destinationDir)
    report(
      'unpacking',
      skippedLinks > 0 ? `Copied, skipping ${skippedLinks} links` : 'Copied the folder'
    )
  } else {
    throw new Error('Nothing to install: neither a package nor a folder was given')
  }

  report('pinning', 'Pinning the extension identity')
  const manifest = await readManifestObject(request.destinationDir)
  if (request.crxPath) {
    manifest['key'] = publicKeyBase64
  } else if (isValidBase64Key(manifest['key'])) {
    publicKeyBase64 = manifest['key']
  } else {
    publicKeyBase64 = generateExtensionKey()
    manifest['key'] = publicKeyBase64
  }

  report('compat', 'Installing the compatibility layer')
  const injection = await injectCompatibilityPreamble(
    request.destinationDir,
    manifest,
    request.preamble
  )
  await writeManifest(request.destinationDir, manifest)

  report('registering', 'Reading the finished extension')
  const record = await readManifestRecord(request.destinationDir)
  const summary = summariseExtensionSource(record)
  // A package can declare a popup its files do not contain. Offering it anyway
  // ends in `ERR_FILE_NOT_FOUND` once the rail already opened a popup for it,
  // so the install reports no popup instead and says why.
  let popupMissing = false
  if (
    summary.popupPath &&
    !(await extensionPageFileExists(request.destinationDir, summary.popupPath))
  ) {
    popupMissing = true
    summary.popupPath = null
  }
  const iconDataUrl = await readManifestIconDataUrl(request.destinationDir, manifest)
  const sourceHash = await hashExtensionDirectory(request.destinationDir)

  return {
    ...summary,
    iconDataUrl,
    publicKeyBase64,
    sourceHash,
    injected: injection.injection,
    entry: injection.entry,
    skippedLinks,
    popupMissing
  }
}

prepare()
  .then((result) => {
    const message: ExtensionPrepareMessage = { type: 'result', result }
    port?.postMessage(message)
  })
  .catch((error: unknown) => {
    const message: ExtensionPrepareMessage = {
      type: 'error',
      message: error instanceof Error && error.message ? error.message : String(error)
    }
    port?.postMessage(message)
  })
