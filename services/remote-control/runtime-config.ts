import { resolve } from 'node:path'

export const remoteProduction = process.env['NODE_ENV'] === 'production'
export const remotePublicOrigin = remoteProduction
  ? 'https://mobile.codeinoven.com'
  : 'http://localhost:8877'
export const remoteBrowserOrigin = remoteProduction ? remotePublicOrigin : 'http://localhost:5173'
export const remoteDatabasePath = resolve(
  remoteProduction ? '/data/remote-control.sqlite' : 'data/remote-control.sqlite'
)
export const trustRemoteProxy = process.env['TRUST_PROXY'] === '1'
