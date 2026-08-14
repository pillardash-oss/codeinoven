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
