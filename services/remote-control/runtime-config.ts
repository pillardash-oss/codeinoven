import { resolve } from 'node:path'

export const remoteProduction = process.env['NODE_ENV'] === 'production'
export const remotePublicOrigin = remoteProduction
  ? 'https://mobile.codeinoven.com'
  : 'http://localhost:8877'
export const remoteAuthOrigin = remoteProduction
  ? 'https://auth.codeinoven.com'
  : 'http://localhost:8877'
export const remoteBrowserOrigin = remoteProduction ? remotePublicOrigin : 'http://localhost:5173'
export const remoteDatabasePath = resolve(
  process.env['REMOTE_DATABASE_PATH'] ??
    (remoteProduction ? '/data/remote-control.sqlite' : 'data/remote-control.sqlite')
)
export const trustRemoteProxy = process.env['TRUST_PROXY'] === '1'

function csv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

const configuredStunUrls = csv(process.env['REMOTE_STUN_URLS'])
export const remoteStunUrls =
  configuredStunUrls.length > 0 ? configuredStunUrls : ['stun:stun.cloudflare.com:3478']
export const remoteTurnUrls = csv(process.env['REMOTE_TURN_URLS'])
export const remoteTurnSharedSecret = process.env['REMOTE_TURN_SHARED_SECRET']?.trim() ?? ''
export const remoteTurnCredentialTtlSeconds = Math.max(
  300,
  Number.parseInt(process.env['REMOTE_TURN_CREDENTIAL_TTL_SECONDS'] ?? '3600', 10) || 3600
)

const configuredConvexSiteUrl = process.env['CONVEX_SITE_URL']?.trim()
export const convexSiteUrl = configuredConvexSiteUrl
  ? new URL(configuredConvexSiteUrl).origin
  : 'http://127.0.0.1:3211'
