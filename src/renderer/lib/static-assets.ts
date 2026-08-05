/// <reference types="vite/client" />

/**
 * Resolve a file copied from `src/renderer/static` against Vite's configured base.
 * Development is served from `/`; packaged Electron renderers load from `./`.
 */
export function publicAssetUrl(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`
}
