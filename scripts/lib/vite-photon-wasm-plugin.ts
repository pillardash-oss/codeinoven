/// <reference types="node" />

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Plugin } from 'vite'

/**
 * Vite plugin that ships Photon's wasm payload beside the bundled chunk that
 * reads it.
 *
 * Pi reads images through Photon (`@silvia-odwyer/photon-node`), whose module
 * body does its own payload lookup in the module's own directory:
 *
 *   var path = require("path").join(__dirname, "photon_rs_bg.wasm");
 *   var bytes = require("fs").readFileSync(path);
 *
 * Bundling rewrites that `__dirname` to the emitted chunk's directory, so the
 * payload has to be sitting in `out/main/chunks/` next to `photon_rs-<hash>.js`.
 * Rollup emits the JavaScript for the module but never the wasm it reads, and
 * the failure that leaves behind is silent and badly misleading: `loadPhoton`
 * catches the ENOENT, caches `null`, and every image Pi is handed comes back as
 * `[Image omitted: could not be resized below the inline image size limit.]`
 * whether it weighs 40 KB or 4 MB. The model then sees only a file path and
 * spends turns running `sips` instead of looking at the picture.
 *
 * Pi also probes three fallbacks (`dirname(execPath)`, its `photon/` sibling and
 * the process cwd) before giving up, but all three are outside the app bundle:
 * one is inside the signed `.app` and the others are wherever the user launched
 * from, so the chunk directory is the only place this can be fixed properly.
 *
 * The copy is a no-op when Photon is not part of the bundle, which keeps the
 * plugin honest for any build that stops inlining it: it acts only when a
 * photon chunk was actually emitted, and throws rather than ship a build whose
 * image pipeline is broken.
 */
const PHOTON_WASM = 'photon_rs_bg.wasm'

/** Absolute path of the installed payload, or `null` when the package is gone. */
export function resolvePhotonWasm(): string | null {
  try {
    const entry = createRequire(import.meta.url).resolve('@silvia-odwyer/photon-node')
    const candidate = join(dirname(entry), PHOTON_WASM)
    return existsSync(candidate) ? candidate : null
  } catch {
    return null
  }
}

/** Output directories Photon's chunk can land in, the bundle root and `chunks/`. */
export function photonPayloadDirectories(directory: string): string[] {
  return [directory, join(directory, 'chunks')]
}

/**
 * Whether this bundle actually contains Photon.
 *
 * Rollup names a chunk after the module it came from, so the JS that performs
 * the lookup is the file whose name carries `photon`. Reading the directory
 * listing keeps the check to one `readdirSync` per output directory.
 */
export function bundleContainsPhoton(directory: string): boolean {
  return photonPayloadDirectories(directory).some((candidate) => {
    if (!existsSync(candidate)) return false
    return readdirSync(candidate).some((name) => name.includes('photon') && name.endsWith('.js'))
  })
}

/**
 * Place the payload where every Photon chunk in `directory` will look for it.
 *
 * Answers whether anything was written, so a caller can distinguish "no Photon
 * in this bundle" from "shipped".
 */
export function emitPhotonPayload(directory: string, source: string | null): boolean {
  if (!bundleContainsPhoton(directory)) return false
  if (source === null) {
    throw new Error(
      '@silvia-odwyer/photon-node is bundled into the main process but its photon_rs_bg.wasm payload could not be resolved. Without it every attached image is dropped before the model sees it.'
    )
  }
  for (const target of photonPayloadDirectories(directory)) {
    mkdirSync(target, { recursive: true })
    copyFileSync(source, join(target, PHOTON_WASM))
  }
  return true
}

/** The slice of the bundle output options this plugin reads. */
interface BundleOutput {
  readonly dir?: string
  readonly file?: string | null
}

/** The output directory of one bundle, or `null` when it wrote a single file. */
function outputDirectory(options: BundleOutput): string | null {
  if (options.dir !== undefined) return options.dir
  if (options.file != null) return dirname(options.file)
  return null
}

export function photonWasmPlugin(): Plugin {
  return {
    name: 'cio-photon-wasm',
    apply: 'build',
    writeBundle(options) {
      const directory = outputDirectory(options)
      if (directory === null) return
      emitPhotonPayload(directory, resolvePhotonWasm())
    }
  }
}
