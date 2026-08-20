/**
 * Network-layer base URL contract for self-hosted providers, led by Coolify.
 *
 * The base URL MUST be an explicit, verified URL supplied by the user — never
 * invented, guessed, or derived from NODE_ENV. `localhost` is permitted only as
 * a development/test mock. There is no default and no production host is
 * hardcoded here; callers that need the resolved value must read the public
 * environment variable and gate production use behind the readiness check.
 */

/** Public env var carrying the user-supplied Coolify instance base URL. */
export const COOLIFY_BASE_URL_ENV = 'CODEINOVEN_COOLIFY_BASE_URL'

/** Plain-http development-only localhost hosts that may stand in for a host. */
const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])

/** IANA-reserved documentation domains that read as invented placeholders. */
const PLACEHOLDER_HOSTS = new Set(['example.com', 'example.net', 'example.org', 'example.edu'])

/** Reserved TLDs and mDNS suffixes that can never resolve to a real verified host. */
const PLACEHOLDER_SUFFIXES = ['.example', '.invalid', '.localhost', '.test', '.local']

/** Outcome of validating a candidate base URL. */
export interface BaseUrlValidation {
  ok: boolean
  /** Normalized base URL (origin, optional path, no trailing slash) when valid. */
  baseUrl: string | null
  /** Human-readable reason the value was rejected. */
  reason?: string
}

/** Environment flag the validation contract depends on. */
export interface BaseUrlValidationOptions {
  /** Whether the app is running in development. */
  development: boolean
}

/** Result of the deployment-readiness check. */
export interface DeploymentReadiness {
  ready: boolean
  baseUrl: string | null
  reason?: string
}

function isLocalhostHostname(hostname: string): boolean {
  return LOCALHOST_HOSTNAMES.has(hostname)
}

function isPrivateIpAddress(hostname: string): boolean {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname)
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
    if ([a, b, Number(ipv4[3]), Number(ipv4[4])].some((part) => part > 255)) return true
    if (a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    return a === 0 || a === 127
  }
  if (!hostname.includes(':')) return false
  return hostname === '0:0:0:0:0:0:0:1' || hostname.startsWith('fc') || hostname.startsWith('fd')
}

function isInventedHost(hostname: string): boolean {
  if (isPrivateIpAddress(hostname)) return true
  for (const host of PLACEHOLDER_HOSTS) {
    if (hostname === host || hostname.endsWith(`.${host}`)) return true
  }
  for (const suffix of PLACEHOLDER_SUFFIXES) {
    if (hostname.endsWith(suffix)) return true
  }
  // A bare hostname with no dot cannot be a public, verified HTTPS host.
  return !hostname.includes('.')
}

/**
 * Validate a candidate self-hosted provider base URL.
 *
 * Rejects empty, unverified (non-TLS non-localhost), and invented hosts, and
 * permits `localhost` only when `options.development` is true. The returned
 * value is the normalized base URL with a trailing slash stripped, ready to be
 * composed with provider API paths.
 */
export function validateBaseUrl(raw: string, options: BaseUrlValidationOptions): BaseUrlValidation {
  const trimmed = raw.trim()
  if (!trimmed) {
    return { ok: false, baseUrl: null, reason: 'must not be empty' }
  }
  if (trimmed.length > 2048) {
    return { ok: false, baseUrl: null, reason: 'must be at most 2048 characters' }
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, baseUrl: null, reason: 'must be an absolute URL with a host' }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, baseUrl: null, reason: 'must use http or https' }
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, baseUrl: null, reason: 'must not contain credentials' }
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    return { ok: false, baseUrl: null, reason: 'must be a base URL without a query or fragment' }
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  const baseUrl = parsed.href.replace(/\/+$/u, '')

  if (isLocalhostHostname(hostname)) {
    if (!options.development) {
      return { ok: false, baseUrl: null, reason: 'localhost is only permitted in development' }
    }
    return { ok: true, baseUrl }
  }

  // A non-localhost host must be a verified HTTPS host, never plain http.
  if (parsed.protocol !== 'https:') {
    return { ok: false, baseUrl: null, reason: 'non-localhost hosts must use https' }
  }

  if (isInventedHost(hostname)) {
    return { ok: false, baseUrl: null, reason: 'host looks invented or is a reserved placeholder' }
  }

  return { ok: true, baseUrl }
}

/** Whether the given environment is a development environment. */
export function isDevelopmentEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['VITEST']) return true
  return env['NODE_ENV'] !== 'production'
}

/**
 * Resolve the Coolify base URL from the environment, honoring the explicit
 * verified-URL contract. Returns the normalized base URL or null when unset or
 * invalid — never an invented fallback.
 */
export function resolveCoolifyBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const result = validateBaseUrl(env[COOLIFY_BASE_URL_ENV] ?? '', {
    development: isDevelopmentEnvironment(env)
  })
  return result.ok ? result.baseUrl : null
}

/**
 * Deployment-readiness gate: production use requires a real, verified base URL.
 * In development, a localhost mock satisfies the check; an empty or invalid
 * value always leaves the deployment path not ready with a reason.
 */
export function getCoolifyDeploymentReadiness(
  env: NodeJS.ProcessEnv = process.env
): DeploymentReadiness {
  const result = validateBaseUrl(env[COOLIFY_BASE_URL_ENV] ?? '', {
    development: isDevelopmentEnvironment(env)
  })
  if (result.ok) return { ready: true, baseUrl: result.baseUrl }
  return { ready: false, baseUrl: null, reason: result.reason }
}
