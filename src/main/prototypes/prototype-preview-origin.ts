export const PROTOTYPE_PREVIEW_ORIGIN_ENV = 'CODEINOVEN_PUBLIC_PROTOTYPE_PREVIEW_ORIGIN'

export interface PrototypePreviewOriginOptions {
  development: boolean
  allocatedPort?: number
  bakedOrigin?: string
}

export interface PrototypePreviewOriginResult {
  ready: boolean
  origin: string | null
  source: 'runtime' | 'build' | 'loopback' | 'missing'
  reason?: string
}

function validateOrigin(raw: string, development: boolean): string | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > 2_048) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol === 'https:' && !loopback) return url.origin
  if (development && loopback && url.protocol === 'http:') return url.origin
  return null
}

export function resolvePrototypePreviewOrigin(
  env: NodeJS.ProcessEnv,
  options: PrototypePreviewOriginOptions
): PrototypePreviewOriginResult {
  const runtime = env[PROTOTYPE_PREVIEW_ORIGIN_ENV] ?? ''
  if (runtime.trim()) {
    const origin = validateOrigin(runtime, options.development)
    return origin
      ? { ready: true, origin, source: 'runtime' }
      : {
          ready: false,
          origin: null,
          source: 'runtime',
          reason: 'Prototype preview origin must be HTTPS, or loopback HTTP in development'
        }
  }
  if (options.bakedOrigin?.trim()) {
    const origin = validateOrigin(options.bakedOrigin, options.development)
    return origin
      ? { ready: true, origin, source: 'build' }
      : {
          ready: false,
          origin: null,
          source: 'build',
          reason: 'Baked prototype preview origin is invalid for this environment'
        }
  }
  if (
    options.development &&
    Number.isSafeInteger(options.allocatedPort) &&
    (options.allocatedPort ?? 0) > 0
  ) {
    return {
      ready: true,
      origin: `http://127.0.0.1:${options.allocatedPort}`,
      source: 'loopback'
    }
  }
  return {
    ready: false,
    origin: null,
    source: 'missing',
    reason: `${PROTOTYPE_PREVIEW_ORIGIN_ENV} must be configured with an HTTPS origin`
  }
}
