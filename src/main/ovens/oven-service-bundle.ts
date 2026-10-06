import { createHash } from 'node:crypto'

/**
 * Normalize an Oven service bundle to exactly one trailing newline.
 *
 * One build of `oven-service.mjs` has to hash to one revision no matter which
 * path delivers it, so the app that pushes the bundle, the standalone agent
 * installer that embeds it, and the published `cio-oven` CLI all normalize the
 * same way. This module stays free of Electron imports on purpose: the CLI runs
 * on the Oven, where nothing from the desktop app exists.
 */
export function normalizeServiceBundle(source: string): string {
  return `${source.replace(/\n+$/u, '')}\n`
}

/** The revision an Oven service bundle is identified by everywhere it travels. */
export function serviceBundleRevision(source: string): string {
  return createHash('sha256').update(normalizeServiceBundle(source)).digest('hex')
}
