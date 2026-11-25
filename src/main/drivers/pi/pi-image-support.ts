/// <reference types="node" />

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getMainBundleDirectory } from '../../bootstrap/bundle-directory'
import { Logger } from '../../system/logger'

/**
 * Whether the Pi build the app hosts can resize an image at all.
 *
 * Pi's vision support leans on Photon (`@silvia-odwyer/photon-node`), whose
 * module body reads `photon_rs_bg.wasm` from its own directory at import time:
 *
 *   var path = require("path").join(__dirname, "photon_rs_bg.wasm");
 *   var bytes = require("fs").readFileSync(path);
 *
 * The bundled main process emits that module as a chunk under
 * `out/main/chunks`, but it does not emit the wasm payload beside it, so the
 * read throws ENOENT at module initialisation. Pi catches it in `loadPhoton`
 * (a bare `catch`), caches `null` for the rest of the process, and every later
 * `resizeImage` returns `null`. `processImage` then answers
 *
 *   [Image omitted: could not be resized below the inline image size limit.]
 *
 *   a message about encoded size that has nothing to do with size. The model
 * never sees the picture, only the `Attached image file: <path>` reference the
 * driver also sends, so it reaches for `file`, `xxd` and `sips -Z` trying to
 * make the image readable. That hunt looks like model confusion and is really
 * one missing 200 KB wasm file.
 *
 * The standalone harness (`resources/harnesses/pi`) is unaffected: it ships
 * `vendor/@silvia-odwyer/photon-node` with the payload, and the same resize
 * succeeds there. Only the copy bundled into the app's own main output is
 * broken, and this audit is what turns that silent degradation into a log line
 * that names the file and every directory it was expected in.
 */
const PHOTON_WASM = 'photon_rs_bg.wasm'

/**
 * Every directory Pi's Photon loader searches, in the order it searches them:
 * the directory holding the bundled chunk first, then the three fallbacks its
 * `patchPhotonWasmRead` redirect tries when the chunk-relative read fails.
 */
export function photonWasmDirectories(chunkRoots: readonly string[]): string[] {
  const executableDirectory = dirname(process.execPath)
  return [...chunkRoots, executableDirectory, join(executableDirectory, 'photon'), process.cwd()]
}

/**
 * The directories this process's main bundle may have emitted its chunks into.
 *
 * Shared main code is bundled either beside the entry or under a `chunks`
 * sibling, so both are searched before handing the list to the Photon audit.
 */
export function mainChunkRoots(moduleUrl: string): string[] {
  const bundleDirectory = getMainBundleDirectory(moduleUrl)
  return [bundleDirectory, join(bundleDirectory, 'chunks')]
}

export interface PiImageSupport {
  /** Whether a Photon payload was found anywhere the loader would look. */
  readonly resizable: boolean
  /** Every directory searched, so a log line can name them all. */
  readonly searched: readonly string[]
}

let audit: PiImageSupport | null = null

/**
 * Audit the hosted Pi's image pipeline once per app run.
 *
 * Cached because the answer cannot change while the process is alive   the
 * wasm payload either shipped or it did not   and because the point is one log
 * line per run, not one per session.
 */
export function auditPiImageSupport(moduleUrl: string): PiImageSupport {
  if (audit !== null) return audit
  const searched = photonWasmDirectories(mainChunkRoots(moduleUrl))
  const resizable = searched.some((directory) => existsSync(join(directory, PHOTON_WASM)))
  audit = { resizable, searched }
  if (!resizable) {
    Logger.error(
      'Pi image resizing is unavailable: photon_rs_bg.wasm was not found, so every attached image is dropped',
      {
        consequence:
          'Pi replaces each image with "[Image omitted: could not be resized below the inline image size limit.]" and the model falls back to reading the file path with shell tools.',
        searched
      }
    )
  }
  return audit
}

/** Test seam: forget the cached audit so a case can exercise its own layout. */
export function resetPiImageSupportAudit(): void {
  audit = null
}
